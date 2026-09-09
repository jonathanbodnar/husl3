import OpenAI from "openai";
import type { ToolCall, Usage } from "../../shared/types.js";
import type { ProviderConfig } from "../env.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

export function makeClient(cfg: ProviderConfig, timeoutMs: number): OpenAI {
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: timeoutMs, maxRetries: 1 });
}

/** Provider-specific switch for reasoning. Each vendor spells it differently on the same OpenAI-shaped endpoint. */
export function thinkingBody(cfg: ProviderConfig): Record<string, unknown> {
  const host = safeHost(cfg.baseURL);
  const on = cfg.thinking === "on";
  if (host.includes("deepseek")) return { thinking: { type: on ? "enabled" : "disabled" } };
  if (host.includes("aliyuncs")) return { enable_thinking: on, ...(on && cfg.thinkingBudget > 0 ? { thinking_budget: cfg.thinkingBudget } : {}) };
  if (host.includes("openrouter")) return { reasoning: { enabled: on } };
  if (host.includes("moonshot")) return on ? {} : { thinking: { type: "disabled" } };
  return {};
}

function safeHost(u: string) { try { return new URL(u).host.toLowerCase(); } catch { return ""; } }

export function normalizeUsage(u: any): Usage {
  if (!u) return { promptHit: 0, promptMiss: 0, completion: 0, reasoning: 0 };
  const prompt = Number(u.prompt_tokens ?? 0);
  const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  const miss = u.prompt_cache_miss_tokens != null ? Number(u.prompt_cache_miss_tokens) : Math.max(0, prompt - hit);
  return {
    promptHit: hit,
    promptMiss: miss,
    completion: Number(u.completion_tokens ?? 0),
    reasoning: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

export interface StreamHandlers {
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

export interface StreamResult { content: string; toolCalls: ToolCall[]; usage: Usage; finishReason: string | null }

/** One streamed completion; returns the assembled assistant message and usage. */
export async function streamChat(cfg: ProviderConfig, messages: Message[], tools: Tool[] | undefined, signal: AbortSignal | undefined, h: StreamHandlers): Promise<StreamResult> {
  const client = makeClient(cfg, 180_000);
  const params: any = {
    model: cfg.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.4,
    max_tokens: 4000,
    ...thinkingBody(cfg),
  };
  if (tools && tools.length) { params.tools = tools; params.tool_choice = "auto"; }
  const stream: any = await client.chat.completions.create(params, { signal });
  let content = "";
  let finishReason: string | null = null;
  let usage: Usage = { promptHit: 0, promptMiss: 0, completion: 0, reasoning: 0 };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of stream) {
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta: any = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) h.onReasoning?.(delta.reasoning_content);
    if (typeof delta.content === "string" && delta.content) { content += delta.content; h.onDelta?.(delta.content); }
    for (const tc of delta.tool_calls ?? []) {
      const idx = Number(tc.index ?? 0);
      const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
    id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function" as const,
    function: { name: c.name, arguments: c.args || "{}" },
  }));
  return { content, toolCalls, usage, finishReason };
}

/** One completion that should return JSON. Streams under the hood: Qwen's thinking mode on Model Studio only supports streaming, and streaming also keeps long generations alive through proxies. */
export async function completeJson(cfg: ProviderConfig, messages: Message[], signal?: AbortSignal): Promise<{ text: string; usage: Usage; reasoning?: string }> {
  const client = makeClient(cfg, 600_000);
  const params: any = {
    model: cfg.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.3,
    max_tokens: 24_000,
    ...thinkingBody(cfg),
  };
  if (cfg.jsonMode) params.response_format = { type: "json_object" };
  const stream: any = await client.chat.completions.create(params, { signal });
  let text = "";
  let reasoning = "";
  let usage: Usage = { promptHit: 0, promptMiss: 0, completion: 0, reasoning: 0 };
  for await (const chunk of stream) {
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    const delta: any = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (typeof delta.content === "string") text += delta.content;
  }
  return { text, usage, reasoning: reasoning || undefined };
}

/** Pull the first JSON object out of a model reply that may carry prose or fences. */
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try { return JSON.parse(c.slice(start, end + 1)); } catch { /* try next */ }
  }
  throw new Error("Model reply did not contain a JSON object");
}
