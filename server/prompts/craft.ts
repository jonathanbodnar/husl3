import type { PromptsRequest, PromptsResponse, Todo } from "../../shared/types.js";
import { bundleFor, brainVersion } from "../brain/render.js";
import { costEvent } from "../cost.js";
import { env } from "../env.js";
import { completeJson, extractJson, type Message } from "../llm/client.js";

const MAX_PER_CALL = 10;

const SYSTEM = `You write prompts for coding agents (Claude Code, Cursor, Codex, Aider and the like). A solo SaaS founder will paste each prompt, unedited, into an agent session that has their repository open. The prompts implement items from a distribution audit built on one body of evidence (the "brain", version ${brainVersion}); excerpts are supplied per item.

Write each prompt so the agent can execute it without this conversation:
1. Context: the product in one line, the stack, and the files or areas involved. Use the founder's real paths when they are given; otherwise tell the agent to locate the file that does X and to read it before editing.
2. Objective: what changes for the user or the business, in one paragraph, tied to the audit's reason.
3. Exact changes: UI copy, behavior, data model, events to fire (give event names and properties), pricing or limit rules, emails — as concrete as the evidence allows. Never pad with generic best-practice lists.
4. Instrumentation: which metric this move is judged by, defined the way the brain defines it (definition, unit, denominator, timezone, exclusions), and the event or column the agent must add so it can be measured.
5. Acceptance: how the agent proves it works (a query, a test, a manual check), and the honest-number rules (drop today from daily series; no rates with a numerator under 5 or a denominator under 100 without the counts).
6. Guardrails: what not to touch; keep read paths honest; no fake numbers or placeholder data; ask the founder before anything irreversible (billing, deletions, mass email).
7. Report back: the agent ends with a short summary of what changed, what to watch, and when the data can show the effect.

Rules: second person to the agent ("You are working in…"); 300–700 words each; markdown inside the prompt is fine; do not open with the item title as a heading; never invent numbers, files or data the founder does not have; when the audit conversation shows the founder disagreed with or refined an item, follow the conversation.

Output JSON only, exactly: {"prompts":[{"todo_id":"…","prompt":"…"}]}`;

const cap = (t: string | undefined | null, n: number) => (t ? (t.length > n ? t.slice(0, n) + " …" : t) : "");

function productContext(req: PromptsRequest): string {
  const home = req.site.pages.find((p) => p.kind === "home") ?? req.site.pages[0];
  const pricing = req.site.pages.find((p) => p.kind === "pricing");
  const L = [`Domain: ${req.site.domain}`, `Home page title: ${home?.title ?? ""}`, `Home page text: ${cap(home?.text, 900)}`];
  if (home?.ctas.length) L.push(`CTAs: ${home.ctas.slice(0, 10).join(" | ")}`);
  const prices = [...(pricing?.prices ?? []), ...(home?.prices ?? [])].slice(0, 10);
  if (prices.length) L.push(`Prices seen: ${prices.join(" | ")}`);
  if (req.site.stack.length) L.push(`Stack seen on the site: ${req.site.stack.join(", ")}`);
  if (req.repo) {
    L.push(`Repository: ${req.repo.repo} (default branch ${req.repo.defaultBranch}${req.repo.language ? `, ${req.repo.language}` : ""})`);
    if (req.repo.stack.length) L.push(`Stack from manifest: ${req.repo.stack.join(", ")}`);
    if (req.repo.manifest) L.push(`Manifest ${req.repo.manifestPath}: ${cap(req.repo.manifest, 1500)}`);
    if (req.repo.interestingFiles.length) L.push(`Relevant files:\n${req.repo.interestingFiles.slice(0, 50).map((f) => `- ${f}`).join("\n")}`);
    if (req.repo.recentCommits.length) L.push(`Recent commits:\n${req.repo.recentCommits.slice(0, 15).map((c) => `- ${c.date.slice(0, 10)} ${c.message}`).join("\n")}`);
  } else L.push("Repository: not connected (tell the agent to locate files).");
  if (req.schema) L.push(`Database (read-only summary):\n${cap(req.schema.summary, 3500)}`);
  else L.push("Database: not connected (the agent must not assume table names).");
  return L.join("\n");
}

function conversationGist(req: PromptsRequest): string {
  const turns = req.transcript.filter((m) => (m.role === "user" && !m.hidden) || (m.role === "assistant" && m.content)).slice(-16);
  if (!turns.length) return "(no conversation beyond the opening turn)";
  return turns.map((m) => `${m.role === "user" ? "Founder" : "Guide"}: ${cap((m as { content: string | null }).content ?? "", 500)}`).join("\n");
}

export function selectTodos(req: PromptsRequest): { chosen: Todo[]; skipped: string[] } {
  const wanted = req.todoIds?.length ? req.todos.filter((t) => req.todoIds!.includes(t.id)) : req.todos.filter((t) => (t.status === "todo" || t.status === "doing") && (!t.prompt || t.promptStale));
  const sorted = [...wanted].sort((a, b) => a.order - b.order);
  return { chosen: sorted.slice(0, MAX_PER_CALL), skipped: sorted.slice(MAX_PER_CALL).map((t) => t.id) };
}

export async function craftPrompts(req: PromptsRequest, signal?: AbortSignal): Promise<PromptsResponse> {
  const cfg = env.prompts();
  if (!cfg.apiKey) throw new Error("The prompt-writer model is not configured (set DASHSCOPE_API_KEY, or PROMPT_BASE_URL + PROMPT_API_KEY).");
  const { chosen, skipped } = selectTodos(req);
  if (!chosen.length) return { prompts: [], cost: costEvent("prompts", cfg.model, { promptHit: 0, promptMiss: 0, completion: 0 }, cfg.prices), model: cfg.model, skipped };
  const items = chosen.map((t, i) => [
    `### Item ${i + 1} — todo_id: ${t.id}`,
    `Title: ${t.title}`, `Why (from the audit): ${t.why}`, `Stage: ${t.stage}${t.principle ? `; principle: ${t.principle}` : ""}; status: ${t.status}`,
    `Brain evidence:\n${bundleFor(t.principle, t.evidence) || "(none attached; reason from the principle named in the title)"}`,
  ].join("\n")).join("\n\n");
  const user = `## Product\n${productContext(req)}\n\n## Audit conversation (latest turns)\n${conversationGist(req)}\n\n## Items to write prompts for\n${items}\n\nReturn {"prompts":[…]} with one entry per item, todo_id copied exactly.`;
  const messages: Message[] = [{ role: "system", content: SYSTEM }, { role: "user", content: user }];
  const res = await completeJson(cfg, messages, signal);
  const parsed = extractJson(res.text) as { prompts?: { todo_id?: string; todoId?: string; prompt?: string }[] };
  const prompts = (parsed.prompts ?? [])
    .map((p) => ({ todoId: String(p.todo_id ?? p.todoId ?? ""), prompt: String(p.prompt ?? "").trim() }))
    .filter((p) => p.todoId && p.prompt && chosen.some((t) => t.id === p.todoId));
  if (!prompts.length) throw new Error("The prompt writer returned no usable prompts");
  return { prompts, cost: costEvent("prompts", cfg.model, res.usage, cfg.prices), model: cfg.model, skipped };
}
