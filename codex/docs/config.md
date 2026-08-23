# Configuration

For basic configuration instructions, see [this documentation](https://developers.openai.com/codex/config-basic).

For advanced configuration instructions, see [this documentation](https://developers.openai.com/codex/config-advanced).

For a full configuration reference, see [this documentation](https://developers.openai.com/codex/config-reference).

## Lifecycle hooks

Admins can set top-level `allow_managed_hooks_only = true` in
`requirements.toml` to ignore user, project, and session hook configs while
still allowing managed hooks from requirements and managed config layers. This
setting is only supported in `requirements.toml`; putting it in `config.toml`
does not enable managed-hooks-only mode.

## Guard layer (`[guardian]`)

The guard layer is an inline reference monitor that runs *above* the hook
subsystem. At every dispatch choke point — prompt intake, tool and MCP calls,
tool results, approvals, MCP server admission — it is asked for a verdict before
any configured hook runs, so its decision cannot be overridden by hook config.
Precedence at a choke point is Guard → Hooks → automated review → user. It also
records session activity that hooks never see, such as token usage and live
context-window occupancy.

```toml
[guardian]
# off | csv | ipc | both
# Default: csv for a debug build, off for a release build.
mode = "csv"
# Per-session history. Default: $CODEX_HOME/guardian/debug
debug_dir = "/Users/me/.codex/guardian/debug"
# Socket of the resident guardian process. Default: $CODEX_HOME/guardian/guardian.sock
socket_path = "/Users/me/.codex/guardian/guardian.sock"
# Deny guarded actions when the guardian cannot be reached. Default: true
fail_closed = true
# Deadline for one round trip to the guardian process. Default: 3000
request_timeout_ms = 3000
```

- `csv` writes one CSV file per session, `<debug_dir>/<thread_id>.csv`, with a
  fixed header and one row per guarded action and recorded activity. It never
  denies anything; it is a debugging and audit record. Beside each file sits a
  `<thread_id>.meta.yml` sidecar holding everything constant for that session —
  the session it belongs to, the account, the model, the originator, the
  starting directory, and running totals. Those are deliberately not columns,
  so grouping sidecars by `session_id` reassembles a run that spawned
  sub-agents without opening a single history file. The TUI session header
  names the directory whenever a mode that records is active.
- `ipc` delegates every decision to a resident local process listening on
  `socket_path`, exchanging newline-delimited JSON: the request carries the
  session context plus the action, and the reply carries a verdict of `allow`,
  `deny`, `rewrite`, or `defer`. `rewrite` replaces a prompt, a tool input, or a
  tool result; `defer` falls through to the layers below.
- `both` records locally and enforces through the resident process.

A build from source records by default so that a session run while debugging
leaves a trail without having been configured in advance. Released binaries
default to `off`: writing every prompt and tool result to disk is opt-in. Files
are written `0600` inside a `0700` directory, but they do contain prompt text
and tool output, so treat the directory as sensitive.

With `fail_closed = true` (the default), an unreachable guardian denies guarded
actions, so a session started in `ipc` mode without a running guardian will have
its tool calls blocked. Set `mode = "off"` or `fail_closed = false` to opt out of
that posture.
