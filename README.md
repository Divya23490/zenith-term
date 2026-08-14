# zenith-term

A Warp-style AI terminal that runs in your browser. Real shell (via a PTY), plus:

- **✨ Ask AI (⌘K / Ctrl+K)** — describe what you want in plain English, get a shell command back. Review it, then *Insert* (puts it at your prompt) or *Run now*.
- **🩺 Explain (⌘E / Ctrl+E)** — sends the recent terminal output to the AI and streams back *what happened / why / how to fix it*.
- **🤖 Auto-suggest** — type plain text (or a typo) straight at the prompt; if the shell can't find it as a command, zenith-term automatically asks the AI what you meant and shows the same Insert/Run preview — no hotkey needed. Never auto-runs. Disable with `AUTO_SUGGEST=off`.
- **🤖 Agent mode (⌘J / Ctrl+J)** — agentic coding: give it a task ("add a --json flag to cli.py and make the tests pass"), pick a workspace folder, and it reads files, writes code, and runs commands in a loop until done. **Every file write shows a diff you approve, every command asks first** (optional auto-approve per session; clearly dangerous commands always ask). Confined to the workspace folder, capped at 25 steps (`AGENT_MAX_STEPS`), auto-waits on free-tier rate limits.
- Streaming responses, dark Warp-ish theme, works with any OpenAI-compatible model API — **Groq, Ollama, OpenRouter, and Gemini all have free tiers**. Zero-cost by design.

## Native macOS app

```bash
npm run app     # dev mode: launches the Electron window directly
npm run dist    # builds dist/mac-arm64/zenith-term.app (standalone, unsigned)
```

Drag `dist/mac-arm64/zenith-term.app` into `/Applications` to install. It embeds the server (no browser, no `npm start` needed) and reads `.env` from the app's resources folder — for a packaged install, keep your `.env` in the project folder before running `npm run dist`, or edit `zenith-term.app/Contents/Resources/app/.env` afterwards. Because the app is unsigned, the first launch on another Mac needs right-click → Open; on this Mac it opens normally.

## Quick start (local)

```bash
cd zenith-term
npm install
cp .env.example .env       # edit .env — add your Groq key (or switch to Ollama)
set -a; source .env; set +a
npm start
```

Open http://localhost:3000. The terminal works immediately even with no AI key; the AI buttons need one (or a local Ollama).

### Zero-cost, zero-key option: Ollama

```bash
brew install ollama
ollama pull llama3.1
```

Then in `.env`:

```
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=llama3.1
AI_API_KEY=
```

## Architecture

```
browser (xterm.js UI)  ⇄  WebSocket  ⇄  server.js (Express + node-pty)
                                          ├─ spawns your real shell in a PTY
                                          ├─ keeps a 32KB ring buffer of output
                                          │  (ANSI-stripped, fed to "Explain")
                                          └─ ai.js → any OpenAI-compatible API
```

- `server.js` — HTTP + WebSocket server; one PTY per browser tab; relays keystrokes/output and handles AI requests over the same socket.
- `ai.js` — provider layer + prompts (natural-language→command, error explanation).
- `public/` — xterm.js frontend, command palette, explain panel.

## Hosting beyond localhost — read this first

**This app hands a real shell on the host machine to whoever loads the page.** That is the point locally, and the danger everywhere else.

1. **Always set `AUTH_TOKEN`** when binding to anything other than localhost, and share the URL as `https://host/?token=...`.
2. Best free option for remote access to *your own machine*: keep running it locally and tunnel it —
   - [Tailscale](https://tailscale.com) (free): access `http://your-machine:3000` from your other devices, nothing exposed publicly.
   - `cloudflared tunnel --url http://localhost:3000` (free, no account needed for quick tunnels) — gives you a public HTTPS URL; **only with `AUTH_TOKEN` set**.
3. Free PaaS hosts (Render, Railway, Fly.io, Koyeb) *can* run it — you get a shell inside their container, which is actually a neat disposable cloud sandbox. `PORT` is respected automatically. Note node-pty needs a build step; their default Node images handle it. Set `AUTH_TOKEN` in the dashboard env vars.

## Config

| Env var | Meaning | Default |
|---|---|---|
| `AI_BASE_URL` | OpenAI-compatible API base | Groq |
| `AI_MODEL` | Model name | `llama-3.3-70b-versatile` |
| `AI_API_KEY` | API key (empty for Ollama) | — |
| `PORT` | HTTP port | `3000` |
| `AUTH_TOKEN` | Shared secret; required for non-local hosting | unset |
| `SHELL_CMD` | Shell to spawn | your `$SHELL` |
| `AUTO_SUGGEST` | Set to `off` to disable the auto-suggest-on-typo/plain-text feature | on |
| `AGENT_ROOT` | Default workspace folder for agent mode | your home dir |
| `AGENT_MAX_STEPS` | Step cap per agent session | `25` |

## Notes

- ⌘E/Ctrl+E and ⌘K/Ctrl+K are captured by the app, so readline's `Ctrl+E` (end-of-line) and `Ctrl+K` (kill-line) won't reach the shell. On macOS use the ⌘ versions and Ctrl+A/Ctrl+K still work — or rebind in `public/app.js`.
- "Run now" executes the AI's command verbatim. The prompt forbids destructive commands, but models make mistakes — prefer *Insert* and read before hitting Enter.
