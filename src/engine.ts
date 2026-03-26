import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import {
  type Task,
  type TaskStatus,
  type EngineType,
  ENGINE_CONFIGS,
  KIBITZ_DIR,
  DEFAULT_TIMEOUT_MS,
} from './types.js';

// ---------------------------------------------------------------------------
// ANSI stripping (no external dep)
// ---------------------------------------------------------------------------

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '');
}

// ---------------------------------------------------------------------------
// Prompt file builder
// ---------------------------------------------------------------------------

function buildTaskFile(prompt: string, sentinelPath: string): string {
  return `${prompt}

===== COMPLETION PROTOCOL =====
When you have FULLY completed ALL tasks above, create a file at:
${sentinelPath}

The file MUST use this exact format:

\`\`\`
---
status: completed
---

## Summary
(Brief description of what you accomplished)

## Files Changed
(List each file path and what changed, or "None")

## Issues
(Any problems encountered, or "None")
\`\`\`

RULES:
- If you hit an unrecoverable error, still write the file but use \`status: failed\`
- Write this file as your ABSOLUTE LAST action
- Do NOT write it until ALL other work is fully complete
- Use forward slashes in the file path
===== END COMPLETION PROTOCOL =====
`;
}

// ---------------------------------------------------------------------------
// Engine Manager
// ---------------------------------------------------------------------------

export class EngineManager {
  private tasks = new Map<string, Task>();
  private processes = new Map<string, ChildProcess>();
  private watchers = new Map<string, FSWatcher>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private waitResolvers = new Map<string, (task: Task) => void>();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async run(
    engine: EngineType,
    prompt: string,
    cwd?: string,
    timeoutMs?: number,
    wait?: boolean,
  ): Promise<Task> {
    const taskId = nanoid(10);
    const workDir = resolve(cwd || process.cwd());
    const kibitzDir = join(workDir, KIBITZ_DIR);
    const sentinelFile = `${taskId}.md`;
    const sentinelPath = join(kibitzDir, sentinelFile).replace(/\\/g, '/');
    const promptFilePath = join(kibitzDir, `${taskId}.prompt`).replace(/\\/g, '/');
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

    // Ensure .kibitz directory exists
    await mkdir(kibitzDir, { recursive: true });

    // Write full task (with completion protocol) to a prompt file.
    // The CLI receives a short boot prompt pointing at this file.
    // This avoids cmd.exe arg-length limits and escaping nightmares.
    const taskContent = buildTaskFile(prompt, sentinelPath);
    await writeFile(promptFilePath, taskContent, 'utf-8');

    const bootPrompt = [
      `Read and execute the task defined in: ${promptFilePath}`,
      'Follow ALL instructions in that file exactly, including the completion protocol at the end.',
      'Start immediately. Do not ask for confirmation.',
    ].join('. ');

    // --- task record ---
    const task: Task = {
      id: taskId,
      engine,
      status: 'running',
      prompt,
      cwd: workDir,
      stdout: '',
      sentinelContent: null,
      startedAt: Date.now(),
      completedAt: null,
      pid: null,
      error: null,
    };
    this.tasks.set(taskId, task);

    // --- spawn via cmd.exe /c  to handle .cmd shims on Windows ---
    const config = ENGINE_CONFIGS[engine];
    const spawnArgs = ['/c', config.command, ...config.promptModeArgs, '-p', bootPrompt];

    const proc = spawn('cmd.exe', spawnArgs, {
      cwd: workDir,
      env: {
        ...process.env,
        // Prevent MSYS2 from mangling paths passed as arguments
        MSYS2_ARG_CONV_EXCL: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    task.pid = proc.pid ?? null;
    this.processes.set(taskId, proc);

    // --- collect stdout / stderr ---
    proc.stdout?.on('data', (chunk: Buffer) => {
      task.stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      task.stdout += chunk.toString();
    });

    // --- watch for sentinel file ---
    this.startSentinelWatch(taskId, kibitzDir, sentinelFile);

    // --- process lifecycle ---
    proc.on('exit', (code) => {
      this.handleProcessExit(taskId, code, join(kibitzDir, sentinelFile));
    });
    proc.on('error', (err) => {
      this.completeTask(taskId, 'failed', null, `Spawn error: ${err.message}`);
    });

    // --- timeout ---
    const timer = setTimeout(() => {
      if (task.status === 'running') {
        this.completeTask(taskId, 'timed_out', null, `Timed out after ${timeout}ms`);
      }
    }, timeout);
    this.timeouts.set(taskId, timer);

    // --- optional synchronous wait ---
    if (wait) {
      if (task.status !== 'running') return task;
      return new Promise<Task>((res) => {
        this.waitResolvers.set(taskId, res);
      });
    }

    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    this.completeTask(taskId, 'cancelled', null, 'Cancelled by user');
    return true;
  }

  shutdown(): void {
    for (const [taskId, task] of this.tasks) {
      if (task.status === 'running') {
        this.completeTask(taskId, 'cancelled', null, 'Server shutting down');
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sentinel file watcher
  // -----------------------------------------------------------------------

  private startSentinelWatch(taskId: string, dir: string, filename: string): void {
    try {
      const watcher = watch(dir, (event, changed) => {
        // 'rename' fires when a new file is created on Windows (NTFS)
        if (changed === filename) {
          // Brief delay so the engine finishes writing
          setTimeout(() => this.readSentinel(taskId, join(dir, filename)), 500);
        }
      });
      this.watchers.set(taskId, watcher);
    } catch {
      // Non-fatal — process exit handler is the fallback
    }
  }

  private async readSentinel(taskId: string, filePath: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    try {
      const content = await readFile(filePath, 'utf-8');
      const status: TaskStatus = content.includes('status: failed') ? 'failed' : 'completed';
      this.completeTask(taskId, status, content, null);
    } catch {
      // File not fully written yet — process exit handler will retry
    }
  }

  // -----------------------------------------------------------------------
  // Process exit
  // -----------------------------------------------------------------------

  private async handleProcessExit(
    taskId: string,
    code: number | null,
    sentinelFilePath: string,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    // Small delay for sentinel file to be flushed to disk
    await new Promise((r) => setTimeout(r, 500));

    // Try reading sentinel even if watcher missed it
    try {
      const content = await readFile(sentinelFilePath, 'utf-8');
      const status: TaskStatus = content.includes('status: failed') ? 'failed' : 'completed';
      this.completeTask(taskId, status, content, null);
      return;
    } catch {
      // No sentinel file
    }

    // Fallback: use process exit code
    if (code === 0) {
      this.completeTask(taskId, 'completed', null, null);
    } else {
      this.completeTask(
        taskId,
        'failed',
        null,
        `Process exited with code ${code}. No sentinel file written.`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Task lifecycle
  // -----------------------------------------------------------------------

  private completeTask(
    taskId: string,
    status: TaskStatus,
    sentinel: string | null,
    error: string | null,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    task.status = status;
    task.sentinelContent = sentinel;
    task.error = error;
    task.completedAt = Date.now();
    task.stdout = stripAnsi(task.stdout);

    this.cleanup(taskId);

    const resolver = this.waitResolvers.get(taskId);
    if (resolver) {
      resolver(task);
      this.waitResolvers.delete(taskId);
    }
  }

  private cleanup(taskId: string): void {
    const proc = this.processes.get(taskId);
    if (proc && !proc.killed) {
      try {
        // On Windows, kill() sends TerminateProcess (hard kill)
        proc.kill();
      } catch {
        // Already exited
      }
    }
    this.processes.delete(taskId);

    const watcher = this.watchers.get(taskId);
    if (watcher) {
      try { watcher.close(); } catch { /* */ }
    }
    this.watchers.delete(taskId);

    const timeout = this.timeouts.get(taskId);
    if (timeout) clearTimeout(timeout);
    this.timeouts.delete(taskId);
  }
}
