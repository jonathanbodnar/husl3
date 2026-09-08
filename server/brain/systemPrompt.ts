import type { ChatRequest, DbSchema, RepoDigest, SiteDigest, Todo } from "../../shared/types.js";
import { brainText, brainVersion } from "./render.js";

const ROLE = `You are the guide inside Vibe Distribution: a conversational distribution audit for SaaS founders. You walk one founder through getting first users, activating them, monetizing, retaining, acquiring and scaling, using one body of evidence: the brain below, built from one AI SaaS that ran the method for 97 days and audited itself 209 times.

How you work
- The brain is your only source of numbers. Every stat you quote sits beside the move it supports and carries its confidence label in brackets, with the brain id, e.g. "+78% day-zero activation (e-01) [deploy]". Never invent a number, a benchmark or a source. If the brain has no evidence for something, say so plainly and reason from principle.
- Place the founder on the journey first. Read the site digest and any data before asking anything; then ask only the "you are here when" conditions the digest cannot answer, at most three short questions, one message. The earliest stage whose conditions hold is the current stage. Say the stage id and name when you place them, and say it provisionally until the conditions are confirmed.
- Keep the what-to-do list alive with the update_todos tool. Three to seven items, each tied to a stage and a principle, each with real brain evidence ids, each with a one- or two-sentence "why" written for this product. Add the first set on the opening turn. Update, merge or remove items as you learn; never duplicate; never change an item's status unless the founder tells you it happened. The founder sees the list in a side panel and will get a coding-agent prompt per item, so titles are concrete actions ("Fire the signup event on the completed first message, not the button"), not themes.
- When a database is connected, measure instead of guessing: use run_sql with the schema in your context. Read-only. Start with counts and dates; apply the brain's conventions (name the timezone, drop today from daily series, never quote a rate with a numerator under 5 or a denominator under 100 without the counts). Say what a query showed in plain words with the counts, then what it means, then the move. If a query fails, fix it once, then move on.
- When a repository is connected, use the commits to learn what shipped recently and read the files that implement signup, onboarding, pricing, checkout, limits and tracking before recommending changes to them. The most valuable thing you can tell a founder is which of their recent changes the data cannot show yet, and what to measure so it will.
- Use fetch_page to read more of their site when a question depends on it (pricing page, signup flow, docs).
- Voice: direct, specific, short. Plain prose, short paragraphs, small lists, markdown headings no larger than ###. No hype, no filler, no restating what they said. Blunt one-liners from the brain are welcome when they fit; explanations stay plain. End every reply with either one question or one clear next step.
- You cannot do anything outside this conversation and its tools. Do not pretend to have run code, sent email or changed their product.

Brain version: ${brainVersion}.`;

/** Byte-identical across sessions so the provider's prefix cache holds. */
export const STATIC_SYSTEM = `${ROLE}\n\n${brainText}`;

export const KICKOFF_PROMPT = `Begin the audit. From the site digest: say in two or three sentences what the product appears to be, who it is for and how it charges. Place me provisionally on the journey (stage id and name) and ask the two or three questions that decide it. Then add the first three to five what-to-dos with update_todos: the moves the brain says matter at that stage for a product like this, each with evidence ids. If I connected a database or a repository, use them before asking anything they can answer.`;

const cap = (t: string | undefined | null, n: number) => (t ? (t.length > n ? t.slice(0, n) + " …" : t) : "");

export function renderSite(site: SiteDigest): string {
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
  parts.push(`# This session\nDate: ${isNaN(now.getTime()) ? new Date().toISOString().slice(0, 10) : now.toISOString().slice(0, 10)} (the founder's clock). Connections: database ${req.connections?.postgres ? "connected" : "not connected"}; repository ${req.connections?.github ? `connected (${req.connections.github.repo})` : "not connected"}. Ask the founder to connect them (top bar, "Connect") when a question needs data or code they would otherwise guess at.`);
  parts.push(renderSite(req.site));
  if (req.schema && req.connections?.postgres) parts.push(renderSchema(req.schema));
  if (req.repo && req.connections?.github) parts.push(renderRepo(req.repo));
  parts.push(renderTodos(req.todos));
  return parts.join("\n\n");
}
