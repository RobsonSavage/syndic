import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, realpath, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewAccess } from '../dist/review-access.js';
import { prepareReview, resolveReviewRoslyn, reviewEnvironment } from '../dist/review.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('automatic Roslyn resolution uses the per-user install and preserves explicit overrides', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-access-'));
  try {
    const env = { LOCALAPPDATA: cwd };
    assert.match((await resolveReviewRoslyn(undefined, env)).error, /Install Roslyn/);
    assert.match((await resolveReviewRoslyn(undefined, {})).error, /absolute path/);
    assert.match((await resolveReviewRoslyn(undefined, { LOCALAPPDATA: '.' })).error, /absolute path/);
    await mkdir(join(cwd, 'RoslynMcp'));
    const command = join(cwd, 'RoslynMcp', 'RoslynMcp.Server.exe');
    await writeFile(command, 'fixture - never executed');
    assert.deepEqual(await resolveReviewRoslyn(undefined, env), { roslyn: { command, args: [] } });
    const override = { command: join(cwd, 'custom.exe'), args: ['--custom'] };
    assert.deepEqual(await resolveReviewRoslyn(override, env), { roslyn: override });
    await assert.rejects(resolveReviewRoslyn({ command: 'relative.exe' }, env), /absolute trusted/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('review environment removes unrelated credentials and startup injection', () => {
  const env = reviewEnvironment({ PATH: 'path', GH_TOKEN: 'canary', NODE_OPTIONS: 'canary',
    BTNET_MCP: 'canary', CLAUDECODE: 'canary', OPENAI_API_KEY: 'model-auth' });
  assert.deepEqual(env, { PATH: 'path', OPENAI_API_KEY: 'model-auth' });
});

test('review broker distinguishes disk reads from HEAD and discovers external snapshots', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-access-'));
  const client = new Client({ name: 'review-provenance-test', version: '1' });
  try {
    const root = join(cwd, 'repo');
    await mkdir(root);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    await writeFile(join(root, 'source.txt'), 'committed content');
    git('add', 'source.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    const head = git('rev-parse', 'HEAD');
    await writeFile(join(root, 'source.txt'), 'staged content');
    git('add', 'source.txt');
    await writeFile(join(root, 'source.txt'), 'working tree content');
    const snapshot = join(cwd, 'roslyn-publish-local.ps1');
    await writeFile(snapshot, 'supplied script contents');
    const config = join(cwd, 'access.json');
    await writeFile(config, JSON.stringify({ root, inputs: [snapshot] }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['dist/review-server.js', config], stderr: 'pipe' }));
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const status = await call('review_status');
    assert.equal(status.head, head);
    assert.match(status.read_semantics, /not HEAD or index/);
    assert.deepEqual(status.supplied_inputs, [await realpath(snapshot)]);
    assert.ok(status.roslyn_error); // No semantic server, but supplied scripts remain readable.
    assert.deepEqual((await call('list_files')).files, ['source.txt']);
    const source = await call('read_file', { path: 'source.txt' });
    assert.equal(source.source, 'working_tree');
    assert.equal(source.revision, null);
    assert.deepEqual(source.lines, ['working tree content']);
    assert.equal(git('show', 'HEAD:source.txt'), 'committed content');
    assert.equal(git('show', ':source.txt'), 'staged content');
    const evidence = await call('read_file', { path: status.supplied_inputs[0] });
    assert.equal(evidence.source, 'supplied_input');
    assert.equal(evidence.revision, null);
    assert.equal(evidence.resolved_path, await realpath(snapshot));
    assert.deepEqual(evidence.lines, ['supplied script contents']);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('both review engines receive the evidence inventory and attribution protocol', async () => {
  for (const engine of ['claude', 'codex']) {
    const launch = await prepareReview(engine, process.cwd(), 'Review the supplied code.', { inputs: [] });
    try {
      assert.match(launch.args.at(-1), /review_status/);
      const prompt = await readFile(join(launch.cwd, 'task.prompt'), 'utf8');
      assert.match(prompt, /supplied_inputs/);
      assert.match(prompt, /not committed HEAD or index blobs/);
      assert.match(prompt, /Unread evidence is not unavailable evidence/);
    } finally { await launch.cleanup(); }
  }
});

test('review reads only tracked files and explicit inputs, with bounded ranges', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-access-'));
  try {
    const root = join(cwd, 'repo');
    await mkdir(root);
    execFileSync('git', ['init', '--quiet', root]);
    await writeFile(join(root, 'source.txt'), 'first\nsecond\n');
    await writeFile(join(root, 'untracked.txt'), 'private');
    await writeFile(join(cwd, 'packet.md'), 'approved facts');
    await writeFile(join(cwd, 'outside.txt'), 'outside');
    execFileSync('git', ['-C', root, 'add', 'source.txt']);
    const access = new ReviewAccess(root);
    await access.initialize([join(cwd, 'packet.md')]);
    assert.deepEqual(access.list(), ['source.txt']);
    assert.deepEqual((await access.read('source.txt', 2, 1)).lines, ['second']);
    assert.deepEqual((await access.read('../packet.md')).lines, ['approved facts']);
    await assert.rejects(access.read('untracked.txt'), /Read denied/);
    await assert.rejects(access.read('../outside.txt'), /Read denied/);
    await assert.rejects(access.read('source.txt', 0), /offset/);
    await assert.rejects(access.diff('HEAD', 'HEAD'), /Full commit SHAs/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
