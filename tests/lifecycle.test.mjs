import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { EngineManager } from '../dist/engine.js';

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
