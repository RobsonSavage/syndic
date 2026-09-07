import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP advertises optional overrides and forwards effort to the engine', async () => {
  const client = new Client({ name: 'syndic-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const schema = tools.find(tool => tool.name === 'syndic_run').inputSchema;
    assert.ok(schema.properties.engine.enum.includes('claude'));
    assert.match(schema.properties.model.description, /Claude Code/);
    assert.match(schema.properties.reasoning_effort.description, /Claude Code/);
    assert.equal(schema.properties.reasoning_effort.type, 'string');
    assert.equal(schema.required.includes('reasoning_effort'), false);
    assert.equal(schema.required.includes('model'), false);
    assert.deepEqual(schema.properties.mode.enum, ['default', 'review']);
    assert.ok(schema.properties.review_inputs);
    assert.ok(schema.properties.review_roslyn);
    assert.match(schema.properties.model.description, /For Gemini, do not set this unless the user explicitly requests a model/);
    const result = await client.callTool({
      name: 'syndic_run',
      arguments: { engine: 'gemini', prompt: 'Inspect the task', reasoning_effort: 'max' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /reasoning_effort is not supported for gemini/);
    const rejected = await client.callTool({ name: 'syndic_run', arguments: {
      engine: 'gemini', prompt: 'Inspect the task', mode: 'review',
    } });
    assert.equal(rejected.isError, true);
    const cancel = await client.callTool({ name: 'syndic_cancel', arguments: { task_id: 'unknown-test-task' } });
    assert.equal(JSON.parse(cancel.content[0].text).accepted, false);
  } finally {
    await client.close();
  }
});
