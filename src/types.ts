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
  /** Args placed before the prompt in safe mode (e.g. subcommand, flags) */
  safeArgs: string[];
  /** Args placed before the prompt in YOLO mode (no guardrails) */
  yoloArgs: string[];
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
  // Prompt is positional — codex exec has no -p flag.
  codex: {
    command: 'codex',
    safeArgs: ['exec', '--full-auto'],
    yoloArgs: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
    promptFlag: '',
  },
  // -p triggers headless mode.
  gemini: {
    command: 'gemini',
    safeArgs: ['--approval-mode=auto_edit'],
    yoloArgs: ['--yolo'],
    promptFlag: '-p',
  },
  claude: {
    command: 'claude',
    safeArgs: ['--dangerously-skip-permissions'],
    yoloArgs: ['--dangerously-skip-permissions'],
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
