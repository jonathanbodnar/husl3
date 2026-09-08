import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = Record<string, any>;

function loadBrain(): Any {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "brain.json"), path.resolve(process.cwd(), "server/brain/brain.json")];
  for (const c of candidates) if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf8"));
  throw new Error("brain.json not found; run `npm run sync-brain`");
}

export const brain: Any = loadBrain();
export const brainVersion: string = String(brain.version ?? "unknown");

/** id → entity, for evidence validation and prompt bundles. */
export const brainIndex: Map<string, { kind: string; entity: Any }> = new Map();
function index(kind: string, list: Any[] | undefined) {
  for (const e of list ?? []) if (e && typeof e.id === "string") brainIndex.set(e.id, { kind, entity: e });
}
index("principle", brain.principles);
for (const p of brain.principles ?? []) for (const m of p.moves ?? []) if (m?.id) brainIndex.set(m.id, { kind: "move", entity: { ...m, principle: p.id } });
index("effect", brain.effect_ledger);
index("benchmark", brain.benchmarks);
index("trap", brain.measurement_traps);
index("killed", brain.killed);
index("law", brain.laws);
index("audit", brain.audit_kit);
index("practice", brain.practices);
index("belief_signal", brain.belief_signals);
index("metric", brain.metrics);
index("stage", brain.journey);
index("manifesto", brain.manifesto?.blocks);

export const stageIds: string[] = (brain.journey ?? []).map((s: Any) => s.id);

const s = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => s(x)).join("; ") : JSON.stringify(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : v == null ? [] : [s(v)]);

function render(): string {
  const L: string[] = [];
  const push = (...xs: string[]) => L.push(...xs);

  push(`# VIBE DISTRIBUTION — THE BRAIN (v${brainVersion})`, s(brain.tagline), "");
  push("## Source", s(brain.source?.summary));
  for (const b of list(brain.source?.boundaries)) push(`- ${b}`);
  push("", "## Confidence labels (every number carries one)");
  for (const [k, v] of Object.entries(brain.confidence_labels ?? {})) push(`- ${k}: ${s(v)}`);
  push("", "## Metric conventions");
  for (const [k, v] of Object.entries(brain.metric_conventions ?? {})) push(`- ${k}: ${s(v)}`);

  push("", "## Manifesto (founder's voice)");
  for (const b of brain.manifesto?.blocks ?? []) {
    push(`### ${s(b.key)} (${b.id})`);
    for (const v of list(b.voice)) push(`> ${v}`);
    const said = list(b.what_the_data_said);
    if (said.length) { push("What the data said:"); for (const x of said) push(`- ${x}`); }
  }
  const punch = list(brain.manifesto?.punch_list);
  if (punch.length) { push("### Punch list"); for (const x of punch) push(`- ${x}`); }
  if (brain.manifesto?.closer) push(`### Closer`, s(brain.manifesto.closer));

  push("", "## Journey (stages; the earliest stage whose you_are_here_when conditions hold is the current one)");
  for (const st of brain.journey ?? []) {
    push(`### ${st.id} · ${s(st.name)}`, `Goal: ${s(st.goal)}`);
    const here = list(st.you_are_here_when);
    if (here.length) { push("You are here when:"); for (const x of here) push(`- ${x}`); }
    if (st.feels_like) push(`Feels like: ${s(st.feels_like)}`);
    const doNow = st.do_now ?? [];
    if (doNow.length) {
      push("Do now:");
      doNow.forEach((d: Any, i: number) => push(`${i + 1}. [${s(d.principle)}] ${s(d.move)}${list(d.evidence).length ? ` (evidence: ${list(d.evidence).join(", ")})` : ""}`));
    }
    if (list(st.instrument_now).length) push(`Instrument now: ${list(st.instrument_now).join(", ")}`);
    if ((st.audits ?? []).length) push(`Audits: ${st.audits.map((a: Any) => `${s(a.audit_id)} (${s(a.cadence)})`).join(", ")}`);
    if ((st.readiness ?? []).length) {
      push("Readiness to advance:");
      for (const r of st.readiness) {
        const chk = r.check ? ` [check: ${s(r.check.metric)}.${s(r.check.field)} ${s(r.check.op)} ${s(r.check.value)}]` : "";
        push(`- ${s(r.metric)} ${s(r.threshold)}${r.note ? `: ${s(r.note)}` : ""}${chk}${list(r.evidence).length ? ` (evidence: ${list(r.evidence).join(", ")})` : ""}`);
      }
    }
    if (list(st.traps).length) push(`Traps to watch: ${list(st.traps).join(", ")}`);
    if (list(st.killed_examples).length) push(`Killed at this stage: ${list(st.killed_examples).join("; ")}`);
  }

  push("", "## Principles");
  for (const p of brain.principles ?? []) {
    push(`### ${p.id} · ${s(p.title)}`, `Key: ${s(p.key)}`, `Voice: "${s(p.voice)}"`);
    if (p.why) push(`Why: ${s(p.why)}`);
    if (p.moves_lead) push(`Moves: ${s(p.moves_lead)}`);
    for (const m of p.moves ?? []) push(`- ${s(m.id)}: ${s(m.text)}`);
    const ev = p.evidence ?? [];
    if (ev.length) { push("Evidence:"); for (const e of ev) push(`- ${s(e.text)}${e.confidence ? ` [${s(e.confidence)}]` : ""}`); }
    const donts = list(p.donts);
    if (donts.length) { push("Don't:"); for (const d of donts) push(`- ${d}`); }
    if (p.how_to_measure) push(`How to measure: ${s(p.how_to_measure)}`);
    if (list(p.metric_ids).length) push(`Metrics: ${list(p.metric_ids).join(", ")}`);
  }

  push("", "## Effect ledger (what a change did, with its confidence label)");
  for (const e of brain.effect_ledger ?? []) {
    push(`- ${e.id}: ${s(e.change)} → ${s(e.metric)} ${s(e.before_after)} (${s(e.effect)}) [${s(e.confidence)}]${e.caveat ? `; caveat: ${s(e.caveat)}` : ""}${e.same_change_as ? `; same change as ${s(e.same_change_as)}` : ""}${list(e.principle_ids).length ? ` {${list(e.principle_ids).join(", ")}}` : ""}`);
  }
  push("", "## Headline effects");
  for (const h of brain.effects_headline ?? []) push(`- ${s(h.headline)}: ${s(h.move)} — ${s(h.before_after)} [${s(h.confidence)}] (${s(h.ledger_id)})`);

  push("", "## Benchmarks");
  for (const b of brain.benchmarks ?? []) push(`- ${b.id} (${s(b.area)}): ${s(b.value)}. Read it as: ${s(b.read_it_as)}${b.metric_id ? ` {metric: ${s(b.metric_id)}}` : ""}`);

  push("", "## Measurement traps");
  for (const t of brain.measurement_traps ?? []) push(`- ${t.id}: looked like "${s(t.looked_like)}" — was: ${s(t.was)} Rule: ${s(t.rule)}`);

  push("", "## Killed (what was cut, and why)");
  for (const k of brain.killed ?? []) push(`- ${k.id}: ${s(k.what)} — ${s(k.why)}`);

  push("", "## Laws");
  const byTheme = new Map<string, Any[]>();
  for (const l of brain.laws ?? []) { const t = s(l.theme) || "General"; if (!byTheme.has(t)) byTheme.set(t, []); byTheme.get(t)!.push(l); }
  for (const [theme, laws] of byTheme) {
    push(`### ${theme}`);
    for (const l of laws) push(`- ${l.id}: ${s(l.law)}${l.incident ? ` (incident: ${s(l.incident)})` : ""}${list(l.principle_ids).length ? ` {${list(l.principle_ids).join(", ")}}` : ""}`);
  }

  push("", "## Cadence");
  for (const c of brain.cadence ?? []) { push(`### ${s(c.period)} — ${s(c.name)} (${c.id})`); for (const i of list(c.items)) push(`- ${i}`); }

  push("", "## Audit kit (question → trap → decision rule)");
  for (const a of brain.audit_kit ?? []) push(`- ${a.id} · ${s(a.audit)}: Q: ${s(a.question)} | Trap: ${s(a.trap)} | Rule: ${s(a.decision_rule)}`);

  push("", "## Practices");
  for (const p of brain.practices ?? []) push(`- ${p.id} · ${s(p.practice)} (${s(p.cadence)}): ${s(p.what)} Why: ${s(p.why)}`);

  push("", "## Belief signals (what users' behavior said they believed the product was)");
  for (const b of brain.belief_signals ?? []) push(`- ${b.id} · ${s(b.signal)}: ${s(b.showed)} → ${s(b.changed)}`);

  push("", "## Metric recipes");
  for (const m of brain.metrics ?? []) {
    const ref = (m.reference ?? []).map((r: Any) => `${s(r.field)}=${s(r.value)}`).join(", ");
    push(`- ${m.id} · ${s(m.name)} [${s(m.unit)}]: ${s(m.definition)}${m.benchmark ? ` Benchmark: ${s(m.benchmark)}` : ""}${m.trap ? ` Trap: ${s(m.trap)}` : ""}${ref ? ` Reference: ${ref}` : ""}`);
  }
  return L.join("\n");
}

export const brainText: string = render();
/** Rough token estimate (≈3.8 chars/token for this kind of English). */
export const brainTokensApprox: number = Math.round(brainText.length / 3.8);

/** Resolve an evidence id to a one-line description for prompts and UI. */
export function describeEvidence(id: string): string | null {
  const hit = brainIndex.get(id);
  if (!hit) return null;
  const e = hit.entity;
  switch (hit.kind) {
    case "effect": return `${id}: ${s(e.change)} → ${s(e.metric)} ${s(e.before_after)} (${s(e.effect)}) [${s(e.confidence)}]${e.caveat ? `; ${s(e.caveat)}` : ""}`;
    case "trap": return `${id}: looked like "${s(e.looked_like)}" — was ${s(e.was)}. Rule: ${s(e.rule)}`;
    case "law": return `${id}: ${s(e.law)}${e.incident ? ` (incident: ${s(e.incident)})` : ""}`;
    case "benchmark": return `${id}: ${s(e.value)}. Read it as: ${s(e.read_it_as)}`;
    case "killed": return `${id}: killed ${s(e.what)} — ${s(e.why)}`;
    case "audit": return `${id}: ${s(e.audit)} — ${s(e.question)} Rule: ${s(e.decision_rule)}`;
    case "practice": return `${id}: ${s(e.practice)} — ${s(e.what)}`;
    case "metric": return `${id}: ${s(e.name)} [${s(e.unit)}] — ${s(e.definition)}${e.benchmark ? ` Benchmark: ${s(e.benchmark)}` : ""}`;
    case "principle": return `${id}: ${s(e.title)} — "${s(e.voice)}"`;
    case "move": return `${id}: ${s(e.text)}`;
    case "belief_signal": return `${id}: ${s(e.signal)} — ${s(e.showed)}`;
    case "stage": return `${id}: ${s(e.name)} — ${s(e.goal)}`;
    default: return `${id}`;
  }
}

/** Full-detail bundle for the prompt writer: principle moves + measurement + resolved evidence. */
export function bundleFor(principleId: string | undefined, evidence: string[]): string {
  const out: string[] = [];
  if (principleId && brainIndex.get(principleId)?.kind === "principle") {
    const p = brainIndex.get(principleId)!.entity;
    out.push(`Principle ${p.id} · ${s(p.title)}`, `Voice: "${s(p.voice)}"`, `Why: ${s(p.why)}`);
    for (const m of p.moves ?? []) out.push(`- ${s(m.id)}: ${s(m.text)}`);
    if (p.how_to_measure) out.push(`How to measure: ${s(p.how_to_measure)}`);
    for (const mid of list(p.metric_ids)) { const d = describeEvidence(mid); if (d) out.push(`Metric ${d}`); }
  }
  for (const id of evidence) { const d = describeEvidence(id); if (d) out.push(d); }
  return out.join("\n");
}
