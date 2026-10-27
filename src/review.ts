import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMANTIC_TOOLS, type EngineType, type Task } from './types.js';
import { loadReviewDefaults, mergeMcp, resolveSkills, type McpSpec } from './defaults.js';

export interface ReviewOptions {
  inputs: string[];
  roslyn?: { command: string; args?: string[] };
  /** Skill names ("plugin:skill" or "skill") whose SKILL.md the reviewer must read and apply. */
  skills?: string[];
  /** Extra MCP servers the reviewer may use, limited to the named tools. */
  mcp?: McpSpec[];
  /** false ignores the defaults file. */
  defaults?: boolean;
}

export class LiteralToolInvocationError extends Error {
  constructor(readonly output: string) {
    super('CLI returned literal tool invocation text instead of a review report.');
  }
}

export class ReviewEvidenceError extends Error {
  constructor(readonly output: string, reason: string) {
    super(`Review evidence verification failed: ${reason}`);
  }
}

// Resolve only the trusted per-user installation, never an executable in the
// reviewed repository or on its PATH. Roslyn owns solution discovery.
export async function resolveReviewRoslyn(override: ReviewOptions['roslyn'],
  env: NodeJS.ProcessEnv = process.env): Promise<{ roslyn?: ReviewOptions['roslyn']; error?: string }> {
  if (override) {
    if (!isAbsolute(override.command) || !/\.exe$/i.test(override.command)) {
      throw new Error('review_roslyn.command must be the absolute trusted executable path');
    }
    return { roslyn: override };
  }
  if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) return { error: 'Automatic Roslyn resolution failed: LOCALAPPDATA must be an absolute path. Install Roslyn or supply review_roslyn.' };
  const command = join(env.LOCALAPPDATA, 'RoslynMcp', 'RoslynMcp.Server.exe');
  try {
    if (!(await stat(command)).isFile()) throw new Error('not a file');
    return { roslyn: { command, args: [] } };
  } catch (error) {
    return { error: `Automatic Roslyn resolution failed at ${command}: ${error instanceof Error ? error.message : String(error)}. Install Roslyn or supply review_roslyn.` };
  }
}
// Codex fixes a session's tool inventory from the first tools/list answer and
// ignores a later tools/list_changed, so the broker has to name the semantic
// tools before Roslyn has opened anything. Their descriptions belong to the
// installed Roslyn, so they are read from it once per build and kept here.
const TOOL_CACHE = join(tmpdir(), 'syndic-roslyn-tools.json');
const TOOL_LIST_MS = 30_000;

async function readToolCache(stamp: string): Promise<Tool[] | undefined> {
  try {
    const cache = JSON.parse(await readFile(TOOL_CACHE, 'utf8'));
    if (cache.stamp === stamp && Array.isArray(cache.tools)) return cache.tools;
  } catch { /* absent or unreadable: read the descriptions from Roslyn again */ }
}

// Only the descriptions are read here. Selecting the solution is the slow part
// and stays in the broker, where a review can wait for it.
export async function semanticTools(roslyn: NonNullable<ReviewOptions['roslyn']>): Promise<Tool[]> {
  let stamp: string;
  try {
    const exe = await stat(roslyn.command);
    stamp = `${roslyn.command}:${exe.mtimeMs}:${exe.size}`;
  } catch { return []; }
  const cached = await readToolCache(stamp);
  if (cached) return cached;
  const client = new Client({ name: 'syndic-review-tools', version: '1' });
  let expiry: ReturnType<typeof setTimeout> | undefined;
  try {
    const listing = (async () => {
      // Roslyn selects a solution from its working directory at startup. This
      // process only reads descriptions, so it is started where there is none.
      await client.connect(new StdioClientTransport({ command: roslyn.command, args: roslyn.args ?? [],
        cwd: tmpdir(), env: Object.fromEntries(Object.entries(reviewEnvironment(process.env))
          .filter((pair): pair is [string, string] => typeof pair[1] === 'string')), stderr: 'pipe' }));
      return (await client.listTools()).tools.filter(tool => SEMANTIC_TOOLS.has(tool.name));
    })();
    listing.catch(() => { });
    const tools = await Promise.race([listing, new Promise<never>((_, reject) => {
      expiry = setTimeout(() => reject(new Error('Roslyn did not list its tools in time')), TOOL_LIST_MS);
    })]);
    // Concurrent reviews write the same descriptions; renaming keeps every
    // reader on one complete file.
    const scratch = `${TOOL_CACHE}.${process.pid}`;
    await writeFile(scratch, JSON.stringify({ stamp, tools }), 'utf8');
    await rename(scratch, TOOL_CACHE);
    return tools;
  } catch {
    // A reviewer with no semantic tools is degraded, not broken.
    return [];
  } finally {
    clearTimeout(expiry);
    await client.close().catch(() => { });
  }
}

// Same fixed-inventory reason as semanticTools: Codex reads the tool list once,
// so the schemas of an extra server's allowed tools are read before the launch.
// It runs from the review root, as the broker will, so relative args resolve the same way.
async function upstreamTools(spec: McpSpec, root: string): Promise<{ tools: Tool[]; error?: string }> {
  const client = new Client({ name: 'syndic-review-extra', version: '1' });
  let expiry: ReturnType<typeof setTimeout> | undefined;
  try {
    const listing = (async () => {
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args ?? [], cwd: root,
        env: Object.fromEntries(Object.entries(reviewEnvironment(process.env))
          .filter((pair): pair is [string, string] => typeof pair[1] === 'string')), stderr: 'pipe' });
      // An unread stderr pipe fills and blocks a chatty server before it answers the handshake.
      transport.stderr?.on('data', () => { });
      await client.connect(transport);
      return (await client.listTools()).tools;
    })();
    listing.catch(() => { });
    const all = await Promise.race([listing, new Promise<never>((_, reject) => {
      expiry = setTimeout(() => reject(new Error('did not list its tools in time')), TOOL_LIST_MS);
    })]);
    const named = all.filter(tool => spec.tools.includes(tool.name));
    // Review mode changes nothing, so a tool its server declares as changing state is not offered.
    const mutating = named.filter(tool => tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true);
    const tools = named.filter(tool => !mutating.includes(tool));
    const absent = spec.tools.filter(name => !named.some(tool => tool.name === name));
    const problems = [absent.length ? `server has no tool ${absent.join(', ')}` : '',
      mutating.length ? `${mutating.map(tool => tool.name).join(', ')} declared as changing state, not offered in review mode` : ''].filter(Boolean);
    return { tools, error: problems.length ? `${spec.name}: ${problems.join('; ')}` : undefined };
  } catch (error) {
    return { tools: [], error: `${spec.name}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(expiry);
    await client.close().catch(() => { });
  }
}

export interface ReviewLaunch {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  result(): Promise<string>;
  observe(task: Task, stdout: string, stderr: string): void;
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

export function reviewEnvironment(source: NodeJS.ProcessEnv, extraKeys: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'CODEX_HOME',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', ...extraKeys.map(key => key.toUpperCase())]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
}

/** Env var names an OpenCode provider reads its API key from. OpenCode names them after the provider id, except Google. */
export function openCodeProviderKeys(model: string): string[] {
  const provider = model.split('/')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return [`${provider}_API_KEY`, ...(provider === 'GOOGLE' ? ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] : []), 'OPENCODE_API_KEY'];
}

const readJson = async (path: string): Promise<any> => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
};

/**
 * A custom provider block that is safe to hand to the review run: an object whose only option is baseURL (a local
 * server such as ollama). Anything else, apiKey and headers included, would put a secret in the config or drop a setting.
 */
function forwardableProvider(block: any): object | undefined {
  return block && typeof block === 'object' && Object.keys(block.options ?? {}).every(key => key === 'baseURL') ? block : undefined;
}

/**
 * The provider block for the model's provider from OpenCode's config.json. Review mode runs with an empty home and loads
 * no config, so a custom provider (ollama) has no route unless its block is passed in.
 */
export async function openCodeProviderBlock(model: string, configDir: string = join(homedir(), '.config', 'opencode')): Promise<object | undefined> {
  return forwardableProvider((await readJson(join(configDir, 'config.json')))?.provider?.[model.split('/')[0]]);
}

/**
 * The model OpenCode itself would start with: the first favorite of the picker's state file (model.json), then the
 * top-level "model" of config.json, then the most recent model in model.json. Review mode runs with an empty home and loads neither
 * file, so only the model name is read to stand in for an omitted `model`. Environment API keys play no part in the
 * choice: an unreachable provider fails in OpenCode with its own error.
 * Same identifier rule as a caller-supplied model, because the value reaches cmd.exe.
 * shortcut: reads config.json and model.json only (no JSONC, no other file names), extend when a config uses another name.
 */
export async function openCodeConfigModel(
  configDir: string = join(homedir(), '.config', 'opencode'),
  stateDir: string = join(homedir(), '.local', 'state', 'opencode'),
): Promise<string | undefined> {
  const config = await readJson(join(configDir, 'config.json'));
  const state = await readJson(join(stateDir, 'model.json'));
  const entry = (e: any): string | undefined =>
    typeof e?.providerID === 'string' && typeof e?.modelID === 'string' ? `${e.providerID}/${e.modelID}` : undefined;
  return [entry(state?.favorite?.[0]), config?.model, entry(state?.recent?.[0])].find((model): model is string =>
    typeof model === 'string' && model.includes('/') && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model));
}

/** OpenCode review mode cannot hide tools.opencode.* from the model, so a call to it is found after the fact. */
export function openCodePolicyViolation(part: { tool?: unknown; state?: { input?: { code?: unknown } } } | undefined): string | undefined {
  const tool = typeof part?.tool === 'string' ? part.tool : '';
  if (tool && tool !== 'execute' && !tool.startsWith('syndic_review')) return `called tool ${tool}.`;
  const code = part?.state?.input?.code;
  if (typeof code !== 'string') return undefined;
  if (/\btools\s*\[\s*["'`]opencode["'`]\s*\]/.test(code)) return 'called tools.opencode by computed name.';
  for (const [, name] of code.matchAll(/\btools\s*\.\s*opencode\s*\.\s*(\w+)/g)) {
    if (!OPENCODE_READ_ONLY_HELPERS.has(name)) return `called tools.opencode.${name}.`;
  }
  if (/\btools\s*\.\s*opencode\s*(?![.\w])/.test(code)) return 'used tools.opencode directly.';
  return undefined;
}

// Built-in OpenCode 2.1.2 helpers that only read. Every other tools.opencode.* helper is rejected.
const OPENCODE_READ_ONLY_HELPERS = new Set(['models', 'list_mcp_resources', 'read_mcp_resource', 'worktree_list']);

export async function prepareReview(engine: EngineType, root: string, prompt: string,
  options: ReviewOptions, auditPath?: string, model?: string): Promise<ReviewLaunch> {
  if (engine !== 'claude' && engine !== 'codex' && engine !== 'opencode') throw new Error('Review mode supports Claude, Codex and OpenCode only');
  // The engine fills an omitted model from OpenCode's config (openCodeConfigModel); what reaches here is all there is.
  if (engine === 'opencode' && !model?.includes('/')) throw new Error('OpenCode review mode needs model as provider/model, and neither the OpenCode config nor its model.json names one.');
  const roslyn = await resolveReviewRoslyn(options.roslyn);
  const semantic = roslyn.roslyn ? await semanticTools(roslyn.roslyn) : [];
  const defaults = options.defaults === false ? { skills: [], mcp: [], notes: [] } : await loadReviewDefaults();
  const notes = [...defaults.notes];
  const skills = await resolveSkills([...defaults.skills, ...(options.skills ?? [])]);
  if (skills.missing.length) notes.push(`Requested skills not found: ${skills.missing.join(', ')}. Mark the coverage they would add as incomplete.`);
  const extraMcp = await Promise.all(mergeMcp(defaults.mcp, options.mcp ?? []).map(async spec => {
    const listed = await upstreamTools(spec, root);
    if (listed.error) notes.push(`Extra MCP ${listed.error}`);
    return { ...spec, tools: listed.tools };
  }));
  // Only the caller's evidence must be read for a report to count; skills are readable but not evidence.
  const inputs = await Promise.all(options.inputs.map(path => realpath(path)));
  const skillInputs = await Promise.all(skills.found.map(skill => realpath(skill.path)));
  const cwd = await mkdtemp(join(tmpdir(), 'syndic-review-'));
  const cleanup = async () => {
    await rm(cwd, { recursive: true, force: true });
  };
  try {
    const promptPath = join(cwd, 'task.prompt');
    const auditFile = auditPath ?? join(cwd, 'evidence.jsonl');
    let attempt = 1;
    const evidenceProtocol = [
      'Syndic evidence protocol:',
      'Call review_status before inspecting evidence. Its supplied_inputs inventory includes files outside list_files.',
      'read_file reads current disk contents, not committed HEAD or index blobs. A tracked path is an access rule, not revision provenance.',
      'Attribute reads to working_tree or supplied_input as returned. A snapshot filename or matching contents does not prove a commit. git_diff compares only the requested commits.',
      'Check supplied_inputs and read relevant supplied files before claiming evidence is unavailable. Roslyn tool availability is separate from supplied Roslyn source snapshots.',
      'In the report, identify evidence used and relevant evidence left unread, including failed reads and unread line ranges. Unread evidence is not unavailable evidence.',
      ...(skills.found.length ? ['Skill instructions are supplied inputs. Read each one before reviewing and apply it: ' +
        skills.found.map(skill => `${skill.name} (${skill.path.replaceAll('\\', '/')})`).join(', ') + '.'] : []),
      'review_status lists notes about requested skills and extra tools. Report any that affect coverage.',
      'search_files finds text in tracked files of every type (.sql, json, docs, scripts), which the Roslyn text search does not cover. Search the names a change touches before concluding nothing else uses them.',
      'Return the complete Markdown report as your final response. Syndic saves it. Do not write files.',
      ...(engine === 'opencode' ? ['Use only the syndic_review tools, called as tools.syndic_review.<name> inside execute. Never call tools.opencode.session_*, tools.opencode.worktree_create or any other tools.opencode.* helper that changes state: a review that calls one is rejected.'] : []),
    ].join('\n');
    const taskPrompt = prompt + '\n\n' + evidenceProtocol + '\n';
    await writeFile(promptPath, taskPrompt, 'utf8');
    const resolvedPrompt = await realpath(promptPath);
    const promptLines = taskPrompt.split(/\r?\n/).length;
    const writeAccess = () => writeFile(join(cwd, 'access.json'), JSON.stringify({ root,
      inputs: [...inputs, ...skillInputs, promptPath], audit_path: auditFile, attempt,
      roslyn: roslyn.roslyn, roslyn_error: roslyn.error, semantic_tools: semantic,
      extra_mcp: extraMcp, notes }), 'utf8');
    await writeAccess();
    const server = { command: process.execPath, args: [fileURLToPath(new URL('./review-server.js', import.meta.url)), join(cwd, 'access.json')] };
    const env: NodeJS.ProcessEnv = { ...reviewEnvironment(process.env, engine === 'opencode' ? openCodeProviderKeys(model!) : []), MSYS2_ARG_CONV_EXCL: '*',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
    const boot = `Call syndic_review review_status for the supplied-input inventory and read semantics, then use read_file to read ${promptPath.replaceAll('\\', '/')} and perform that review. Return the report in your final response` +
      (engine === 'opencode' ? '. Call only tools.syndic_review.* inside execute. Never call tools.opencode.session_*, tools.opencode.worktree_create or any other tools.opencode.* helper that changes state; a review that does is rejected' : '');
    let args: string[];
    if (engine === 'claude') {
      // Solution loading runs behind the handshake, so this covers only a slow
      // broker start on a loaded machine.
      env.MCP_TIMEOUT = '240000';
      await writeFile(join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { syndic_review: server } }), 'utf8');
      await writeFile(join(cwd, 'settings.json'), JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), 'utf8');
      args = ['--restricted', '--strict-mcp-config', '--mcp-config', 'mcp.json', '--tools', '',
        '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__syndic_review__*',
        '--setting-sources', '', '--settings', 'settings.json', '--disable-slash-commands',
        '--no-session-persistence', '--no-chrome', '--output-format', 'stream-json', '--verbose',
        // Preserve the CLI's native tool-use guidance; instruction-file loading
        // is disabled separately in the environment above.
        '--append-system-prompt', 'Review only the supplied evidence using the syndic_review tools. Invoke tools through native tool calls and wait for their results; do not print tool invocations as text. Return a Markdown report. Memory and external actions are outside this task.',
        '-p', boot];
    } else if (engine === 'opencode') {
      // OpenCode 2 reads its config, agents, plugins, MCP servers and stored logins from the home folder,
      // so an empty home is the only isolation that drops them all. Provider keys then come from the
      // allow-listed environment above. The review server keeps the real home: Roslyn needs it.
      const realHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
      const home = join(cwd, 'home');
      await mkdir(home, { recursive: true });
      const providerBlock = await openCodeProviderBlock(model!);
      env.USERPROFILE = home;
      env.HOME = home;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        autoupdate: false, share: 'disabled',
        // Verified live on OpenCode 2.1.2: this layout reaches syndic_review through the `execute` tool
        // (tools.syndic_review.*) and blocks bash, edit and read. It does NOT block tools.opencode.*
        // (session_rename ran, worktree_create ran and failed only because the folder is not a git repo),
        // and denying them by name or with '*' hides the MCP tools too.
        // shortcut: the helpers are blocked by the prompt and rejected after the fact (openCodePolicyViolation), not prevented.
        permission: { 'syndic_review_*': 'allow', bash: 'deny', edit: 'deny', read: 'deny', glob: 'deny', grep: 'deny',
          lsp: 'deny', webfetch: 'deny', websearch: 'deny', question: 'deny', skill: 'deny', external_directory: 'deny', task: 'deny' },
        mcp: { syndic_review: { type: 'local', enabled: true, command: [server.command, ...server.args],
          environment: { USERPROFILE: realHome, HOME: realHome } } },
        ...(providerBlock && { provider: { [model!.split('/')[0]]: providerBlock } }),
      });
      env.OPENCODE_DISABLE_CLAUDE_CODE = '1';
      env.OPENCODE_DISABLE_AUTOUPDATE = '1';
      // --standalone: the default background service keeps its own config and would ignore the above.
      args = ['run', '--standalone', '--format', 'json', boot];
    } else {
      // --ignore-user-config also suppresses file profiles on the installed CLI.
      // Explicit overrides are applied after that suppression. No auth is copied.
      const overrides = ['project_doc_max_bytes=0', 'web_search="disabled"',
        'features.shell_tool=false', 'features.code_mode=false', 'features.code_mode_host=true',
        'features.apps=false', 'features.plugins=false', 'features.hooks=false', 'features.memories=false',
        'features.multi_agent=false', 'features.skill_search=false', 'features.skip_host_skill_discovery=true',
        `mcp_servers.syndic_review.command=${JSON.stringify(server.command)}`,
        `mcp_servers.syndic_review.args=${JSON.stringify(server.args)}`,
        'mcp_servers.syndic_review.startup_timeout_sec=240', 'mcp_servers.syndic_review.tool_timeout_sec=120'];
      args = ['exec', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral',
        '--skip-git-repo-check', '-s', 'read-only', ...overrides.flatMap(value => ['-c', value]), '-o', 'response.md', boot];
    }
    let response = '';
    let policyViolation: string | undefined;
    return { cwd, args, env, cleanup,
      // The Codex launch banner is read by the engine manager, which records it
      // in every mode.
      observe(task, stdout) {
        if (engine === 'opencode') {
          // The report is the text of the last step: a step that ends in tool calls carries only narration.
          let text = '';
          policyViolation = undefined;
          for (const line of stdout.split(/\r?\n/)) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'step_start') text = '';
              if (event.type === 'text' && typeof event.part?.text === 'string') text += event.part.text;
              if (event.type === 'tool_use') policyViolation ??= openCodePolicyViolation(event.part);
            } catch { }
          }
          response = text;
          return;
        }
        if (engine !== 'claude') return;
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
              task.observed = { model: event.model, reasoning_effort: null, source: 'CLI system.init event' };
            }
            if (event.type === 'result' && !event.is_error && typeof event.result === 'string') response = event.result;
          } catch { }
        }
      },
      async result() {
        if (policyViolation) throw new Error(`OpenCode review rejected: ${policyViolation}`);
        const output = engine === 'codex' ? await readFile(join(cwd, 'response.md'), 'utf8') : response;
        if (!output.trim()) throw new Error('CLI did not return a review report');
        // Some engines end successfully with serialized tool calls in their text
        // response. Those calls were never dispatched and are not a report.
        // Allow the corrupted opener words reported in Claude issue #74063.
        // Reject a response consisting only of a fenced invocation too.
        if (/^\s*(?:```(?:xml)?\s*)?(?:(?:court|count|course|call)\s+)?(?:<(?:antml:)?function_calls>\s*)?<(?:antml:)?invoke\b/i.test(output)) {
          throw new LiteralToolInvocationError(output);
        }
        // A narrative preamble does not make a simulated tool transcript valid.
        // Preserve Markdown quotations, fenced samples and inline code in reports.
        let fence: string | undefined;
        for (const line of output.split(/\r?\n/)) {
          if (/^\s*>/.test(line)) continue;
          const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
          if (marker) {
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
            continue;
          }
          if (!fence && /<(?:antml:)?invoke\b/i.test(line.replace(/(`+).*?\1/g, ''))) {
            throw new LiteralToolInvocationError(output);
          }
        }
        // Only the restricted broker writes these receipts. Model-authored text,
        // including a plausible transcript or CLI result, is not proof of a read.
        let receipts: Array<{ attempt: number; tool: string; success: boolean;
          resolved_path?: string; offset?: number; count?: number; total_lines?: number }>;
        try {
          receipts = (await readFile(auditFile, 'utf8')).split(/\r?\n/)
            .filter(Boolean).map(line => JSON.parse(line))
            .filter(event => event.attempt === attempt && event.success === true);
        } catch {
          throw new ReviewEvidenceError(output, 'no readable broker receipts for this attempt.');
        }
        if (!receipts.some(event => event.tool === 'review_status')) {
          throw new ReviewEvidenceError(output, 'review_status was not successfully called.');
        }
        const ranges = receipts.filter(event => event.tool === 'read_file' && event.resolved_path === resolvedPrompt &&
          event.total_lines === promptLines && Number.isInteger(event.offset) && Number.isInteger(event.count) &&
          event.offset! >= 1 && event.count! > 0)
          .sort((left, right) => left.offset! - right.offset!);
        let nextLine = 1;
        for (const range of ranges) {
          if (range.offset! > nextLine) break;
          nextLine = Math.max(nextLine, range.offset! + range.count!);
        }
        if (nextLine <= promptLines) {
          throw new ReviewEvidenceError(output, `task.prompt was not fully read (first unread line: ${nextLine}).`);
        }
        if (inputs.length && !receipts.some(event => event.tool === 'read_file' &&
          inputs.includes(event.resolved_path!) && event.count! > 0)) {
          throw new ReviewEvidenceError(output, 'none of the supplied input files were read.');
        }
        return output;
      },
      async reset() {
        response = '';
        attempt++;
        await writeAccess();
        if (engine === 'codex') await rm(join(cwd, 'response.md'), { force: true });
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
