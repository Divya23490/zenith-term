// AI provider layer.
// Speaks the OpenAI-compatible /chat/completions API, which Groq, Ollama,
// OpenRouter, and Gemini all support — all with free tiers. Pick a provider
// via env vars:
//
//   Groq (free, fastest):
//     AI_BASE_URL=https://api.groq.com/openai/v1
//     AI_MODEL=llama-3.3-70b-versatile
//     AI_API_KEY=gsk_...
//
//   Ollama (free, local, offline):
//     AI_BASE_URL=http://localhost:11434/v1
//     AI_MODEL=llama3.1
//     (no key needed)
//
//   OpenRouter free models:
//     AI_BASE_URL=https://openrouter.ai/api/v1
//     AI_MODEL=meta-llama/llama-3.3-70b-instruct:free
//     AI_API_KEY=sk-or-...
//
//   Google Gemini:
//     AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
//     AI_MODEL=gemini-2.0-flash
//     AI_API_KEY=...

const BASE_URL = (process.env.AI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const MODEL = process.env.AI_MODEL || "llama-3.3-70b-versatile";
const API_KEY = process.env.AI_API_KEY || "";

export function providerInfo() {
  return { baseUrl: BASE_URL, model: MODEL, hasKey: Boolean(API_KEY) || BASE_URL.includes("11434") };
}

// Async generator yielding text chunks from a streaming chat completion.
export async function* streamChat(messages, { maxTokens = 1024, temperature = 0.2 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI provider error ${res.status}: ${body.slice(0, 500)}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}

const NL2CMD_SYSTEM = `You translate natural language into a single shell command for the user's environment.
Rules:
- Output ONLY the command, no backticks, no markdown, no explanation, no leading $.
- Prefer safe, standard, portable commands. Never output destructive commands (rm -rf /, mkfs, dd to devices, fork bombs) — if the request is dangerous, output: echo "refused: dangerous command"
- If multiple steps are needed, join them with && on one line.`;

const EXPLAIN_SYSTEM = `You are a terminal assistant. The user will paste recent terminal output (a command and its result, possibly an error).
Reply in this exact structure, concise, plain text with minimal markdown:
**What happened:** one or two sentences.
**Why:** the root cause.
**Fix:** the exact command(s) to run, each on its own line in a code block.
Keep the whole reply under 200 words.`;

export function nl2cmdMessages(request, context) {
  return [
    { role: "system", content: NL2CMD_SYSTEM },
    {
      role: "user",
      content: `OS: ${process.platform}. Shell: ${process.env.SHELL || "sh"}. cwd: ${context?.cwd || "unknown"}\n\nRequest: ${request}`,
    },
  ];
}

export function explainMessages(terminalOutput, question) {
  return [
    { role: "system", content: EXPLAIN_SYSTEM },
    {
      role: "user",
      content: `Recent terminal output:\n\n${terminalOutput}\n\n${question ? `Question: ${question}` : "Explain what happened and how to fix any error."}`,
    },
  ];
}
