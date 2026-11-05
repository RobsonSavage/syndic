import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const exec = promisify(execFile);
export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export class ReviewAccess {
  private files = new Set<string>();
  private inputs = new Set<string>();
  constructor(readonly root: string) { }

  async git(args: string[]): Promise<string> {
    // GIT_CONFIG_NOSYSTEM/GLOBAL below also drop the user's safe.directory entries, so a repo owned by
    // another account (a copied drive, an elevated checkout) fails ls-files with "dubious ownership" and
    // the broker dies before its MCP handshake. The root is the repo the caller chose to review.
    const result = await exec('git.exe', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.pager=cat', '-c', `safe.directory=${this.root.replaceAll('\\', '/')}`, ...args], { cwd: this.root, windowsHide: true, timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    return result.stdout;
  }

  async initialize(inputs: string[]): Promise<void> {
    for (const path of (await this.git(['ls-files', '-z'])).split('\0').filter(Boolean)) {
      this.files.add(path);
    }
    for (const path of inputs) this.inputs.add(await realpath(path));
  }

  list(prefix = ''): string[] { return [...this.files].filter(path => path.startsWith(prefix)); }

  listInputs(): string[] { return [...this.inputs]; }

  async read(path: string, offset = 1, limit = 200): Promise<object> {
    const full = await realpath(resolve(this.root, path));
    const rel = relative(this.root, full).split(sep).join('/');
    if (!this.inputs.has(full) && (!inside(this.root, full) || !this.files.has(rel))) {
      throw new Error('Read denied: only tracked repository files and explicit review inputs are available');
    }
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 2000) {
      throw new Error('offset must be positive and limit must be 1..2000');
    }
    if ((await stat(full)).size > 2 * 1024 * 1024) throw new Error('File exceeds 2 MiB; report a coverage gap');
    const text = await readFile(full, 'utf8');
    if (text.includes('\0')) throw new Error('Binary file; report a coverage gap');
    const lines = text.split(/\r?\n/);
    return { path, resolved_path: full,
      source: this.inputs.has(full) ? 'supplied_input' : 'working_tree',
      revision: null,
      total_lines: lines.length, offset, lines: lines.slice(offset - 1, offset - 1 + limit) };
  }

  // git grep covers tracked files of every type, read from the working tree like read_file.
  async search(pattern: string, prefix = '', limit = 100, regex = false): Promise<{ matches: string[]; total: number; truncated: boolean }> {
    if (!pattern || pattern.length > 200) throw new Error('pattern must be 1..200 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be 1..500');
    if (prefix.startsWith(':') || prefix.split(/[\\/]/).includes('..')) throw new Error('prefix must be a plain repository path');
    let out = '';
    try {
      out = await this.git(['-c', 'core.quotepath=false', 'grep', '-n', '-I', '-i', regex ? '-E' : '-F', '--no-color', '-e', pattern, '--', ...(prefix ? [prefix] : [])]);
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Too many matches; narrow the pattern or the prefix');
      if (code !== 1) throw error; // exit 1 is "no match"
    }
    const lines = out.split(/\r?\n/).filter(Boolean);
    return { matches: lines.slice(0, limit).map(line => line.slice(0, 300)), total: lines.length, truncated: lines.length > limit };
  }

  // Any revision git understands (HEAD~1, a branch) becomes a full SHA here, so the reviewer needs no SHA to hand.
  private async commit(rev: string): Promise<string> {
    if (!rev || rev.length > 200 || rev.startsWith('-') || /[\s\0]/.test(rev)) throw new Error('Revision must be a commit SHA, branch, tag or HEAD~n');
    try {
      return (await this.git(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
    } catch { throw new Error(`Unknown revision: ${rev}`); }
  }

  // One page per call: every reply stays under the smallest client cap on MCP output, so none spills to a file the reviewer cannot read.
  // The text of all pages joins, with no separator, into the whole diff. offset counts units: one line, or a piece of a line too long to fit a page.
  async diff(base: string, head: string, path = '', offset = 0, budget = 40_000): Promise<object> {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be nonnegative');
    if (path.length > 4096 || path.startsWith(':') || path.split(/[\\/]/).includes('..')) throw new Error('path must be a plain repository path');
    const [from, to] = [await this.commit(base), await this.commit(head)];
    // --no-renames keeps every numstat path usable as a path argument; --literal-pathspecs keeps path from acting as a glob.
    const spec = ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
    const range = [from, to, '--', ...(path ? [path] : [])];
    let text: string;
    try {
      text = await this.git([...spec, ...range]);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Diff exceeds 8 MiB; pass path to read one file');
      throw error;
    }
    const units = splitUnits(text, budget / 2);
    const files = (await this.git([...spec, '--numstat', '-z', ...range])).split('\0').filter(Boolean);
    // The file list shares page 0 with the text, so it takes its own slice of the reply cap.
    let listed = 0;
    for (let used = 0; listed < files.length; listed++) {
      used += JSON.stringify(files[listed]).length + 1;
      if (used > 15_000) break;
    }
    let end = offset;
    for (let used = 0; end < units.length; end++) {
      used += JSON.stringify(units[end]).length;
      if (used > budget && end > offset) break;
    }
    return { base: from, head: to, path: path || null, files_total: files.length,
      ...(offset === 0 && { files: files.slice(0, listed), files_listed: listed }),
      total_lines: units.length, offset, next_offset: end < units.length ? end : null, text: units.slice(offset, end).join('') };
  }
}

// Lines keep their newline, so joining units restores the text. A unit over the limit (escaped) is cut into pieces that fit.
export function splitUnits(text: string, limit: number): string[] {
  const units: string[] = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    let rest = line;
    while (JSON.stringify(rest).length > limit) {
      let cut = Math.min(rest.length, limit);
      while (JSON.stringify(rest.slice(0, cut)).length > limit) cut = Math.floor(cut / 2);
      if (cut > 1 && /[\ud800-\udbff]/.test(rest[cut - 1])) cut--; // never end a piece inside a surrogate pair
      units.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    units.push(rest);
  }
  return units;
}

// Characters a client will count for a tool result: text parts as sent, every other part and field as JSON.
export function replySize(result: object): number {
  const { content, ...others } = result as { content?: unknown };
  const parts = Array.isArray(content) ? content : [];
  return parts.reduce((sum: number, part: { type?: unknown; text?: unknown }) =>
    sum + (part.type === 'text' && typeof part.text === 'string' ? part.text.length : JSON.stringify(part).length), 0)
    + JSON.stringify(others).length;
}
