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
# off (default)
mode = "off"
```

With `mode = "off"` the guard is a no-op: nothing is reviewed and nothing is
recorded, and the choke points cost one virtual call each.
