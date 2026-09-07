import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
