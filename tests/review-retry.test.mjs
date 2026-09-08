import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { EngineManager } from '../dist/engine.js';

const malformed = '<invoke name="mcp__syndic_review__review_status"></invoke>';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Lifecycle condition did not settle within 2500ms');
    await nextTurn();
  }
}

async function fixture(engine, onLaunch = async () => {}) {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-retry-'));
  const attempts = [];
  const manager = new EngineManager(async (_command, _args, workdir) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    const attempt = {
      proc, workdir, pid: attempts.length + 1,
      termination: 'running', exitCode: 0, closed: false, stops: 0,
      close(termination = 'stopped', exitCode = 0) {
        this.termination = termination;
        this.exitCode = exitCode;
        if (!this.closed) {
          this.closed = true;
          proc.emit('close', exitCode);
        }
      },
    };
    attempts.push(attempt);
    await onLaunch(attempt, attempts.length);
    return { proc,
      receipt: async () => ({ pid: attempt.pid, termination: attempt.termination, exit_code: attempt.exitCode }),
      stop: () => {
        attempt.stops++;
        if (!attempt.closed) queueMicrotask(() => attempt.close());
      },
    };
  });
  return {
    cwd, attempts, manager,
    run: (timeout = 10000) => manager.run(engine, 'Analyze the supplied evidence', cwd,
      timeout, false, false, undefined, undefined, { inputs: [] }),
    async output(attempt, value) {
      if (engine === 'claude') {
        attempt.proc.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: value }) + '\n');
      } else {
        await writeFile(join(attempt.workdir, 'response.md'), value);
      }
    },
    async cleanup() {
      for (const attempt of attempts) attempt.close();
      await manager.shutdown();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

for (const engine of ['claude', 'codex']) {
  for (const failure of ['empty report', 'nonzero exit']) {
    test(`${engine} ${failure} does not trigger a tool-format retry`, { timeout: 5000 }, async () => {
      const context = await fixture(engine);
      try {
        const task = await context.run();
        await context.output(context.attempts[0], failure === 'empty report' ? '' : malformed);
        context.attempts[0].close('stopped', failure === 'nonzero exit' ? 7 : 0);
        await until(() => task.status === 'failed');
        assert.equal(context.attempts.length, 1);
        assert.equal(task.termination, 'stopped');
        assert.match(task.error, failure === 'empty report' ? /did not return a review report/i : /code 7/);
        assert.equal(task.outputContent, null);
        assert.equal(task.sentinelContent, null);
      } finally { await context.cleanup(); }
    });
  }

  test(`${engine} cannot retry without confirmed prior job termination`, { timeout: 5000 }, async () => {
    const context = await fixture(engine);
    try {
      const task = await context.run();
      await context.output(context.attempts[0], malformed);
      context.attempts[0].close('running');
      await until(() => task.status === 'failed');
      assert.equal(context.attempts.length, 1);
      assert.equal(task.termination, 'unknown');
      assert.match(task.terminationError, /did not confirm an empty process job/i);
      assert.match(task.error, /literal tool invocation/i);
      assert.equal(context.attempts[0].stops, 1);
      assert.equal(task.sentinelContent, null);
    } finally { await context.cleanup(); }
  });

  test(`${engine} an empty retry cannot reuse the first response`, { timeout: 5000 }, async () => {
    const context = await fixture(engine);
    try {
      const task = await context.run();
      await context.output(context.attempts[0], malformed);
      context.attempts[0].close();
      await until(() => context.attempts[1]?.proc.listenerCount('close') > 0);
      // No response event or response file is produced by the replacement.
      context.attempts[1].close();
      await until(() => task.status === 'failed');
      assert.equal(context.attempts.length, 2);
      assert.equal(task.termination, 'stopped');
      assert.doesNotMatch(task.error, /literal tool invocation/i);
      assert.match(task.error, engine === 'claude' ? /did not return a review report/i : /ENOENT/);
      assert.equal(task.outputContent, null);
      assert.equal(task.sentinelContent, null);
      assert.equal(await readFile(join(context.cwd, '.syndic', `${task.id}.attempt-1.invalid-output.md`), 'utf8'), malformed);
      await assert.rejects(readFile(join(context.cwd, '.syndic', `${task.id}.md`)), { code: 'ENOENT' });
    } finally { await context.cleanup(); }
  });
}

for (const action of ['cancel', 'shutdown']) {
  test(`${action} during a pending retry launch stops the replacement`, { timeout: 5000 }, async () => {
    const release = deferred();
    const context = await fixture('claude', async (_attempt, number) => {
      if (number === 2) await release.promise;
    });
    try {
      const task = await context.run();
      await context.output(context.attempts[0], malformed);
      context.attempts[0].close();
      await until(() => context.attempts.length === 2);
      let finished = false;
      const stopping = (action === 'cancel' ? context.manager.cancel(task.id) : context.manager.shutdown())
        .then(() => { finished = true; });
      await nextTurn();
      assert.equal(task.status, 'stopping');
      assert.equal(finished, false);
      assert.equal(context.attempts[1].stops, 0);
      release.resolve();
      await stopping;
      assert.equal(context.attempts.length, 2);
      assert.equal(context.attempts[1].stops, 1);
      assert.equal(context.attempts[1].closed, true);
      assert.equal(task.status, 'cancelled');
      assert.equal(task.termination, 'stopped');
      assert.equal(task.pid, context.attempts[1].pid);
      assert.equal(task.sentinelContent, null);
    } finally { release.resolve(); await context.cleanup(); }
  });
}

test('retry retains the original timeout budget', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = await fixture('codex');
  try {
    const task = await context.run(1000);
    const startedAt = task.startedAt;
    t.mock.timers.tick(600);
    await context.output(context.attempts[0], malformed);
    context.attempts[0].close();
    await until(() => context.attempts[1]?.proc.listenerCount('close') > 0);
    t.mock.timers.tick(399);
    assert.equal(task.status, 'running');
    assert.equal(context.attempts[1].stops, 0);
    t.mock.timers.tick(1);
    await until(() => task.status === 'timed_out');
    assert.equal(context.attempts.length, 2);
    assert.equal(context.attempts[1].stops, 1);
    assert.equal(task.startedAt, startedAt);
    assert.equal(task.termination, 'stopped');
    assert.match(task.error, /Timed out after 1000ms/);
    assert.equal(task.sentinelContent, null);
  } finally { await context.cleanup(); }
});

test('timeout during a pending retry launch stops the replacement', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const release = deferred();
  const context = await fixture('codex', async (_attempt, number) => {
    if (number === 2) await release.promise;
  });
  try {
    const task = await context.run(1000);
    await context.output(context.attempts[0], malformed);
    context.attempts[0].close();
    await until(() => context.attempts.length === 2);
    t.mock.timers.tick(1000);
    await nextTurn();
    assert.equal(task.status, 'stopping');
    assert.equal(context.attempts[1].stops, 0);
    release.resolve();
    await until(() => task.status === 'timed_out');
    assert.equal(context.attempts.length, 2);
    assert.equal(context.attempts[1].stops, 1);
    assert.equal(context.attempts[1].closed, true);
    assert.equal(task.termination, 'stopped');
    assert.equal(task.pid, context.attempts[1].pid);
    assert.equal(task.sentinelContent, null);
  } finally { release.resolve(); await context.cleanup(); }
});
