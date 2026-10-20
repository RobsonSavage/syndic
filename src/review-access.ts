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
    const result = await exec('git.exe', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.pager=cat', ...args], { cwd: this.root, windowsHide: true, timeout: 30_000,
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

  async diff(base: string, head: string): Promise<string> {
    if (![base, head].every(value => /^[a-fA-F0-9]{40,64}$/.test(value))) throw new Error('Full commit SHAs required');
    return this.git(['diff', '--no-ext-diff', '--no-textconv', base, head, '--']);
  }
}
