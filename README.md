# syndic-mcp

An MCP server that lets any MCP-capable AI host (Claude Code, Cursor, Cline, etc.) spawn and orchestrate external AI CLI engines — **Codex**, **Gemini CLI**, and **Claude Code** — as subagents for parallel or delegated task execution.

Tasks run in their own processes. Completion is detected via a sentinel file written by the engine, so the orchestrator never polls or blocks unnecessarily.

## How it works

1. The orchestrating AI calls `syndic_run` with an engine, a prompt, and an optional working directory.
2. syndic-mcp writes the full task (prompt + structured completion protocol) to a `.syndic/<id>.prompt` file in the working directory.
3. The chosen CLI engine is spawned via `cmd.exe /c` and instructed to read and execute that file.
4. When the engine finishes, it writes its results to `.syndic/<id>.output.md` and a structured sentinel to `.syndic/<id>.md`.
5. syndic-mcp detects the sentinel (via `fs.watch` + process-exit fallback), reads the output, and marks the task complete.
6. The orchestrating AI polls with `syndic_status` or uses `wait: true` for synchronous execution.

## Prerequisites

Install the CLI engines you intend to use:

| Engine | Install |
|--------|---------|
| Codex CLI | `npm install -g @openai/codex` |
| Gemini CLI | `npm install -g @google/gemini-cli` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |

Node.js >= 18 required.

## Installation

```bash
npm install -g syndic-mcp
```

Or run directly without installing:

```bash
npx syndic-mcp
```

## MCP Configuration

Add to your MCP host's config (e.g. `claude_desktop_config.json`, `.claude.json`, `mcp.json`):

```json
{
  "mcpServers": {
    "syndic": {
      "command": "syndic-mcp"
    }
  }
}
```

Or with `npx`:

```json
{
  "mcpServers": {
    "syndic": {
      "command": "npx",
      "args": ["syndic-mcp"]
    }
  }
}
```

## Tools

### `syndic_run`

Spawn an external AI CLI engine to execute a task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `engine` | `"codex" \| "gemini" \| "claude"` | Yes | Which CLI engine to invoke |
| `prompt` | `string` | Yes | Self-contained task prompt (≥10 chars, ≤200,000 chars). The engine has **no context** beyond this string. |
| `cwd` | `string` | No | Absolute working directory path. Defaults to the server's cwd. |
| `timeout_ms` | `number` | No | Timeout in ms. Range: 10,000–3,600,000. Default: 300,000 (5 min). |
| `wait` | `boolean` | No | If `true`, block until the task completes or times out. Default: `false` (returns `task_id` immediately). |

**Async response** (`wait: false`):
```json
{
  "task_id": "abc1234567",
  "status": "running",
  "engine": "codex",
  "message": "Task spawned. Use syndic_status to check progress."
}
```

**Sync response** (`wait: true`):
```json
{
  "task_id": "abc1234567",
  "status": "completed",
  "engine": "gemini",
  "duration_ms": 12400,
  "output_content": "## Output\n...",
  "result": "---\nstatus: completed\n---\n\n## Summary\n...",
  "error": null
}
```

---

### `syndic_status`

Check the status of a task by its ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | `string` | Yes | ID returned by `syndic_run` |

While running, returns a tail of stdout for progress visibility. When complete, returns the full output and sentinel content.

**Task statuses:** `running` | `completed` | `failed` | `cancelled` | `timed_out`

---

### `syndic_cancel`

Kill a running task immediately.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | `string` | Yes | ID of the task to cancel |

## Completion protocol

syndic-mcp instructs each engine to write two files when it finishes:

**`.syndic/<id>.output.md`** — findings, results, or generated content:
```markdown
## Output
(engine's findings/results)
```

**`.syndic/<id>.md`** — structured sentinel (read by syndic-mcp):
```markdown
---
status: completed
---

## Summary
(what was accomplished)

## Files Changed
(list of changed files, or "None")

## Issues
(problems encountered, or "None")
```

If the engine hits an unrecoverable error it uses `status: failed` in the sentinel. syndic-mcp falls back to process exit code if no sentinel is written.

## Working directory and file isolation

Each task creates files under `.syndic/` in the working directory:

```
<cwd>/
└── .syndic/
    ├── <id>.prompt      # task instructions (written by syndic-mcp)
    ├── <id>.output.md   # results (written by engine)
    └── <id>.md          # completion sentinel (written by engine)
```

You can safely add `.syndic/` to `.gitignore`.

## Example: parallel code review

```
syndic_run(engine="codex", prompt="Review src/auth.ts for security issues. List findings in the output file.", cwd="/my/project")
syndic_run(engine="gemini", prompt="Review src/auth.ts for performance issues. List findings in the output file.", cwd="/my/project")
```

Poll both with `syndic_status` until complete, then compare results.

## Platform notes

- **Windows only** in the current release. Engines are spawned via `cmd.exe /c` to handle `.cmd` shims (npm global installs on Windows).
- `MSYS2_ARG_CONV_EXCL=*` is set in the child environment to prevent MSYS2/Git Bash path mangling.

## License

MIT
