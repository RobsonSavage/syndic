import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** path_args maps a tool name to the argument names that carry file locations; those are always checked. */
export interface McpSpec { name: string; command: string; args?: string[]; tools: string[]; path_args?: Record<string, string[]> }
export interface SkillRef { name: string; path: string }

const MCP_NAME = /^[A-Za-z0-9_-]{1,32}$/;
// The plugin part becomes a folder name, so it cannot carry a separator or "..".
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

function defaultsPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.SYNDIC_DEFAULTS || join(home, '.syndic', 'defaults.json');
}

// A broken defaults file degrades the review and says why. It never fails the call.
export async function loadReviewDefaults(env: NodeJS.ProcessEnv = process.env, home: string = homedir()):
  Promise<{ skills: string[]; mcp: McpSpec[]; notes: string[] }> {
  const empty = { skills: [] as string[], mcp: [] as McpSpec[], notes: [] as string[] };
  const path = defaultsPath(env, home);
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    return { ...empty, notes: [`Defaults file ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let review: { skills?: unknown; mcp?: unknown };
  try { review = JSON.parse(stripBom(text)).review ?? {}; } catch {
    return { ...empty, notes: [`Defaults file ${path} is not valid JSON`] };
  }
  const notes: string[] = [];
  const skills = Array.isArray(review.skills) ? review.skills.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  if (review.skills !== undefined && !Array.isArray(review.skills)) notes.push('Defaults review.skills must be an array of names');
  const mcp: McpSpec[] = [];
  for (const entry of Array.isArray(review.mcp) ? review.mcp : []) {
    const problem = mcpProblem(entry);
    if (problem) notes.push(`Defaults review.mcp entry skipped: ${problem}`); else mcp.push(entry as McpSpec);
  }
  return { skills, mcp, notes };
}

export function mcpProblem(spec: unknown): string | undefined {
  const value = spec as Partial<McpSpec> | null;
  if (!value || typeof value !== 'object') return 'not an object';
  if (typeof value.name !== 'string' || !MCP_NAME.test(value.name)) return 'name must be 1-32 letters, digits, - or _';
  if (typeof value.command !== 'string' || !isAbsolute(value.command)) return `${value.name}: command must be an absolute path`;
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(a => typeof a !== 'string'))) return `${value.name}: args must be strings`;
  if (!Array.isArray(value.tools) || !value.tools.length || value.tools.some(t => typeof t !== 'string' || !t)) {
    return `${value.name}: tools must list the allowed tool names (a review server never exposes a whole server)`;
  }
  // JSON and the zod record treat this key differently, so a mapping or tool under it would not mean the same everywhere.
  if (value.tools.includes('__proto__') || (value.path_args && typeof value.path_args === 'object' && Object.hasOwn(value.path_args, '__proto__'))) {
    return `${value.name}: __proto__ is not supported as a tool name`;
  }
  if (value.path_args !== undefined) {
    const declared = value.path_args as unknown;
    const entries = declared && typeof declared === 'object' && !Array.isArray(declared) ? Object.entries(declared) : undefined;
    if (!entries || entries.some(([, names]) => !Array.isArray(names) || names.some(n => typeof n !== 'string' || !n))) {
      return `${value.name}: path_args must map a tool name to a list of argument names`;
    }
    const unknown = entries.map(([tool]) => tool).filter(tool => !value.tools!.includes(tool));
    if (unknown.length) return `${value.name}: path_args names tools that are not allowed: ${unknown.join(', ')}`;
  }
}

// The last entry of a name wins, so a call replaces a default and the broker never sees two servers under one name.
export function mergeMcp(defaults: McpSpec[], call: McpSpec[]): McpSpec[] {
  const byName = new Map<string, McpSpec>();
  for (const spec of [...defaults, ...call]) { byName.delete(spec.name); byName.set(spec.name, spec); }
  return [...byName.values()];
}

async function skillFiles(root: string, depth = 5): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (level < depth) await walk(path, level + 1); }
      else if (entry.name === 'SKILL.md') found.push(path);
    }
  };
  await walk(root, 0);
  return found;
}

async function frontmatterName(path: string): Promise<string | undefined> {
  try {
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stripBom(await readFile(path, 'utf8')))?.[1];
    return /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(head ?? '')?.[1];
  } catch { /* unreadable file: not a match */ }
}

// Install locations come from the plugin registry, so a plugin update that
// moves the folder (new version, new layout) cannot break the lookup.
async function pluginRoots(plugin: string, home: string): Promise<string[]> {
  const roots: string[] = [];
  try {
    const registry = JSON.parse(await readFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, installs] of Object.entries<unknown>(registry.plugins ?? {})) {
      if (!key.startsWith(`${plugin}@`) || !Array.isArray(installs)) continue;
      for (const install of installs) if (typeof install?.installPath === 'string') roots.push(install.installPath);
    }
  } catch { /* no registry: fall through to the cache folder */ }
  if (roots.length) return roots;
  // shortcut: newest folder by numeric compare, when the registry is missing.
  const cache = join(home, '.claude', 'plugins', 'cache', plugin, plugin);
  try {
    const versions = (await readdir(cache, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map(v => join(cache, v));
  } catch { return []; }
}

// "plugin:skill" is looked up in the plugin's install, a bare "skill" in ~/.claude/skills.
export async function resolveSkills(names: string[], home: string = homedir()):
  Promise<{ found: SkillRef[]; missing: string[] }> {
  const found: SkillRef[] = [];
  const missing: string[] = [];
  for (const name of [...new Set(names)]) {
    const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [undefined, name];
    if (plugin !== undefined && !PLUGIN_NAME.test(plugin)) { missing.push(name); continue; }
    const roots = plugin ? await pluginRoots(plugin, home) : [join(home, '.claude', 'skills')];
    let path: string | undefined;
    for (const root of roots) {
      for (const file of await skillFiles(root)) {
        if (await frontmatterName(file) === skill) { path = file; break; }
      }
      if (path) break;
    }
    if (path) found.push({ name, path }); else missing.push(name);
  }
  return { found, missing };
}
