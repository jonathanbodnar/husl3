import { useMemo, useState } from "react";
import type { ReadinessRow, Scoreboard as ScoreboardT, ScoreboardEval, StatResult, StatSpec } from "../../../shared/types";
import type { BrainIndex } from "../api";

const STAGE_FALLBACK: Record<string, string> = { s0: "Before users", s1: "First users", s2: "Activation", s3: "Monetization", s4: "Retention", s5: "Acquisition", s6: "Scale" };

const fmtInt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtNum = (n: number) => (Number.isInteger(n) ? fmtInt(n) : Math.abs(n) >= 100 ? fmtInt(n) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
function fmtValue(v: number, unit: StatSpec["unit"]): string {
  switch (unit) {
    case "percent": return pct(v);
    case "usd": return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 100 ? 0 : 2 });
    case "minutes": return `${fmtNum(v)} min`;
    case "days": return `${fmtNum(v)} d`;
    default: return fmtNum(v);
  }
}
const ago = (iso?: string) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 60 * 24 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function ScoreboardPanel(props: {
  board: ScoreboardT | null;
  evaluation: ScoreboardEval | null;
  brainIndex: BrainIndex | null;
  dbConnected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { board, evaluation } = props;
  const stats = useMemo(() => [...(board?.stats ?? [])].sort((a, b) => a.order - b.order), [board]);
  const stageName = (id: string) => props.brainIndex?.stages.find((s) => s.id === id)?.name ?? STAGE_FALLBACK[id] ?? id;
  const stale = board?.computedAt ? Date.now() - Date.parse(board.computedAt) > 60 * 60_000 : false;

  if (!board || !stats.length) {
    return (
      <div className="sbempty">
        <h3>Your numbers, through the plan</h3>
        <p>{props.dbConnected
          ? "The guide is binding the brain's metric recipes to your tables. The scoreboard appears as soon as the first ones run."
          : "Connect your database and the guide binds the brain's metric recipes to your tables: the money event, activation, and the numbers that decide your stage. The plan then adapts to what they say."}</p>
      </div>
    );
  }

  const byStage = new Map<string, ReadinessRow[]>();
  for (const r of evaluation?.rows ?? []) { if (!byStage.has(r.stage)) byStage.set(r.stage, []); byStage.get(r.stage)!.push(r); }
  const current = evaluation?.stageByNumbers ?? null;

  return (
    <div className="sb">
      <div className="sbhead">
        <div className="sbmeta">
          {board.goal && <div><span className="k">Money event</span> {board.goal}</div>}
          {board.activation && <div><span className="k">Activated</span> {board.activation}</div>}
          {board.coreRequest && <div><span className="k">Core request</span> {board.coreRequest}</div>}
          <div className="muted small">Computed {ago(board.computedAt)}{board.timezone ? ` · ${board.timezone}` : ""}{stale ? " · stale" : ""}{!props.dbConnected ? " · database not connected; refresh needs it" : ""}</div>
        </div>
        <button className="btn sm" disabled={props.refreshing || !props.dbConnected} onClick={props.onRefresh} title={props.dbConnected ? "Re-run every stat" : "Connect the database to refresh"}>
          {props.refreshing ? <><span className="spin" /> running…</> : "Refresh"}
        </button>
      </div>

      {evaluation && evaluation.measuredCount > 0 && (
        <section className="stagecard">
          <div className="stagehead2">
            <span className="sdot" style={{ background: `var(--${current ?? "s0"})` }} />
            <b>Stage by the numbers:</b> {current ? `${current} · ${stageName(current)}` : "not yet placeable"}
          </div>
          {current && (
            <ul className="ready">
              {(byStage.get(current) ?? []).map((r, i) => <ReadinessLine key={i} row={r} spec={stats.find((s) => s.id === r.statId)} />)}
            </ul>
          )}
          {current && (evaluation.unbound[current] ?? []).length > 0 && (
            <div className="muted small">Not yet measured for this stage: {(evaluation.unbound[current] ?? []).join(", ")}</div>
          )}
        </section>
      )}

      <div className="tiles">
        {stats.map((s) => <StatTile key={s.id} spec={s} result={board.results[s.id]} brainIndex={props.brainIndex} />)}
      </div>
    </div>
  );
}

function ReadinessLine({ row, spec }: { row: ReadinessRow; spec?: StatSpec }) {
  const icon = row.status === "pass" ? "✓" : row.status === "fail" ? "✗" : row.status === "small_n" ? "≈" : row.status === "stated" ? "❝" : "○";
  const label = row.status === "pass" ? "met" : row.status === "fail" ? (row.stated ? "not met (stated)" : "not met") : row.status === "small_n" ? "too few to say" : row.status === "stated" ? "stated" : "unmeasured";
  // A small-n row shows the counts, never the share the rule forbids.
  const actual = row.status === "small_n" && row.numerator != null ? `${fmtInt(row.numerator)} of ${fmtInt(row.denominator ?? 0)}`
    : row.actual != null ? (spec ? fmtValue(row.actual, spec.unit) : fmtNum(row.actual)) : null;
  return (
    <li className={`rl ${row.status}`} title={row.threshold}>
      <span className="ic" aria-hidden>{icon}</span>
      <span className="lab">{label}</span>
      <span className="txt">{row.threshold}</span>
      {actual != null && <span className="act mono">{actual}</span>}
    </li>
  );
}

function StatTile({ spec, result, brainIndex }: { spec: StatSpec; result?: StatResult; brainIndex: BrainIndex | null }) {
  const [open, setOpen] = useState(false);
  const metricLine = spec.metricId ? brainIndex?.evidence[spec.metricId] : undefined;
  const wide = !!(result?.points || result?.steps || result?.items) || spec.kind === "series" || spec.kind === "funnel" || spec.kind === "breakdown";
  return (
    <div className={`tile${wide ? " wide" : ""}${result && !result.ok ? " err" : ""}`}>
      <div className="tlabel">
        <span>{spec.title}</span>
        {spec.kind === "assert" && <span className="chip" title={spec.source ?? "stated by you"}>stated</span>}
        {spec.kind === "ads" && <span className="chip" title="From the ad platform export you uploaded">ads</span>}
        {spec.kind === "derived" && <span className="chip" title="Computed from two other stats on this board">derived</span>}
        {spec.metricId && <span className="ev" title={metricLine ?? spec.metricId}>{spec.metricId}{spec.field ? `.${spec.field}` : ""}</span>}
      </div>
      {!result ? <div className="muted small">not run yet</div>
        : !result.ok ? <div className="terr">{result.error}</div>
        : result.points ? <Series points={result.points} unit={spec.unit} droppedToday={!!result.droppedToday} />
        : result.steps ? <Funnel steps={result.steps} />
        : result.items ? <Breakdown items={result.items} unit={spec.unit} />
        : result.numerator != null ? (
          <div className="tvalue">
            {result.smallN
              ? <><span className="statv">{fmtInt(result.numerator)}<span className="of"> of {fmtInt(result.denominator ?? 0)}</span></span><div className="muted small">too few to quote as a share</div></>
              : <><span className="statv">{pct(result.value ?? 0)}</span><div className="muted small">{fmtInt(result.numerator)} of {fmtInt(result.denominator ?? 0)}</div></>}
          </div>
        ) : (
          <div className="tvalue"><span className="statv">{fmtValue(result.value ?? 0, spec.unit)}</span>{result.n != null && <div className="muted small">n = {fmtInt(result.n)}</div>}</div>
        )}
      {spec.caveat && <div className="muted small">{spec.caveat}</div>}
      {result?.notes?.map((n, i) => <div className="muted small tnote" key={i}>{n}</div>)}
      <div className="tfoot">
        <button type="button" className="alt small" onClick={() => setOpen((o) => !o)}>{open ? "less" : "why"}</button>
        {result?.ok && result.computedAt && <span className="muted small" title={result.computedAt}>{ago(result.computedAt)}</span>}
      </div>
      {open && (
        <div className="twhy">
          <div>{spec.why}</div>
          {spec.sql && <pre className="mono">{spec.sql}</pre>}
        </div>
      )}
    </div>
  );
}

/** Sparkline: history in the de-emphasis gray, the latest point in the data hue, one labeled value, hover reads any point. */
function Series({ points, unit, droppedToday }: { points: { day: string; value: number }[]; unit: StatSpec["unit"]; droppedToday: boolean }) {
  const [hoverRaw, setHover] = useState<number | null>(null);
  // The hover index can outlive a shrinking series (the tile keeps its key); clamp it.
  const hover = hoverRaw == null ? null : Math.min(hoverRaw, points.length - 1);
  const W = 320, H = 72, PX = 4, PY = 10;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals, 0), max = Math.max(...vals, 1);
  const x = (i: number) => PX + (points.length === 1 ? (W - 2 * PX) / 2 : (i * (W - 2 * PX)) / (points.length - 1));
  const y = (v: number) => H - PY - ((v - min) / (max - min || 1)) * (H - 2 * PY);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const shown = hover != null ? points[hover] : last;
  // Seven CALENDAR days ending on the latest point, not the last seven rows (quiet days have no row).
  const cutoff = Date.parse(last.day) - 6 * 86_400_000;
  const total7 = points.filter((p) => Date.parse(p.day) >= cutoff).reduce((a, p) => a + p.value, 0);
  const additive = unit === "count" || unit === "usd";
  return (
    <div className="series">
      <div className="tvalue">
        <span className="statv">{fmtValue(shown.value, unit)}</span>
        <div className="muted small">{hover != null ? shown.day : `latest complete day, ${last.day}`}{additive && points.length >= 2 && hover == null ? ` · ${fmtValue(total7, unit)} in the 7 days to ${last.day.slice(5)}` : ""}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="spark" role="img" aria-label={`${points.length} daily values, latest ${fmtValue(last.value, unit)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; let best = 0; for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; setHover(best); }}>
        <path d={path} fill="none" stroke="var(--line-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.length > 1 && <path d={points.slice(-2).map((p, i) => `${i ? "L" : "M"}${x(points.length - 2 + i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")} fill="none" stroke="var(--data)" strokeWidth={2} strokeLinecap="round" />}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PY / 2} y2={H - PY / 2} stroke="var(--line-2)" strokeWidth={1} />}
        <circle cx={x(hover ?? points.length - 1)} cy={y(shown.value)} r={4} fill="var(--data)" stroke="var(--surface)" strokeWidth={2} />
      </svg>
      <div className="muted small axis"><span>{points[0].day}</span><span>{droppedToday ? "today excluded" : ""}</span><span>{last.day}</span></div>
    </div>
  );
}

/** Funnel: horizontal bars sharing one baseline, count at the tip, step conversion beside the label. */
function Funnel({ steps }: { steps: { step: string; count: number; fromPrev?: number; fromFirst?: number; smallN?: boolean }[] }) {
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <div className="bars">
      {steps.map((s, i) => (
        <div className="bar" key={i} title={`${s.step}: ${fmtInt(s.count)}${s.fromFirst != null ? ` · ${pct(s.fromFirst)} of first step` : ""}`}>
          <div className="blabel"><span>{s.step}</span>{i > 0 && (s.fromPrev != null ? <span className="muted small"> {pct(s.fromPrev)} of previous</span> : s.smallN ? <span className="muted small"> too few to quote a share</span> : null)}</div>
          <div className="btrack"><div className="bfill" style={{ width: `${Math.max(2, (s.count / max) * 100)}%` }} /><span className="bval mono">{fmtInt(s.count)}</span></div>
        </div>
      ))}
    </div>
  );
}

function Breakdown({ items, unit }: { items: { label: string; value: number; n?: number; smallN?: boolean }[]; unit: StatSpec["unit"] }) {
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  const shown = (it: { value: number; n?: number; smallN?: boolean }) => (it.smallN ? `${fmtInt(Math.round(it.value * (it.n ?? 0)))} of ${fmtInt(it.n ?? 0)}` : fmtValue(it.value, unit));
  return (
    <div className="bars">
      {items.map((it, i) => (
        <div className="bar" key={i} title={`${it.label}: ${shown(it)}${it.n != null && !it.smallN ? ` (n=${fmtInt(it.n)})` : ""}`}>
          <div className="blabel"><span>{it.label}</span>{it.n != null && !it.smallN && <span className="muted small"> n={fmtInt(it.n)}</span>}{it.smallN && <span className="muted small"> too few to quote a share</span>}</div>
          <div className="btrack"><div className="bfill" style={{ width: `${Math.max(2, (it.value / max) * 100)}%` }} /><span className="bval mono">{shown(it)}</span></div>
        </div>
      ))}
    </div>
  );
}
