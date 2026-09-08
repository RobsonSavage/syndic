import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { launchProcess, type ManagedProcess } from './process.js';
import { parseSentinel } from './sentinel.js';
import { prepareReview, LiteralToolInvocationError, type ReviewOptions, type ReviewLaunch } from './review.js';
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
  private processes = new Map<string, ManagedProcess>();
  private closed = new Map<string, Promise<void>>();
  private finishing = new Map<string, Promise<void>>();
  private reviews = new Map<string, ReviewLaunch>();
  private streams = new Map<string, { stdout: string; stderr: string }>();
  private reviewRetries = new Map<string, () => Promise<void>>();
  private retrying = new Map<string, Promise<void>>();
  private watchers = new Map<string, FSWatcher>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private waitResolvers = new Map<string, (task: Task) => void>();

  constructor(private launchProcessImpl = launchProcess) { }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async run(
    engine: EngineType,
    prompt: string,
    cwd?: string,
    timeoutMs?: number,
    wait?: boolean,
    yolo?: boolean,
    model?: string,
    reasoningEffort?: string,
    review?: ReviewOptions,
  ): Promise<Task> {
    if (review && (yolo || (engine !== 'claude' && engine !== 'codex'))) {
      throw new Error('Review mode requires Claude or Codex and yolo=false');
    }
    // These values cross cmd.exe: accept identifiers, never shell syntax.
    for (const [name, value] of [['model', model], ['reasoning_effort', reasoningEffort]]) {
      if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
        throw new Error(`Invalid ${name}: expected a non-empty model or effort identifier.`);
      }
    }
    if (reasoningEffort !== undefined && engine === 'gemini') {
      throw new Error(`reasoning_effort is not supported for ${engine}.`);
    }
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

    const reviewer = review ? await prepareReview(engine, workDir, prompt, review) : undefined;
    if (reviewer) this.reviews.set(taskId, reviewer);

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
      termination: 'running',
      terminationError: null,
      requested: { model: model ?? null, reasoning_effort: reasoningEffort ?? null },
      launch: { model: model ?? null, reasoning_effort: reasoningEffort ?? null, mode: reviewer ? 'review' : yolo ? 'unrestricted' : 'default' },
      observed: { model: null, reasoning_effort: null, source: null },
    };
    this.tasks.set(taskId, task);

    // --- launch through the Windows process-job supervisor ---
    const config = ENGINE_CONFIGS[engine];
    const baseModeArgs = yolo ? config.yoloArgs : config.safeArgs;
    // Opencode ignores the inherited OS cwd on Windows and needs --dir set
    // explicitly; otherwise write tools resolve to the wrong directory and
    // the sentinel/output files never appear. --dir is a `run` subcommand
    // flag, so it must be injected after 'run' — we splice it directly into
    // modeArgs for opencode.
    const modeArgs =
      engine === 'opencode' ? [...baseModeArgs, '--dir', workDir] : baseModeArgs;
    const promptArgs = config.promptFlag ? [config.promptFlag, bootPrompt] : [bootPrompt];
    const modelArgs = model !== undefined ? ['--model', model] : [];
    const effortArgs = reasoningEffort === undefined ? [] : engine === 'codex'
      ? ['-c', `model_reasoning_effort=${reasoningEffort}`]
      : [engine === 'claude' ? '--effort' : '--variant', reasoningEffort];
    const spawnArgs = reviewer ? [...reviewer.args.slice(0, -1), ...modelArgs, ...effortArgs, reviewer.args.at(-1)!]
      : [...modeArgs, ...modelArgs, ...effortArgs, ...promptArgs];

    process.stderr.write(
      `[INFO] Starting ${engine} task ${taskId}; model=${modelArgs.length ? model : 'CLI default'}; ` +
      `reasoning_effort=${reasoningEffort ?? 'CLI default'}\n`,
    );

    let managed: ManagedProcess;
    try {
      managed = await this.launchProcessImpl(config.command, spawnArgs, reviewer?.cwd ?? workDir, reviewer?.env ?? {
        ...process.env,
        // Prevent MSYS2 from mangling paths passed as arguments
        MSYS2_ARG_CONV_EXCL: '*',
        ...config.env,
      }, join(syndicDir, `${taskId}.launch.json`));
    } catch (error) {
      await reviewer?.cleanup();
      this.reviews.delete(taskId);
      this.tasks.delete(taskId);
      throw error;
    }
    this.attachProcess(task, managed, syndicDir);
    if (reviewer) {
      this.reviewRetries.set(taskId, async () => {
        await reviewer.reset();
        if (task.status !== 'running') return;
        const retryArgs = [...spawnArgs.slice(0, -1), spawnArgs.at(-1) +
          '. The previous attempt returned literal tool invocation text and did not complete. ' +
          'Use native tool calls to invoke the available tools and wait for their results. ' +
          'Do not print XML or JSON as a substitute for invoking a tool. Complete the review and return the report.'];
        const retry = await this.launchProcessImpl(config.command, retryArgs, reviewer.cwd, reviewer.env,
          join(syndicDir, `${taskId}.retry.launch.json`));
        // Register even if cancellation arrived during launch. The finisher waits
        // for this operation, then stops the newly registered process job.
        task.observed = { model: null, reasoning_effort: null, source: null };
        this.attachProcess(task, retry, syndicDir);
      });
    }

    // --- watch for sentinel file ---
    if (!reviewer) this.startSentinelWatch(taskId, syndicDir, sentinelFile);

    // One timeout covers both attempts.
    const timer = setTimeout(() => {
      if (task.status === 'running') {
        void this.completeTask(taskId, 'timed_out', null, null, `Timed out after ${timeout}ms`);
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

  private attachProcess(task: Task, managed: ManagedProcess, syndicDir: string): void {
    const taskId = task.id;
    const proc = managed.proc;
    proc.stdout?.setEncoding?.('utf8');
    proc.stderr?.setEncoding?.('utf8');
    this.processes.set(taskId, managed);
    const streams = { stdout: '', stderr: '' };
    this.streams.set(taskId, streams);

    // --- collect stdout / stderr ---
    proc.stdout?.on('data', (chunk: Buffer) => {
      task.stdout += chunk.toString();
      streams.stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      task.stdout += chunk.toString();
      streams.stderr += chunk.toString();
    });

    // --- process lifecycle ---
    this.closed.set(taskId, new Promise<void>(resolveClosed => {
      proc.once('close', () => {
        resolveClosed();
        void managed.receipt().then(receipt => {
          if (this.processes.get(taskId) !== managed) return;
          task.pid = receipt?.pid ?? null;
          if (task.status === 'running') {
            void this.handleProcessExit(taskId, receipt?.exit_code ?? null, join(syndicDir, `${taskId}.md`), syndicDir);
          }
        });
      });
    }));
    proc.on('error', (err) => {
      if (this.processes.get(taskId) === managed) {
        void this.completeTask(taskId, 'failed', null, null, `Spawn error: ${err.message}`);
      }
    });
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  async inspectTask(taskId: string): Promise<Task | undefined> {
    const task = this.tasks.get(taskId);
    const receipt = await this.processes.get(taskId)?.receipt();
    if (task && receipt) task.pid = receipt.pid;
    return task;
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.termination === 'stopped') return false;
    await this.completeTask(taskId, 'cancelled', null, null, 'Cancelled by user');
    return true;
  }

  async shutdown(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [taskId, task] of this.tasks) {
      if (task.termination !== 'stopped') {
        pending.push(this.completeTask(taskId, 'cancelled', null, null, 'Server shutting down'));
      }
    }
    await Promise.all(pending);
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
      const status = parseSentinel(content);
      if (!status) return;
      const output = await this.readOutputFile(syndicDir, taskId);
      if (output === null) return;
      await this.completeTask(taskId, status, content, output, null);
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

    const reviewer = this.reviews.get(taskId);
    if (reviewer) {
      const streams = this.streams.get(taskId)!;
      reviewer.observe(task, streams.stdout, streams.stderr);
      try {
        if (code !== 0) throw new Error(`Review CLI exited with code ${code}`);
        const output = await reviewer.result();
        if (task.status !== 'running') return;
        const sentinel = '---\nstatus: completed\n---\n\n## Summary\nReview report captured by syndic.\n';
        await writeFile(join(syndicDir, `${taskId}.output.md`), output, 'utf8');
        await writeFile(sentinelFilePath, sentinel, 'utf8');
        await this.completeTask(taskId, 'completed', sentinel, output, null);
      } catch (error) {
        if (task.status !== 'running') return;
        if (error instanceof LiteralToolInvocationError) {
          try {
            const retry = this.reviewRetries.get(taskId);
            await writeFile(join(syndicDir, `${taskId}.attempt-${retry ? 1 : 2}.invalid-output.md`), error.output, 'utf8');
            const receipt = await this.processes.get(taskId)?.receipt();
            if (task.status !== 'running') return;
            if (retry && receipt?.termination === 'stopped') {
              this.reviewRetries.delete(taskId);
              const warning = `[WARN] Review task ${taskId} returned literal tool invocations; retrying once with native tool instructions.\n`;
              process.stderr.write(warning);
              task.stdout += warning;
              const pending = retry();
              this.retrying.set(taskId, pending);
              try { await pending; } finally { this.retrying.delete(taskId); }
              return;
            }
          } catch (retryError) {
            error = retryError;
          }
        }
        if (task.status !== 'running') return;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[ERROR] Review task ${taskId}: ${message}\n`);
        await this.completeTask(taskId, 'failed', null, null, message);
      }
      return;
    }

    // Small delay for sentinel file to be flushed to disk
    await new Promise((r) => setTimeout(r, 500));

    // Try reading sentinel even if watcher missed it
    try {
      const content = await readFile(sentinelFilePath, 'utf-8');
      const status = parseSentinel(content);
      const output = await this.readOutputFile(syndicDir, taskId);
      await this.completeTask(taskId, status && output !== null ? status : 'failed', content, output,
        !status ? 'Invalid or incomplete sentinel frontmatter' : output === null ? 'Missing output artifact' : null);
      return;
    } catch {
      // No sentinel file
    }

    // A clean CLI exit does not establish completion of the requested task.
    await this.completeTask(taskId, 'failed', null, await this.readOutputFile(syndicDir, taskId),
      `Process exited with code ${code} without a readable completion sentinel. ` +
      'For Claude/Codex critiques or consultations that prohibit file writes, use mode=review; syndic captures the final response.');
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
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.termination === 'stopped') return Promise.resolve();
    const current = this.finishing.get(taskId);
    if (current) return current;
    const finish = this.finishTask(task, status, sentinel, output, error);
    this.finishing.set(taskId, finish);
    void finish.finally(() => this.finishing.delete(taskId));
    return finish;
  }

  private async finishTask(task: Task, status: TaskStatus, sentinel: string | null,
    output: string | null, error: string | null): Promise<void> {
    const taskId = task.id;
    task.status = 'stopping';
    task.termination = 'stopping';
    process.stderr.write(`[INFO] Stopping task ${taskId}; outcome=${status}\n`);
    this.cleanup(taskId);
    // Cancellation can arrive while the replacement process is being launched.
    // Wait until it is registered so this stop cannot leave it running.
    try { await this.retrying.get(taskId); } catch { /* launch failure is handled by the caller */ }
    this.reviewRetries.delete(taskId);
    const managed = this.processes.get(taskId);
    managed?.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.closed.get(taskId) ?? Promise.resolve(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 15_000); })]);
    if (timer) clearTimeout(timer);
    const receipt = await managed?.receipt();
    const streams = this.streams.get(taskId);
    if (streams) this.reviews.get(taskId)?.observe(task, streams.stdout, streams.stderr);
    task.pid = receipt?.pid ?? null;
    task.termination = receipt?.termination === 'stopped' ? 'stopped' : 'unknown';
    task.terminationError = task.termination === 'stopped' ? null : 'Supervisor did not confirm an empty process job';
    task.status = task.termination === 'stopped' ? status : 'failed';
    task.sentinelContent = sentinel;
    task.outputContent = output;
    task.error = error;
    task.completedAt = Date.now();
    task.stdout = stripAnsi(task.stdout);

    if (task.termination === 'stopped') {
      this.processes.delete(taskId);
      this.closed.delete(taskId);
      try { await this.reviews.get(taskId)?.cleanup(); }
      catch (cleanupError) {
        task.error = [task.error, `Review artifact cleanup failed: ${String(cleanupError)}`].filter(Boolean).join('; ');
        process.stderr.write(`[WARN] ${task.error}\n`);
      }
      this.reviews.delete(taskId);
      this.streams.delete(taskId);
    }
    process.stderr.write(`[${task.terminationError ? 'ERROR' : 'INFO'}] Task ${taskId}: ${task.status}; termination=${task.termination}\n`);

    const resolver = this.waitResolvers.get(taskId);
    if (resolver) {
      resolver(task);
      this.waitResolvers.delete(taskId);
    }
  }

  private cleanup(taskId: string): void {
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
