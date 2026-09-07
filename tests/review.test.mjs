import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewAccess } from '../dist/review-access.js';
import { reviewEnvironment } from '../dist/review.js';

test('review environment removes unrelated credentials and startup injection', () => {
  const env = reviewEnvironment({ PATH: 'path', GH_TOKEN: 'canary', NODE_OPTIONS: 'canary',
    BTNET_MCP: 'canary', CLAUDECODE: 'canary', OPENAI_API_KEY: 'model-auth' });
  assert.deepEqual(env, { PATH: 'path', OPENAI_API_KEY: 'model-auth' });
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
