import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

export interface ProcessReceipt {
  pid: number;
  termination: 'running' | 'stopped';
  exit_code: number | null;
}

/** cmd quoting for our fixed boot prompt and identifier arguments, not arbitrary shell code. */
export function commandLine(command: string, args: string[]): string {
  const values = [command, ...args];
  for (const value of values) {
    if (/["%!\r\n\0]/.test(value)) throw new Error('Unsupported cmd argument character');
  }
  return `cmd.exe /d /s /c "${values.map(value => `"${value}"`).join(' ')}"`;
}

/** Windows CRT argument quoting, used only when no cmd.exe parser is involved. */
export function quoteArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

async function nativeCommandLine(command: string, args: string[]): Promise<string> {
  // MCP clients commonly omit PATHEXT. Resolve supported file types explicitly,
  // without where.exe's environment-dependent extension expansion.
  const paths = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter)
    .filter(Boolean).flatMap(dir => /\.(exe|cmd)$/i.test(command) ? [join(dir, command)] :
      [join(dir, `${command}.exe`), join(dir, `${command}.cmd`)]);
  const candidates: string[] = [];
  for (const path of paths) {
    try { if ((await stat(path)).isFile()) candidates.push(path); } catch { }
  }
  if (!candidates.length) throw new Error(`CLI not found on PATH: ${command}`);
  const executable = candidates.find(path => /\.exe$/i.test(path));
  if (executable) return [executable, ...args].map(quoteArgument).join(' ');
  const shim = candidates.find(path => /\.cmd$/i.test(path));
  if (shim) {
    const content = await readFile(shim, 'utf8');
    const entry = /"%dp0%[\\/]([^"\r\n]+\.js)"\s+%\*/.exec(content)?.[1];
    if (entry) return [process.execPath, resolve(dirname(shim), entry), ...args].map(quoteArgument).join(' ');
  }
  return commandLine(candidates[0], args);
}

export interface ManagedProcess {
  proc: ChildProcess;
  receipt(): Promise<ProcessReceipt | null>;
  stop(): void;
}

export async function launchProcess(command: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, launchFile: string): Promise<ManagedProcess> {
  if (process.platform !== 'win32') throw new Error('Syndic requires Windows and PowerShell 7');
  const receiptPath = `${launchFile}.receipt`;
  await writeFile(launchFile, JSON.stringify({ commandLine: await nativeCommandLine(command, args), cwd, receipt: receiptPath }), 'utf8');
  const proc = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./native/supervisor.ps1', import.meta.url)), '-LaunchFile', launchFile],
  { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stdin?.on('error', () => { /* close handler reports the supervisor failure */ });
  return {
    proc,
    async receipt() {
      try {
        const value = JSON.parse(await readFile(receiptPath, 'utf8'));
        return Number.isInteger(value.pid) && ['running', 'stopped'].includes(value.termination) ? value : null;
      } catch { return null; }
    },
    stop() { if (proc.stdin?.writable) proc.stdin.end('stop\n'); },
  };
}
