/**
 * Session trajectory: the ledger of everything a session did — context injected,
 * models called, tools run, hooks fired — with a Chrome-network-style overview
 * strip on top and a per-record inspector on the right.
 *
 * Our own implementation. Data is mock.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { KIND_LABEL, laneOf, LANES, markSystemSkips, sessionEnd, tabsFor, totals,
         type Kind } from "./model";
import { realNotes, realSession } from "./real-session";
import {
  AGENT_COUNT, KIND_LABEL as NOTE_KIND, YOU, annotate, byRow, userNote, worst,
  type Annotation, type Kind as NoteKind,
} from "./annotations";
import "./trajectory.css";

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Narrowest a marked band may be, as a fraction of the track.
 *
 * Only needed with a real clock, where an instant event has no width at all.
 * In index mode every step owns an equal slot, so a floor there would make
 * bands wider than the blocks they mark.
 */
const BAND_MIN = 0.006;

/**
 * Share of its slot a block fills in index mode; the rest is the gap.
 *
 * This was a fixed 0.002 subtracted from the slot, which is fine at thirty
 * records and negative past five hundred: 1/600 is 0.00167, so every block
 * came out narrower than nothing and rendered as a dot. A proportion cannot
 * do that.
 */
const SLOT_FILL = 0.72;
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
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9M6.8 7.2v4M9.2 7.2v4",
  shield: "M8 1.8l5 1.8v3.6c0 3.2-2.1 5.6-5 6.8-2.9-1.2-5-3.6-5-6.8V3.6z",
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


/** The floating card: what the agents said about one row, and what to do. */
function NoteCard({ notes, at, blocked, onBlock, onHold, onLeave }: {
  notes: Annotation[];
  at: { top: number; left: number };
  blocked: boolean;
  onBlock: () => void;
  onHold: () => void;
  onLeave: () => void;
}) {
  const canBlock = notes.some((n) => n.blockable);
  return (
    <div className="tj-card" style={{ top: at.top, left: at.left }}
         onMouseEnter={onHold} onMouseLeave={onLeave}>
      {notes.map((n, i) => (
        <div className="tj-card-note" key={i} data-kind={n.kind} data-sev={n.severity}>
          <div className="tj-card-head">
            <span className="tj-card-kind">{NOTE_KIND[n.kind]}</span>
            <span className="tj-card-agent" data-you={n.agent === YOU || undefined}>{n.agent}</span>
            {n.tokens ? <span className="tj-card-tok">{fmtTok(n.tokens)}</span> : null}
          </div>
          <b>{n.title}</b>
          <p>{n.detail}</p>
          {n.evidence && <code>{n.evidence}</code>}
        </div>
      ))}
      {canBlock ? (
        <button className="tj-card-block" data-on={blocked || undefined} onClick={onBlock}>
          {blocked ? "Blocked — allow again" : "Block this"}
        </button>
      ) : (
        // Saying why there is no button beats showing one that does nothing.
        <p className="tj-card-nope">A model turn cannot be blocked after the fact.</p>
      )}
    </div>
  );
}

export default function Trajectory() {
  const session = useMemo(
    () => ({ ...realSession, records: markSystemSkips(realSession.records) }),
    [],
  );
  const end = useMemo(() => sessionEnd(session), [session]);
  const sums = useMemo(() => totals(session), [session]);

  /** Marks the user added by hand, merged with the agents'. */
  const [mine, setMine] = useState<Annotation[]>([]);
  /**
   * Annotations shipped with the session, plus anything the local rules find in
   * it, plus the reader's own. The converter already ran the rules over the
   * full file; `annotate` is kept so a session that arrives without them is
   * still marked up.
   */
  const notes = useMemo(
    () => byRow([...realNotes, ...annotate(session.records), ...mine]),
    [session, mine],
  );
  /** A range picked with shift-click, waiting to be marked. */
  const [picked, setPicked] = useState<string[]>([]);

  /**
   * How much wider than its container the strip is drawn.
   *
   * At 1 the whole session fits and there is nothing to pan; past that the
   * strip becomes a scrollable timeline, which is the only way individual
   * steps stay distinguishable in a long session.
   */
  /**
   * Starts zoomed in rather than fitting the session.
   *
   * 600 steps across 1400px is two pixels each: a picture of "a lot happened",
   * which the ledger already says. Showing a slice and letting it be scrolled
   * is the difference between a summary and a timeline.
   */
  const FIT_RECORDS = 150;
  const [zoom, setZoom] = useState(() =>
    Math.max(1, Math.min(12, session.records.length / FIT_RECORDS)));

  /** Drag across the strip to pick a range to magnify, as in a metrics chart. */
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** Fraction of the session currently visible in the ledger, for the marker. */
  const [view, setView] = useState({ from: 0, to: 1 });
  /** Set while the strip is panning itself, so the two do not fight. */
  const syncing = useRef(false);
  /** Rows the user has chosen to block. Local state; nothing is written. */
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  /** The row whose annotation card is open, and where to put it. */
  const [hover, setHover] = useState<{ rowId: string; top: number; left: number } | null>(null);
  const closeTimer = useRef(0);

  /**
   * A short grace period before closing.
   *
   * The card sits below the marker with a gap; without it, moving the pointer
   * from the marker into the card crosses dead space and dismisses the thing
   * being reached for.
   */
  const openCard = (rowId: string, el: HTMLElement) => {
    clearTimeout(closeTimer.current);
    const r = el.getBoundingClientRect();
    // Anchored near the pointer, then clamped inside the viewport on both axes.
    // The first version subtracted a fixed offset from the row's left edge,
    // which for a full-width row is zero — so the card sat at -300.
    const W = 380, H = 260, PAD = 12;
    const left = Math.max(PAD, Math.min(r.left + 40, innerWidth - W - PAD));
    // Flip above when there is no room below, rather than hanging off the end.
    const below = r.bottom + 8;
    const top = below + H > innerHeight - PAD ? Math.max(PAD, r.top - H - 8) : below;
    setHover({ rowId, top, left });
  };
  const closeCard = () => {
    closeTimer.current = setTimeout(() => setHover(null), 180) as unknown as number;
  };
  const holdCard = () => clearTimeout(closeTimer.current);

  /**
   * Drag selects a range and magnifies it; hold a modifier to pan instead.
   *
   * Selecting is the more common intent on a dense strip — panning is what the
   * wheel is for, and what you do once you are already close in.
   */
  const startDrag = (e: React.MouseEvent) => {
    const el = trackRef.current;
    if (!el) return;

    if (e.altKey || e.shiftKey || e.button === 1) {
      if (el.scrollWidth <= el.clientWidth) return;
      const x0 = e.clientX, s0 = el.scrollLeft;
      const move = (ev: MouseEvent) => { el.scrollLeft = s0 - (ev.clientX - x0); };
      const up = () => {
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
        document.body.style.cursor = "";
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
      document.body.style.cursor = "grabbing";
      return;
    }

    const rect = el.getBoundingClientRect();
    const at = (clientX: number) => clientX - rect.left + el.scrollLeft;
    const a = at(e.clientX);
    let b = a;
    setBrush({ from: a, to: a });

    const move = (ev: MouseEvent) => {
      b = at(ev.clientX);
      setBrush({ from: Math.min(a, b), to: Math.max(a, b) });
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      setBrush(null);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      // A stray click is not a selection; below this it is a click on a block.
      if (hi - lo < 6) return;
      const full = el.scrollWidth;
      // The selection should end up filling the viewport, so the new zoom is
      // the old one scaled by how much narrower the selection is than the
      // viewport. Dividing by the selection's share of the *content* instead
      // multiplies by zoom a second time, and every drag pinned the maximum.
      const next = Math.max(1, Math.min(60, (zoom * el.clientWidth) / (hi - lo)));
      const centre = ((lo + hi) / 2) / full;
      setZoom(next);
      // Layout has to settle at the new width before scrollLeft means anything.
      // The inner layer is `next × 100%`, so that is the new scrollable width.
      requestAnimationFrame(() => {
        el.scrollLeft = centre * el.clientWidth * next - el.clientWidth / 2;
      });
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };

  const [selected, setSelected] = useState<string | null>(
    session.records.find((r) => r.kind === "tool")?.id ?? null,
  );
  const [tab, setTab] = useState("summary");

  /**
   * The ledger drives the strip.
   *
   * Scrolling the log moves the visible-range marker and pans the strip to keep
   * it on screen, so the two views never disagree about where you are.
   */
  const onLedgerScroll = () => {
    const led = ledgerRef.current, track = trackRef.current;
    if (!led) return;
    const max = Math.max(1, led.scrollHeight - led.clientHeight);
    const from = led.scrollTop / (max + led.clientHeight);
    const to = (led.scrollTop + led.clientHeight) / (max + led.clientHeight);
    setView({ from, to });
    if (!track || track.scrollWidth <= track.clientWidth) return;
    syncing.current = true;
    const centre = ((from + to) / 2) * track.scrollWidth;
    track.scrollLeft = centre - track.clientWidth / 2;
    requestAnimationFrame(() => { syncing.current = false; });
  };
  /**
   * Duration only means something when the timestamps do.
   *
   * A rollout does not always carry a usable clock: this one writes 52,000
   * records inside five seconds, because the stamps mark when the file was
   * written rather than when each step ran. Drawing widths from that is not an
   * approximation, it is invention, so the view starts on equal widths and the
   * control says why it is unavailable.
   */
  const hasClock = realSession.clock === "wall";
  const [actualDuration, setActualDuration] = useState(hasClock);
  const [foldTurns, setFoldTurns] = useState(false);
  const [foldCalls, setFoldCalls] = useState(false);
  /** Show only rows carrying this annotation kind; null shows everything. */
  const [noteFilter, setNoteFilter] = useState<NoteKind | null>(null);
  /** Free-text filter over name, body and result. */
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const visible = session.records.filter((r) => {
    if (foldTurns && r.kind !== "user" && r.kind !== "system") return false;
    if (foldCalls && (r.kind === "tool" || r.kind === "subtool")) return false;
    if (noteFilter && !notes.get(r.id)?.some((a) => a.kind === noteFilter)) return false;
    if (q && !`${r.name ?? ""} ${r.text} ${r.result ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const ledgerRef = useRef<HTMLDivElement>(null);
  // The marker is derived from a scroll event, so nothing has sized it before
  // the first one. Measure once the ledger exists.
  useEffect(() => { onLedgerScroll(); }, []);

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
            <button type="button" aria-pressed={actualDuration} disabled={!hasClock}
                    title={!hasClock
                      ? "This rollout has no usable clock — its records were written in one burst"
                      : actualDuration ? "Use equal-width blocks" : "Use recorded duration"}
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
            <button type="button" aria-pressed={noteFilter === "waste"}
                    title="Show only rows marked rubbish"
                    onClick={() => setNoteFilter((f) => f === "waste" ? null : "waste")}>
              <Icon d={P.trash} />Rubbish
            </button>
            <button type="button" aria-pressed={noteFilter === "security"}
                    title="Show only rows marked security"
                    onClick={() => setNoteFilter((f) => f === "security" ? null : "security")}>
              <Icon d={P.shield} />Security
            </button>
            <input
              className="tj-search" type="search" placeholder="Search log…"
              value={query} onChange={(e) => setQuery(e.target.value)}
            />
            {q && (
              // Search → select-all → the pick bar's Mark buttons: batch
              // annotation is the existing flow, this just fills the selection.
              <button type="button" disabled={visible.length === 0}
                      title="Select every matching row for marking"
                      onClick={() => setPicked(visible.map((r) => r.id))}>
                Select {visible.length}
              </button>
            )}
          </div>

          <div className="tj-strip">
            <div className="tj-lanes">{LANES.map((l) => <span key={l}>{l}</span>)}</div>
            <div
              className="tj-track"
              ref={trackRef}
              data-pannable={zoom > 1 || undefined}
              onMouseDown={startDrag}
              onWheel={(e) => {
                // Modifier zooms, plain wheel pans. A bare wheel that zoomed
                // would fight the page scroll on the way past.
                if (e.ctrlKey || e.metaKey) {
                  setZoom((z) => Math.min(12, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
                } else if (trackRef.current) {
                  trackRef.current.scrollLeft += e.deltaY + e.deltaX;
                }
              }}
            >
              <div className="tj-track-in" style={{ width: `${zoom * 100}%` }}>
                {brush && (
                  <div className="tj-brush" style={{
                    left: brush.from, width: Math.max(1, brush.to - brush.from),
                  }} />
                )}
                <div className="tj-view" style={{
                  "--from": `${view.from * 100}%`,
                  "--to": `${(1 - view.to) * 100}%`,
                } as CSSProperties} />
              {/* A band the full height of the strip, aligned to the step it
                  marks. Geometry is computed here rather than left to CSS:
                  `min-width` only ever grows to the right, so a narrow block
                  ended up sitting at the band's left edge instead of its
                  middle. Widening around the centre keeps them lined up. */}
              {session.records.map((r, i) => {
                if (!notes.has(r.id)) return null;
                const x = actualDuration ? r.startedAt / end : i / session.records.length;
                const w = actualDuration
                  ? Math.max(r.durationMs / end, 0.004)
                  : (1 / session.records.length) * SLOT_FILL;
                // A zero-duration step has no width to mark, so the band gets a
                // floor — grown symmetrically, then clamped inside the track.
                // Index mode needs none: every slot is already the same size.
                const bw = actualDuration ? Math.max(w, BAND_MIN) : w;
                const bx = Math.max(0, Math.min(x - (bw - w) / 2, 1 - bw));
                return (
                  <div
                    key={`band-${r.id}`}
                    className="tj-band"
                    data-note={worst(notes.get(r.id)!)}
                    data-blocked={blocked.has(r.id) || undefined}
                    style={{ "--x": `${bx * 100}%`, "--w": `${bw * 100}%` } as CSSProperties}
                  />
                );
              })}
              {session.records.map((r, i) => {
                const x = actualDuration ? r.startedAt / end : i / session.records.length;
                const w = actualDuration
                  ? Math.max(r.durationMs / end, 0.004)
                  : (1 / session.records.length) * SLOT_FILL;
                return (
                  <button
                    key={r.id}
                    className="tj-blk"
                    type="button"
                    data-kind={r.kind}
                    data-status={r.status}
                    data-current={r.id === selected || undefined}
                    data-note={notes.has(r.id) ? worst(notes.get(r.id)!) : undefined}
                    data-blocked={blocked.has(r.id) || undefined}
                    style={{ "--lane": laneOf(r.kind), "--x": `${x * 100}%`, "--w": `${w * 100}%` } as CSSProperties}
                    title={`${r.name ?? KIND_LABEL[r.kind]} · ${fmtMs(r.durationMs)}${r.tokens ? ` · ${fmtTok(r.tokens)} tok` : ""}`}
                    onClick={() => {
                      const hidden = (foldCalls && (r.kind === "tool" || r.kind === "subtool"))
                        || (foldTurns && r.kind !== "user" && r.kind !== "system");
                      if (hidden) { setFoldCalls(false); setFoldTurns(false); }
                      setSelected(r.id);
                      // From the strip the row is usually off-screen, so centre
                      // it. `nearest` is right for ledger clicks and useless here.
                      requestAnimationFrame(() => {
                        ledgerRef.current?.querySelector(`[data-row-id="${r.id}"]`)?.scrollIntoView({
                          block: "center",
                          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                        });
                      });
                    }}
                    aria-label={`${KIND_LABEL[r.kind]} ${r.text.slice(0, 40)}`}
                  />
                );
              })}
              </div>
            </div>
            {zoom > 1 && (
              <button className="tj-zoom" onClick={() => setZoom(1)}
                      title="Drag to magnify a range · alt-drag to pan · click to fit the session">
                {zoom.toFixed(1)}×
              </button>
            )}
          </div>

          {picked.length > 0 && (
            <div className="tj-pick">
              <span>{picked.length} steps</span>
              <button onClick={() => {
                setMine((m) => [...m, ...userNote(picked, "security", "")]);
                setPicked([]);
              }}>Mark security</button>
              <button onClick={() => {
                // Feeds the desktop's rubbish index; future similar tool calls
                // get challenged before they run. Fire-and-forget: the local
                // note is the UI truth, the index is the enforcement side.
                for (const id of picked) {
                  const r = session.records.find((x) => x.id === id);
                  if (r) fetch("/rubbish", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: `${r.name ?? r.kind} ${r.text}`, rowId: r.id }),
                  }).catch(() => {});
                }
                setMine((m) => [...m, ...userNote(picked, "waste",
                  "Marked rubbish — similar tool calls will be challenged before they run.")]);
                setPicked([]);
              }}>Mark rubbish</button>
              <button className="tj-pick-x" onClick={() => setPicked([])}>Clear</button>
            </div>
          )}

          {hover && notes.has(hover.rowId) && (
            <NoteCard
              notes={notes.get(hover.rowId)!}
              at={hover}
              blocked={blocked.has(hover.rowId)}
              onHold={holdCard}
              onLeave={closeCard}
              onBlock={() => setBlocked((b) => {
                const next = new Set(b);
                next.has(hover.rowId) ? next.delete(hover.rowId) : next.add(hover.rowId);
                return next;
              })}
            />
          )}

          <div className="tj-split">
            <div className="tj-ledger" ref={ledgerRef} onScroll={onLedgerScroll}>
              <table className="tj-table">
                <colgroup>
                  <col className="tj-col-event" /><col /><col className="tj-col-tokens" />
                </colgroup>
                <tbody>
                  {visible.map((r, i) => {
                    const first = i === 0 || visible[i - 1].turn !== r.turn;
                    const bad = r.status === "failed" || r.status === "blocked";
                    return (
                      // The whole row is the hover target: a dot in the margin
                      // was too small to find, and the fill already says where.
                      <tr key={r.id}
                          data-row-id={r.id}
                          data-selected={r.id === selected || undefined}
                          data-turn-start={first || undefined}
                          data-note={notes.has(r.id) ? worst(notes.get(r.id)!) : undefined}
                          data-blocked={blocked.has(r.id) || undefined}
                          onMouseEnter={(e) => notes.has(r.id) && openCard(r.id, e.currentTarget)}
                          onMouseLeave={() => notes.has(r.id) && closeCard()}
                          data-picked={picked.includes(r.id) || undefined}
                          onClick={(e) => {
                            if (e.shiftKey && selected) {
                              // Shift extends from the anchor through this row,
                              // in the order the ledger is currently showing.
                              const a = visible.findIndex((x) => x.id === selected);
                              const b = visible.findIndex((x) => x.id === r.id);
                              if (a >= 0 && b >= 0) {
                                const [lo, hi] = a < b ? [a, b] : [b, a];
                                setPicked(visible.slice(lo, hi + 1).map((x) => x.id));
                              }
                              return;
                            }
                            setPicked([]);
                            setSelected(r.id);
                          }}>
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
                            {r.block && <span className="tj-flag" data-skip>
                              skip · save {fmtTok(r.block.savedTokens)}
                            </span>}
                            {notes.has(r.id) && (
                              <span className="tj-note"
                                    data-kind={notes.get(r.id)![0].kind}
                                    data-blocked={blocked.has(r.id) || undefined}>
                                {blocked.has(r.id) ? "blocked"
                                  : notes.get(r.id)![0].kind === "security" ? "security"
                                  : "rubbish"}
                                {notes.get(r.id)!.length > 1 ? ` ×${notes.get(r.id)!.length}` : ""}
                              </span>
                            )}
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
                          {current.block && <>
                            <dt>Blocked by</dt><dd data-error>{current.block.source}</dd>
                            <dt>Reason</dt><dd>{current.block.reason}</dd>
                            <dt>Tokens saved</dt>
                            <dd>~{current.block.savedTokens.toLocaleString()} (est.)</dd>
                          </>}
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
            <span>{sums.turns} turns · {sums.steps} of {realSession.totalRecords.toLocaleString()} steps</span><i>|</i>
            {hasClock
              ? <><span>LLM {fmtMs(sums.llmMs)} · Tool call {fmtMs(sums.toolMs)}</span><i>|</i></>
              : <><span title="Rollout timestamps are write times, not step times">no timing in this rollout</span><i>|</i></>}
            <span>TTFT avg 3.6s · 36 tok/s</span><i>|</i>
            <span>Cache hit 93%</span><i>|</i>
            <span>Input {fmtTok(sums.inputTokens)} tok · Output {fmtTok(sums.outputTokens)}</span><i>|</i>
            <span className="hot">Hooks injected {fmtTok(sums.hookTokens)} tok</span><i>|</i>
            {sums.blockedCalls > 0 && <>
              <span className="hot">
                {sums.blockedCalls} calls skipped · ~{fmtTok(sums.savedTokens)} tok saved
              </span><i>|</i>
            </>}
            {/* Says where the marks came from, and that several readers agreed. */}
            <span title={realSession.source}>{AGENT_COUNT} agents · {notes.size} rows marked
              {blocked.size ? ` · ${blocked.size} blocked` : ""}</span>
          </div>
      </>
    </div>
  );
}
