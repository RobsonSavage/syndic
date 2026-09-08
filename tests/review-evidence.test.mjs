import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareReview } from '../dist/review.js';

async function connect(launch, configure = () => {}) {
  const { mcpServers: { syndic_review: server } } = JSON.parse(await readFile(join(launch.cwd, 'mcp.json'), 'utf8'));
  const configPath = server.args.at(-1);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  delete config.roslyn;
  delete config.roslyn_error;
  configure(config);
  await writeFile(configPath, JSON.stringify(config));
  const client = new Client({ name: 'review-evidence-test', version: '1' });
  await client.connect(new StdioClientTransport({ ...server, cwd: launch.cwd, stderr: 'pipe' }));
  return { client, config };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

async function receipts(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

function report(launch) {
  const output = '## Findings\nThe supplied evidence was reviewed.';
  launch.observe({}, JSON.stringify({ type: 'result', is_error: false, result: output }), '');
  return output;
}

test('generated review transport records real packet and evidence reads, including failed calls', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-evidence-'));
  let launch;
  let client;
  try {
    const evidencePath = join(cwd, 'evidence.txt');
    const evidence = 'Supplied evidence content must stay out of receipt logs.';
    const prompt = 'Review transport verification\nRead the supplied evidence and identify its source.';
    await writeFile(evidencePath, evidence);
    launch = await prepareReview('claude', process.cwd(), prompt, { inputs: [evidencePath] });
    const connected = await connect(launch);
    client = connected.client;
    assert.equal(connected.config.audit_path, join(launch.cwd, 'evidence.jsonl'));
    assert.equal(connected.config.attempt, 1);
    const status = await call(client, 'review_status');
    assert.ok(status.supplied_inputs.includes(await realpath(evidencePath)));
    const promptPath = status.supplied_inputs.find(path => basename(path) === 'task.prompt');
    assert.equal(promptPath, await realpath(join(launch.cwd, 'task.prompt')));
    assert.ok(launch.args.at(-1).includes(promptPath.replaceAll('\\', '/')));
    const output = report(launch);
    const first = await call(client, 'read_file', { path: promptPath, limit: 1 });
    await assert.rejects(launch.result(), /task\.prompt was not fully read/);
    const rest = await call(client, 'read_file', { path: promptPath, offset: 2, limit: 2000 });
    assert.ok([...first.lines, ...rest.lines].join('\n').startsWith(prompt + '\n'));
    await assert.rejects(launch.result(), /none of the supplied input files were read/);
    const failed = await client.callTool({ name: 'read_file', arguments: { path: join(cwd, 'missing-case.md') } });
    assert.equal(failed.isError, true);
    await assert.rejects(launch.result(), /none of the supplied input files were read/);
    const supplied = await call(client, 'read_file', { path: evidencePath });
    assert.deepEqual(supplied.lines, [evidence]);
    assert.equal(await launch.result(), output);
    const recorded = await receipts(connected.config.audit_path);
    assert.deepEqual(recorded[0], { attempt: 1, tool: 'review_status', success: true });
    assert.deepEqual(recorded[1], { attempt: 1, tool: 'read_file', success: true,
      resolved_path: first.resolved_path, source: 'supplied_input', offset: 1, count: 1, total_lines: first.total_lines });
    assert.deepEqual(recorded[2], { attempt: 1, tool: 'read_file', success: true,
      resolved_path: rest.resolved_path, source: 'supplied_input', offset: 2, count: rest.lines.length, total_lines: rest.total_lines });
    assert.deepEqual(recorded[3], { attempt: 1, tool: 'read_file', success: false });
    assert.deepEqual(recorded[4], { attempt: 1, tool: 'read_file', success: true,
      resolved_path: supplied.resolved_path, source: 'supplied_input', offset: 1, count: 1, total_lines: 1 });
    assert.ok(!(await readFile(connected.config.audit_path, 'utf8')).includes(evidence));
    await Promise.all(Array.from({ length: 8 }, () => call(client, 'read_file', { path: evidencePath })));
    const concurrent = await receipts(connected.config.audit_path);
    assert.equal(concurrent.length, recorded.length + 8);
    assert.ok(concurrent.slice(recorded.length).every(receipt => receipt.success && receipt.resolved_path === supplied.resolved_path));
  } finally {
    await client?.close();
    await launch?.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('review receipt attempts remain distinct when the broker restarts for a retry', async () => {
  const cwd = await mkdtemp(join(process.cwd(), '.syndic-evidence-'));
  let launch;
  let client;
  try {
    const auditPath = join(cwd, 'receipts.jsonl');
    launch = await prepareReview('claude', process.cwd(), 'Review the supplied evidence.', { inputs: [] }, auditPath);
    let connected = await connect(launch);
    client = connected.client;
    assert.equal(connected.config.audit_path, auditPath);
    const status = await call(client, 'review_status');
    const promptPath = status.supplied_inputs.find(path => basename(path) === 'task.prompt');
    await call(client, 'read_file', { path: promptPath, limit: 2000 });
    const firstOutput = report(launch);
    assert.equal(await launch.result(), firstOutput);
    await client.close();
    client = undefined;
    await launch.reset();
    connected = await connect(launch);
    client = connected.client;
    assert.equal(connected.config.audit_path, auditPath);
    assert.equal(connected.config.attempt, 2);
    await call(client, 'review_status');
    const output = report(launch);
    await assert.rejects(launch.result(), /task\.prompt was not fully read/);
    await call(client, 'read_file', { path: promptPath, limit: 2000 });
    assert.equal(await launch.result(), output);
    const recorded = await receipts(auditPath);
    assert.deepEqual(recorded.map(({ attempt, tool }) => ({ attempt, tool })), [
      { attempt: 1, tool: 'review_status' },
      { attempt: 1, tool: 'read_file' },
      { attempt: 2, tool: 'review_status' },
      { attempt: 2, tool: 'read_file' },
    ]);
    await client.close();
    client = undefined;
    await launch.cleanup();
    launch = undefined;
    assert.deepEqual(await receipts(auditPath), recorded);
  } finally {
    await client?.close();
    await launch?.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a tool cannot return success when its evidence receipt cannot be written', async () => {
  const launch = await prepareReview('claude', process.cwd(), 'Review the supplied evidence.', { inputs: [] });
  let client;
  try {
    ({ client } = await connect(launch, config => { config.audit_path = launch.cwd; }));
    const result = await client.callTool({ name: 'review_status', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /evidence receipt/i);
    assert.doesNotMatch(result.content[0].text, /supplied_inputs/);
  } finally { await client?.close(); await launch.cleanup(); }
});
