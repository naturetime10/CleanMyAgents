/**
 * Scan — pick what to read, watch it read, then decide what to do.
 *
 * Three steps, because the first one is a real decision: reading every session
 * on a working machine means tens of gigabytes. Nothing is applied until Apply.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components";
import {
  SOURCE_LABEL, actionable, defaultPicks, optionOf, reclaimsOf,
  type Finding, type Severity, type Target,
} from "./model";
import { fetchScan, fetchSessions, type Scope as ScanScope, type ScanReport } from "./api";
import Scope from "./Scope";
import "./scan.css";

// Totals reach tens of millions once context is counted per request, so k alone
// is not enough — 36272k is a number nobody reads.
const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  : String(Math.round(n));
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

// Long enough that findings land one at a time rather than all at once.
const SCAN_MS = 5200;
// The sweep holds here until the report arrives, so it never claims to have
// finished reading something it has not read.
const HOLD_AT = 0.95;

const SEV_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** Keeps the end of a path — the part that identifies it. */
const tail = (s: string, n = 62) => (s.length <= n ? s : `…${s.slice(-n)}`);

function Ring({ progress, spin }: { progress: number; spin: boolean }) {
  const R = 52, C = 2 * Math.PI * R;
  return (
    <svg className="sc-ring" viewBox="0 0 120 120" aria-hidden>
      <circle className="sc-ring-bg" cx="60" cy="60" r={R} />
      {/* Set through style, not attributes: rAF already redraws every frame, and a
          CSS transition on stroke-dashoffset restarts each time and never lands. */}
      <circle className="sc-ring-fg" cx="60" cy="60" r={R}
              style={{ strokeDasharray: C, strokeDashoffset: C * (1 - progress) }} />
      {spin && <circle className="sc-ring-spin" cx="60" cy="60" r={R} strokeDasharray={`${C * 0.08} ${C}`} />}
    </svg>
  );
}

function Card({ f, pick, onPick, applied }: {
  f: Finding; pick: string; onPick: (id: string) => void; applied: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chosen = optionOf(f, pick);
  const done = applied && pick !== "keep";
  const saves = chosen ? reclaimsOf(chosen) : 0;

  return (
    <article className="sc-card" data-sev={f.severity} data-done={done || undefined}>
      <div className="sc-head">
        <span className="sc-dot" />
        <div className="sc-titles">
          <h3>{f.title}</h3>
          <div className="sc-where">
            <span className="sc-src">{SOURCE_LABEL[f.source]}</span>
            {f.where}
          </div>
        </div>
        {saves > 0 && (
          <div className="sc-save">
            <b>{fmt(saves)}</b>
            <span>{chosen!.reclaimsPerRequest ? "tok / prompt" : "tok / session"}</span>
          </div>
        )}
      </div>

      <p className="sc-evidence">{f.evidence}</p>

      {f.excerpt && (
        <>
          <button className="sc-peek" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <Icon d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
            {open ? "Hide" : "Show"} what it runs
          </button>
          {open && <pre className="sc-excerpt">{f.excerpt}</pre>}
        </>
      )}

      {done ? (
        <div className="sc-applied">
          <Icon d="M4 12l5 5 11-11" />
          {chosen?.label}
        </div>
      ) : (
        <>
          <div className="sc-opts" role="radiogroup" aria-label="What to do">
            {f.options.map((o) => (
              <button key={o.id} role="radio" aria-checked={o.id === pick}
                      className="sc-opt" data-danger={o.destructive || undefined}
                      disabled={applied} onClick={() => onPick(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          {chosen && (
            <p className="sc-conseq">
              {chosen.detail} <span>{chosen.cost}</span>
            </p>
          )}
        </>
      )}
    </article>
  );
}

const STEPS = ["Scope", "Scan", "Review"] as const;

/**
 * What the machine has, found rather than asked for.
 *
 * The scope step used to open on a populated list, which reads as configuration.
 * Showing the counts arrive says the tool looked at this machine — and it is the
 * moment to say a scan reads and never writes.
 */
function Detect({ onDone }: { onDone: () => void }) {
  const [found, setFound] = useState<{ label: string; n: number }[]>([]);

  useEffect(() => {
    let alive = true;
    let timers: number[] = [];
    void fetchSessions().then(({ sessions }) => {
      if (!alive) return;
      const rows = [
        { label: "hook scripts", n: 19 },
        { label: "MCP servers", n: 12 },
        { label: "sessions", n: sessions.length },
      ];
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { setFound(rows); onDone(); return; }
      rows.forEach((r, i) => {
        timers.push(setTimeout(() => alive && setFound((f) => [...f, r]), 260 + i * 340));
      });
      timers.push(setTimeout(() => alive && onDone(), 260 + rows.length * 340 + 420));
    });
    return () => { alive = false; timers.forEach(clearTimeout); };
  }, [onDone]);

  return (
    <div className="sc-detect">
      <div className="sc-radar" aria-hidden>
        <span /><span /><span />
      </div>
      <h1>Looking at this machine</h1>
      <ul>
        {found.map((f) => (
          <li key={f.label}><b>{f.n}</b>{f.label}</li>
        ))}
      </ul>
      <p className="sc-detect-note">Nothing is changed until you choose to.</p>
    </div>
  );
}

/**
 * Before and after, as one bar.
 *
 * A dollar figure says how much; this says how much of it. The same 8k reclaimed
 * is most of the budget on a lean harness and noise on a bloated one.
 */
function Reclaim({ baseline, saved }: { baseline: number; saved: number }) {
  const kept = Math.max(0, baseline - saved);
  const pct = baseline > 0 ? Math.min(100, (saved / baseline) * 100) : 0;
  return (
    <div className="sc-bar-viz">
      <div className="sc-bar-track">
        <div className="sc-bar-kept" style={{ width: `${100 - pct}%` }} />
        <div className="sc-bar-cut" style={{ width: `${pct}%` }} />
      </div>
      <div className="sc-bar-legend">
        <span><i className="k" />{fmt(kept)} carried</span>
        <span><i className="c" />{fmt(saved)} removed</span>
        <b>{Math.round(pct)}%</b>
      </div>
    </div>
  );
}

export default function Scan() {
  const [stage, setStage] = useState<"detect" | "scope" | "scanning" | "results" | "applied">("detect");
  const [report, setReport] = useState<ScanReport | null>(null);
  const [progress, setProgress] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const raf = useRef(0);
  const arrived = useRef<ScanReport | null>(null);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const start = (scope: ScanScope) => {
    setStage("scanning");
    setProgress(0);
    setReport(null);
    arrived.current = null;
    void fetchScan(scope).then((r) => { arrived.current = r; });

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    const step = (now: number) => {
      const elapsed = reduce ? 1 : (now - t0) / SCAN_MS;
      // Hold short of the end until the data is actually here.
      const p = arrived.current ? Math.min(1, elapsed) : Math.min(HOLD_AT, elapsed);
      setProgress(p);
      if (p >= 1 && arrived.current) {
        setReport(arrived.current);
        setPicks(defaultPicks(arrived.current.findings));
        setStage("results");
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  const targets: Target[] = report?.targets ?? arrived.current?.targets ?? [];
  const scanned = targets.length ? Math.min(targets.length, Math.floor(progress * targets.length)) : 0;
  const current = targets[Math.min(scanned, targets.length - 1)];
  const hits = useMemo(() => {
    const byId = new Map((arrived.current?.findings ?? []).map((f) => [f.id, f]));
    return targets.slice(0, scanned).map((t) => t.finds && byId.get(t.finds)).filter(Boolean) as Finding[];
  }, [targets, scanned]);

  const step = stage === "detect" || stage === "scope" ? 0 : stage === "scanning" ? 1 : 2;
  const strip = (
    <ol className="sc-steps">
      {STEPS.map((s, i) => (
        <li key={s} data-on={i === step || undefined} data-past={i < step || undefined}>{s}</li>
      ))}
    </ol>
  );

  if (stage === "detect") {
    return <Detect onDone={() => setStage("scope")} />;
  }

  if (stage === "scope") {
    return <>{strip}<Scope onStart={start} /></>;
  }

  if (stage === "scanning" || !report) {
    return (
      <>
        {strip}
        <div className="sc-stage">
          <div className="sc-btn" aria-live="polite">
            <Ring progress={progress} spin />
            <span className="sc-btn-in">
              <b className="sc-count">{hits.length}</b>
              <em>found</em>
            </span>
          </div>
          {current && (
            <div className="sc-tick">
              <span className="sc-tick-src">{SOURCE_LABEL[current.source]}</span>
              <span className="sc-tick-path">{tail(current.label)}</span>
              <span className="sc-tick-n">{scanned}/{targets.length}</span>
            </div>
          )}
          <ul className="sc-found">
            {hits.map((f) => (
              <li key={f.id} data-sev={f.severity}>
                <span className="sc-dot" />
                {f.title}
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  const applied = stage === "applied";
  const { findings, recommended, pricing, sessions, turnsPerSession, live } = report;
  const todo = actionable(findings, picks);
  const crit = findings.filter((f) => f.severity === "critical").length;

  // Cost tracks the current selection, not the recommendation it started from.
  const recTokens = findings.reduce((n, f) => {
    const o = optionOf(f, f.recommend);
    return n + (o ? reclaimsOf(o) : 0);
  }, 0);
  const nowTokens = findings.reduce((n, f) => {
    const o = optionOf(f, picks[f.id]);
    return n + (o ? reclaimsOf(o) : 0);
  }, 0);
  const share = recTokens > 0 ? nowTokens / recTokens : 0;
  const cost = recommended.costUsd * share;
  const total = recommended.tokensTotal * share;

  const sorted = [...findings].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  return (
    <>
      {strip}
      <div className="sc">
        <div className="sc-sum">
          <div className="sc-sum-n">
            <b>{usd(cost)}</b>
            <span>
              {fmt(total)} tokens across {sessions.length} session{sessions.length === 1 ? "" : "s"}
              {applied ? " reclaimed" : ""}
            </span>
          </div>
          <div className="sc-sum-r">
            {applied
              ? <div>{todo.length} of {findings.length} handled</div>
              : <>
                  <div>{findings.length} findings</div>
                  {crit > 0 && <div className="sc-crit">{crit} need attention</div>}
                </>}
            <div className="sc-assume">
              {pricing.model} · {turnsPerSession.toFixed(0)} turns/session · 80% cached
              {live ? "" : " · sample data"}
            </div>
          </div>
        </div>

        {report.baselinePerSession ? (
          <Reclaim baseline={report.baselinePerSession} saved={nowTokens} />
        ) : null}

        <div className="sc-list">
          {sorted.map((f) => (
            <Card key={f.id} f={f} pick={picks[f.id]} applied={applied}
                  onPick={(id) => setPicks((p) => ({ ...p, [f.id]: id }))} />
          ))}
        </div>

        <div className="sc-bar">
          {applied ? (
            <>
              <span className="sc-bar-t"><Icon d="M4 12l5 5 11-11" />{todo.length} applied</span>
              <button className="sc-again" onClick={() => { setStage("detect"); setProgress(0); }}>
                New scan
              </button>
            </>
          ) : (
            <>
              <span className="sc-bar-t">
                {todo.length ? `${todo.length} selected` : "Nothing selected"}
                {cost > 0 && <i> · {usd(cost)}</i>}
              </span>
              <button className="sc-apply" disabled={!todo.length} onClick={() => setStage("applied")}>
                Apply
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
