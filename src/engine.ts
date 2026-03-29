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
  SYNDIC_DIR,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
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

function buildTaskFile(
  prompt: string,
  sentinelRelPath: string,
  outputRelPath: string,
  workDir: string,
): string {
  return `Working directory: ${workDir}
All relative paths in this file are relative to that directory.

${prompt}

===== COMPLETION PROTOCOL =====
When you have FULLY completed ALL tasks above, perform these two steps IN ORDER:

STEP 1 — Write your findings/results to:
${outputRelPath}

Use this format:
\`\`\`
## Output
(Your findings, results, generated content, or analysis)
\`\`\`

STEP 2 — Write the completion sentinel to:
${sentinelRelPath}

The sentinel MUST use this exact format:

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
- If you hit an unrecoverable error, still complete both steps but use \`status: failed\` in the sentinel
- Write the output file (Step 1) BEFORE the sentinel (Step 2)
- Write the sentinel as your ABSOLUTE LAST action
- Do NOT write the sentinel until ALL other work is fully complete
- Use forward slashes in all file paths
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
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `Prompt too large: ${prompt.length.toLocaleString()} chars exceeds limit of ${MAX_PROMPT_CHARS.toLocaleString()}. ` +
          'Break the task into smaller pieces to ensure the completion protocol is not truncated.',
      );
    }

    const taskId = nanoid(10);
    const workDir = resolve(cwd || process.cwd());
    const syndicDir = join(workDir, SYNDIC_DIR);
    const sentinelFile = `${taskId}.md`;
    // Absolute paths used only by the orchestrator (fs operations, watcher).
    const promptFileAbsPath = join(syndicDir, `${taskId}.prompt`);
    const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

    // Relative paths are embedded in strings passed to the engine.
    // Using relative paths avoids cmd.exe metacharacter injection: if workDir
    // contains '&', '|', '<', '>' etc., an absolute path embedded in the boot
    // prompt arg could break cmd.exe parsing. Relative paths contain only the
    // safe characters produced by nanoid (A-Za-z0-9_-) and the known-safe
    // SYNDIC_DIR name.
    const sentinelRelPath = `${SYNDIC_DIR}/${sentinelFile}`;
    const outputRelPath = `${SYNDIC_DIR}/${taskId}.output.md`;
    const promptRelPath = `${SYNDIC_DIR}/${taskId}.prompt`;

    // Ensure .syndic directory exists
    await mkdir(syndicDir, { recursive: true });

    // Write full task (with completion protocol) to a prompt file.
    // The CLI receives a short boot prompt pointing at this file.
    // This avoids cmd.exe arg-length limits and escaping nightmares.
    const taskContent = buildTaskFile(prompt, sentinelRelPath, outputRelPath, workDir);
    await writeFile(promptFileAbsPath, taskContent, 'utf-8');

    const bootPrompt = [
      `Read and execute the task defined in: ${promptRelPath}`,
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
      outputContent: null,
      startedAt: Date.now(),
      completedAt: null,
      pid: null,
      error: null,
    };
    this.tasks.set(taskId, task);

    // --- spawn via cmd.exe /c  to handle .cmd shims on Windows ---
    const config = ENGINE_CONFIGS[engine];
    const promptArgs = config.promptFlag ? [config.promptFlag, bootPrompt] : [bootPrompt];
    const spawnArgs = ['/c', config.command, ...config.promptModeArgs, ...promptArgs];

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
    this.startSentinelWatch(taskId, syndicDir, sentinelFile);

    // --- process lifecycle ---
    proc.on('exit', (code) => {
      this.handleProcessExit(taskId, code, join(syndicDir, sentinelFile), syndicDir);
    });
    proc.on('error', (err) => {
      this.completeTask(taskId, 'failed', null, null, `Spawn error: ${err.message}`);
    });

    // --- timeout ---
    const timer = setTimeout(() => {
      if (task.status === 'running') {
        this.completeTask(taskId, 'timed_out', null, null, `Timed out after ${timeout}ms`);
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
    this.completeTask(taskId, 'cancelled', null, null, 'Cancelled by user');
    return true;
  }

  shutdown(): void {
    for (const [taskId, task] of this.tasks) {
      if (task.status === 'running') {
        this.completeTask(taskId, 'cancelled', null, null, 'Server shutting down');
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
          setTimeout(() => this.readSentinel(taskId, join(dir, filename), dir), 500);
        }
      });
      this.watchers.set(taskId, watcher);
    } catch {
      // Non-fatal — process exit handler is the fallback
    }
  }

  private async readOutputFile(syndicDir: string, taskId: string): Promise<string | null> {
    try {
      return await readFile(join(syndicDir, `${taskId}.output.md`), 'utf-8');
    } catch {
      return null;
    }
  }

  private async readSentinel(taskId: string, sentinelPath: string, syndicDir: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    try {
      const content = await readFile(sentinelPath, 'utf-8');
      const status: TaskStatus = content.includes('status: failed') ? 'failed' : 'completed';
      const output = await this.readOutputFile(syndicDir, taskId);
      this.completeTask(taskId, status, content, output, null);
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
    syndicDir: string,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    // Small delay for sentinel file to be flushed to disk
    await new Promise((r) => setTimeout(r, 500));

    // Try reading sentinel even if watcher missed it
    try {
      const content = await readFile(sentinelFilePath, 'utf-8');
      const status: TaskStatus = content.includes('status: failed') ? 'failed' : 'completed';
      const output = await this.readOutputFile(syndicDir, taskId);
      this.completeTask(taskId, status, content, output, null);
      return;
    } catch {
      // No sentinel file
    }

    // Fallback: use process exit code
    if (code === 0) {
      this.completeTask(taskId, 'completed', null, null, null);
    } else {
      this.completeTask(
        taskId,
        'failed',
        null,
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
    output: string | null,
    error: string | null,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    task.status = status;
    task.sentinelContent = sentinel;
    task.outputContent = output;
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
