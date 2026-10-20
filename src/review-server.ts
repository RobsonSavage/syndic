import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { appendFile, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewAccess, inside } from './review-access.js';
import { SEMANTIC_TOOLS } from './types.js';

// Codex asks for the tool list milliseconds after the transport connects and
// drops a server that answers either request late; mcp_servers.startup_timeout_sec
// does not extend that window, which is shorter than any real solution load.
// So the broker connects first and selects the solution in the background.
// Readiness is awaited inside the first tool call instead of the handshake,
// which is what this bound has to fit: a reviewer's per-tool timeout.
const ROSLYN_STARTUP_MS = 110_000;

const cfg = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (cfg.audit_path !== undefined && (typeof cfg.audit_path !== 'string' || !isAbsolute(cfg.audit_path) ||
  !Number.isInteger(cfg.attempt) || cfg.attempt < 1)) {
  throw new Error('Review audit_path must be absolute and attempt must be a positive integer');
}
const root = await realpath(cfg.root);
const access = new ReviewAccess(root);
await access.initialize(cfg.inputs);
const server = new Server({ name: 'syndic-review', version: '1' }, { capabilities: { tools: { listChanged: true } } });
const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });
let roslyn: Client | undefined;
// Named before the workspace is open, so the reviewer's fixed tool inventory
// includes them. Every call waits on the attach that makes them answerable.
// Roslyn selects the shallowest solution tracked under the root, so a root
// without one is told nothing it cannot deliver.
const candidate = access.list().some(path => /\.slnx?$/i.test(path));
let semantic: Tool[] = candidate
  ? (cfg.semantic_tools ?? []).filter((tool: Tool) => SEMANTIC_TOOLS.has(tool.name)) : [];
let roslynError = cfg.roslyn_error ?? 'Roslyn launcher not supplied';
let connect = () => { };
const connected = new Promise<void>(resolve => { connect = resolve; });

function solutionPath(result: unknown): string | undefined {
  const blocks = (result as { content?: Array<{ text?: string }> }).content;
  for (const block of blocks ?? []) {
    try {
      const value = JSON.parse(block.text ?? '');
      const path = value.solutionPath ?? value.data?.solutionPath;
      if (typeof path === 'string') return path;
    } catch { }
  }
}

async function validateWorkspace(client: Client): Promise<void> {
  const result = await client.callTool({ name: 'get_workspace_status', arguments: {} });
  const path = solutionPath(result);
  if (result.isError || !path || !inside(root, await realpath(path))) {
    throw new Error('Roslyn solution mismatch or unavailable');
  }
}

// Runs beside the handshake. Every tool call waits on it, so a caller never
// sees a half-attached workspace, and nothing here delays the tool list.
let attaching: Client | undefined;
async function attachRoslyn(): Promise<void> {
  const client = new Client({ name: 'syndic-review', version: '1' });
  attaching = client;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  try {
    const transport = new StdioClientTransport({ command: cfg.roslyn.command, args: cfg.roslyn.args ?? [],
      cwd: root, env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')),
      stderr: 'pipe' });
    transport.stderr?.on('data', () => { /* upstream diagnostics never become reviewer memory/context */ });
    const startup = (async () => {
      await client.connect(transport);
      const selection = await client.callTool({ name: 'set_solution_root', arguments: { rootPath: root, warmUp: false } });
      if (selection.isError) throw new Error(`Roslyn selection failed: ${JSON.stringify(selection.content)}`);
      await validateWorkspace(client);
      return (await client.listTools()).tools.filter(tool => SEMANTIC_TOOLS.has(tool.name));
    })();
    // An attempt abandoned at the deadline rejects once the client is closed.
    // The race already reported the failure; a late rejection must not stop
    // the broker from serving the file tools.
    startup.catch(() => { });
    // Semantic tools are published only by the winning startup, so an
    // abandoned attempt cannot advertise a client that is no longer connected.
    semantic = await Promise.race([startup, new Promise<never>((_, reject) => {
      expiry = setTimeout(() => reject(new Error(
        `Roslyn did not finish selecting the solution within ${ROSLYN_STARTUP_MS / 1000}s`)), ROSLYN_STARTUP_MS);
    })]);
    roslyn = client;
    roslynError = '';
  } catch (error) {
    roslynError = error instanceof Error ? error.message : String(error);
    semantic = [];
    await client.close().catch(() => { });
  } finally {
    clearTimeout(expiry);
    attaching = undefined;
    // The advertised list was a prediction. Announce the correction for a
    // client that re-reads it; the rest learn from a call that reports why.
    await connected;
    server.sendToolListChanged();
  }
}
const attached = cfg.roslyn ? attachRoslyn() : Promise.resolve();

// Extra servers come from the caller or the defaults file, each limited to the
// tools it named. Schemas were read at launch; a server is started on first use.
type ExtraSpec = { name: string; command: string; args?: string[]; tools: Tool[]; path_args?: Record<string, string[]> };
const extraSpecs: ExtraSpec[] = cfg.extra_mcp ?? [];
const extraClients = new Map<string, Promise<Client>>();
const extraOwner = new Map<string, ExtraSpec>();
const FILE_TOOL_NAMES = new Set(['review_status', 'list_files', 'read_file', 'git_diff', 'search_files']);
const extraTools: Tool[] = [];
const extraNotes: string[] = [];
let closing = false;
for (const spec of extraSpecs) {
  for (const tool of spec.tools) {
    if (FILE_TOOL_NAMES.has(tool.name) || SEMANTIC_TOOLS.has(tool.name) || extraOwner.has(tool.name)) {
      extraNotes.push(`Extra tool ${tool.name} from ${spec.name} was skipped: the name is already in use`);
      continue;
    }
    extraOwner.set(tool.name, spec);
    extraTools.push(tool);
  }
}
function extraClient(spec: ExtraSpec): Promise<Client> {
  if (closing) return Promise.reject(new Error('Review broker is shutting down'));
  let client = extraClients.get(spec.name);
  if (!client) {
    client = (async () => {
      const upstream = new Client({ name: 'syndic-review-extra', version: '1' });
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args ?? [], cwd: root,
        env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')),
        stderr: 'pipe' });
      transport.stderr?.on('data', () => { /* upstream diagnostics never become reviewer context */ });
      await upstream.connect(transport);
      return upstream;
    })();
    client.catch(() => extraClients.delete(spec.name));
    extraClients.set(spec.name, client);
  }
  return client;
}
// Extra tools may read anything under the review root and the supplied inputs.
// shortcut: arguments are free-form, so a string counts as a location when its key names one, the
// spec lists it in path_args for that tool, or it looks like one (absolute path, file: URI, ".."
// segment). A location in any other shape is outside this guard: list its argument in path_args.
const LOCATION_KEY = /path|file|dir|folder|uri|url|root|cwd|source|target|dest/i;
const supplied = new Set(access.listInputs());
// "C:name" is resolved against drive C:'s own working directory, which the broker and an upstream
// server do not necessarily share, so the file the guard checks can differ from the one that is read.
const DRIVE_RELATIVE = /^[a-z]:(?![\\/])/i;
// Reserved device names open a device in any directory, with or without an extension.
const DEVICE_NAME = new RegExp('^(?:con|prn|aux|nul|conin\\$|conout\\$|(?:com|lpt)[1-9' +
  String.fromCharCode(0xb9, 0xb2, 0xb3) + '])(?:\\..*)?$', 'i');
// \\?\E:\x and \\.\E:\x name the same file as E:\x, and \\?\UNC\h\s is \\h\s. Any other namespace
// (devices, volume GUIDs) is refused.
function plainPath(value: string): string {
  const prefixed = /^[\\/]{2}[?.][\\/]+(.*)$/s.exec(value);
  if (!prefixed) return value;
  if (/^[a-z]:[\\/]/i.test(prefixed[1])) return prefixed[1];
  const unc = /^unc[\\/](.*)$/is.exec(prefixed[1]);
  if (unc) return '\\\\' + unc[1];
  throw new Error('Windows namespace path is not a plain file location');
}
function locationOf(value: string, keyed: boolean): string | undefined {
  if (/^file:/i.test(value)) return fileURLToPath(value);
  // Only network URLs are not file locations. Any other "xx://" value goes through the checks below,
  // where a keyed one is refused for its colon, rather than being waved through as a URL.
  if (/^(?:https?|ftps?|wss?):\/\//i.test(value)) return undefined;
  const plain = plainPath(value);
  if (DRIVE_RELATIVE.test(plain)) throw new Error('Drive-relative path (C:name) is not accepted; give a full path');
  if (keyed || isAbsolute(plain) || /^[a-z]:/i.test(plain) || plain.split(/[\\/]/).includes('..')) return resolve(root, plain);
}
// Windows folds a trailing dot or space off a component, reads "name:stream" as a data stream and
// opens a device for a reserved name, so such a name can reach what realpath reports as missing.
// Refuse it rather than guess.
function ambiguous(full: string): boolean {
  return full.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part) || part.includes(':') || DEVICE_NAME.test(part));
}
// A location that does not exist yet is judged by its nearest existing parent.
async function realLocation(full: string): Promise<string> {
  for (let path = full; ; path = dirname(path)) {
    try { return resolve(await realpath(path), relative(path, full)); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || dirname(path) === path) throw error;
    }
  }
}
// An object key can be a location too (a batch reader keyed by file name), so keys get the same check.
async function guardLocations(value: unknown, declared: ReadonlySet<string>, keyed = false): Promise<void> {
  if (typeof value === 'string') {
    const location = locationOf(value, keyed);
    if (location === undefined) return;
    if (ambiguous(location)) throw new Error('Path has a trailing dot or space, a colon, or a device name in a component');
    const real = await realLocation(location);
    if (!inside(root, real) && !supplied.has(real)) throw new Error('Path outside the review root and supplied inputs');
  } else if (Array.isArray(value)) {
    for (const item of value) await guardLocations(item, declared, keyed);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      await guardLocations(key, declared, keyed);
      await guardLocations(item, declared, keyed || declared.has(key) || LOCATION_KEY.test(key));
    }
  }
}

const fileTools: Tool[] = [
  { name: 'review_status', description: 'Repository HEAD/status, complete supplied-input inventory, read semantics and semantic-tool availability. Check before reviewing.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_files', description: 'List tracked source paths by optional prefix with pagination; total includes unread pages.', inputSchema: { type: 'object', properties: { prefix: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'read_file', description: 'Read current disk contents of a tracked working-tree file or supplied input, with provenance and 1-based lines. This does not read committed HEAD or the index. Supplied paths are listed by review_status.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'git_diff', description: 'Read a diff between full commit SHAs, with external diff and textconv disabled.', inputSchema: { type: 'object', properties: { base: { type: 'string' }, head: { type: 'string' } }, required: ['base', 'head'] } },
  { name: 'search_files', description: 'Case-insensitive text search over tracked files of every type (.cs, .sql, json, docs, scripts), reading the working tree. Plain text by default; regex=true for an extended regular expression. Returns path:line:text.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, prefix: { type: 'string' }, regex: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['pattern'] } },
];
// Extra tools keep the annotations their server declared; launch already dropped the ones that change state.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...[...fileTools, ...semantic].map(tool => ({
  ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
})), ...extraTools] }));
async function callTool(request: CallToolRequest) {
  try {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      // The evidence protocol calls this first, so the wait for the workspace
      // lands here and the reported roslyn_error is a settled answer.
      case 'review_status': await attached; return reply({ root, head: (await access.git(['rev-parse', 'HEAD'])).trim(),
        status: await access.git(['status', '--porcelain']),
        read_semantics: 'read_file returns current disk contents, not HEAD or index blobs. HEAD is repository metadata only. Reads are not an immutable snapshot. git_diff compares committed revisions only.',
        supplied_inputs: access.listInputs(),
        roslyn_error: roslynError || null,
        extra_tools: extraTools.map(tool => tool.name), notes: [...(cfg.notes ?? []), ...extraNotes] });
      case 'list_files': {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 500;
        if (!Number.isInteger(offset) || Number(offset) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 2000) {
          throw new Error('offset must be nonnegative and limit must be 1..2000');
        }
        const files = access.list(String(args.prefix ?? ''));
        return reply({ files: files.slice(Number(offset), Number(offset) + Number(limit)), total: files.length, offset });
      }
      case 'read_file': return reply(await access.read(String(args.path), args.offset as number | undefined, args.limit as number | undefined));
      case 'git_diff': return reply(await access.diff(String(args.base), String(args.head)));
      case 'search_files': return reply(await access.search(String(args.pattern ?? ''), String(args.prefix ?? ''),
        args.limit as number | undefined, args.regex === true));
      default: {
        const extra = extraOwner.get(request.params.name);
        if (extra) {
          // Own properties only: a tool named "constructor" must not read Object's.
          const named = extra.path_args && Object.hasOwn(extra.path_args, request.params.name) ? extra.path_args[request.params.name] : [];
          await guardLocations(args, new Set(named));
          return await (await extraClient(extra)).callTool(request.params);
        }
        // A reviewer that acted on the announcement can call these before the
        // announcement's own round trip settles here.
        await attached;
        // A tool named at startup can still be unreachable, so say which it is.
        if (!roslyn) throw new Error(roslynError || 'Roslyn is not available in review mode');
        if (!semantic.some(tool => tool.name === request.params.name)) throw new Error('Tool is not available in review mode');
        for (const [key, value] of Object.entries(args)) {
          if (/path/i.test(key) && typeof value === 'string' && !inside(root, await realpath(resolve(root, value)))) {
            throw new Error('Semantic path outside the review root');
          }
        }
        await validateWorkspace(roslyn);
        return await roslyn.callTool(request.params);
      }
    }
  } catch (error) {
    return { ...reply(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

let auditWrite = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, async request => {
  const result = await callTool(request);
  if (cfg.audit_path === undefined) return result;
  try {
    const success = !('isError' in result && result.isError);
    const receipt: Record<string, unknown> = {
      attempt: cfg.attempt, tool: request.params.name, success,
    };
    if (success && request.params.name === 'read_file') {
      const read = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      Object.assign(receipt, { resolved_path: read.resolved_path, source: read.source,
        offset: read.offset, count: read.lines.length, total_lines: read.total_lines });
    }
    // Parallel tool calls share one ordered append queue. Only broker results
    // enter this log; model-generated transcripts cannot establish evidence use.
    const pending = auditWrite.then(() => appendFile(cfg.audit_path, JSON.stringify(receipt) + '\n', 'utf8'));
    auditWrite = pending.catch(() => {});
    await pending;
    return result;
  } catch (error) {
    const message = `Review evidence receipt could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`[ERROR] ${message}\n`);
    return { ...reply(message), isError: true };
  }
});
await server.connect(new StdioServerTransport());
connect();
// An attach still in flight owns the only handle on its Roslyn process.
process.stdin.on('end', () => {
  closing = true;
  void roslyn?.close(); void attaching?.close();
  for (const client of extraClients.values()) void client.then(c => c.close()).catch(() => { });
});
