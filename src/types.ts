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
  /** Additional args passed in -p (non-interactive) mode */
  promptModeArgs: string[];
}

export interface Task {
  id: string;
  engine: EngineType;
  status: TaskStatus;
  prompt: string;
  cwd: string;
  stdout: string;
  sentinelContent: string | null;
  startedAt: number;
  completedAt: number | null;
  pid: number | null;
  error: string | null;
}

export const ENGINE_CONFIGS: Record<EngineType, EngineConfig> = {
  codex: {
    command: 'codex',
    promptModeArgs: ['--quiet'],
  },
  gemini: {
    command: 'gemini',
    promptModeArgs: [],
  },
  claude: {
    command: 'claude',
    promptModeArgs: ['--dangerously-skip-permissions'],
  },
};

/** Directory inside cwd where sentinel files and prompt files are written */
export const KIBITZ_DIR = '.kibitz';

/** Default task timeout: 5 minutes */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
