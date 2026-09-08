import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EngineManager } from '../dist/engine.js';
import { prepareReview } from '../dist/review.js';
import { inside } from '../dist/review-access.js';

test('review launch automatically connects installed Roslyn without a caller override', {
  skip: !process.env.SYNDIC_TEST_ROSLYN_ROOT, timeout: 180000,
}, async () => {
  const root = process.env.SYNDIC_TEST_ROSLYN_ROOT;
  const launch = await prepareReview('claude', root, 'Inspect the code.', { inputs: [] });
  const client = new Client({ name: 'automatic-roslyn-test', version: '1' });
  try {
    const started = Date.now();
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/review-server.js'), join(launch.cwd, 'access.json')],
      env: launch.env, stderr: 'pipe' }), { timeout: 150000 });
    // A reviewer's tool inventory is fixed from this first list, so the
    // semantic tools have to be named here, before the workspace is open.
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'find_references'));
    // Codex drops a server that is slower than this to answer the handshake
    // and the list, and it reports no tools rather than an error when it does.
    assert.ok(Date.now() - started < 3000, `handshake and tool list took ${Date.now() - started}ms`);
    const status = await client.callTool({ name: 'review_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).roslyn_error, null);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('find_references'));
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
    const status = await client.callTool({ name: 'review_status', arguments: {} });
    assert.match(JSON.parse(status.content[0].text).roslyn_error, /No .*sln/i);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('read_file'));
    assert.ok(!names.includes('find_references'));
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
      const status = await client.callTool({ name: 'review_status', arguments: {} });
      assert.equal(JSON.parse(status.content[0].text).roslyn_error, null);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('find_references'));
      assert.ok(names.includes('get_workspace_status'));
      assert.equal(names.some(name => /memory|graph|config|execute|set_solution/.test(name)), false);
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

// A Roslyn candidate root: a committed solution the broker can select, small
// enough that its cold load is not what the test measures.
async function writeCandidate(root) {
  const project = join(root, 'src', 'Widgets');
  await mkdir(project, { recursive: true });
  await writeFile(join(root, 'Widgets.sln'), [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    '# Visual Studio Version 17',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Widgets", "src\\Widgets\\Widgets.csproj", "{D1737C7F-B9A7-4079-9CFD-A2EDDB575533}"',
    'EndProject',
    'Global',
    '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
    '\t\tDebug|Any CPU = Debug|Any CPU',
    '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
    '\t\t{D1737C7F-B9A7-4079-9CFD-A2EDDB575533}.Debug|Any CPU.ActiveCfg = Debug|Any CPU',
    '\t\t{D1737C7F-B9A7-4079-9CFD-A2EDDB575533}.Debug|Any CPU.Build.0 = Debug|Any CPU',
    '\tEndGlobalSection',
    'EndGlobal',
    ''].join('\n'), 'utf8');
  await writeFile(join(project, 'Widgets.csproj'),
    '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n', 'utf8');
  await writeFile(join(project, 'WidgetCatalog.cs'), ['namespace Widgets;', '',
    'public sealed class WidgetCatalog', '{',
    '    public int CountWidgets(int seed) => Normalize(seed) + 41;', '',
    '    private static int Normalize(int value) => value < 0 ? 0 : value;', '}', ''].join('\n'), 'utf8');
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'candidate');
}

test('codex review reaches Roslyn semantic tools with the CLI default model and effort', {
  skip: process.env.SYNDIC_TEST_LIVE !== '1' || !process.env.LOCALAPPDATA ||
    !existsSync(join(process.env.LOCALAPPDATA, 'RoslynMcp', 'RoslynMcp.Server.exe')),
  timeout: 600000,
}, async () => {
  const root = await mkdtemp(join(process.cwd(), '.syndic-candidate-'));
  const manager = new EngineManager();
  try {
    await writeCandidate(root);
    const task = await manager.run('codex',
      'Report every member of the WidgetCatalog type with its accessibility and return type. ' +
      'Obtain them from a semantic code tool such as get_file_outline, get_type_members or find_definition, ' +
      'not by reading the file. Name the exact tool you called.',
      root, 540000, true, false, undefined, undefined, { inputs: [] });
    // The caller supplied neither value, so the CLI picks both and reports them.
    assert.deepEqual(task.launch, { model: null, reasoning_effort: null, mode: 'review' });
    assert.ok(task.observed.model, JSON.stringify(task.observed));
    assert.equal(task.status, 'completed', task.error ?? task.stdout);
    // Only the broker writes receipts; a semantic name here means Roslyn was
    // attached and answered, whatever the report claims.
    const receipts = (await readFile(join(root, '.syndic', `${task.id}.review-evidence.jsonl`), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const semantic = receipts.filter(receipt => receipt.success &&
      !['review_status', 'list_files', 'read_file', 'git_diff'].includes(receipt.tool));
    assert.ok(semantic.length, JSON.stringify(receipts));
    assert.match(task.outputContent, /CountWidgets/);
    assert.match(task.outputContent, /Normalize/);
  } finally {
    await manager.shutdown();
    // Roslyn keeps its database open for a moment after the review ends.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
});
