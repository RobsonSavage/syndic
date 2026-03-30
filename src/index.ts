#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EngineManager } from './engine.js';

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'syndic-mcp',
  version: '0.1.0',
});

const manager = new EngineManager();

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
      .enum(['codex', 'gemini', 'claude'])
      .describe('Which CLI engine to invoke'),
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
      .describe('Timeout in ms. Default: 300000 (5 min). Max: 3600000 (1 hr).'),
    wait: z
      .boolean()
      .optional()
      .describe('If true, block until the task completes or times out. Default: false.'),
    yolo: z
      .boolean()
      .optional()
      .describe(
        'If true, run with no guardrails: Gemini uses --yolo, Codex uses --dangerously-bypass-approvals-and-sandbox. ' +
        'Default: false (safe mode — auto_edit / full-auto).',
      ),
  },
  async ({ engine, prompt, cwd, timeout_ms, wait, yolo }) => {
    try {
      const task = await manager.run(engine, prompt, cwd, timeout_ms, wait, yolo);

      if (wait && task.status !== 'running') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  task_id: task.id,
                  status: task.status,
                  engine: task.engine,
                  duration_ms: (task.completedAt ?? Date.now()) - task.startedAt,
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
                task_id: task.id,
                status: 'running',
                engine: task.engine,
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
    const task = manager.getTask(task_id);
    if (!task) {
      return {
        content: [{ type: 'text' as const, text: `Unknown task: ${task_id}` }],
        isError: true,
      };
    }

    const info: Record<string, unknown> = {
      task_id: task.id,
      status: task.status,
      engine: task.engine,
      duration_ms: (task.completedAt ?? Date.now()) - task.startedAt,
    };

    if (task.status !== 'running') {
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
  'Cancel a running syndic task. Kills the engine process immediately.',
  {
    task_id: z.string().describe('Task ID to cancel'),
  },
  async ({ task_id }) => {
    const success = manager.cancel(task_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: success
            ? `Task ${task_id} cancelled.`
            : `Task ${task_id} not found or already finished.`,
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

process.on('SIGINT', () => {
  manager.shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  manager.shutdown();
  process.exit(0);
});
