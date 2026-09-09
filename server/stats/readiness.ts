import type { ReadinessRow, Scoreboard, ScoreboardEval, StageId } from "../../shared/types.js";
import { brain } from "../brain/render.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Grades the founder's scoreboard against the brain's journey. Every stage carries readiness checks of
 * the form {metric, field, op, value}; a stat that declares the same metricId and field supplies the
 * actual. The current stage by the numbers is the earliest stage with a check that is not passed —
 * which is exactly how the brain says a stage is advanced: by numbers, not by opinion.
 */
export function evaluateScoreboard(board: Scoreboard | null | undefined): ScoreboardEval {
  const stages: any[] = brain.journey ?? [];
  const rows: ReadinessRow[] = [];
  const unbound: Record<string, string[]> = {};
  const stats = board?.stats ?? [];
  const results = board?.results ?? {};
  const bound = new Set(stats.filter((s) => s.metricId).map((s) => s.metricId as string));
  let measuredCount = 0;

  const cmp = (op: string, a: number, b: number): boolean => {
    switch (op) {
      case ">=": return a >= b;
      case ">": return a > b;
      case "<=": return a <= b;
      case "<": return a < b;
      case "==": case "=": return a === b;
      default: return false;
    }
  };

  for (const st of stages) {
    unbound[st.id] = (st.instrument_now ?? []).filter((m: string) => !bound.has(m));
    for (const r of st.readiness ?? []) {
      const chk = r.check ?? {};
      const metric = String(chk.metric ?? r.metric ?? "");
      const field = String(chk.field ?? "");
      const op = String(chk.op ?? ">=");
      const target = Number(chk.value);
      const row: ReadinessRow = { stage: st.id as StageId, metric, field, op, value: target, threshold: String(r.threshold ?? ""), note: r.note ? String(r.note) : undefined, status: "unmeasured" };
      // Candidates bound to metric+field; a scalar (number/rate/assert) outranks a series on the same
      // binding, because a series answers "per period" and a scalar "in total" and the check names which.
      // Fall back to a stat bound to the metric alone when it is the only one.
      const rank = (s: { kind: string }) => (s.kind === "series" ? 1 : 0);
      const exact = stats.filter((s) => s.metricId === metric && s.field === field).sort((a, b) => rank(a) - rank(b));
      const loose = exact.length ? [] : stats.filter((s) => s.metricId === metric);
      const spec = exact[0] ?? (loose.length === 1 ? loose[0] : undefined);
      if (spec) {
        const res = results[spec.id];
        row.statId = spec.id;
        // A series is graded on its latest complete period.
        const actual = res?.ok ? (typeof res.value === "number" ? res.value : res.points?.length ? res.points[res.points.length - 1].value : undefined) : undefined;
        if (typeof actual === "number" && Number.isFinite(target)) {
          measuredCount++;
          if (spec.kind === "assert") row.status = "stated";
          else if (res!.smallN) row.status = "small_n";
          else row.status = cmp(op, actual, target) ? "pass" : "fail";
          row.actual = actual;
        }
      }
      rows.push(row);
    }
  }

  // The current stage is the earliest one with a check the numbers do not clear (fail, or too few to
  // say). A stage whose checks are merely unmeasured does not pin the founder when a later stage already
  // carries real numbers; it is reported as a gap instead, so "we never measured s0's registry" cannot
  // hold a founder with paying accounts at "before users".
  let stageByNumbers: StageId | null = null;
  if (measuredCount > 0) {
    const graded = (id: string) => rows.some((r) => r.stage === id && (r.status === "pass" || r.status === "fail" || r.status === "small_n"));
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const mine = rows.filter((r) => r.stage === st.id);
      if (mine.some((r) => r.status === "fail" || r.status === "small_n")) { stageByNumbers = st.id as StageId; break; }
      const allUnmeasured = mine.length > 0 && mine.every((r) => r.status === "unmeasured");
      if (allUnmeasured && !stages.slice(i + 1).some((later: any) => graded(later.id))) { stageByNumbers = st.id as StageId; break; }
    }
    if (!stageByNumbers && stages.length) stageByNumbers = stages[stages.length - 1].id as StageId;
  }
  return { stageByNumbers, rows, unbound, measuredCount };
}

/** The metric ids and readiness fields, for the tool description, so the model binds to real names. */
export function bindingCatalog(): string {
  const metrics: any[] = brain.metrics ?? [];
  const stages: any[] = brain.journey ?? [];
  const lines: string[] = [];
  lines.push("Brain metric recipes (metricId · unit · definition):");
  for (const m of metrics) lines.push(`- ${m.id} · ${m.unit} · ${String(m.definition).slice(0, 220)}`);
  lines.push("Readiness fields per stage (bind a stat with metricId + field to grade the check):");
  for (const st of stages) for (const r of st.readiness ?? []) if (r.check) lines.push(`- ${st.id}: ${r.check.metric}.${r.check.field} ${r.check.op} ${r.check.value}`);
  return lines.join("\n");
}
