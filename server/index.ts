import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { brainTokensApprox, brainVersion } from "./brain/render.js";
import { env } from "./env.js";

const chat = env.chat();
const prompts = env.prompts();
serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`vibe-distribution app on http://localhost:${info.port}`);
  console.log(`brain ${brainVersion} (~${brainTokensApprox.toLocaleString("en-US")} tokens in the cached prefix)`);
  console.log(`chat: ${chat.model} @ ${chat.baseURL} ${chat.apiKey ? "(key set)" : "(NO KEY — set DEEPSEEK_API_KEY)"}`);
  console.log(`prompts: ${prompts.model} @ ${prompts.baseURL} ${prompts.apiKey ? "(key set)" : "(NO KEY — set DASHSCOPE_API_KEY)"}`);
  if (env.accessCode) console.log("access code: required");
});
