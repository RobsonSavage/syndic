import { mkdtemp, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineType, Task } from './types.js';

export interface ReviewOptions {
  inputs: string[];
  roslyn?: { command: string; args?: string[] };
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
export interface ReviewLaunch {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  result(): Promise<string>;
  observe(task: Task, stdout: string, stderr: string): void;
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

export function reviewEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'CODEX_HOME',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
}

export async function prepareReview(engine: EngineType, root: string, prompt: string,
  options: ReviewOptions, auditPath?: string): Promise<ReviewLaunch> {
  if (engine !== 'claude' && engine !== 'codex') throw new Error('Review mode supports Claude and Codex only');
  const roslyn = await resolveReviewRoslyn(options.roslyn);
  const inputs = await Promise.all(options.inputs.map(path => realpath(path)));
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
      'Return the complete Markdown report as your final response. Syndic saves it. Do not write files.',
    ].join('\n');
    const taskPrompt = prompt + '\n\n' + evidenceProtocol + '\n';
    await writeFile(promptPath, taskPrompt, 'utf8');
    const resolvedPrompt = await realpath(promptPath);
    const promptLines = taskPrompt.split(/\r?\n/).length;
    const writeAccess = () => writeFile(join(cwd, 'access.json'), JSON.stringify({ root,
      inputs: [...inputs, promptPath], audit_path: auditFile, attempt,
      roslyn: roslyn.roslyn, roslyn_error: roslyn.error }), 'utf8');
    await writeAccess();
    const server = { command: process.execPath, args: [fileURLToPath(new URL('./review-server.js', import.meta.url)), join(cwd, 'access.json')] };
    const env: NodeJS.ProcessEnv = { ...reviewEnvironment(process.env), MSYS2_ARG_CONV_EXCL: '*',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
    const boot = `Call syndic_review review_status for the supplied-input inventory and read semantics, then use read_file to read ${promptPath.replaceAll('\\', '/')} and perform that review. Return the report in your final response`;
    let args: string[];
    if (engine === 'claude') {
      // Cold Roslyn solution loading completes before the broker accepts MCP connections.
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
    return { cwd, args, env, cleanup,
      observe(task, stdout, stderr) {
        if (engine === 'claude') {
          for (const line of stdout.split(/\r?\n/)) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
                task.observed = { model: event.model, reasoning_effort: null, source: 'CLI system.init event' };
              }
              if (event.type === 'result' && !event.is_error && typeof event.result === 'string') response = event.result;
            } catch { }
          }
        } else {
          const model = /^model:\s*(\S+)\s*$/m.exec(stderr)?.[1];
          const effort = /^reasoning effort:\s*(\S+)\s*$/m.exec(stderr)?.[1];
          if (model || effort) task.observed = { model: model ?? null, reasoning_effort: effort ?? null, source: 'CLI launch banner' };
        }
      },
      async result() {
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
