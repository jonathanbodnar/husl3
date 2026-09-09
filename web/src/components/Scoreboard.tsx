import { useMemo, useState } from "react";
import { pathLeaks, pct0 } from "../../../shared/path";
import type { DbTelemetry, ReadinessRow, Scoreboard as ScoreboardT, ScoreboardEval, StatResult, StatSpec } from "../../../shared/types";
import type { BrainIndex } from "../api";

/**
 * The founder's numbers, arranged the way a founder thinks: the goal, the path people take to reach it,
 * where they leak out, and then the rest. Technical names (metric ids, stage ids, SQL) exist for the
 * model and the evidence trail; here they sit behind one "Show details" toggle.
 */

const STAGE_FALLBACK: Record<string, string> = { s0: "Before users", s1: "First users", s2: "Activation", s3: "Monetization", s4: "Retention", s5: "Acquisition", s6: "Scale" };

const fmtInt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtNum = (n: number) => (Number.isInteger(n) ? fmtInt(n) : Math.abs(n) >= 100 ? fmtInt(n) : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
function fmtValue(v: number, unit: StatSpec["unit"]): string {
  switch (unit) {
    case "percent": return pct(v);
    case "usd": return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 100 ? 0 : 2 });
    case "minutes": return `${fmtNum(v)} min`;
    case "days": return `${fmtNum(v)} days`;
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
  telemetry: DbTelemetry | null | undefined;
  dbConnected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onAsk: (text: string) => void;
}) {
  const { board, evaluation } = props;
  const [details, setDetails] = useState(false);
  const stats = useMemo(() => [...(board?.stats ?? [])].sort((a, b) => a.order - b.order), [board]);
  const stageName = (id: string) => props.brainIndex?.stages.find((s) => s.id === id)?.name ?? STAGE_FALLBACK[id] ?? id;
  const noTelemetry = props.dbConnected && props.telemetry != null && !props.telemetry.hasEvents;

  const path = useMemo(() => {
    if (!board) return null;
    const chosen = board.stats.find((s) => s.id === board.pathStatId && s.kind === "funnel");
    const fallback = [...board.stats].filter((s) => s.kind === "funnel").sort((a, b) => (board.results[b.id]?.steps?.length ?? 0) - (board.results[a.id]?.steps?.length ?? 0))[0];
    const spec = chosen ?? fallback;
    if (!spec) return null;
    const result = board.results[spec.id];
    return { spec, result, leaks: pathLeaks(result) };
  }, [board]);

  if (!board || !stats.length) {
    return (
      <div className="sb">
        {noTelemetry && <TelemetryBanner telemetry={props.telemetry!} onAsk={props.onAsk} />}
        <div className="sbempty">
          <h3>Your numbers, through the plan</h3>
          <p>{props.dbConnected
            ? noTelemetry
              ? "Accounts and payments can be counted. Everything in between waits on tracking."
              : "The guide is reading your tables now. The numbers appear as soon as the first ones run."
            : "Connect your database and the guide works out your goal, the path people take to reach it, and where they leak out. The plan then follows what the numbers say."}</p>
        </div>
      </div>
    );
  }

  // Without tracking, only counts of accounts, payments and money are honest; anything that needs events is hidden.
  const others = stats.filter((s) => s.id !== path?.spec.id && (!noTelemetry || (board.results[s.id]?.ok && s.kind !== "funnel")));
  const current = evaluation?.stageByNumbers ?? null;
  const rows = (evaluation?.rows ?? []).filter((r) => r.stage === current);

  return (
    <div className="sb">
      {noTelemetry && <TelemetryBanner telemetry={props.telemetry!} onAsk={props.onAsk} />}

      <section className="goalcard">
        <div className="k">Your goal</div>
        <div className="goal">{board.goal ?? "Not named yet"}</div>
        {board.activation && <div className="sub"><b>Activated means</b> {board.activation}</div>}
        <div className="sbtools">
          <span className="muted small">Computed {ago(board.computedAt)}{!props.dbConnected ? " · connect the database to refresh" : ""}</span>
          <button className="btn sm" disabled={props.refreshing || !props.dbConnected} onClick={props.onRefresh}>{props.refreshing ? <><span className="spin" /> running…</> : "Refresh"}</button>
          <button type="button" className="alt small" onClick={() => setDetails((d) => !d)}>{details ? "Hide details" : "Show details"}</button>
        </div>
      </section>

      {path && !noTelemetry && <PathCard spec={path.spec} result={path.result} leaks={path.leaks} details={details} onAsk={props.onAsk} />}

      {!noTelemetry && evaluation && evaluation.measuredCount > 0 && current && (
        <section className="standcard">
          <div className="k">Where you stand</div>
          <div className="stage"><span className="sdot" style={{ background: `var(--${current})` }} /> {stageName(current)}</div>
          <ul className="plainready">
            {rows.map((r, i) => <PlainReadiness key={i} row={r} spec={stats.find((s) => s.id === r.statId)} brainIndex={props.brainIndex} details={details} />)}
          </ul>
          {details && (evaluation.unbound[current] ?? []).length > 0 && (
            <div className="muted small">Not yet measured for this stage: {(evaluation.unbound[current] ?? []).join(", ")}</div>
          )}
        </section>
      )}

      {others.length > 0 && (
        <section>
          <div className="k">The numbers</div>
          <div className="tiles">
            {others.map((s) => <StatTile key={s.id} spec={s} result={board.results[s.id]} brainIndex={props.brainIndex} details={details} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function TelemetryBanner({ telemetry, onAsk }: { telemetry: DbTelemetry; onAsk: (t: string) => void }) {
  return (
    <section className="telemetry" role="alert">
      <div className="k">First things first</div>
      <h3>You're not tracking what users do</h3>
      <p>Your database has accounts and payments, but nothing about what people do in between. So it can say how many signed up and how many paid, and nothing about who got value, who came back, or where people leave on the way to paying. Until that exists, every other move is a guess.</p>
      <p><b>Your first step is to start tracking</b>: an event for every page view, click and action, with a stable anonymous id from before signup. It is the first item on your what-to-do list.</p>
      <div className="rowb">
        <button className="btn primary sm" onClick={() => onAsk("What exactly should I track first, and how do I add it to my product in a day? Give me the event names and where each one fires.")}>Ask how to start</button>
        {telemetry.eventTables.length > 0 && <span className="muted small">Looked at: {telemetry.eventTables.join(", ")}</span>}
      </div>
    </section>
  );
}

function PathCard({ spec, result, leaks, details, onAsk }: { spec: StatSpec; result?: StatResult; leaks: ReturnType<typeof pathLeaks>; details: boolean; onAsk: (t: string) => void }) {
  const steps = result?.steps ?? [];
  const biggest = leaks[0];
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <section className="pathcard">
      <div className="k">The path to it, and where people leave</div>
      {!result ? <div className="muted small">not run yet</div>
        : !result.ok ? <div className="terr">{result.error}</div>
        : (
          <div className="path">
            {steps.map((s, i) => {
              const leak = i > 0 ? leaks.find((l) => l.from === i - 1) : undefined;
              const isBiggest = !!(leak && biggest && leak.from === biggest.from && (biggest.lost ?? 0) > 0);
              return (
                <div key={i}>
                  {i > 0 && (
                    <div className={`leak${isBiggest ? " biggest" : ""}`}>
                      <span className="arrow" aria-hidden>↓</span>
                      {leak
                        ? (leak.smallN || leak.lost == null
                          ? <span><b>{fmtInt(leak.lostCount)} people</b> did not go on{leak.lostCount < 10 ? " (too few to call a share)" : ""}</span>
                          : <span><b>{pct0(leak.lost)} leave here</b> · {fmtInt(leak.lostCount)} people</span>)
                        : <span className="muted">more people here than at the step before — check the step order</span>}
                      {isBiggest && <span className="tag">Biggest leak · fix this first</span>}
                    </div>
                  )}
                  <div className="step">
                    <div className="sbar"><div className="sfill" style={{ width: `${Math.max(3, (s.count / max) * 100)}%` }} /></div>
                    <div className="stext"><span className="sname">{s.step}</span><span className="scount">{fmtInt(s.count)}</span></div>
                  </div>
                </div>
              );
            })}
            {biggest && (biggest.lost ?? 0) > 0 && (
              <div className="rowb" style={{ marginTop: ".4rem" }}>
                <button className="btn primary sm" onClick={() => onAsk(`The biggest leak on my path is between "${biggest.fromStep}" and "${biggest.toStep}": ${biggest.smallN || biggest.lost == null ? `${biggest.lostCount} people` : `${pct0(biggest.lost)} of people`} leave there. What is the one change to make first, and how do I measure whether it worked?`)}>What do I do about it?</button>
              </div>
            )}
          </div>
        )}
      {spec.why && <div className="why">{spec.why}</div>}
      {result?.notes?.map((n, i) => <div className="muted small tnote" key={i}>{n}</div>)}
      {details && <div className="detailbox"><div>{spec.title}{spec.metricId ? ` · ${spec.metricId}` : ""}</div>{spec.sql && <pre className="mono">{spec.sql}</pre>}</div>}
    </section>
  );
}

function PlainReadiness({ row, spec, brainIndex, details }: { row: ReadinessRow; spec?: StatSpec; brainIndex: BrainIndex | null; details: boolean }) {
  // The brain's evidence line reads "metric_id: Metric name [unit] — definition"; the name is the plain label.
  const line = brainIndex?.evidence[row.metric] ?? "";
  const name = line.split(":").slice(1).join(":").split("[")[0].trim() || spec?.title || row.metric;
  const unit = (spec?.unit ?? (row.value <= 1 ? "percent" : "count")) as StatSpec["unit"];
  const target = fmtValue(row.value, unit);
  const actual = row.status === "small_n" && row.numerator != null
    ? `${fmtInt(row.numerator)} of ${fmtInt(row.denominator ?? 0)}`
    : row.actual != null ? fmtValue(row.actual, unit) : null;
  const word = row.status === "pass" ? "There" : row.status === "fail" ? (row.stated ? "Not there (your estimate)" : "Not there yet") : row.status === "small_n" ? "Too few to say" : row.status === "stated" ? "There (your estimate)" : "Not measured yet";
  const relation = row.op === "<" || row.op === "<=" ? "under" : "at least";
  return (
    <li className="pr" title={details ? row.threshold : undefined}>
      <span className={`pill ${row.status}`}>{word}</span>
      <span className="ptext">
        <b>{name}</b>{actual ? <>: <span className="mono">{actual}</span></> : null}
        <span className="muted"> · the bar is {relation} {target}</span>
      </span>
      {details && <span className="muted small" style={{ flexBasis: "100%" }}>{row.threshold}</span>}
    </li>
  );
}

function StatTile({ spec, result, brainIndex, details }: { spec: StatSpec; result?: StatResult; brainIndex: BrainIndex | null; details: boolean }) {
  const metricLine = spec.metricId ? brainIndex?.evidence[spec.metricId] : undefined;
  const isChart = !!(result?.points || result?.steps || result?.items);
  return (
    <div className={`tile${isChart ? " wide" : ""}${result && !result.ok ? " err" : ""}`}>
      <div className="tlabel">
        <span className="ttitle">{spec.title}</span>
        {spec.kind === "assert" && <span className="chip" title={spec.source ?? "your estimate"}>your estimate</span>}
        {spec.kind === "ads" && <span className="chip" title="From the ad spend you brought in">ad spend</span>}
        {spec.kind === "derived" && <span className="chip" title="Worked out from two other numbers here">worked out</span>}
      </div>
      {!result ? <div className="muted small">not run yet</div>
        : !result.ok ? <div className="terr">{result.error}</div>
        : result.points ? <Series points={result.points} unit={spec.unit} droppedToday={!!result.droppedToday} />
        : result.steps ? <Funnel steps={result.steps} />
        : result.items ? <Breakdown items={result.items} unit={spec.unit} />
        : result.numerator != null ? (
          <div className="tvalue">
            {result.smallN
              ? <><span className="statv">{fmtInt(result.numerator)}<span className="of"> of {fmtInt(result.denominator ?? 0)}</span></span><div className="muted small">too few to call a share yet</div></>
              : <><span className="statv">{pct(result.value ?? 0)}</span><div className="muted small">{fmtInt(result.numerator)} of {fmtInt(result.denominator ?? 0)}</div></>}
          </div>
        ) : result.smallN && result.n != null ? (
          <div className="tvalue">
            <span className="statv">{fmtValue((result.value ?? 0) * result.n, spec.unit)}<span className="of"> over {fmtInt(result.n)}</span></span>
            <div className="muted small">too few to quote per person</div>
          </div>
        ) : (
          <div className="tvalue"><span className="statv">{fmtValue(result.value ?? 0, spec.unit)}</span>{result.n != null && <div className="muted small">out of {fmtInt(result.n)}</div>}</div>
        )}
      {spec.why && <div className="why">{spec.why}</div>}
      {spec.caveat && <div className="muted small">{spec.caveat}</div>}
      {result?.notes?.map((n, i) => <div className="muted small tnote" key={i}>{n}</div>)}
      {details && (
        <div className="detailbox">
          <div>{spec.metricId ? <span className="ev" title={metricLine ?? spec.metricId}>{spec.metricId}{spec.field ? `.${spec.field}` : ""}</span> : null}{result?.computedAt && <span className="muted small"> · computed {ago(result.computedAt)}</span>}</div>
          {spec.sql && <pre className="mono">{spec.sql}</pre>}
        </div>
      )}
    </div>
  );
}

/** Sparkline: history in the de-emphasis gray, the latest point in the data hue, one labeled value, hover reads any point. */
function Series({ points, unit, droppedToday }: { points: { day: string; value: number }[]; unit: StatSpec["unit"]; droppedToday: boolean }) {
  const [hoverRaw, setHover] = useState<number | null>(null);
  const hover = hoverRaw == null ? null : Math.min(hoverRaw, points.length - 1);
  const W = 320, H = 72, PX = 4, PY = 10;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals, 0), max = Math.max(...vals, 1);
  const x = (i: number) => PX + (points.length === 1 ? (W - 2 * PX) / 2 : (i * (W - 2 * PX)) / (points.length - 1));
  const y = (v: number) => H - PY - ((v - min) / (max - min || 1)) * (H - 2 * PY);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const shown = hover != null ? points[hover] : last;
  const cutoff = Date.parse(last.day) - 6 * 86_400_000;
  const total7 = points.filter((p) => Date.parse(p.day) >= cutoff).reduce((a, p) => a + p.value, 0);
  const additive = unit === "count" || unit === "usd";
  return (
    <div className="series">
      <div className="tvalue">
        <span className="statv">{fmtValue(shown.value, unit)}</span>
        <div className="muted small">{hover != null ? shown.day : `on ${last.day}, the last full day`}{additive && points.length >= 2 && hover == null ? ` · ${fmtValue(total7, unit)} in the 7 days to ${last.day.slice(5)}` : ""}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="spark" role="img" aria-label={`${points.length} daily values, latest ${fmtValue(last.value, unit)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; let best = 0; for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; setHover(best); }}>
        <path d={path} fill="none" stroke="var(--line-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.length > 1 && <path d={points.slice(-2).map((p, i) => `${i ? "L" : "M"}${x(points.length - 2 + i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")} fill="none" stroke="var(--data)" strokeWidth={2} strokeLinecap="round" />}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PY / 2} y2={H - PY / 2} stroke="var(--line-2)" strokeWidth={1} />}
        <circle cx={x(hover ?? points.length - 1)} cy={y(shown.value)} r={4} fill="var(--data)" stroke="var(--surface)" strokeWidth={2} />
      </svg>
      <div className="muted small axis"><span>{points[0].day}</span><span>{droppedToday ? "today not counted yet" : ""}</span><span>{last.day}</span></div>
    </div>
  );
}

/** A secondary funnel (not the path): horizontal bars, count at the tip, step conversion beside the label. */
function Funnel({ steps }: { steps: { step: string; count: number; fromPrev?: number; fromFirst?: number; smallN?: boolean }[] }) {
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <div className="bars">
      {steps.map((s, i) => (
        <div className="bar" key={i} title={`${s.step}: ${fmtInt(s.count)}${s.fromFirst != null ? ` · ${pct(s.fromFirst)} of the first step` : ""}`}>
          <div className="blabel"><span>{s.step}</span>{i > 0 && (s.fromPrev != null ? <span className="muted small"> {pct(s.fromPrev)} went on</span> : s.smallN ? <span className="muted small"> too few to call a share</span> : null)}</div>
          <div className="btrack"><div className="bfill" style={{ width: `${Math.max(2, (s.count / max) * 100)}%` }} /><span className="bval mono">{fmtInt(s.count)}</span></div>
        </div>
      ))}
    </div>
  );
}

function Breakdown({ items, unit }: { items: { label: string; value: number; n?: number; smallN?: boolean }[]; unit: StatSpec["unit"] }) {
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  const perUnit = unit === "usd" || unit === "minutes" || unit === "days";
  const shown = (it: { value: number; n?: number; smallN?: boolean }) =>
    !it.smallN ? fmtValue(it.value, unit)
      : perUnit ? `${fmtValue(it.value * (it.n ?? 0), unit)} over ${fmtInt(it.n ?? 0)}`
      : `${fmtInt(Math.round(it.value * (it.n ?? 0)))} of ${fmtInt(it.n ?? 0)}`;
  return (
    <div className="bars">
      {items.map((it, i) => (
        <div className="bar" key={i} title={`${it.label}: ${shown(it)}${it.n != null && !it.smallN ? ` (of ${fmtInt(it.n)})` : ""}`}>
          <div className="blabel"><span>{it.label}</span>{it.n != null && !it.smallN && <span className="muted small"> of {fmtInt(it.n)}</span>}{it.smallN && <span className="muted small"> {perUnit ? "too few to quote per person" : "too few to call a share"}</span>}</div>
          <div className="btrack"><div className="bfill" style={{ width: `${Math.max(2, (it.value / max) * 100)}%` }} /><span className="bval mono">{shown(it)}</span></div>
        </div>
      ))}
    </div>
  );
}
