export type EngineType = 'codex' | 'gemini' | 'claude';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface EngineConfig {
  command: string;
  /** Args placed before the prompt (e.g. subcommand, flags) */
  promptModeArgs: string[];
  /** Flag preceding the prompt string (e.g. '-p'). Empty string = positional (no flag). */
  promptFlag: string;
}

export interface Task {
  id: string;
  engine: EngineType;
  status: TaskStatus;
  prompt: string;
  cwd: string;
  stdout: string;
  sentinelContent: string | null;
  /** Content of .syndic/{id}.output.md written by the engine before the sentinel. */
  outputContent: string | null;
  startedAt: number;
  completedAt: number | null;
  pid: number | null;
  error: string | null;
}

export const ENGINE_CONFIGS: Record<EngineType, EngineConfig> = {
  // `codex exec` is the proper headless subcommand (no TTY, no Ink TUI).
  // --full-auto required for write access; default sandbox is read-only.
  // Prompt is positional — codex exec has no -p flag.
  codex: {
    command: 'codex',
    promptModeArgs: ['exec', '--full-auto'],
    promptFlag: '',
  },
  // -p triggers headless mode. --approval-mode=auto_edit auto-approves file
  // writes; without it gemini hangs waiting for y/n in non-interactive mode.
  gemini: {
    command: 'gemini',
    promptModeArgs: ['--approval-mode=auto_edit'],
    promptFlag: '-p',
  },
  claude: {
    command: 'claude',
    promptModeArgs: ['--dangerously-skip-permissions'],
    promptFlag: '-p',
  },
};

/** Directory inside cwd where sentinel files and prompt files are written */
export const SYNDIC_DIR = '.syndic';

/** Default task timeout: 5 minutes */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Maximum allowed prompt size in characters (~50k tokens at 4 chars/token).
 * The completion protocol sits at the end of the prompt file; if the file is
 * too large the engine may truncate it before reaching those instructions,
 * causing the task to time out with no sentinel written.
 * Both Codex CLI (codex-mini-latest, ~200k tokens) and Gemini CLI
 * (gemini-2.5-pro+, 1M tokens) comfortably support this limit.
 */
export const MAX_PROMPT_CHARS = 200_000;
