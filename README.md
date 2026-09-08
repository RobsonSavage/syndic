# syndic-mcp

An MCP server that lets any MCP-capable AI host (Claude Code, Cursor, Cline, etc.) spawn and orchestrate external AI CLI engines — **Codex**, **Gemini CLI**, **Claude Code**, and **OpenCode** — as subagents for parallel or delegated task execution.

Tasks run in their own processes. Completion is detected via a sentinel file written by the engine, so the orchestrator never polls or blocks unnecessarily.

## How it works

1. The orchestrating AI calls `syndic_run` with an engine, a prompt, and an optional working directory.
2. syndic-mcp writes the full task (prompt + structured completion protocol) to a `.syndic/<id>.prompt` file in the working directory.
3. A Windows supervisor starts the CLI suspended, assigns it to a process job, then resumes it. Native executables and recognized npm shims run without a command shell.
4. When the engine finishes, it writes its results to `.syndic/<id>.output.md` and a structured sentinel to `.syndic/<id>.md`.
5. syndic-mcp validates the sentinel, reads the output, stops the process job, and confirms termination before reporting the outcome.
6. The orchestrating AI polls with `syndic_status` or uses `wait: true` for synchronous execution.

## Prerequisites

Install the CLI engines you intend to use:

| Engine | Install |
|--------|---------|
| Codex CLI | `npm install -g @openai/codex` |
| Gemini CLI | `npm install -g @google/gemini-cli` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| OpenCode | `npm install -g @anthropic-ai/opencode` |

Node.js >= 18, Windows, and PowerShell 7 (`pwsh.exe` on PATH) are required.

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
| `engine` | `"codex" \| "gemini" \| "claude" \| "opencode"` | Yes | Which CLI engine to invoke |
| `prompt` | `string` | Yes | Self-contained task prompt (≥10 chars, ≤200,000 chars). The engine has **no context** beyond this string. |
| `cwd` | `string` | No | Absolute working directory path. Defaults to the server's cwd. |
| `timeout_ms` | `number` | No | Timeout in ms. Range: 10,000–3,600,000. Default: 1,800,000 (30 min). |
| `wait` | `boolean` | No | If `true`, block until the task completes or times out. Default: `false` (returns `task_id` immediately). |
| `yolo` | `boolean` | No | If `true`, run engine without guardrails. Default: `false` (safe mode). See [Safe mode vs YOLO mode](#safe-mode-vs-yolo-mode). |
| `model` | `string` | No | Model override for Codex, Gemini, Claude Code, or OpenCode (`provider/model`). Omit to use the CLI default. For Gemini, only set when the user explicitly requests a model. |
| `reasoning_effort` | `string` | No | Codex or Claude Code reasoning effort, or OpenCode model variant, supported by the selected model/provider. Omit to use the CLI default. Rejected for Gemini. |
| `mode` | `"default" \| "review"` | No | `review` restricts Claude/Codex to source/semantic inspection and captures their final report. Requires `yolo: false`. |
| `review_inputs` | `string[]` | No | Absolute paths to packet/procedure/evidence files the reviewer may read, in addition to tracked repository source. |
| `review_roslyn` | `{command: string, args?: string[]}` | No | Override the automatic per-user Roslyn installation with a trusted absolute executable and arguments. Review mode only. |

For Codex with Astra at max effort, pass `engine="codex", model="gpt-6-astra", reasoning_effort="max"` to `syndic_run` along with the task prompt. These settings override the CLI defaults for that invocation. OpenCode receives the same fields through `--model` and `--variant`; use its provider/model identifier and a supported variant.

For Claude Code, pass `engine="claude"`, optionally with `model="opus"` and `reasoning_effort="max"`. Syndic launches `claude -p` and forwards the overrides through `--model` and `--effort`. Without overrides, Claude Code uses its configured defaults.

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

**Task statuses:** `running` | `stopping` | `completed` | `failed` | `cancelled` | `timed_out`

All responses include `requested` model/effort, `launch` settings/mode, `observed`
CLI metadata with provenance, `pid`, `termination`, and `termination_error`.
Observed metadata may be unavailable (null). It is never filled from the request
or model self-description. A CLI banner/event is not provider attestation.
`termination` is `running`, `stopping`, `stopped`, or `unknown`. Only `stopped`
confirms that the supervised job contains no active processes.

---

### `syndic_cancel`

Request job termination and wait for evidence. Returns structured task state.
An unknown termination state remains cancellable even when task status is failed.
Timeout initiates termination automatically. The supervisor also terminates its
job if the parent connection closes; its job handle uses kill-on-close for crashes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | `string` | Yes | ID of the task to cancel |

## Safe mode vs YOLO mode

Each engine supports two permission levels, selected by the `yolo` parameter:

| Engine | Safe (`yolo: false`, default) | YOLO (`yolo: true`) |
|--------|-------------------------------|---------------------|
| Codex | `exec -s workspace-write` (writes confined to workspace, unrestricted reads) | `exec --dangerously-bypass-approvals-and-sandbox` (no sandbox, no approvals) |
| Gemini | `--approval-mode=auto_edit` (auto-approves file writes only) | `--yolo` (auto-approves all tools including shell commands) |
| Claude | `--permission-mode dontAsk` (unapproved operations denied) | `--dangerously-skip-permissions` |
| OpenCode | `run --auto` (auto-approve unless explicitly denied by config) | `run --auto` (same policy) |

Default mode is not a read-only boundary. Use `mode: review` for the restrictions
below. Existing Claude automation that needs writes must supply appropriate CLI
permissions or explicitly select unrestricted mode; safe mode no longer bypasses
permission checks.

## Restricted review mode

The CLI runs in temporary storage, with user hooks/plugins/memory disabled and an
environment allowlist retaining OS startup variables and model authentication.
No credential files are copied. Claude has no built-in tools; Codex has its shell,
apps and delegation disabled and uses its read-only sandbox. Only the supplied
review MCP server is configured. Installed CLIs must support these controls;
unsupported flags fail the run instead of falling back to default mode.

The broker exposes tracked-file listing and bounded reads, explicit evidence-file
reads, diffs between full SHAs (external diff/textconv disabled), and repository
status. Paths escaping the source root are denied unless explicitly supplied as
review inputs. It has no arbitrary command, write, publication, or memory tools.
`review_status` lists all supplied inputs, including snapshots outside the repository
that do not appear in `list_files`. `read_file` labels current disk reads as
`working_tree` or `supplied_input`, with a resolved path and no asserted revision.
Tracked-file access does not mean committed HEAD contents; the reported HEAD is
repository metadata, and reads are not frozen against concurrent edits. Only
`git_diff` compares committed revisions. Reviewers are instructed to inspect the
input inventory and relevant supplied evidence before reporting missing coverage.
Unavailable Roslyn semantic tools do not make supplied Roslyn scripts unavailable.
The reviewer returns Markdown in its final response; syndic writes the output and
sentinel after the CLI exits. The coordinator validates coverage and saves/publishes
the report. A transport success is not evidence of a complete review.

Review mode automatically uses `%LOCALAPPDATA%/RoslynMcp/RoslynMcp.Server.exe`,
the standard per-user installation. Supply `review_roslyn` to override that launcher
for a custom installation. Executables are never discovered from the reviewed
repository or its PATH. Roslyn owns solution discovery: a repository without a
supported solution gets no semantic tools. Missing installations and selection or
startup failures are reported in `review_status.roslyn_error`.
The broker selects
the source root with `warmUp=false` and validates solution containment before
semantic queries. Each broker owns its own stdio server; same-solution instances
can share Roslyn's on-disk cache/database. Errors become explicit coverage gaps.
Arbitrary builds/tests run separately in the coordinator's approved environment.

This is a tool-access boundary, not OS containment of a compromised CLI or semantic
server. Roslyn can evaluate project metadata and write caches. Use trusted tooling
and source environments; do not put secrets in review evidence. The Windows job
controls process lifetime, not network or filesystem privileges.

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

If the engine hits an unrecoverable error it uses `status: failed` in the sentinel.
Only the exact single status field in frontmatter is parsed. Partial/malformed
sentinels or a missing paired output cannot certify completion. Default mode still
falls back to process exit code when no sentinel exists; consumers must check that
usable output exists. Review mode requires a captured final response.

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

- **Windows only**. PowerShell 7 compiles the bundled job supervisor at runtime.
  Recognized npm JS launchers run through Node; other command shims use validated
  `cmd.exe` arguments. Unsupported shell expansion characters are rejected.
- `MSYS2_ARG_CONV_EXCL=*` is set in the child environment to prevent MSYS2/Git Bash path mangling.

## License

MIT
