import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadReviewDefaults, mcpProblem, mergeMcp, resolveSkills } from '../dist/defaults.js';
import { prepareReview } from '../dist/review.js';
import { ReviewAccess } from '../dist/review-access.js';

const skill = (name, body = 'Do the thing.') => `---\nname: ${name}\ndescription: test\n---\n${body}\n`;

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), 'syndic-defaults-'));
  const install = join(home, '.claude', 'plugins', 'cache', 'acme', 'acme', '9.0.0');
  await mkdir(join(install, 'skills', 'acme'), { recursive: true });
  await mkdir(join(install, 'skills', 'acme-review'), { recursive: true });
  await mkdir(join(install, '.openclaw', 'skills', 'acme'), { recursive: true });
  await writeFile(join(install, 'skills', 'acme', 'SKILL.md'), skill('acme', 'base'));
  await writeFile(join(install, 'skills', 'acme-review', 'SKILL.md'), skill('acme-review', 'review'));
  await writeFile(join(install, '.openclaw', 'skills', 'acme', 'SKILL.md'), skill('acme', 'decoy'));
  await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'acme@acme': [{ installPath: install, version: '9.0.0' }] } }));
  await mkdir(join(home, '.claude', 'skills', 'mine'), { recursive: true });
  await writeFile(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), skill('mine'));
  return { home, install };
}

test('loadReviewDefaults is empty without a file and degrades on a broken one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'syndic-defaults-'));
  try {
    assert.deepEqual(await loadReviewDefaults({}, home), { skills: [], mcp: [], notes: [] });
    const file = join(home, 'd.json');
    await writeFile(file, '{ nope');
    assert.match((await loadReviewDefaults({ SYNDIC_DEFAULTS: file }, home)).notes[0], /not valid JSON/);
    await writeFile(file, JSON.stringify({ review: { skills: ['a:b', 3], mcp: [
      { name: 'ok', command: process.execPath, tools: ['x'] },
      { name: 'no-tools', command: process.execPath, tools: [] },
      { name: 'relative', command: 'node', tools: ['x'] },
    ] } }));
    const loaded = await loadReviewDefaults({ SYNDIC_DEFAULTS: file }, home);
    assert.deepEqual(loaded.skills, ['a:b']);
    assert.deepEqual(loaded.mcp.map(m => m.name), ['ok']);
    assert.equal(loaded.notes.length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('mergeMcp lets a call entry replace a default of the same name', () => {
  const merged = mergeMcp([{ name: 'a', command: '/x', tools: ['1'] }, { name: 'b', command: '/x', tools: ['1'] }],
    [{ name: 'a', command: '/y', tools: ['2'] }]);
  assert.deepEqual(merged.map(m => `${m.name}:${m.command}`), ['b:/x', 'a:/y']);
  const twice = mergeMcp([{ name: 'a', command: '/1', tools: ['1'] }, { name: 'a', command: '/2', tools: ['1'] }], []);
  assert.deepEqual(twice.map(m => m.command), ['/2']);
});

test('resolveSkills follows the plugin registry, ignores dot-folder copies and reports misses', async () => {
  const { home, install } = await fixtureHome();
  try {
    const { found, missing } = await resolveSkills(['acme:acme', 'acme:acme-review', 'mine', 'acme:gone', 'ghost:ghost'], home);
    assert.deepEqual(found.map(s => s.name), ['acme:acme', 'acme:acme-review', 'mine']);
    assert.equal(found[0].path, join(install, 'skills', 'acme', 'SKILL.md'));
    assert.deepEqual(missing, ['acme:gone', 'ghost:ghost']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('resolveSkills refuses a plugin name that would leave the plugin folders', async () => {
  const { home } = await fixtureHome();
  try {
    const { found, missing } = await resolveSkills(['..:mine', 'a/b:acme', '.:acme'], home);
    assert.deepEqual(found, []);
    assert.deepEqual(missing, ['..:mine', 'a/b:acme', '.:acme']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('resolveSkills survives a plugin update that moves the install and reshuffles the layout', async () => {
  const { home } = await fixtureHome();
  try {
    const moved = join(home, 'elsewhere', 'acme-10', 'deep', 'nested', 'acme');
    await mkdir(moved, { recursive: true });
    await writeFile(join(moved, 'SKILL.md'), skill('acme', 'moved'));
    await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'acme@acme': [{ installPath: join(home, 'elsewhere', 'acme-10') }] } }));
    const { found } = await resolveSkills(['acme:acme'], home);
    assert.equal(found[0].path, join(moved, 'SKILL.md'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('resolveSkills falls back to the newest cached version when the registry is missing', async () => {
  const { home } = await fixtureHome();
  try {
    await rm(join(home, '.claude', 'plugins', 'installed_plugins.json'));
    const newer = join(home, '.claude', 'plugins', 'cache', 'acme', 'acme', '10.0.0', 'skills', 'acme');
    await mkdir(newer, { recursive: true });
    await writeFile(join(newer, 'SKILL.md'), skill('acme', 'newer'));
    const { found } = await resolveSkills(['acme:acme'], home);
    assert.equal(found[0].path, join(newer, 'SKILL.md'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('search_files finds text in every tracked file type and rejects pathspec tricks', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'syndic-search-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo });
    git('init', '-q');
    await mkdir(join(repo, 'sql'));
    await writeFile(join(repo, 'a.cs'), 'var t = "ZClrMemberSalary";\n');
    await writeFile(join(repo, 'sql', 'b.sql'), 'INSERT INTO dbo.zclrmembersalary (x) VALUES (1);\n');
    await writeFile(join(repo, 'untracked.txt'), 'ZClrMemberSalary\n');
    await writeFile(join(repo, 'é.sql'), 'select 1; -- ZClrAccent\n');
    git('add', 'a.cs', 'sql/b.sql', 'é.sql');
    const access = new ReviewAccess(repo);
    assert.ok((await access.search('ZClrAccent')).matches[0].startsWith('é.sql:1:'), 'non-ASCII names are not quoted');
    const hit = await access.search('ZClrMemberSalary');
    assert.equal(hit.total, 2);
    assert.ok(hit.matches.some(line => line.startsWith('sql/b.sql:1:')));
    assert.equal((await access.search('ZClrMemberSalary', 'sql')).total, 1);
    assert.equal((await access.search('no-such-text')).total, 0);
    assert.equal((await access.search('ZClr.*Salary', '', 100, true)).total, 2);
    await assert.rejects(access.search('x', ':(top)'), /plain repository path/);
    await assert.rejects(access.search('x', '../up'), /plain repository path/);
    assert.equal((await access.search('ZClrMemberSalary', '', 1)).truncated, true);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a review launch applies the defaults file: skills as inputs, an allowlisted extra server, notes', { timeout: 120000 }, async () => {
  const { home } = await fixtureHome();
  const repo = await mkdtemp(join(tmpdir(), 'syndic-launch-'));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, SYNDIC_DEFAULTS: process.env.SYNDIC_DEFAULTS };
  const server = resolve('tests/fixtures/extra-mcp.mjs');
  let launch; let client;
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['add', 'f.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const defaults = join(home, 'defaults.json');
    await writeFile(defaults, JSON.stringify({ review: { skills: ['acme:acme', 'acme:gone'],
      mcp: [{ name: 'extra', command: process.execPath, args: [server], tools: ['echo', 'wipe'], path_args: { echo: ['value'] } }] } }));
    Object.assign(process.env, { USERPROFILE: home, HOME: home, SYNDIC_DEFAULTS: defaults });
    launch = await prepareReview('claude', repo, 'Review the repository.', { inputs: [], skills: ['acme:acme-review'] });
    client = new Client({ name: 'defaults-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/review-server.js'), join(launch.cwd, 'access.json')], env: launch.env, stderr: 'pipe' }),
      { timeout: 60000 });
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('search_files') && names.includes('echo'));
    assert.ok(!names.includes('secret'), 'a tool outside the allowlist must not be exposed');
    const status = JSON.parse((await client.callTool({ name: 'review_status', arguments: {} })).content[0].text);
    assert.ok(status.supplied_inputs.some(path => path.endsWith(join('skills', 'acme', 'SKILL.md'))));
    assert.ok(status.supplied_inputs.some(path => path.endsWith(join('skills', 'acme-review', 'SKILL.md'))));
    assert.ok(status.supplied_inputs.every(path => !path.includes('.openclaw')));
    assert.match(status.notes.join('\n'), /Requested skills not found: acme:gone/);
    assert.deepEqual(status.extra_tools, ['echo']);
    assert.match(status.notes.join('\n'), /wipe declared as changing state/);
    const listed = (await client.listTools()).tools;
    assert.ok(!listed.some(tool => tool.name === 'wipe'), 'a tool declared as changing state must not be offered');
    assert.equal(listed.find(tool => tool.name === 'echo').annotations.idempotentHint, false, 'extra tools keep their own annotations');
    assert.equal(listed.find(tool => tool.name === 'search_files').annotations.readOnlyHint, true);
    const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    assert.equal(echoed.content[0].text, 'echo:hi');
    const escaped = await client.callTool({ name: 'echo', arguments: { text: 'hi', path: '../../outside' } });
    assert.equal(escaped.isError, true);
    // Extra tools may read any file under the review root, tracked or not, and the supplied inputs.
    await writeFile(join(repo, 'untracked.txt'), 'x\n');
    const skillFile = status.supplied_inputs.find(path => path.endsWith(join('skills', 'acme', 'SKILL.md')));
    for (const allowed of [{ path: 'untracked.txt' }, { file: join(repo, 'untracked.txt') }, { path: 'not-yet/created.txt' },
      { path: skillFile }, { paths: [skillFile, 'f.txt'] }, { value: 'untracked.txt' }, { value: ['f.txt'] }]) {
      const ok = await client.callTool({ name: 'echo', arguments: { text: 'ok', ...allowed } });
      assert.ok(!ok.isError, JSON.stringify(allowed) + ' ' + JSON.stringify(ok.content));
    }
    // An existing file outside the root and the inputs is refused whatever shape carries it.
    const outside = join(home, 'outside.txt');
    await writeFile(outside, 'secret\n');
    // A junction inside the root that points outside it, and the spellings Windows folds back onto it.
    await symlink(home, join(repo, 'link'), 'junction');
    const slashed = outside.replaceAll('\\', '/');
    for (const denied of [{ path: outside }, { file: outside }, { paths: ['f.txt', outside] }, { request: { path: outside } },
      { list: [{ nested: { dir: outside } }] }, { uri: pathToFileURL(outside).href }, { text: outside },
      // file: URIs without the double slash, under a key that names no location
      { text: 'file:/' + slashed }, { text: 'file:' + slashed },
      { path: 'link/outside.txt' }, { path: 'link./outside.txt' }, { path: 'link /outside.txt' },
      // a path used as an object key
      { files: { [outside]: true } }, { data: { [outside]: 1 } },
      // a key the server declared in path_args is a location whatever its name
      { value: 'link/outside.txt' }, { value: ['f.txt', 'link/outside.txt'] }]) {
      const refused = await client.callTool({ name: 'echo', arguments: denied });
      assert.equal(refused.isError, true, JSON.stringify(denied));
    }
    const hidden = await client.callTool({ name: 'secret', arguments: {} });
    assert.equal(hidden.isError, true);
    const found = JSON.parse((await client.callTool({ name: 'search_files', arguments: { pattern: 'x' } })).content[0].text);
    assert.equal(found.total, 1);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await client?.close(); await launch?.cleanup();
    await rm(home, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true });
  }
});

test('extra server discovery runs from the review root, like the broker', { timeout: 60000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'syndic-rel-'));
  let launch;
  try {
    await writeFile(join(repo, 'boot.mjs'), `await import(${JSON.stringify(pathToFileURL(resolve('tests/fixtures/extra-mcp.mjs')).href)});\n`);
    launch = await prepareReview('claude', repo, 'Review the repository.',
      { inputs: [], defaults: false, mcp: [{ name: 'rel', command: process.execPath, args: ['boot.mjs'], tools: ['echo'] }] });
    const access = JSON.parse(await readFile(join(launch.cwd, 'access.json'), 'utf8'));
    assert.deepEqual(access.extra_mcp[0].tools.map(tool => tool.name), ['echo']);
    assert.deepEqual(access.notes, []);
  } finally { await launch?.cleanup(); await rm(repo, { recursive: true, force: true }); }
});

test('a chatty extra server does not stall tool discovery', { timeout: 60000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'syndic-noisy-'));
  let launch;
  try {
    const started = Date.now();
    const marker = join(repo, 'noise.marker');
    launch = await prepareReview('claude', repo, 'Review the repository.', { inputs: [], defaults: false,
      mcp: [{ name: 'noisy', command: process.execPath, args: [resolve('tests/fixtures/extra-mcp.mjs'), 'noisy', marker], tools: ['echo'] }] });
    const access = JSON.parse(await readFile(join(launch.cwd, 'access.json'), 'utf8'));
    assert.deepEqual(access.extra_mcp[0].tools.map(tool => tool.name), ['echo']);
    assert.deepEqual(access.notes, []);
    assert.ok(Date.now() - started < 20000, 'discovery waited for its timeout');
    // The fixture records the bytes it really wrote, so a runtime that dropped the noise cannot pass vacuously.
    assert.equal(await readFile(marker, 'utf8'), String(1024 * 1024));
  } finally { await launch?.cleanup(); await rm(repo, { recursive: true, force: true }); }
});

// A broker over a one-server review, plus the paths a test needs. Evidence goes in as a supplied input.
async function brokerOver(tools, extra = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'syndic-guard-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'syndic-guard-out-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'x\n');
  await writeFile(join(repo, 'untracked.txt'), 'u\n');
  const evidence = join(outsideDir, 'evidence.txt');
  await writeFile(evidence, 'e\n');
  const launch = await prepareReview('claude', repo, 'Review the repository.', { inputs: [evidence], defaults: false,
    mcp: [{ name: 'fx', command: process.execPath, args: [resolve('tests/fixtures/extra-mcp.mjs')], tools, ...extra }] });
  const { mcpServers: { syndic_review: server } } = JSON.parse(await readFile(join(launch.cwd, 'mcp.json'), 'utf8'));
  const configPath = server.args.at(-1);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  delete config.roslyn; delete config.roslyn_error;
  await writeFile(configPath, JSON.stringify(config));
  const client = new Client({ name: 'guard-test', version: '1' });
  await client.connect(new StdioClientTransport({ ...server, cwd: launch.cwd, stderr: 'pipe' }), { timeout: 60000 });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const close = async () => {
    await client.close(); await launch.cleanup();
    await rm(repo, { recursive: true, force: true }); await rm(outsideDir, { recursive: true, force: true });
  };
  return { repo, outsideDir, evidence, call, close };
}

// The fixture's read_text opens the argument the way a real reader does, from the review root. A
// refusal must come from the broker (the reader never ran); an allowed read must return the file.
const refusedBeforeReading = result => result.isError === true && !/^read failed/.test(result.content[0].text);

test('N5: drive-relative values are refused before any reader resolves them', { timeout: 60000 }, async () => {
  const { repo, call, close } = await brokerOver(['read_text']);
  try {
    const drive = repo.slice(0, 2);
    for (const args of [{ path: 'C:../Windows/win.ini' }, { path: 'Z:foo' }, { path: drive + 'f.txt' }, { path: drive + '..\\f.txt' },
      { text: 'C:..\\Windows\\win.ini' }, { path: '\\\\?\\C:foo' }, { files: { 'C:foo': true } }]) {
      assert.ok(refusedBeforeReading(await call('read_text', args)), JSON.stringify(args));
    }
    const full = await call('read_text', { path: join(repo, 'f.txt') });
    assert.equal(full.content[0].text, 'x\n');
  } finally { await close(); }
});

test('N6: reserved device names are refused wherever they appear in a path', { timeout: 60000 }, async () => {
  const { repo, call, close } = await brokerOver(['read_text']);
  try {
    for (const path of ['NUL', 'nul', 'CON', 'COM1', 'lpt1.txt', 'NUL.txt', 'sub/aux', 'sub\\prn.log', join(repo, 'conout$'), 'COM¹',
      '\\\\.\\NUL', '\\\\.\\PhysicalDrive0', '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x']) {
      assert.ok(refusedBeforeReading(await call('read_text', { path })), path);
    }
    // Names that only start like a device are ordinary files.
    for (const name of ['null.txt', 'console.txt', 'com10.txt', 'comb', 'lpt.txt']) {
      await writeFile(join(repo, name), 'ok\n');
      assert.equal((await call('read_text', { path: name })).content[0].text, 'ok\n', name);
    }
  } finally { await close(); }
});

test('N7: namespace spellings of allowed files are accepted and checked as the plain path', { timeout: 60000 }, async () => {
  const { repo, outsideDir, evidence, call, close } = await brokerOver(['read_text']);
  try {
    for (const path of ['\\\\?\\' + join(repo, 'f.txt'), '\\\\?\\' + join(repo, 'untracked.txt'), '//?/' + join(repo, 'f.txt').replaceAll('\\', '/'),
      '\\\\?\\' + evidence]) {
      assert.ok(!refusedBeforeReading(await call('read_text', { path })), path);
    }
    assert.equal((await call('read_text', { path: '\\\\?\\' + join(repo, 'f.txt') })).content[0].text, 'x\n');
    // Windows also accepts repeated separators after the prefix.
    assert.equal((await call('read_text', { path: '\\\\?\\\\' + join(repo, 'f.txt') })).content[0].text, 'x\n');
    assert.ok(refusedBeforeReading(await call('read_text', { path: '\\\\?\\\\' + join(outsideDir, 'other.txt') })));
    assert.equal((await call('read_text', { path: '\\\\?\\' + evidence })).content[0].text, 'e\n');
    // The same spellings of a file that is neither under the root nor supplied are still refused.
    await writeFile(join(outsideDir, 'other.txt'), 'o\n');
    for (const path of ['\\\\?\\' + join(outsideDir, 'other.txt'), '\\\\.\\' + join(outsideDir, 'other.txt'),
      '\\\\?\\' + join(repo, '..', 'x.txt'), '\\\\?\\' + join(repo, 'f.txt.')]) {
      assert.ok(refusedBeforeReading(await call('read_text', { path })), path);
    }
  } finally { await close(); }
});

test('only network URLs skip the location checks', { timeout: 60000 }, async () => {
  const { call, close } = await brokerOver(['echo']);
  try {
    for (const args of [{ url: 'https://example.com/a' }, { uri: 'HTTP://example.com' }, { text: 'wss://example.com/s' },
      { text: 'cc://x' }, { text: 'ab://x' }]) {
      assert.ok(!(await call('echo', args)).isError, JSON.stringify(args));
    }
    // Under a key that names a location, a scheme the guard does not know is judged as a path, not trusted as a URL.
    for (const args of [{ path: 'cc://x' }, { file: 'ab://x' }, { uri: 's3://bucket/key' }]) {
      assert.equal((await call('echo', args)).isError, true, JSON.stringify(args));
    }
  } finally { await close(); }
});

test('N8: tools named like object properties work, and __proto__ is refused at the boundary', { timeout: 60000 }, async () => {
  const { call, close } = await brokerOver(['constructor', 'toString'], { path_args: {} });
  try {
    for (const name of ['constructor', 'toString']) {
      const result = await call(name, { text: 'hi', path: 'f.txt' });
      assert.ok(!result.isError, name + ' ' + JSON.stringify(result.content));
      assert.equal(result.content[0].text, `${name}:hi`);
    }
  } finally { await close(); }
  const base = { name: 'x', command: process.execPath };
  assert.equal(mcpProblem({ ...base, tools: ['constructor'], path_args: { constructor: ['file'] } }), undefined);
  assert.match(mcpProblem({ ...base, tools: ['__proto__'] }), /__proto__/);
  assert.match(mcpProblem(JSON.parse('{"name":"x","command":"' + process.execPath.replaceAll('\\', '\\\\') + '","tools":["a"],"path_args":{"__proto__":["f"]}}')), /__proto__/);
});

test('path_args must name tools the spec allows and list argument names', () => {
  const base = { name: 'x', command: process.execPath, tools: ['a', 'b'] };
  assert.equal(mcpProblem({ ...base, path_args: { a: ['file'], b: ['dir', 'out'] } }), undefined);
  assert.match(mcpProblem({ ...base, path_args: { c: ['file'] } }), /path_args.*c/);
  assert.match(mcpProblem({ ...base, path_args: { a: 'file' } }), /path_args/);
  assert.match(mcpProblem({ ...base, path_args: { a: [''] } }), /path_args/);
  assert.match(mcpProblem({ ...base, path_args: [] }), /path_args/);
});

test('a skill read does not stand in for the supplied evidence', { timeout: 60000 }, async () => {
  const { home } = await fixtureHome();
  const repo = await mkdtemp(join(tmpdir(), 'syndic-skillread-'));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  let launch; let client;
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const evidence = join(repo, 'evidence.txt');
    await writeFile(evidence, 'packet\n');
    execFileSync('git', ['add', 'evidence.txt'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: repo });
    Object.assign(process.env, { USERPROFILE: home, HOME: home });
    launch = await prepareReview('claude', repo, 'Review the supplied evidence.', { inputs: [evidence], skills: ['mine'], defaults: false });
    const { mcpServers: { syndic_review: server } } = JSON.parse(await readFile(join(launch.cwd, 'mcp.json'), 'utf8'));
    const configPath = server.args.at(-1);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.roslyn; delete config.roslyn_error;
    await writeFile(configPath, JSON.stringify(config));
    client = new Client({ name: 'skill-read-test', version: '1' });
    await client.connect(new StdioClientTransport({ ...server, cwd: launch.cwd, stderr: 'pipe' }), { timeout: 60000 });
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result.content));
      return JSON.parse(result.content[0].text);
    };
    const status = await call('review_status');
    const promptPath = status.supplied_inputs.find(path => path.endsWith('task.prompt'));
    const skillPath = status.supplied_inputs.find(path => path.endsWith(join('skills', 'mine', 'SKILL.md')));
    assert.ok(skillPath, 'the skill is a supplied input');
    await call('read_file', { path: promptPath, limit: 2000 });
    await call('read_file', { path: skillPath });
    launch.observe({}, JSON.stringify({ type: 'result', is_error: false, result: '## Findings\nDone.' }), '');
    await assert.rejects(launch.result(), /none of the supplied input files were read/);
    await call('read_file', { path: evidence });
    assert.match(await launch.result(), /Findings/);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await client?.close(); await launch?.cleanup();
    await rm(home, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true });
  }
});
