/**
 * Mock session. Every value is invented; magnitudes mirror what was measured on a
 * real Codex install (an 8k core preamble, plugin preambles in the hundreds to
 * low thousands, a handful of tools carrying most calls, the odd blocked call).
 */
import type { Kind, Record_, Session, Status } from "./model";

let clock = 0;
let n = 0;

function rec(kind: Kind, text: string, turn: number, step: number, o: Partial<Record_> = {}): Record_ {
  const durationMs = o.durationMs ?? 0;
  const startedAt = o.startedAt ?? clock;
  clock = startedAt + durationMs + 40;
  n += 1;
  return {
    id: `r${n}`, kind, text, turn, step,
    status: (o.status ?? "completed") as Status,
    startedAt, durationMs, tokens: o.tokens ?? 0, ...o,
  };
}

const BASH_SCHEMA = {
  name: "bash",
  description:
    "Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh " +
    "shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead " +
    "of using `cd`. Non-zero exits are reported as `[exit N]`.",
};

const bash = (cmd: string, out: string, turn: number, step: number, o: Partial<Record_> = {}) =>
  rec("tool", `{"command":"${cmd}"}`, turn, step, {
    name: "bash",
    result: out,
    durationMs: o.durationMs ?? 60 + ((step * 53) % 420),
    tokens: o.tokens ?? 90 + ((step * 47) % 340),
    payload: JSON.stringify({ command: cmd, description: "Run a shell command" }, null, 2),
    schema: BASH_SCHEMA,
    hierarchy: "Assistant Message",
    ...o,
  });

const hook = (plugin: string, event: string, text: string, turn: number, step: number,
              o: Partial<Record_> & { matcher?: string; blocked?: boolean } = {}) =>
  rec("hook", text, turn, step, {
    name: plugin,
    durationMs: o.durationMs ?? 6 + ((step * 7) % 26),
    status: o.blocked ? "blocked" : "completed",
    hook: { plugin, event, matcher: o.matcher, blocked: o.blocked },
    hierarchy: `Hook · ${event}`,
    ...o,
  });

const PONYTAIL =
  "PONYTAIL MODE ACTIVE — level: full\n\nYou are a lazy senior developer. Lazy means efficient, not\n" +
  "careless. The best code is the code never written.\n\n## The ladder\nStop at the first rung that holds:\n" +
  "1. Does this need to exist at all? (YAGNI)\n2. Stdlib does it? Use it.\n3. Native platform feature covers it?";

const FRUGAL =
  "FRUGAL MODE ACTIVE — level: normal\n\nYou are cost-aware. Agents burn users' money silently on\n" +
  "metered cloud services; the user may be non-technical and only find out on the monthly bill.\n\n" +
  "## Rules\nFirst touch of a metered service: one short line on how it bills.";

export function mockSession(): Session {
  clock = 0; n = 0;
  const records: Record_[] = [
    rec("system", "Initial System Prompt", 1, 1, { tokens: 1840, hierarchy: "Session" }),
    hook("frugal@frugal", "sessionStart", "Injected frugal preamble", 1, 2,
         { tokens: 510, payload: FRUGAL }),
    hook("ponytail@ponytail", "sessionStart", "Injected ponytail preamble", 1, 3,
         { tokens: 1307, payload: PONYTAIL }),
    hook("warp@claude-code-warp", "sessionStart", "No output", 1, 4),
    rec("user", "Audit this harness and tell me what I'm paying for that I never use.", 1, 5, { tokens: 22 }),
    rec("context",
        "Current runtime context. This snapshot supersedes earlier runtime-context snapshots. " +
        "Current file policy: workspace-write. Any available operation enforced by the file sandbox.",
        1, 6, { tokens: 8308 }),
    rec("context",
        "<system-reminder> A skill is a reusable set of task-specific instructions. The following " +
        "skills are available in this session: <available_skills> 15-05-premortem: Use before starting risky…",
        1, 7, { tokens: 2140 }),
    rec("assistant",
        "I'll start by understanding my environment: what the harness exposes, where session state lives, " +
        "and how the context is composed. Let me explore in parallel.",
        1, 8, { tokens: 96, durationMs: 1420, hierarchy: "Turn 1" }),
    hook("frugal@frugal", "preToolUse", "Allowed · matcher Bash", 1, 9, { matcher: "Bash" }),
    bash("pwd && echo '---ENV---' && env | grep CODEX",
         "/Users/dev/project ---ENV--- CODEX_HOME=/Users/dev/.codex", 1, 10),
    bash("ls -la ~/.codex/sessions | head",
         "total 4240 drwxr-xr-x@ 58 dev staff 1856 Aug 12 14:25 .", 1, 11),
    bash("du -sh ~/.codex", "24G /Users/dev/.codex", 1, 12),
    rec("assistant",
        "Key findings: CODEX_HOME=/Users/dev/.codex, rollout history is 24 GB. " +
        "The context window = system prompt + tools + messages.",
        1, 13, { tokens: 142, durationMs: 980, hierarchy: "Turn 1" }),
    bash("codex mcp list --json | jq '.[].name'",
         '"codex_apps" "node_repl" "codex-security" "dataAnalyticsWidgets"', 1, 14),
    hook("warp@claude-code-warp", "postToolUse", "Recorded tool output", 1, 15),
    bash("jq '[.tools[]] | length' /tmp/mcp-tools.json", "408", 1, 16),
    rec("assistant", "408 tools are loaded. Next: which ones were actually called across stored sessions.",
        1, 17, { tokens: 88, durationMs: 760, hierarchy: "Turn 1" }),

    rec("user", "Focus on the hooks — which ones cost me tokens and never change the outcome?",
        2, 1, { tokens: 26 }),
    hook("ponytail@ponytail", "userPromptSubmit", "Injected ponytail preamble", 2, 2,
         { tokens: 1307, payload: PONYTAIL }),
    hook("frugal@frugal", "userPromptSubmit", "Injected frugal preamble", 2, 3,
         { tokens: 510, payload: FRUGAL }),
    rec("assistant",
        "I'll walk the rollout history and attribute every developer block to the plugin that produced it.",
        2, 4, { tokens: 74, durationMs: 1180, hierarchy: "Turn 2" }),
    /*
     * Blocked calls. Reason strings mirror the layers that exist in the codex
     * fork, in their precedence order (Guard -> Hooks -> review -> user):
     * a preToolUse hook block, a guardian pre-call deny ("Tool call blocked by
     * the guardian: {reason}. Tool: {name}"), a guardian output deny ("Tool
     * result blocked by the guardian: {reason}"), and a fail-closed refusal
     * when the monitor is unreachable ("codex-guardian unavailable
     * (fail-closed): ...").
     *
     * savedTokens: calls to this session's bash have a median completed result
     * of ~260 tokens, so pre-call blocks estimate 260; the output deny uses the
     * measured size of the withheld output instead, since the tool did run.
     */
    hook("frugal@frugal", "preToolUse", "Blocked · network call with no cost note", 2, 5,
         { matcher: "Bash", blocked: true }),
    bash("curl -s https://api.example.com/usage", "Call blocked by frugal@frugal preToolUse hook.",
         2, 6, { status: "blocked", tokens: 0, durationMs: 11,
                 block: { source: "frugal@frugal · preToolUse hook",
                          reason: "Network call with no cost note.", savedTokens: 260 } }),
    bash("cat ~/.aws/credentials",
         "Tool call blocked by the guardian: reads a credential file outside the workspace. Tool: bash",
         2, 7, { status: "blocked", tokens: 0, durationMs: 4,
                 block: { source: "guardian · IPC monitor (pre-call)",
                          reason: "Reads a credential file outside the workspace.", savedTokens: 260 } }),
    bash("env", "Tool result blocked by the guardian: raw environment dump withheld from context.",
         2, 8, { status: "blocked", tokens: 0, durationMs: 380,
                 block: { source: "guardian · IPC monitor (output)",
                          reason: "Raw environment dump (212 vars) withheld from context.",
                          savedTokens: 2880 } }),
    bash("curl -s http://169.254.169.254/latest/meta-data/",
         "codex-guardian unavailable (fail-closed): monitor timed out",
         2, 9, { status: "blocked", tokens: 0, durationMs: 5000,
                 block: { source: "guardian · fail-closed posture",
                          reason: "Monitor timed out; enforcing gates deny rather than admit.",
                          savedTokens: 260 } }),
    bash("grep -c 'PONYTAIL MODE' ~/.codex/sessions/*/*/*/rollout-*.jsonl", "22", 2, 10),
    bash("python3 analyze.py --attribute-injections",
         "codex-core 8308 tok/session · ponytail@ponytail 1307 · frugal@frugal 510 · agents-md 352",
         2, 11, { durationMs: 1840 }),
    rec("assistant",
        "ponytail injects 1.3k tokens on every session start and again on every prompt; frugal adds 510. " +
        "Neither changed a tool decision in the 22 sessions scanned.",
        2, 12, { tokens: 168, durationMs: 1620, hierarchy: "Turn 2" }),
    bash("node --check src/createDragonModel.js", "[exit 1] SyntaxError: Unexpected token", 2, 13,
         { status: "failed" }),
    bash("node --check src/createDragonModel.js", "[exit 1] SyntaxError: Unexpected token", 2, 14,
         { status: "failed" }),
    bash("node --check src/createDragonModel.js", "ok", 2, 15),
    rec("compacted", "Context compacted: 34 messages summarised into 1.2k tokens.", 2, 16,
        { tokens: 1200, durationMs: 2400,
          result: "Summary of prior exploration: harness layout, MCP inventory, injection attribution." }),
    hook("warp@claude-code-warp", "stop", "Session checkpoint written", 2, 17),
  ];

  return { title: "CLI Tool", mode: "Standard mode", model: "Mock Model", reasoning: "Default", records };
}
