/**
 * Session trajectory: the ledger of everything a session did — context injected,
 * models called, tools run, hooks fired — with a Chrome-network-style overview
 * strip on top and a per-record inspector on the right.
 *
 * Our own implementation. Data is mock.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { KIND_LABEL, laneOf, LANES, sessionEnd, tabsFor, totals,
         type Kind } from "./model";
import { mockSession } from "./mock";
import "./trajectory.css";

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtMs = (ms: number) =>
  ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  : `${Math.round(ms)}ms`;

const P = {
  clock: "M8 4.6v3.6l2.3 1.4M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  rows: "M2.5 4h11M2.5 8h11M2.5 12h11",
  calls: "M2.5 3.5h5.5v4H2.5zM8 8.5h5.5v4H8z",
  download: "M8 2.5v7m0 0L5.5 7M8 9.5 10.5 7M2.5 11.5v2h11v-2",
  sparkle: "M8 1.6l1.6 4.3 4.3 1.6-4.3 1.6L8 13.4 6.4 9.1 2.1 7.5l4.3-1.6z",
  wrench: "M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1L9.4 3.3l2.3 2.3L14 3.3Z",
  bolt: "M9 1.5 3.5 9h4L7 14.5 13 7H9z",
  info: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 7.2v4M8 5v.1",
  user: "M8 8.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4ZM2.8 13.8a5.2 5.2 0 0 1 10.4 0",
  gear: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6 3.4 3.4",
  compact: "M2.5 4.5h11M2.5 11.5h11M6 8h4",
};
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const KIND_ICON: Record<Kind, string> = {
  system: P.gear, user: P.user, context: P.info, assistant: P.sparkle,
  compacted: P.compact, tool: P.wrench, subtool: P.wrench, hook: P.bolt,
};

/** Highlights JSON keys and string values without pulling in a syntax highlighter. */
function Code({ text, json }: { text: string; json?: boolean }) {
  if (!json) return <pre className="tj-code">{text}</pre>;
  const parts = text.split(/("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*")/g);
  return (
    <pre className="tj-code">
      {parts.map((p, i) =>
        /^"[^"]*"\s*:$/.test(p) ? <span className="k" key={i}>{p}</span>
        : /^"/.test(p) ? <span className="s" key={i}>{p}</span>
        : <span key={i}>{p}</span>)}
    </pre>
  );
}

export default function Trajectory() {
  const session = useMemo(() => mockSession(), []);
  const end = useMemo(() => sessionEnd(session), [session]);
  const sums = useMemo(() => totals(session), [session]);

  const [selected, setSelected] = useState<string | null>(
    session.records.find((r) => r.kind === "tool")?.id ?? null,
  );
  const [tab, setTab] = useState("summary");
  const [actualDuration, setActualDuration] = useState(true);
  const [foldTurns, setFoldTurns] = useState(false);
  const [foldCalls, setFoldCalls] = useState(false);

  const visible = session.records.filter((r) => {
    if (foldTurns && r.kind !== "user" && r.kind !== "system") return false;
    if (foldCalls && (r.kind === "tool" || r.kind === "subtool")) return false;
    return true;
  });

  const ledgerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const row = ledgerRef.current?.querySelector(`[data-row-id="${selected}"]`);
    // `nearest` leaves an already-visible row alone, so clicking a row never jumps.
    row?.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [selected]);

  const current = session.records.find((r) => r.id === selected) ?? null;
  const tabs = current ? tabsFor(current) : [];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "summary";

  return (
    <div className="tj">
      <>
          <div className="tj-bar" role="toolbar" aria-label="Trajectory">
            <button type="button" aria-pressed={actualDuration}
                    title={actualDuration ? "Use equal-width blocks" : "Use recorded duration"}
                    onClick={() => setActualDuration((v) => !v)}>
              <Icon d={P.clock} />Duration
            </button>
            <button type="button" aria-pressed={foldTurns} title="Collapse to user turns"
                    onClick={() => setFoldTurns((v) => !v)}>
              <Icon d={P.rows} />Turns
            </button>
            <button type="button" aria-pressed={foldCalls} title="Hide tool calls"
                    onClick={() => setFoldCalls((v) => !v)}>
              <Icon d={P.calls} />Calls
            </button>
          </div>

          <div className="tj-strip">
            <div className="tj-lanes">{LANES.map((l) => <span key={l}>{l}</span>)}</div>
            <div className="tj-track">
              {session.records.map((r, i) => {
                const x = actualDuration ? r.startedAt / end : i / session.records.length;
                const w = actualDuration
                  ? Math.max(r.durationMs / end, 0.004)
                  : 1 / session.records.length - 0.002;
                return (
                  <button
                    key={r.id}
                    className="tj-blk"
                    type="button"
                    data-kind={r.kind}
                    data-status={r.status}
                    data-current={r.id === selected || undefined}
                    style={{ "--lane": laneOf(r.kind), "--x": `${x * 100}%`, "--w": `${w * 100}%` } as CSSProperties}
                    title={`${r.name ?? KIND_LABEL[r.kind]} · ${fmtMs(r.durationMs)}${r.tokens ? ` · ${fmtTok(r.tokens)} tok` : ""}`}
                    onClick={() => {
                      const hidden = (foldCalls && (r.kind === "tool" || r.kind === "subtool"))
                        || (foldTurns && r.kind !== "user" && r.kind !== "system");
                      if (hidden) { setFoldCalls(false); setFoldTurns(false); }
                      setSelected(r.id);
                    }}
                    aria-label={`${KIND_LABEL[r.kind]} ${r.text.slice(0, 40)}`}
                  />
                );
              })}
            </div>
          </div>

          <div className="tj-split">
            <div className="tj-ledger" ref={ledgerRef}>
              <table className="tj-table">
                <colgroup>
                  <col className="tj-col-event" /><col /><col className="tj-col-tokens" />
                </colgroup>
                <tbody>
                  {visible.map((r, i) => {
                    const first = i === 0 || visible[i - 1].turn !== r.turn;
                    const bad = r.status === "failed" || r.status === "blocked";
                    return (
                      <tr key={r.id}
                          data-row-id={r.id}
                          data-selected={r.id === selected || undefined}
                          data-turn-start={first || undefined}
                          onClick={() => setSelected(r.id)}>
                        <td className="tj-event">
                          {first && <span className="tj-turn">Turn {r.turn}</span>}
                          <span className="tj-rail" />
                          <span className="tj-tagwrap">
                            <span className="tj-tag" data-kind={r.kind}>
                              <Icon d={KIND_ICON[r.kind]} />{KIND_LABEL[r.kind]}
                            </span>
                          </span>
                        </td>
                        <td className="tj-body">
                          <div className="tj-line">
                            {r.name && <span className="tj-name">{r.name}</span>}
                            <span className="tj-text">{r.text}</span>
                            {r.result && <>
                              <span className="tj-arrow">→</span>
                              <span className="tj-result" data-error={bad || undefined}>{r.result}</span>
                            </>}
                            {bad && <span className="tj-flag">{r.status}</span>}
                          </div>
                        </td>
                        <td className="tj-tokens" data-hot={r.tokens >= 1000 || undefined}>
                          {r.tokens ? fmtTok(r.tokens) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>

            <aside className="tj-detail">
              {!current ? <div className="tj-none">Select a record to inspect it.</div> : (
                <>
                  <div className="tj-dhead">
                    <span className="tj-tag" data-kind={current.kind}>{KIND_LABEL[current.kind]}</span>
                    <span className="tj-dwhere">Turn {current.turn} · Step {current.step}</span>
                    <button className="tj-dclose" type="button" aria-label="Close"
                            onClick={() => setSelected(null)}>✕</button>
                  </div>
                  <div className="tj-dtabs" role="tablist">
                    {tabs.map((t) => (
                      <button key={t.id} role="tab" aria-selected={t.id === activeTab}
                              onClick={() => setTab(t.id)}>{t.label}</button>
                    ))}
                  </div>
                  <div className="tj-dbody">
                    {activeTab === "summary" && (
                      <>
                        <dl className="tj-kv">
                          <dt>Hierarchy</dt><dd>{current.hierarchy ?? "Session"}</dd>
                          <dt>Status</dt>
                          <dd data-error={current.status === "failed" || current.status === "blocked" || undefined}>
                            {current.status[0].toUpperCase() + current.status.slice(1)}
                          </dd>
                          <dt>Context cost</dt>
                          <dd>{current.tokens ? `${current.tokens.toLocaleString()} tokens` : "none"}</dd>
                          {current.hook && <>
                            <dt>Fired by</dt><dd>{current.hook.plugin} · {current.hook.event}</dd>
                          </>}
                        </dl>
                        {current.payload && <>
                          <div className="tj-sect">{current.kind === "hook" ? "Injected" : "Payload"} <i>›</i></div>
                          <Code text={current.payload} json={current.kind !== "hook"} />
                        </>}
                        {current.result && <>
                          <div className="tj-sect">Result <i>›</i></div>
                          <Code text={current.result} />
                        </>}
                        {current.schema && <>
                          <div className="tj-sect">Schema <i>›</i></div>
                          <pre className="tj-code"><b>{current.schema.name}</b>{"\n"}{current.schema.description}</pre>
                        </>}
                        <div className="tj-sect">Timing <i>›</i></div>
                        <dl className="tj-kv">
                          <dt>Started</dt><dd>+{fmtMs(current.startedAt)}</dd>
                          <dt>Duration</dt><dd>{fmtMs(current.durationMs)}</dd>
                          <dt>Timing source</dt><dd>Session timestamps</dd>
                        </dl>
                      </>
                    )}
                    {activeTab === "payload" && <Code text={current.payload ?? "No payload recorded."} json />}
                    {activeTab === "injected" && <Code text={current.payload ?? "This hook injected nothing."} />}
                    {activeTab === "result" && <Code text={current.result ?? "No result recorded."} />}
                    {activeTab === "raw" && <Code text={current.result ?? current.payload ?? current.text} />}
                    {activeTab === "schema" && (
                      current.schema
                        ? <pre className="tj-code"><b>{current.schema.name}</b>{"\n"}{current.schema.description}</pre>
                        : <Code text="No schema for this record." />
                    )}
                    {activeTab === "owner" && current.hook && (
                      <dl className="tj-kv">
                        <dt>Plugin</dt><dd>{current.hook.plugin}</dd>
                        <dt>Event</dt><dd>{current.hook.event}</dd>
                        <dt>Matcher</dt><dd>{current.hook.matcher ?? "all tools"}</dd>
                        <dt>Outcome</dt>
                        <dd data-error={current.hook.blocked || undefined}>
                          {current.hook.blocked ? "Blocked the call" : "Allowed"}
                        </dd>
                        <dt>Injected</dt>
                        <dd>{current.tokens ? `${current.tokens.toLocaleString()} tokens` : "nothing"}</dd>
                      </dl>
                    )}
                    {activeTab === "timing" && (
                      <dl className="tj-kv">
                        <dt>Started</dt><dd>+{fmtMs(current.startedAt)}</dd>
                        <dt>Duration</dt><dd>{fmtMs(current.durationMs)}</dd>
                        <dt>Timing source</dt><dd>Session timestamps</dd>
                      </dl>
                    )}
                  </div>
                </>
              )}
            </aside>
          </div>

          <div className="tj-status">
            <span>{sums.turns} turns · {sums.steps} steps</span><i>|</i>
            <span>LLM {fmtMs(sums.llmMs)} · Tool call {fmtMs(sums.toolMs)}</span><i>|</i>
            <span>TTFT avg 3.6s · 36 tok/s</span><i>|</i>
            <span>Cache hit 93%</span><i>|</i>
            <span>Input {fmtTok(sums.inputTokens)} tok · Output {fmtTok(sums.outputTokens)}</span><i>|</i>
            <span className="hot">Hooks injected {fmtTok(sums.hookTokens)} tok</span>
          </div>
      </>
    </div>
  );
}
