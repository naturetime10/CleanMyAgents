import { useRef, useState, type ReactNode } from "react";
import type { DailyPoint } from "./types";

export const ICON = {
  // Radar sweep: outer dial plus a quarter wedge.
  scan: "M12 3a9 9 0 100 18 9 9 0 000-18z M12 12V3a9 9 0 019 9z",
  analytics: "M3 3v18h18M7 15l4-5 3 3 5-7",
  injectors: "M12 2v6m0 8v6M2 12h6m8 0h6M6 6l3 3m6 6l3 3m0-12l-3 3M9 15l-3 3",
  mcp: "M4 7h16M4 12h16M4 17h10",
  efficiency: "M13 2L4 14h7l-1 8 9-12h-7z",
  findings: "M12 3l9 16H3zM12 9v5m0 3h.01",
  export: "M4 16v3h16v-3M12 4v11m0 0l-4-4m4 4l4-4",
  filter: "M4 5h16M7 12h10M10 19h4",
  sessions: "M3 5h18v14H3zM3 10h18M8 10v9",
};

export const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24"><path d={d} /></svg>
);

export const Select = ({ label, icon }: { label: string; icon?: string }) => (
  <div className="select">{icon && <Icon d={icon} />}{label}<Icon d="M6 9l6 6 6-6" /></div>
);

export function Card({ title, icon, right, full, plain, children }: {
  title: string; icon?: string; right?: ReactNode; full?: boolean; plain?: boolean; children: ReactNode;
}) {
  return (
    <div className={"card" + (full ? " full" : "")}>
      <header>
        <div className={"t" + (plain ? " plain" : "")}>{icon && <Icon d={icon} />}{title}</div>
        {right}
      </header>
      {children}
    </div>
  );
}
export const Body = ({ children }: { children: ReactNode }) => <div className="body">{children}</div>;
export const Foot = ({ title, children }: { title?: string; children: ReactNode }) => (
  <div className="foot">{title && <h4>{title}</h4>}{children}</div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export type Kpi = { label: string; value: string; tone?: "crit" | "warn" | "ok"; sub?: string };
export const Kpis = ({ items }: { items: Kpi[] }) => (
  <div className="kpis">
    {items.map((k) => (
      <div className="kpi" key={k.label}>
        <div className="lbl">{k.label}</div>
        <div className={"num " + (k.tone ?? "")}>{k.value}</div>
        {k.sub && <div className="sub">{k.sub}</div>}
      </div>
    ))}
  </div>
);

/** Bar row; `sub` stacks a red failure segment on the same track. */
export function Rank({ name, value, max, color, sub, text, danger, title, onClick }: {
  name: string; value: number; max: number; color?: string; sub?: number;
  text?: string; danger?: boolean; title?: string; onClick?: () => void;
}) {
  // Widths are set on first paint; the CSS transition animates subsequent poll updates,
  // which is when movement is actually informative.
  const w = Math.max(0, (value / (max || 1)) * 100);
  const w2 = sub ? (sub / (max || 1)) * 100 : 0;
  return (
    <div className={"rank" + (onClick ? " clickable" : "")} onClick={onClick} title={title}>
      <div className="name">{name}</div>
      <div className="track">
        <div className="fill" style={{ background: color ?? "#16181d", width: `${w}%` }} />
        {sub ? <div className="fill" style={{ background: "var(--crit)", width: `${w2}%` }} /> : null}
      </div>
      <div className="v">{danger ? <u>{text ?? value}</u> : (text ?? value)}</div>
    </div>
  );
}

/** Line chart with gridlines, axis ticks and a hover readout. */
export function LineChart({ points, yLabel, valueOf, color = "#16181d" }: {
  points: DailyPoint[]; yLabel: string; valueOf: (d: DailyPoint) => number; color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 640, H = 190, padL = 34, padB = 26, padT = 10, padR = 6;
  const max = Math.max(1, ...points.map(valueOf));
  const x = (i: number) => padL + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i)} ${y(valueOf(p))}`).join(" ");
  const step = Math.max(1, Math.ceil(points.length / 8));

  return (
    <div className="chart">
      <div className="ylab">{yLabel}</div>
      <svg ref={ref} className="plot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid-line" x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} />
            <text className="tick" x={padL - 7} y={y(max * f) + 3} textAnchor="end">{Math.round(max * f)}</text>
          </g>
        ))}
        {points.length > 1 && (
          <>
            <path d={`${d} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={color} opacity={0.07} />
            <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {points.map((p, i) => (
          <g key={p.date}>
            <circle cx={x(i)} cy={y(valueOf(p))} r={hover === i ? 4.5 : points.length > 30 ? 0 : 3} fill={color} />
            <circle cx={x(i)} cy={y(valueOf(p))} r={11} fill="transparent"
                    onPointerEnter={() => setHover(i)}>
              <title>{`${p.date} · ${valueOf(p)}`}</title>
            </circle>
            {(i % step === 0 || i === points.length - 1) && (
              <text className="tick" x={x(i)} y={H - padB + 15} textAnchor="middle">{p.date.slice(8)}</text>
            )}
          </g>
        ))}
        {points.length > 0 && (
          <text className="tick" x={padL} y={H - padB + 27} textAnchor="middle">
            {new Date(points[0].date + "T00:00:00").toLocaleString("en", { month: "short" }).toUpperCase()}
          </text>
        )}
      </svg>
    </div>
  );
}

/** Action button that reports success inline instead of via a toast. */
export function ActionButton({ label, done, tone, onRun }: {
  label: string; done: string; tone: "danger" | "primary"; onRun: () => Promise<boolean>;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  return (
    <button
      className={"btn " + (state === "done" ? "done" : tone)}
      disabled={state !== "idle"}
      onClick={async () => { setState("busy"); setState((await onRun()) ? "done" : "idle"); }}
    >
      {state === "done" ? `✓ ${done}` : label}
    </button>
  );
}
