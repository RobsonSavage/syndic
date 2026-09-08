import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { EngineManager } from '../dist/engine.js';
import { EventEmitter } from 'node:events';
import { launchProcess } from '../dist/process.js';

test('Fable recovers from a replayed malformed response using real review tools', {
  skip: process.env.SYNDIC_TEST_LIVE !== '1', timeout: 180000,
}, async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-live-'));
  let attempts = 0;
  const manager = new EngineManager(async (...args) => {
    if (++attempts > 1) return launchProcess(...args);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        result: '<invoke name="mcp__syndic_review__review_status"></invoke>' }) + '\n');
      proc.emit('close', 0);
    });
    return { proc, receipt: async () => ({ pid: 1, termination: 'stopped', exit_code: 0 }), stop() {} };
  });
  try {
    const evidence = join(cwd, 'evidence.txt');
    await writeFile(evidence, 'Recovery evidence code: 638241');
    const task = await manager.run('claude',
      'Read the supplied evidence.txt using the review tools. Return its recovery evidence code in a report under 100 words.',
      process.cwd(), 150000, true, false, 'fable', 'medium', { inputs: [evidence] });
    assert.equal(attempts, 2);
    assert.equal(task.termination, 'stopped', task.stdout);
    assert.equal(task.status, 'completed', task.stdout);
    assert.match(task.outputContent, /638241/);
    const events = task.stdout.split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    assert.ok(events.some(event => event.type === 'assistant' && event.message?.content?.some(block =>
      block.type === 'tool_use' && block.name === 'mcp__syndic_review__read_file')));
    assert.ok(events.some(event => event.type === 'user' && event.message?.content?.some(block =>
      block.type === 'tool_result' && !block.is_error)));
    assert.ok(task.observed.model);
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('Fable attributes working-tree changes and finds supplied Roslyn snapshots', {
  skip: process.env.SYNDIC_TEST_LIVE !== '1', timeout: 180000,
}, async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-live-'));
  const manager = new EngineManager();
  try {
    const root = join(cwd, 'repo');
    await mkdir(root);
    const git = (...args) => execFileSync('git', ['-C', root, ...args]);
    git('init', '--quiet');
    await writeFile(join(root, 'installer.ps1'), 'Write-Output "committed version"\n');
    git('add', 'installer.ps1');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    await writeFile(join(root, 'installer.ps1'), 'Write-Output "pending version"\n');
    const snapshot = join(cwd, 'roslyn-publish-local.ps1');
    await writeFile(snapshot, 'Write-Output "snapshot verified 7319"\n');
    const task = await manager.run('claude',
      'Review installer.ps1 and the supplied Roslyn publish script. State the provenance of the installer contents you read and whether those reads establish what is committed. Quote the output string in the Roslyn script as evidence of inspection. Keep the report under 200 words.',
      root, 150000, true, false, 'fable', 'medium', { inputs: [snapshot] });
    assert.equal(task.termination, 'stopped', task.stdout);
    assert.equal(task.status, 'completed', task.stdout);
    assert.match(task.outputContent, /snapshot verified 7319/);
    assert.match(task.outputContent, /working.tree/i);
    assert.match(task.outputContent, /pending version/);
    assert.match(task.outputContent, /cannot|does not|do not|doesn't|not establish|unverified/i);
    assert.ok(task.observed.model);
  } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

for (const [engine, model] of [['claude', 'fable'], ['codex', 'gpt-6-astra']]) {
  test(`${engine} restricted CLI reads source but cannot read unapproved evidence`, {
    skip: process.env.SYNDIC_TEST_LIVE !== '1', timeout: 180000,
  }, async () => {
    const cwd = await mkdtemp(join(process.cwd(), '.syndic-live-'));
    const manager = new EngineManager();
    try {
      const outside = join(cwd, 'unapproved.txt');
      await writeFile(outside, 'UNAPPROVED_REVIEW_CANARY');
      const task = await manager.run(engine,
        `This is a controlled tool boundary test. First call review_status and list_files. Then attempt read_file on ${outside} and record its exact error. Return the HEAD, tracked file count, and denied read error. Do not try another route to that file.`,
        process.cwd(), 150000, true, false, model, 'medium', { inputs: [] });
      assert.equal(task.termination, 'stopped', task.stdout);
      assert.equal(task.status, 'completed', task.stdout);
      assert.match(task.outputContent, /Read denied/);
      assert.doesNotMatch(task.outputContent, /UNAPPROVED_REVIEW_CANARY/);
      assert.ok(task.observed.model);
      if (engine === 'claude') {
        const init = task.stdout.split(/\r?\n/).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        }).find(event => event.type === 'system' && event.subtype === 'init');
        assert.ok(init);
        assert.ok(init.tools.every(name => name.startsWith('mcp__syndic_review__')), JSON.stringify(init.tools));
      } else {
        assert.equal(task.observed.reasoning_effort, 'medium');
        assert.match(task.stdout, /syndic_review\/review_status \(completed\)/);
      }
    } finally { await manager.shutdown(); await rm(cwd, { recursive: true, force: true }); }
  });
}
