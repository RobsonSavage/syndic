#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EngineManager } from './engine.js';
import type { Task } from './types.js';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'syndic-mcp',
  version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
});

const manager = new EngineManager();

function taskInfo(task: Task): Record<string, unknown> {
  return {
    task_id: task.id, status: task.status, engine: task.engine,
    duration_ms: (task.completedAt ?? Date.now()) - task.startedAt,
    requested: task.requested, launch: task.launch, observed: task.observed,
    pid: task.pid, termination: task.termination, termination_error: task.terminationError,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  'syndic_run',
  [
    'Spawn an external AI CLI engine to execute a task with full capabilities.',
    'The engine runs in its own process and signals completion by writing a sentinel file.',
    'Default: returns task_id immediately (async). Set wait=true to block until done.',
  ].join(' '),
  {
    engine: z
      .enum(['codex', 'gemini', 'claude', 'opencode'])
      .describe('Which CLI engine to invoke. Use claude for Claude Code CLI.'),
    prompt: z
      .string()
      .min(10)
      .describe('Self-contained task prompt. Be specific — the engine has NO context beyond this.'),
    cwd: z
      .string()
      .optional()
      .describe('Working directory (absolute path, use forward slashes). Defaults to server cwd.'),
    timeout_ms: z
      .number()
      .min(10_000)
      .max(3_600_000)
      .optional()
      .describe('Timeout in ms. Default: 1800000 (30 min). Max: 3600000 (1 hr).'),
    wait: z
      .boolean()
      .optional()
      .describe('If true, block until the task completes or times out. Default: false.'),
    yolo: z
      .boolean()
      .optional()
      .describe(
        'If true, run with no guardrails: Gemini uses --yolo, Codex uses --dangerously-bypass-approvals-and-sandbox. ' +
        'Opencode has no safe/yolo distinction at the CLI level (permissions are enforced via ~/.config/opencode/config.json). ' +
        'Claude safe mode uses dontAsk; unapproved operations are denied. ' +
        'Default: false. These engine defaults are not a read-only review boundary.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Optional model override for Codex, Gemini, Claude Code, or OpenCode (provider/model). ' +
        'Omit to use the CLI default. For Gemini, do not set this unless the user explicitly requests a model.',
      ),
    reasoning_effort: z
      .string()
      .optional()
      .describe(
        'Optional reasoning effort for Codex or Claude Code (for example max), or model variant for OpenCode. ' +
        'Must be supported by the selected model/provider. Omit to use the CLI default. ' +
        'Not supported for Gemini.',
      ),
    mode: z.enum(['default', 'review']).optional().describe('review: controlled read/semantic MCP tools, no shell or report-write tools; syndic captures the final report. Claude/Codex only.'),
    review_inputs: z.array(z.string()).optional().describe('Absolute paths to the factual packet/procedure/evidence the restricted reviewer may read, in addition to tracked source.'),
    review_roslyn: z.object({ command: z.string(), args: z.array(z.string()).optional() }).optional()
      .describe('Trusted Roslyn executable and arguments from host configuration. Only an allowlist of semantic tools is exposed; no memory or mutations.'),
  },
  async ({ engine, prompt, cwd, timeout_ms, wait, yolo, model, reasoning_effort, mode, review_inputs, review_roslyn }) => {
    try {
      if (mode !== 'review' && (review_inputs || review_roslyn)) throw new Error('Review options require mode=review');
      const task = await manager.run(engine, prompt, cwd, timeout_ms, wait, yolo, model, reasoning_effort,
        mode === 'review' ? { inputs: review_inputs ?? [], roslyn: review_roslyn } : undefined);

      if (wait && task.status !== 'running') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ...taskInfo(task),
                  output_content: task.outputContent,
                  result: (task.sentinelContent || task.stdout || 'No output captured').substring(
                    0,
                    50_000,
                  ),
                  error: task.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ...taskInfo(task),
                message: 'Task spawned. Use syndic_status to check progress.',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error spawning engine: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'syndic_status',
  'Check the status of a syndic task. Returns result content if the task has completed.',
  {
    task_id: z.string().describe('Task ID returned by syndic_run'),
  },
  async ({ task_id }) => {
    const task = await manager.inspectTask(task_id);
    if (!task) {
      return {
        content: [{ type: 'text' as const, text: `Unknown task: ${task_id}` }],
        isError: true,
      };
    }

    const info = taskInfo(task);

    if (task.status !== 'running' && task.status !== 'stopping') {
      info.output_content = task.outputContent;
      info.result = (task.sentinelContent || task.stdout || 'No output').substring(0, 50_000);
      info.error = task.error;
    } else {
      // Show tail of stdout for progress visibility
      const tail = task.stdout.length > 500 ? task.stdout.slice(-500) : task.stdout;
      info.stdout_tail = tail || '(no output yet)';
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
    };
  },
);

server.tool(
  'syndic_cancel',
  'Stop the task process job and wait for termination evidence. Returns termination state; unknown is not stopped.',
  {
    task_id: z.string().describe('Task ID to cancel'),
  },
  async ({ task_id }) => {
    const success = await manager.cancel(task_id);
    const task = manager.getTask(task_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ accepted: success, ...(task ? taskInfo(task) : { error: 'Unknown task' }) }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`syndic-mcp failed to start: ${err}\n`);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.stdin.on('end', () => { void shutdown(); });
