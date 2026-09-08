import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareReview } from '../dist/review.js';
import { inside } from '../dist/review-access.js';

test('review launch automatically connects installed Roslyn without a caller override', {
  skip: !process.env.SYNDIC_TEST_ROSLYN_ROOT, timeout: 180000,
}, async () => {
  const root = process.env.SYNDIC_TEST_ROSLYN_ROOT;
  const launch = await prepareReview('claude', root, 'Inspect the code.', { inputs: [] });
  const client = new Client({ name: 'automatic-roslyn-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/review-server.js'), join(launch.cwd, 'access.json')],
      env: launch.env, stderr: 'pipe' }), { timeout: 150000 });
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('find_references'));
    const status = await client.callTool({ name: 'review_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).roslyn_error, null);
    const workspace = await client.callTool({ name: 'get_workspace_status', arguments: {} });
    assert.notEqual(workspace.isError, true);
    const values = workspace.content.flatMap(block => {
      try { return [JSON.parse(block.text)]; } catch { return []; }
    });
    const solution = values.map(value => value.solutionPath ?? value.data?.solutionPath).find(Boolean);
    assert.ok(solution && inside(root, solution), JSON.stringify(workspace));
  } finally { await client.close(); await launch.cleanup(); }
});

test('automatic Roslyn selection reports a non-.NET review root without disabling file tools', {
  skip: !process.env.SYNDIC_TEST_ROSLYN_ROOT, timeout: 180000,
}, async () => {
  const launch = await prepareReview('codex', process.cwd(), 'Inspect this TypeScript repository.', { inputs: [] });
  const client = new Client({ name: 'non-dotnet-review-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/review-server.js'), join(launch.cwd, 'access.json')],
      env: launch.env, stderr: 'pipe' }), { timeout: 150000 });
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('read_file'));
    assert.ok(!names.includes('find_references'));
    const status = await client.callTool({ name: 'review_status', arguments: {} });
    assert.match(JSON.parse(status.content[0].text).roslyn_error, /No .*sln/i);
  } finally { await client.close(); await launch.cleanup(); }
});

test('two review brokers select the same solution without exposing memory or mutation tools', {
  skip: !process.env.SYNDIC_TEST_ROSLYN_ROOT || !process.env.SYNDIC_TEST_ROSLYN_COMMAND,
  timeout: 180000,
}, async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-roslyn-'));
  const clients = [];
  try {
    const config = join(cwd, 'access.json');
    await writeFile(config, JSON.stringify({ root: process.env.SYNDIC_TEST_ROSLYN_ROOT, inputs: [],
      roslyn: { command: process.env.SYNDIC_TEST_ROSLYN_COMMAND, args: [] } }));
    await Promise.all([1, 2].map(async i => {
      const client = new Client({ name: `review-test-${i}`, version: '1' });
      clients.push(client);
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [resolve('dist/review-server.js'), config], stderr: 'pipe' });
      await client.connect(transport, { timeout: 150000 });
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('find_references'));
      assert.ok(names.includes('get_workspace_status'));
      assert.equal(names.some(name => /memory|graph|config|execute|set_solution/.test(name)), false);
      const status = await client.callTool({ name: 'review_status', arguments: {} });
      assert.equal(JSON.parse(status.content[0].text).roslyn_error, null);
      const workspace = await client.callTool({ name: 'get_workspace_status', arguments: {} });
      assert.notEqual(workspace.isError, true);
      const search = await client.callTool({ name: 'text_search', arguments: { pattern: 'namespace', pageSize: 1 } });
      assert.notEqual(search.isError, true);
      const forbidden = await client.callTool({ name: 'memory_search', arguments: { query: 'anything' } });
      assert.equal(forbidden.isError, true);
    }));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await rm(cwd, { recursive: true, force: true });
  }
});
