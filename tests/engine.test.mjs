import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
