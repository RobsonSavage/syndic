import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReviewAccess } from '../dist/review-access.js';
import { openCodeConfigModel, openCodeProviderBlock, prepareReview, resolveReviewRoslyn, reviewEnvironment } from '../dist/review.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('review rejects a fabricated report without broker evidence reads', async () => {
  for (const engine of ['claude', 'codex']) {
    const launch = await prepareReview(engine, process.cwd(), 'Review QM-4876 PR 243.', { inputs: [] });
    try {
      const output = '## Findings\nThe retry in hostess/retry.py loses the cleanup request.';
      if (engine === 'codex') await writeFile(join(launch.cwd, 'response.md'), output);
      else launch.observe({}, JSON.stringify({ type: 'result', is_error: false, result: output }), '');
      await assert.rejects(launch.result(), /review evidence/i);
    } finally { await launch.cleanup(); }
  }
});

test('review report validation rejects invocation wrappers but permits quoted evidence', async () => {
  for (const engine of ['claude', 'codex']) {
    const launch = await prepareReview(engine, process.cwd(), 'Analyze the supplied code.', { inputs: [] });
    try {
      const result = async output => {
        if (engine === 'codex') await writeFile(join(launch.cwd, 'response.md'), output);
        else launch.observe({}, JSON.stringify({ type: 'result', is_error: false, result: output }), '');
        return launch.result();
      };
      for (const output of [
        'Reading the case file, diff, and trace summary next.\n\n' +
          '<invoke name="mcp__syndic_review__read_file">case.md</invoke>\n' +
          '<tool_result>hostess table cleanup retry</tool_result>\n## Findings\nInvented report.',
        '<invoke name="mcp__syndic_review__review_status"></invoke>',
        '<function_calls>\n<invoke name="mcp__syndic_review__review_status">',
        '<antml:function_calls>\n<antml:invoke name="mcp__syndic_review__review_status">',
        '```xml\n<invoke name="mcp__syndic_review__review_status"></invoke>\n```',
        ...['court', 'count', 'course', 'call'].map(prefix =>
          `${prefix}\n<invoke name="mcp__syndic_review__review_status"></invoke>`),
      ]) await assert.rejects(result(output), /literal tool invocation/i);
      // Model a successful broker read separately from the mocked CLI response.
      const access = JSON.parse(await readFile(join(launch.cwd, 'access.json'), 'utf8'));
      const promptPath = await realpath(join(launch.cwd, 'task.prompt'));
      const lines = (await readFile(promptPath, 'utf8')).split(/\r?\n/).length;
      await writeFile(access.audit_path, [
        { attempt: access.attempt, tool: 'review_status', success: true },
        { attempt: access.attempt, tool: 'read_file', success: true, resolved_path: promptPath,
          offset: 1, count: lines, total_lines: lines },
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
      const report = '## Findings\nThe captured output contains a malformed call:\n' +
        '```xml\n<invoke name="mcp__syndic_review__review_status"></invoke>\n```';
      assert.equal(await result(report), report);
      assert.equal(await result('## Findings\nNo issues found.'), '## Findings\nNo issues found.');
      await assert.rejects(result('   '), /did not return a review report/);
    } finally { await launch.cleanup(); }
  }
});

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

test('Claude preserves native tool guidance while excluding instruction files', async () => {
  const launch = await prepareReview('claude', process.cwd(), 'Analyze the supplied evidence.', { inputs: [] });
  try {
    assert.ok(launch.args.includes('--append-system-prompt'));
    assert.ok(!launch.args.includes('--system-prompt'));
    assert.ok(launch.args.includes('--restricted'));
    assert.ok(launch.args.includes('--strict-mcp-config'));
    assert.equal(launch.args[launch.args.indexOf('--tools') + 1], '');
    assert.equal(launch.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
    assert.equal(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(launch.env.MCP_TIMEOUT, '240000');
  } finally { await launch.cleanup(); }
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
      if (engine === 'codex') assert.ok(launch.args.includes('mcp_servers.syndic_review.startup_timeout_sec=240'));
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

test('OpenCode review needs provider/model and runs with an empty home and standalone server', async () => {
  await assert.rejects(prepareReview('opencode', process.cwd(), 'Review.', { inputs: [] }), /provider\/model/);
  const launch = await prepareReview('opencode', process.cwd(), 'Review.', { inputs: [] }, undefined, 'deepseek/deepseek-flash');
  try {
    assert.deepEqual(launch.args.slice(0, 3), ['run', '--standalone', '--format']);
    assert.notEqual(launch.env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(launch.env.HOME, launch.env.USERPROFILE);
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.permission.bash, 'deny');
    assert.deepEqual(Object.keys(config.mcp), ['syndic_review']);
    const protocol = await readFile(join(launch.cwd, 'task.prompt'), 'utf8');
    assert.match(protocol, /Never call tools\.opencode\.session_\*/);
  } finally { await launch.cleanup(); }
});

const KEYS = { OLLAMA_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' };

test('openCodeConfigModel reads only a safe provider/model from the top level of config.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'syndic-ocmodel-'));
  const state = await mkdtemp(join(tmpdir(), 'syndic-ocstate-'));
  try {
    assert.equal(await openCodeConfigModel(dir, state, KEYS), undefined);
    for (const [content, expected] of [
      [JSON.stringify({ model: 'ollama/glm-5.3:cloud', agent: { a: { model: 'x/y' } } }), 'ollama/glm-5.3:cloud'],
      [JSON.stringify({ agent: { a: { model: 'x/y' } } }), undefined],
      [JSON.stringify({ model: 'nomodelprovider' }), undefined],
      [JSON.stringify({ model: 'a/b & calc' }), undefined],
      ['{ not json', undefined],
    ]) {
      await writeFile(join(dir, 'config.json'), content, 'utf8');
      assert.equal(await openCodeConfigModel(dir, state, KEYS), expected, content);
    }
  } finally { await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test('openCodeConfigModel falls back to model.json favorite, then recent, after config.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'syndic-ocmodel-'));
  const state = await mkdtemp(join(tmpdir(), 'syndic-ocstate-'));
  const pick = (providerID, modelID) => ({ providerID, modelID });
  const write = content => writeFile(join(state, 'model.json'), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  try {
    await write({ favorite: [pick('ollama', 'a:cloud')], recent: [pick('deepseek', 'deepseek-flash')] });
    assert.equal(await openCodeConfigModel(dir, state, KEYS), 'ollama/a:cloud', 'favorite beats recent');
    await write({ favorite: [], recent: [pick('deepseek', 'deepseek-flash')] });
    assert.equal(await openCodeConfigModel(dir, state, KEYS), 'deepseek/deepseek-flash', 'recent when no favorite');
    await write({ favorite: [pick('bad', 'x & calc')], recent: [pick('deepseek', 'deepseek-flash')] });
    assert.equal(await openCodeConfigModel(dir, state, KEYS), 'deepseek/deepseek-flash', 'unsafe favorite is skipped');
    await write({ favorite: [{ providerID: 1 }], recent: 'nope' });
    assert.equal(await openCodeConfigModel(dir, state, KEYS), undefined, 'malformed entries');
    await write('{ not json');
    assert.equal(await openCodeConfigModel(dir, state, KEYS), undefined, 'unparseable model.json');
    await write({ favorite: [pick('ollama', 'a:cloud')] });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ model: 'deepseek/deepseek-flash' }), 'utf8');
    assert.equal(await openCodeConfigModel(dir, state, KEYS), 'deepseek/deepseek-flash', 'config.json wins');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});

test('OpenCode review rejects tools.opencode calls and other tools, and reads the last step as the report', async () => {
  const launch = await prepareReview('opencode', process.cwd(), 'Review.', { inputs: [] }, undefined, 'deepseek/deepseek-flash');
  try {
    const events = lines => lines.map(line => JSON.stringify(line)).join('\n');
    const execute = code => ({ type: 'tool_use', part: { tool: 'execute', state: { input: { code } } } });
    launch.observe({}, events([{ type: 'step_start' }, { type: 'text', part: { text: 'narration' } },
      execute('return await tools.syndic_review.review_status();'), { type: 'step_start' },
      { type: 'text', part: { text: '## Findings\nNone.' } }]), '');
    await assert.rejects(launch.result(), /broker receipts/);
    for (const code of ['await tools.opencode.session_rename({title:"x"})', 'tools [ "opencode" ].worktree_list()']) {
      launch.observe({}, events([execute(code), { type: 'text', part: { text: '## Findings\nNone.' } }]), '');
      await assert.rejects(launch.result(), /OpenCode review rejected: called tools\.opencode/);
    }
    launch.observe({}, events([execute('return await tools.opencode.list_mcp_resources({});'), { type: 'text', part: { text: '## Findings\nNone.' } }]), '');
    await assert.rejects(launch.result(), /broker receipts/);
    launch.observe({}, events([{ type: 'tool_use', part: { tool: 'websearch', state: {} } }]), '');
    await assert.rejects(launch.result(), /called tool websearch/);
  } finally { await launch.cleanup(); }
});

test('openCodeConfigModel takes the first listed model whose provider this PC can reach', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'syndic-ocmodel-'));
  const state = await mkdtemp(join(tmpdir(), 'syndic-ocstate-'));
  const pick = (providerID, modelID) => ({ providerID, modelID });
  const model = (favorite, recent, env) => writeFile(join(state, 'model.json'), JSON.stringify({ favorite, recent }), 'utf8')
    .then(() => openCodeConfigModel(dir, state, env));
  try {
    assert.equal(await model([pick('openai', 'gpt-x')], [pick('deepseek', 'deepseek-flash')], { OPENAI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' }), 'openai/gpt-x', 'both keys set: list order decides');
    assert.equal(await model([pick('openai', 'gpt-x')], [pick('deepseek', 'deepseek-flash')], { DEEPSEEK_API_KEY: 'k' }), 'deepseek/deepseek-flash', 'favorite without a key is skipped');
    assert.equal(await model([pick('openai', 'gpt-x')], [pick('deepseek', 'deepseek-flash')], { OPENCODE_API_KEY: 'k' }), undefined, 'the opencode key opens only the opencode provider');
    await writeFile(join(dir, 'config.json'), JSON.stringify({ provider: {
      ollama: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:11434/v1' }, models: {} },
      moonshot: { options: { apiKey: 'secret', baseURL: 'https://x/v1' } } } }), 'utf8');
    assert.equal(await model([pick('moonshot', 'k3')], [pick('ollama', 'a:cloud')], { MOONSHOT_API_KEY: 'k' }), 'ollama/a:cloud', 'a block with an apiKey is unreachable, a keyless block is reachable');
    assert.deepEqual(await openCodeProviderBlock('ollama/a:cloud', dir), { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:11434/v1' }, models: {} });
    assert.equal(await openCodeProviderBlock('moonshot/k3', dir), undefined);
    assert.equal(await openCodeProviderBlock('deepseek/deepseek-flash', dir), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
