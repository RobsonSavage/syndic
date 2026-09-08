import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReviewAccess, inside } from './review-access.js';

// Deliberately excludes memory, graph, configuration, execution and mutation tools.
const SEMANTIC_TOOLS = new Set(['get_workspace_status', 'find_references', 'find_callers',
  'find_callees', 'find_definition', 'find_implementations', 'get_method_body', 'get_type_members',
  'get_file_outline', 'understand_method', 'understand_type', 'analyze_data_flow', 'get_errors', 'text_search']);

const cfg = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = await realpath(cfg.root);
const access = new ReviewAccess(root);
await access.initialize(cfg.inputs);
const server = new Server({ name: 'syndic-review', version: '1' }, { capabilities: { tools: {} } });
const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });
let roslyn: Client | undefined;
let semantic: Tool[] = [];
let roslynError = 'Roslyn launcher not supplied';

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

async function validateWorkspace(): Promise<void> {
  const result = await roslyn!.callTool({ name: 'get_workspace_status', arguments: {} });
  const path = solutionPath(result);
  if (result.isError || !path || !inside(root, await realpath(path))) {
    throw new Error('Roslyn solution mismatch or unavailable');
  }
}

if (cfg.roslyn) {
  try {
    roslyn = new Client({ name: 'syndic-review', version: '1' });
    const transport = new StdioClientTransport({ command: cfg.roslyn.command, args: cfg.roslyn.args ?? [],
      cwd: root, env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')),
      stderr: 'pipe' });
    transport.stderr?.on('data', () => { /* upstream diagnostics never become reviewer memory/context */ });
    await roslyn.connect(transport);
    const selection = await roslyn.callTool({ name: 'set_solution_root', arguments: { rootPath: root, warmUp: false } });
    if (selection.isError) throw new Error('Roslyn selection failed');
    await validateWorkspace();
    semantic = (await roslyn.listTools()).tools.filter(tool => SEMANTIC_TOOLS.has(tool.name));
    roslynError = '';
  } catch (error) {
    roslynError = error instanceof Error ? error.message : String(error);
    await roslyn?.close();
    roslyn = undefined;
  }
}

const tools: Tool[] = [
  { name: 'review_status', description: 'Repository HEAD/status, complete supplied-input inventory, read semantics and semantic-tool availability. Check before reviewing.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_files', description: 'List tracked source paths by optional prefix with pagination; total includes unread pages.', inputSchema: { type: 'object', properties: { prefix: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'read_file', description: 'Read current disk contents of a tracked working-tree file or supplied input, with provenance and 1-based lines. This does not read committed HEAD or the index. Supplied paths are listed by review_status.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'git_diff', description: 'Read a diff between full commit SHAs, with external diff and textconv disabled.', inputSchema: { type: 'object', properties: { base: { type: 'string' }, head: { type: 'string' } }, required: ['base', 'head'] } },
  ...semantic,
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
  ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
})) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case 'review_status': return reply({ root, head: (await access.git(['rev-parse', 'HEAD'])).trim(),
        status: await access.git(['status', '--porcelain']),
        read_semantics: 'read_file returns current disk contents, not HEAD or index blobs. HEAD is repository metadata only. Reads are not an immutable snapshot. git_diff compares committed revisions only.',
        supplied_inputs: access.listInputs(),
        roslyn_error: roslynError || null });
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
      default: {
        if (!roslyn || !semantic.some(tool => tool.name === request.params.name)) throw new Error('Tool is not available in review mode');
        for (const [key, value] of Object.entries(args)) {
          if (/path/i.test(key) && typeof value === 'string' && !inside(root, await realpath(resolve(root, value)))) {
            throw new Error('Semantic path outside the review root');
          }
        }
        await validateWorkspace();
        return await roslyn.callTool(request.params);
      }
    }
  } catch (error) {
    return { ...reply(error instanceof Error ? error.message : String(error)), isError: true };
  }
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void roslyn?.close(); });
