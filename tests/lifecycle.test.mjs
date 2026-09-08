import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { EngineManager } from '../dist/engine.js';

for (const engine of ['claude', 'codex']) {
  for (const recovers of [true, false]) test(`${engine} retries literal tool invocations once (${recovers ? 'recovers' : 'fails'})`, async () => {
    const cwd = await mkdtemp(join(process.cwd(), '.syndic-outcome-'));
    const attempts = [];
    const report = '## Findings\nThe supplied evidence has been analyzed.';
    const manager = new EngineManager(async (command, args, workdir, env, launchFile) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      attempts.push({ command, args, workdir, env, launchFile });
      const attempt = attempts.length;
      setImmediate(async () => {
        // Replay UgjzjeyGhm's output, with its machine-specific path replaced.
        const output = attempt === 2 && recovers ? report :
          (recovers ? 'court\n' : '\n') + '<invoke name="mcp__syndic_review__review_status">\n</invoke>\n' +
          '<invoke name="mcp__syndic_review__read_file">\n' +
          `<parameter name="path">${join(workdir, 'task.prompt')}</parameter>\n</invoke>`;
        if (attempt === 2 && recovers) {
          // The fake process models broker reads as well as the CLI report.
          const access = JSON.parse(await readFile(join(workdir, 'access.json'), 'utf8'));
          const promptPath = await realpath(join(workdir, 'task.prompt'));
          const lines = (await readFile(promptPath, 'utf8')).split(/\r?\n/).length;
          await writeFile(access.audit_path, [
            { attempt: access.attempt, tool: 'review_status', success: true },
            { attempt: access.attempt, tool: 'read_file', success: true,
              resolved_path: promptPath, offset: 1, count: lines, total_lines: lines },
          ].map(value => JSON.stringify(value)).join('\n') + '\n');
        }
        if (engine === 'claude') {
          proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: output }) + '\n');
        } else {
          await writeFile(join(workdir, 'response.md'), output);
        }
        proc.stderr.emit('data', `attempt ${attempt} diagnostics\n`);
        proc.emit('close', 0);
      });
      return { proc,
        receipt: async () => ({ pid: attempt, termination: 'stopped', exit_code: 0 }),
        stop: () => {},
      };
    });
    try {
      const task = await manager.run(engine, 'Analyze the supplied evidence', cwd, 10000, true,
        false, undefined, 'medium', { inputs: [] });
      assert.equal(attempts.length, 2);
      assert.equal(task.status, recovers ? 'completed' : 'failed');
      assert.equal(task.termination, 'stopped');
      assert.equal(task.pid, 2);
      assert.equal(manager.getTask(task.id), task);
      assert.deepEqual(attempts[1].args.slice(0, -1), attempts[0].args.slice(0, -1));
      assert.match(attempts[1].args.at(-1), /native tool/i);
      assert.equal(attempts[1].workdir, attempts[0].workdir);
      assert.deepEqual(attempts[1].env, attempts[0].env);
      assert.notEqual(attempts[1].launchFile, attempts[0].launchFile);
      assert.match(task.stdout, /attempt 1 diagnostics/);
      assert.match(task.stdout, /attempt 2 diagnostics/);
      assert.equal((await readdir(join(cwd, '.syndic'))).filter(name => name.endsWith('.prompt')).length, 1);
      if (recovers) {
        assert.equal(task.error, null);
        assert.equal(task.outputContent, report);
        assert.match(await readFile(join(cwd, '.syndic', `${task.id}.md`), 'utf8'), /status: completed/);
      } else {
        assert.match(task.error, /literal tool invocation/i);
        assert.equal(task.outputContent, null);
        assert.equal(task.sentinelContent, null);
        await assert.rejects(readFile(join(cwd, '.syndic', `${task.id}.md`)), { code: 'ENOENT' });
      }
    } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
  });
}

test('cancel waits for exit evidence, unknown termination stays retryable', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-lifecycle-'));
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  let stopped = false;
  let stops = 0;
  const manager = new EngineManager(async () => ({ proc,
    receipt: async () => ({ pid: 321, termination: stopped ? 'stopped' : 'running', exit_code: null }),
    stop: () => { stops++; },
  }));
  try {
    const task = await manager.run('claude', 'Review the task', cwd);
    let returned = false;
    const cancelled = manager.cancel(task.id).then(result => { returned = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(returned, false);
    assert.equal(task.status, 'stopping');
    proc.emit('close', 1);
    await cancelled;
    assert.equal(task.status, 'failed');
    assert.equal(task.termination, 'unknown');
    assert.ok(task.terminationError);
    stopped = true;
    assert.equal(await manager.cancel(task.id), true);
    assert.equal(task.termination, 'stopped');
    assert.equal(stops, 2);
    assert.equal(await manager.cancel(task.id), false);
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('timeout and successful sentinel completion both stop the process job', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-outcome-'));
  const manager = new EngineManager(async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    return { proc, receipt: async () => ({ pid: 123, termination: 'stopped', exit_code: 0 }),
      stop: () => { queueMicrotask(() => proc.emit('close', 0)); } };
  });
  try {
    const timeout = await manager.run('claude', 'Review the task', cwd, 20, true);
    assert.equal(timeout.status, 'timed_out');
    assert.equal(timeout.termination, 'stopped');
    const task = await manager.run('claude', 'Review the task', cwd);
    const dir = join(cwd, '.syndic');
    const sentinel = join(dir, `${task.id}.md`);
    await writeFile(join(dir, `${task.id}.output.md`), 'Review result');
    await writeFile(sentinel, '---\nstatus: completed\n---\nReview status: failed');
    await manager.readSentinel(task.id, sentinel, dir);
    assert.equal(task.status, 'completed');
    assert.equal(task.termination, 'stopped');
    assert.equal(task.outputContent, 'Review result');
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('zero exit without completion artifacts fails and retains response diagnostics', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-outcome-'));
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  const manager = new EngineManager(async () => ({ proc,
    receipt: async () => ({ pid: 123, termination: 'stopped', exit_code: 0 }),
    stop: () => {},
  }));
  try {
    const completion = manager.run('claude', 'Review without writing any files', cwd, 10000, true);
    while (proc.listenerCount('close') === 0) await new Promise(resolve => setTimeout(resolve, 5));
    proc.stdout.emit('data', Buffer.from('File writes denied; findings returned as response text.'));
    proc.emit('close', 0);
    const task = await completion;
    assert.equal(task.status, 'failed');
    assert.equal(task.termination, 'stopped');
    assert.match(task.error, /completion sentinel/i);
    assert.match(task.error, /mode=review/);
    assert.match(task.stdout, /File writes denied/);
    assert.equal(task.outputContent, null);
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});
