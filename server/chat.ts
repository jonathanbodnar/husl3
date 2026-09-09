import type { ChatEvent, ChatRequest, Scoreboard, Todo, TranscriptMessage, Usage } from "../shared/types.js";
import { KICKOFF_PROMPT, STATIC_SYSTEM, sessionSystem } from "./brain/systemPrompt.js";
import { addUsage, costEvent, zeroUsage } from "./cost.js";
import { env } from "./env.js";
import { streamChat, type Message } from "./llm/client.js";
import { hasDatabase } from "./db/postgres.js";
import { toolsFor } from "./tools/definitions.js";
import { executeTool, parseArgs } from "./tools/execute.js";

/** Convert the stored transcript into provider-shaped messages; shrink old tool payloads. */
export function toModelMessages(transcript: TranscriptMessage[]): Message[] {
  const out: Message[] = [];
  const cutoff = Math.max(0, transcript.length - 12);
  transcript.forEach((m, i) => {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m.tool_calls?.length) out.push({ role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls });
      else out.push({ role: "assistant", content: m.content ?? "" });
    } else if (m.role === "tool") {
      const c = i < cutoff && m.content.length > 1500 ? m.content.slice(0, 1500) + "…(older result shortened)" : m.content;
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: c });
    }
  });
  // Drop a dangling assistant tool_call block with no results (an aborted turn), so the provider does not reject the history.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as { role: string; tool_calls?: unknown[] };
    if (m.role === "assistant" && m.tool_calls?.length) {
      const next = out[i + 1] as { role: string } | undefined;
      if (!next || next.role !== "tool") out.splice(i, 1);
    }
  }
  return out;
}

export async function runChatTurn(req: ChatRequest, emit: (e: ChatEvent) => void, signal: AbortSignal): Promise<{ usage: Usage; usd: number }> {
  const cfg = env.chat();
  if (!cfg.apiKey) throw new Error("The conversation model is not configured (set DEEPSEEK_API_KEY).");
  const userText = req.kickoff ? KICKOFF_PROMPT : (req.message ?? "").trim();
  if (!userText) throw new Error("Empty message");

  let todos: Todo[] = Array.isArray(req.todos) ? req.todos : [];
  let scoreboard: Scoreboard = req.scoreboard && Array.isArray(req.scoreboard.stats) ? { ...req.scoreboard, results: req.scoreboard.results ?? {} } : { stats: [], results: {} };
  let scoreboardChanged = false;
  const now = () => new Date().toISOString();
  const produced: TranscriptMessage[] = [{ role: "user", content: userText, at: now(), hidden: !!req.kickoff }];
  const messages: Message[] = [
    { role: "system", content: STATIC_SYSTEM },
    { role: "system", content: sessionSystem({ ...req, todos, scoreboard }) },
    ...toModelMessages(req.transcript ?? []),
    { role: "user", content: userText },
  ];
  // The repo digest alone enables the tools (public repositories read without a token); a token adds private access.
  const tools = toolsFor({ db: hasDatabase(req.connections?.postgres), github: !!(req.connections?.github?.repo || req.repo?.repo), ads: !!req.ads?.rows.length });
  let usage = zeroUsage();
  let usd = 0;
  /** Text streamed in the round currently running, so a mid-stream failure does not erase what the user read. */
  let partial = "";
  const account = (u: Usage) => { usage = addUsage(usage, u); const c = costEvent("chat", cfg.model, u, cfg.prices); usd += c.usd; emit({ type: "usage", cost: c }); };

  try {
    for (let round = 0; round <= env.maxToolRounds; round++) {
      if (signal.aborted) break;
      const lastRound = round === env.maxToolRounds;
      partial = "";
      const res = await streamChat(cfg, messages, lastRound ? undefined : tools, signal, { onDelta: (t) => { partial += t; emit({ type: "delta", text: t }); } });
      account(res.usage);
      if (!res.toolCalls.length) {
        produced.push({ role: "assistant", content: res.content, at: now() });
        break;
      }
      const assistant: TranscriptMessage = { role: "assistant", content: res.content || null, tool_calls: res.toolCalls, at: now() };
      produced.push(assistant);
      messages.push({ role: "assistant", content: res.content || "", tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        const args = parseArgs(call.function.arguments);
        emit({ type: "tool_start", id: call.id, name: call.function.name, args: args.__parse_error ? {} : args });
        const out = await executeTool(call.function.name, args, { req, todos, scoreboard });
        if (out.todos) { todos = out.todos; emit({ type: "todos", todos }); }
        if (out.scoreboard && out.eval) { scoreboard = out.scoreboard; scoreboardChanged = true; emit({ type: "scoreboard", scoreboard, eval: out.eval }); }
        emit({ type: "tool_result", id: call.id, name: call.function.name, ui: out.ui });
        produced.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out.content, ui: out.ui });
        messages.push({ role: "tool", tool_call_id: call.id, content: out.content });
      }
    }
  } catch (err) {
    if (partial.trim()) produced.push({ role: "assistant", content: partial, at: now() });
    if (!signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: friendly(message) });
    }
  }
  // If the last produced message is an assistant tool-call block (aborted mid-round), keep the transcript consistent.
  const last = produced[produced.length - 1];
  if (last?.role === "assistant" && last.tool_calls?.length) {
    const answered = new Set(produced.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id));
    if (!last.tool_calls.every((c) => answered.has(c.id))) produced.pop();
  }
  // Only a board a tool changed goes back; the request-time copy would overwrite a refresh made mid-turn.
  emit({ type: "done", messages: produced, todos, scoreboard: scoreboardChanged ? scoreboard : undefined });
  return { usage, usd };
}

function friendly(m: string): string {
  if (/401|invalid api key|authentication/i.test(m)) return "The model provider rejected the API key.";
  if (/429|rate limit/i.test(m)) return "The model provider is rate-limiting; try again in a moment.";
  if (/insufficient|balance|quota/i.test(m)) return "The model provider account is out of credit.";
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(m)) return "The model took too long to answer; try again.";
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}
