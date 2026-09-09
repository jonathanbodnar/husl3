import type { AdDataset, ChatRequest, DbSchema, RepoDigest, Scoreboard, SiteDigest, Todo } from "../../shared/types.js";
import { evaluateScoreboard } from "../stats/readiness.js";
import { brainText, brainVersion } from "./render.js";

const ROLE = `You are the guide inside Vibe Distribution: a conversational distribution audit for SaaS founders. You walk one founder through getting first users, activating them, monetizing, retaining, acquiring and scaling, using one body of evidence: the brain below, built from one AI SaaS that ran the method for 97 days and audited itself 209 times.

How you work
- The brain is your only source of numbers. Every stat you quote sits beside the move it supports and carries its confidence label in brackets, with the brain id, e.g. "+78% day-zero activation (e-01) [deploy]". Never invent a number, a benchmark or a source. If the brain has no evidence for something, say so plainly and reason from principle.
- Place the founder on the journey first. Read the site digest and any data before asking anything; then ask only the "you are here when" conditions the digest cannot answer, at most three short questions, one message. The earliest stage whose conditions hold is the current stage. Say the stage id and name when you place them, and say it provisionally until the conditions are confirmed.
- Keep the what-to-do list alive with the update_todos tool. Three to seven items, each tied to a stage and a principle, each with real brain evidence ids, each with a one- or two-sentence "why" written for this product. Add the first set on the opening turn. Update, merge or remove items as you learn; never duplicate; never change an item's status unless the founder tells you it happened. The founder sees the list in a side panel and will get a coding-agent prompt per item, so titles are concrete actions ("Fire the signup event on the completed first message, not the button"), not themes.
- When a database is connected, measure instead of guessing: use run_sql with the schema in your context. Read-only. Start with counts and dates; apply the brain's conventions (name the timezone, drop today from daily series, never quote a rate with a numerator under 5 or a denominator under 100 without the counts). Say what a query showed in plain words with the counts, then what it means, then the move. If a query fails, fix it once, then move on.
- When a repository is connected, use the commits to learn what shipped recently and read the files that implement signup, onboarding, pricing, checkout, limits and tracking before recommending changes to them. The most valuable thing you can tell a founder is which of their recent changes the data cannot show yet, and what to measure so it will.
- Use fetch_page to read more of their site when a question depends on it (pricing page, signup flow, docs).
- The scoreboard is how the plan adapts to this founder. The brain supplies metric recipes and readiness checks; their data decides which apply and what they say. When a database is connected and the scoreboard is empty, build it BEFORE placing them and before adding to-dos: name the money event, the core request and the activation definition for this product; set the reporting timezone; then bind the recipes for the money event, activation and the current stage's instrument_now list to their real tables with update_scoreboard (4 to 12 stats). Results and errors come back at once; fix a failing stat in the same turn. Readiness is graded for you from the scoreboard and shown at the top of every turn as "stage by the numbers"; place the founder by it, and say which checks are unmeasured rather than guessing them. A number that can decide a question is measured before any advice is given on it; the brain's move comes second, as the thing the number points to.
- When a repository is connected as well, the funnel comes from the code, not from guesses: read the files behind signup, onboarding, the core action, the limit or paywall, checkout and tracking; learn the real steps and the event names actually emitted; rebuild the funnel stat from those steps in path order, and say in each stat's why which file or event it is bound to. If the code fires no event for a step, say so: that is a to-do (instrumentation), not a number.
- Ad spend arrives as the platform's own export, uploaded by the founder; there is no ad account connection and no platform API. Read it with read_ad_spend before saying anything about acquisition cost. Spend lives in that export and outcomes live in the database, and there are two honest ways to put them together. Best: write ONE query using the token {{ad_spend}} where a table belongs — the server pastes the uploaded rows in as a table, so cost per payer BY CAMPAIGN is a single breakdown stat returning label = campaign, value = spend ÷ payers and n = the payer count. Total the spend per campaign in a subquery before joining it to accounts, or the join multiplies every campaign-day of spend by the number of matching accounts and inflates the cost without looking wrong. When the founder's tables carry no campaign or utm column at all, fall back to: an ads stat for the spend, a database stat for the outcome, and a derived stat dividing them, with the same date range on each — an unmatched range makes the ratio meaningless and you must say so rather than quote it, and that blended figure charges organic payers to the ad budget, which you must also say. The platform's own conversion counts are its marking of its own homework; never present them as signups, activations or payers, and when they disagree with the founder's database say which is which. To attribute spend to outcomes, read the campaign ids (or names, when the export carries no id — say that a rename would break that join) from the export and look for them in the founder's own attribution fields; when those fields are empty or absent, that is the finding (t-01), and instrumenting attribution is the to-do, not a number.
- The founder can refresh the scoreboard at any time and can read every stat's SQL. Never present a stated value as a measured one, and never quote a share the small-n rule forbids; give the counts.
- On the opening turn, when no database or repository is connected, close by saying plainly that the placement stays provisional until you can read their repository and their data, and point them to Connect in the top bar. Say it once; on later turns ask again only when a question depends on it. When only one of the two is connected, ask for the other the same way, once.
- When the audit started from a repository and no public site could be read, say so, work from the code, and ask for the live URL if one exists.
- Voice: direct, specific, short. Plain prose, short paragraphs, small lists, markdown headings no larger than ###. No hype, no filler, no restating what they said. Blunt one-liners from the brain are welcome when they fit; explanations stay plain. End every reply with either one question or one clear next step.
- You cannot do anything outside this conversation and its tools. Do not pretend to have run code, sent email or changed their product.

Brain version: ${brainVersion}.`;

/** Byte-identical across sessions so the provider's prefix cache holds. */
export const STATIC_SYSTEM = `${ROLE}\n\n${brainText}`;

export const KICKOFF_PROMPT = `Begin the audit. From the site digest and the repository digest (whichever exist): say in two or three sentences what the product appears to be, who it is for and how it charges. If a database is connected, build the scoreboard first and place me by the numbers. Place me provisionally on the journey (stage id and name) and ask the two or three questions that decide it. Then add the first three to five what-to-dos with update_todos: the moves the brain says matter at that stage for a product like this, each with evidence ids. If I connected a database or a repository, use them before asking anything they can answer.`;

const cap = (t: string | undefined | null, n: number) => (t ? (t.length > n ? t.slice(0, n) + " …" : t) : "");

export function renderSite(site: SiteDigest | null): string {
  if (!site) return "## Site digest\nNo public site was scanned: the audit started from the repository. If the README or manifest names a live URL, read it with fetch_page before judging copy, pricing or signup.";
  const L: string[] = [`## Site digest — ${site.domain} (scanned ${site.scannedAt.slice(0, 16)}Z)`, `Entry URL: ${site.url}`];
  if (site.stack.length) L.push(`Detected stack: ${site.stack.join(", ")}`);
  for (const n of site.notes) L.push(`- note: ${n}`);
  for (const p of site.pages) {
    L.push(``, `### [${p.kind}] ${p.title || "(untitled)"} — ${p.url} (HTTP ${p.status})`);
    if (p.description) L.push(`Description: ${cap(p.description, 300)}`);
    if (p.headings.length) L.push(`Headings: ${p.headings.slice(0, 14).join(" | ")}`);
    if (p.ctas.length) L.push(`CTAs: ${p.ctas.slice(0, 16).join(" | ")}`);
    if (p.prices.length) L.push(`Prices seen: ${p.prices.slice(0, 12).join(" | ")}`);
    for (const f of p.forms.slice(0, 4)) L.push(`Form${f.action ? ` → ${f.action}` : ""}: ${f.fields.join(", ") || "(no named fields)"}`);
    L.push(`Text: ${cap(p.text, p.kind === "home" ? 1600 : 1000)}`);
  }
  return L.join("\n");
}

export function renderSchema(schema: DbSchema): string {
  return `## Connected database (read-only; introspected ${schema.introspectedAt.slice(0, 16)}Z)\n${cap(schema.summary, 9000)}`;
}

export function renderRepo(repo: RepoDigest): string {
  const L: string[] = [`## Connected repository — ${repo.repo} (default branch ${repo.defaultBranch}; last push ${repo.pushedAt ?? "unknown"})`];
  if (repo.description) L.push(`Description: ${cap(repo.description, 300)}`);
  if (repo.language) L.push(`Primary language: ${repo.language}`);
  if (repo.stack.length) L.push(`Stack from manifest: ${repo.stack.join(", ")}`);
  L.push(`Files: ${repo.fileCount}${repo.treeTruncated ? " (tree truncated by the API)" : ""}`);
  if (repo.interestingFiles.length) L.push(`Files that likely implement signup, pricing, checkout, limits or tracking:\n${repo.interestingFiles.slice(0, 60).map((f) => `- ${f}`).join("\n")}`);
  if (repo.commitsByWeek.length) L.push(`Commits per week (recent first): ${repo.commitsByWeek.slice(0, 10).map((w) => `${w.week}: ${w.count}`).join(", ")}`);
  if (repo.recentCommits.length) L.push(`Recent commits:\n${repo.recentCommits.slice(0, 30).map((c) => `- ${c.date.slice(0, 10)} ${c.sha} ${cap(c.message, 110)}`).join("\n")}`);
  if (repo.readme) L.push(`README (start):\n${cap(repo.readme, 1800)}`);
  return L.join("\n");
}

const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
const fmtVal = (v: number, unit: string) => (unit === "percent" ? pct(v) : unit === "usd" ? `$${v.toFixed(2)}` : Number.isInteger(v) ? String(v) : v.toFixed(2));

export function renderAds(ads: AdDataset | null | undefined): string {
  if (!ads || !ads.rows.length) return "## Ad spend\n(none uploaded — if the founder buys traffic, ask for a campaign export from their ad platform: Connect → Ad spend)";
  const byCampaign = new Map<string, number>();
  for (const r of ads.rows) byCampaign.set(r.campaign, (byCampaign.get(r.campaign) ?? 0) + r.spend);
  const top = [...byCampaign.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const L = [
    `## Ad spend (uploaded from ${ads.source}; ${ads.platforms.join(" + ")}; ${ads.firstDay} to ${ads.lastDay}; ${ads.rows.length} campaign-days)`,
    `Total ${ads.totalSpend}${ads.currency ? " " + ads.currency : ""}. This is the platform's own export, not a live connection: it is a snapshot as of upload.`,
    `Spend by campaign (top ${top.length}${byCampaign.size > top.length ? ` of ${byCampaign.size}` : ""}): ${top.map(([c, v]) => `${c} ${Math.round(v)}`).join("; ")}`,
  ];
  for (const n of ads.notes) L.push(`Note: ${n}`);
  return L.join("\n");
}

export function renderScoreboard(board: Scoreboard | null | undefined, dbConnected: boolean): string {
  if (!board || !board.stats.length) {
    return dbConnected
      ? "## Scoreboard\n(empty — a database is connected; build it with update_scoreboard before placing the founder or adding to-dos)"
      : "## Scoreboard\n(empty — no database connected; ask for one when a number would decide the next move)";
  }
  const ev = evaluateScoreboard(board);
  const L: string[] = [`## Scoreboard (${board.stats.length} stats; newest computed ${board.computedAt ? board.computedAt.slice(0, 16) + "Z" : "never"}; reporting timezone ${board.timezone ?? "NOT SET — UTC assumed for day boundaries; set it"})`];
  if (board.goal) L.push(`Money event: ${board.goal}`);
  if (board.activation) L.push(`Activation: ${board.activation}`);
  if (board.coreRequest) L.push(`Core request: ${board.coreRequest}`);
  for (const s of [...board.stats].sort((a, b) => a.order - b.order)) {
    const r = board.results[s.id];
    const age = r?.ok && board.computedAt && r.computedAt && Date.parse(board.computedAt) - Date.parse(r.computedAt) > 3_600_000 ? ` (computed ${r.computedAt.slice(0, 16)}Z)` : "";
    const tag = `${s.id}${s.metricId ? ` [${s.metricId}${s.field ? "." + s.field : ""}]` : ""}${age}`;
    if (!r) { L.push(`- ${tag} ${s.title}: not run`); continue; }
    if (!r.ok) { L.push(`- ${tag} ${s.title}: FAILED — ${r.error}`); continue; }
    if (r.points) {
      const last = r.points.slice(-7).map((p) => p.value);
      const prev = r.points.slice(-14, -7).map((p) => p.value);
      const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
      const additive = s.unit === "count" || s.unit === "usd";
      L.push(`- ${tag} ${s.title} (daily, ${r.points.length} points to ${r.points[r.points.length - 1].day}): last 7 points = ${last.join(", ")}${additive && prev.length === 7 ? ` (prior 7 total ${sum(prev)} → ${sum(last)})` : ""}${r.droppedToday ? "; today excluded" : ""}`);
    } else if (r.steps) L.push(`- ${tag} ${s.title} (funnel): ${r.steps.map((st, i) => `${st.step} ${st.count}${i > 0 ? (st.fromPrev != null ? ` (${pct(st.fromPrev)} of previous)` : " (too few to quote a share)") : ""}`).join(" → ")}`);
    else if (r.items) L.push(`- ${tag} ${s.title} (breakdown): ${r.items.map((i) => `${i.label} ${i.smallN ? `${Math.round(i.value * (i.n ?? 0))} of ${i.n} (too few to quote a share)` : fmtVal(i.value, s.unit)}${i.n != null && !i.smallN ? ` n=${i.n}` : ""}`).join("; ")}`);
    else if (r.numerator != null) L.push(`- ${tag} ${s.title}: ${r.numerator}/${r.denominator}${r.smallN ? " — small n: quote the counts, not a percentage" : ` = ${pct(r.value!)}`}`);
    else if (s.kind === "derived" && s.derived) L.push(`- ${tag} ${s.title}: ${fmtVal(r.value ?? 0, s.unit)} (${board.stats.find((x) => x.id === s.derived!.numeratorStatId)?.title ?? s.derived.numeratorStatId} ÷ ${board.stats.find((x) => x.id === s.derived!.denominatorStatId)?.title ?? s.derived.denominatorStatId})${r.smallN ? " — too few in the denominator to quote per unit" : ""}`);
    else L.push(`- ${tag} ${s.title}: ${fmtVal(r.value ?? 0, s.unit)}${r.n != null ? ` (n=${r.n})` : ""}${s.kind === "assert" ? ` (STATED by the founder${s.source ? `: ${s.source}` : ""}, not measured)` : ""}`);
    if (s.caveat) L.push(`  caveat: ${s.caveat}`);
    for (const n of r.notes ?? []) L.push(`  note: ${n}`);
  }
  L.push(`Stage by the numbers: ${ev.stageByNumbers ?? "not yet placeable (no readiness check measured)"}`);
  const graded = ev.rows.filter((r) => r.status !== "unmeasured");
  if (graded.length) L.push(`Readiness graded: ${graded.map((r) => `${r.stage} ${r.metric}.${r.field} ${r.status}${r.status === "small_n" ? ` (${r.numerator} of ${r.denominator}: too few to grade)` : r.actual != null ? ` (${r.stated ? "stated " : ""}${fmtVal(r.actual, "count")} ${r.op} ${r.value})` : ""}`).join("; ")}`);
  if (ev.stageByNumbers) {
    const un = ev.rows.filter((r) => r.stage === ev.stageByNumbers && r.status === "unmeasured");
    if (un.length) L.push(`Unmeasured at ${ev.stageByNumbers}: ${un.map((r) => `${r.metric}.${r.field}`).join(", ")} — bind these before advancing anyone`);
    const unbound = ev.unbound[ev.stageByNumbers] ?? [];
    if (unbound.length) L.push(`instrument_now not yet bound at ${ev.stageByNumbers}: ${unbound.join(", ")}`);
  }
  return L.join("\n");
}

export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return "## What-to-do list\n(empty — add the first items with update_todos)";
  const sorted = [...todos].sort((a, b) => a.order - b.order);
  return `## What-to-do list (current; ids are stable)\n${sorted
    .map((t) => `- ${t.id} [${t.status}] (${t.stage}${t.principle ? `, ${t.principle}` : ""}) ${t.title} — ${cap(t.why, 240)}${t.evidence.length ? ` {${t.evidence.join(", ")}}` : ""}${t.prompt ? " (has prompt)" : ""}`)
    .join("\n")}`;
}

export function sessionSystem(req: ChatRequest): string {
  const parts: string[] = [];
  const now = req.clientTime ? new Date(req.clientTime) : new Date();
  parts.push(`# This session\nDate: ${req.clientDate ?? (isNaN(now.getTime()) ? new Date().toISOString().slice(0, 10) : now.toISOString().slice(0, 10))} (the founder's local date${req.clientTimezone ? `, ${req.clientTimezone}` : ""}). Connections: database ${req.connections?.postgres?.connectionString ? "connected (Postgres)" : req.connections?.postgres?.supabase ? `connected (Supabase project ${req.connections.postgres.supabase.projectName ?? req.connections.postgres.supabase.projectRef})` : "not connected"}; repository ${req.connections?.github ? `connected (${req.connections.github.repo})` : req.repo?.repo ? `${req.repo.repo} — digest read earlier; public files still readable, but private files need the founder to reconnect GitHub` : "not connected"}. Ask the founder to connect them (top bar, "Connect") when a question needs data or code they would otherwise guess at.`);
  parts.push(renderSite(req.site));
  if (req.schema && (req.connections?.postgres?.connectionString || req.connections?.postgres?.supabase)) parts.push(renderSchema(req.schema));
  // The digest goes in whenever it exists: the repository tools are enabled from it too, so context and tools must agree.
  if (req.repo) parts.push(renderRepo(req.repo));
  parts.push(renderAds(req.ads));
  parts.push(renderScoreboard(req.scoreboard, !!(req.connections?.postgres?.connectionString || req.connections?.postgres?.supabase)));
  parts.push(renderTodos(req.todos));
  return parts.join("\n\n");
}
