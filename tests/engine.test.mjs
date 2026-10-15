import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('engine launch overrides and defaults', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-test-'));
  const launches = [];
  const launch = async (command, args, workdir, env) => {
    launches.push({ command: 'cmd.exe', args: ['/c', command, ...args], options: { cwd: workdir, env, windowsHide: true } });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    return { proc, receipt: async () => ({ pid: 123, termination: 'stopped', exit_code: 0 }),
      stop: () => { queueMicrotask(() => proc.emit('close', 0)); } };
  };
  const { EngineManager } = await import('../dist/engine.js');
  const manager = new EngineManager(launch);
  try {
    for (const yolo of [false, true]) {
      for (const engine of ['codex', 'opencode', 'gemini', 'claude']) {
        {
          await manager.run(engine, 'Inspect the task', cwd, undefined, false, yolo);
          const { args, options } = launches.at(-1);
          assert.equal(args.includes('--model'), false);
          assert.equal(args.includes('--variant'), false);
          assert.equal(args.includes('--effort'), false);
          assert.equal(args.some(arg => arg.startsWith('model_reasoning_effort=')), false);
          assert.equal(options.windowsHide, true);
          if (engine === 'opencode') {
            assert.deepEqual(args.slice(2, 6), ['run', '--auto', '--dir', cwd]);
          }
        }
        {
          const model = engine === 'claude' ? 'opus' : engine === 'opencode' ? 'openai/gpt-6-astra' : 'gpt-6-astra';
          const effort = engine === 'gemini' ? undefined : 'max';
          await manager.run(engine, 'Inspect the task', cwd, undefined, false, yolo, model, effort);
          const { command, args } = launches.at(-1);
          assert.equal(command, 'cmd.exe');
          assert.equal(args[args.indexOf('--model') + 1], model);
          if (engine === 'codex') {
            assert.equal(args[2], 'exec');
            assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort=max');
          }
          if (engine === 'opencode') assert.equal(args[args.indexOf('--variant') + 1], 'max');
          if (engine === 'claude') {
            assert.equal(args[1], 'claude');
            assert.equal(args[args.indexOf('--effort') + 1], 'max');
            assert.equal(args.at(-2), '-p');
          }
          assert.match(args.at(-1), /^Read and execute the task defined in:/);
        }
      }
    }
    {
      for (const engine of ['codex', 'opencode', 'claude']) {
        await manager.run(engine, 'Inspect the task', cwd, undefined, false, false, undefined, 'max');
        assert.equal(launches.at(-1).args.includes('--model'), false);
        assert.ok(launches.at(-1).args.includes(engine === 'codex' ? 'model_reasoning_effort=max' : engine === 'claude' ? '--effort' : '--variant'));
      }
    }
    {
      // "default" is how the tool documents omission. Forwarded as an
      // identifier it reaches the provider, which rejects it with a 400.
      for (const engine of ['codex', 'opencode', 'claude', 'gemini']) {
        const task = await manager.run(engine, 'Inspect the task', cwd, undefined, false, false, 'Default', 'DEFAULT');
        const { args } = launches.at(-1);
        assert.equal(args.includes('--model'), false);
        assert.equal(args.includes('--effort'), false);
        assert.equal(args.includes('--variant'), false);
        assert.equal(args.some(arg => arg.startsWith('model_reasoning_effort=')), false);
        assert.deepEqual(task.requested, { model: 'Default', reasoning_effort: 'DEFAULT' });
        assert.deepEqual(task.launch, { model: null, reasoning_effort: null, mode: 'default' });
      }
    }
    {
      // Codex refuses an untracked working directory; only a caller that says
      // it knows that disables the check.
      for (const yolo of [false, true]) {
        await manager.run('codex', 'Inspect the task', cwd, undefined, false, yolo, undefined, undefined, undefined, true);
        const { args } = launches.at(-1);
        assert.equal(args[2], 'exec');
        assert.ok(args.includes('--skip-git-repo-check'));
        assert.match(args.at(-1), /^Read and execute the task defined in:/);
      }
      await manager.run('codex', 'Inspect the task', cwd, undefined, false, false);
      assert.equal(launches.at(-1).args.includes('--skip-git-repo-check'), false);
      for (const engine of ['opencode', 'gemini', 'claude']) {
        await assert.rejects(
          manager.run(engine, 'Inspect the task', cwd, undefined, false, false, undefined, undefined, undefined, true),
          /skip_git_repo_check is not supported/);
      }
    }
    {
      const before = await readdir(join(cwd, '.syndic'));
      const count = launches.length;
      for (const invalid of ['', '-flag', 'a&whoami', '%PATH%', 'a b', 'a"b', 'a\nb']) {
        await assert.rejects(manager.run('codex', 'Inspect the task', cwd, undefined, false, false, invalid), /Invalid model/);
        await assert.rejects(manager.run('opencode', 'Inspect the task', cwd, undefined, false, false, undefined, invalid), /Invalid reasoning_effort/);
      }
      for (const engine of ['gemini']) {
        await assert.rejects(manager.run(engine, 'Inspect the task', cwd, undefined, false, false, undefined, 'max'), /not supported/);
      }
      assert.equal(launches.length, count);
      assert.deepEqual(await readdir(join(cwd, '.syndic')), before);
    }
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('codex records the launch banner outside review mode', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-banner-'));
  const { EngineManager } = await import('../dist/engine.js');
  const manager = new EngineManager(async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    setImmediate(() => {
      proc.stderr.emit('data', 'OpenAI Codex v0.153.4\n--------\nworkdir: ' + cwd +
        '\nmodel: gpt-6-astra\nprovider: openai\nreasoning effort: none\n--------\n');
      proc.emit('close', 0);
    });
    return { proc, receipt: async () => ({ pid: 7, termination: 'stopped', exit_code: 0 }), stop: () => {} };
  });
  // No model table in an empty CODEX_HOME, so this keeps testing the banner alone whatever this machine's Codex lists.
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = cwd;
  try {
    const task = await manager.run('codex', 'Inspect the task', cwd, 10000, true);
    assert.deepEqual(task.launch, { model: null, reasoning_effort: null, mode: 'default' });
    assert.deepEqual(task.observed,
      { model: 'gpt-6-astra', reasoning_effort: 'none', source: 'CLI launch banner' });
  } finally {
    if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome;
    await manager.shutdown(); await rm(cwd, { recursive: true, force: true });
  }
});

// A watcher that can only read files sees the model while the task runs, not after it ends.
const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    try { const value = await check(); if (value) return value; } catch { /* not there yet */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met within 2s');
};

test('claude in review mode writes observed.json when the init event arrives, before the task ends', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-live-'));
  const { EngineManager } = await import('../dist/engine.js');
  let proc;
  const manager = new EngineManager(async () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    let stopped = false;
    return { proc, receipt: async () => ({ pid: 5, termination: stopped ? 'stopped' : 'running', exit_code: stopped ? 1 : null }),
      stop: () => { stopped = true; queueMicrotask(() => proc.emit('close', 1)); } };
  });
  try {
    const task = await manager.run('claude', 'Review the supplied evidence', cwd, 10000, false,
      false, undefined, undefined, { inputs: [] });
    const file = join(cwd, '.syndic', `${task.id}.observed.json`);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    proc.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-live-1' }) + '\n');
    const written = await until(() => readFile(file, 'utf8'));
    assert.deepEqual(JSON.parse(written), { model: 'claude-live-1', reasoning_effort: null, source: 'CLI system.init event' });
    assert.equal(task.status, 'running');
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('codex rewrites observed.json when the effort line arrives after the model line', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-live-'));
  const { EngineManager } = await import('../dist/engine.js');
  let proc;
  const manager = new EngineManager(async () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    let stopped = false;
    return { proc, receipt: async () => ({ pid: 6, termination: stopped ? 'stopped' : 'running', exit_code: stopped ? 1 : null }),
      stop: () => { stopped = true; queueMicrotask(() => proc.emit('close', 1)); } };
  });
  try {
    const task = await manager.run('codex', 'Inspect the task', cwd, 10000, false);
    const file = join(cwd, '.syndic', `${task.id}.observed.json`);
    proc.stderr.emit('data', 'model: gpt-live-1\n');
    assert.deepEqual(JSON.parse(await until(() => readFile(file, 'utf8'))),
      { model: 'gpt-live-1', reasoning_effort: null, source: 'CLI launch banner' });
    proc.stderr.emit('data', 'reasoning effort: high\n');
    const both = await until(async () => {
      const value = JSON.parse(await readFile(file, 'utf8'));
      return value.reasoning_effort === 'high' ? value : null;
    });
    assert.deepEqual(both, { model: 'gpt-live-1', reasoning_effort: 'high', source: 'CLI launch banner' });
    assert.equal(task.status, 'running');
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('a call_tag also keys observed.json, so a wait=true caller can read it before the task id exists', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-live-'));
  const { EngineManager } = await import('../dist/engine.js');
  let proc;
  const manager = new EngineManager(async () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    let stopped = false;
    return { proc, receipt: async () => ({ pid: 8, termination: stopped ? 'stopped' : 'running', exit_code: stopped ? 1 : null }),
      stop: () => { stopped = true; queueMicrotask(() => proc.emit('close', 1)); } };
  });
  try {
    for (const tag of ['', 'a b', 'a/b', '..', 'x'.repeat(65)]) {
      await assert.rejects(manager.run('codex', 'Inspect the task', cwd, 10000, false, false, undefined, undefined,
        undefined, undefined, tag), /Invalid call_tag/);
    }
    const task = await manager.run('codex', 'Inspect the task', cwd, 10000, false, false, undefined, undefined,
      undefined, undefined, 'toolu_01-abc');
    const tagged = join(cwd, '.syndic', 'toolu_01-abc.observed.json');
    proc.stderr.emit('data', 'model: gpt-live-2\nreasoning effort: low\n');
    const seen = await until(async () => {
      const value = JSON.parse(await readFile(tagged, 'utf8'));
      return value.reasoning_effort === 'low' ? value : null;
    });
    const observed = { model: 'gpt-live-2', reasoning_effort: 'low', source: 'CLI launch banner' };
    // The tagged copy also names the task, so a wait=true caller whose call was moved to the background can follow its receipt.
    assert.deepEqual(seen, { ...observed, task_id: task.id });
    assert.deepEqual(JSON.parse(await readFile(join(cwd, '.syndic', `${task.id}.observed.json`), 'utf8')), observed);
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('codex banner "none" with no effort requested becomes the model table default, and only then', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-default-'));
  const { EngineManager } = await import('../dist/engine.js');
  const home = join(cwd, 'home');
  const table = join(home, 'models_cache.json');
  await mkdir(home);
  await writeFile(table, JSON.stringify({ models: [
    { slug: 'gpt-table-1', default_reasoning_level: 'low' },
    { slug: 'gpt-table-2', default_reasoning_level: 'medium' },
    { slug: 'gpt-no-default' },
  ] }), 'utf8');
  const observe = async (model, effort) => {
    const manager = new EngineManager(async () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stderr.emit('data', `model: ${model}\nreasoning effort: none\n`);
        proc.emit('close', 0);
      });
      return { proc, receipt: async () => ({ pid: 9, termination: 'stopped', exit_code: 0 }), stop: () => {} };
    });
    try {
      return (await manager.run('codex', 'Inspect the task', cwd, 10000, true, false, undefined, effort)).observed;
    } finally { await manager.shutdown(); }
  };
  const touch = async seconds => {
    const when = new Date(Date.now() + seconds * 1000);
    await utimes(table, when, when);
  };
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const source = 'CLI launch banner, effort from the Codex model table default';
    assert.deepEqual(await observe('gpt-table-1'), { model: 'gpt-table-1', reasoning_effort: 'low', source });
    assert.deepEqual(await observe('gpt-table-2'), { model: 'gpt-table-2', reasoning_effort: 'medium', source });
    assert.deepEqual(await observe('gpt-table-2', 'default'), { model: 'gpt-table-2', reasoning_effort: 'medium', source });
    // An effort the caller set is the banner's own, and a model the table lacks keeps the banner value.
    assert.deepEqual(await observe('gpt-table-1', 'none'), { model: 'gpt-table-1', reasoning_effort: 'none', source: 'CLI launch banner' });
    assert.deepEqual(await observe('gpt-unlisted'), { model: 'gpt-unlisted', reasoning_effort: 'none', source: 'CLI launch banner' });
    assert.deepEqual(await observe('gpt-no-default'), { model: 'gpt-no-default', reasoning_effort: 'none', source: 'CLI launch banner' });
    // A table that changes is read again, and an unreadable one leaves the banner value.
    await writeFile(table, JSON.stringify({ models: [{ slug: 'gpt-table-1', default_reasoning_level: 'high' }] }), 'utf8');
    await touch(5);
    assert.equal((await observe('gpt-table-1')).reasoning_effort, 'high');
    await writeFile(table, '{ not json', 'utf8');
    await touch(10);
    assert.equal((await observe('gpt-table-1')).reasoning_effort, 'none');
  } finally {
    if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome;
    await rm(cwd, { recursive: true, force: true });
  }
});
