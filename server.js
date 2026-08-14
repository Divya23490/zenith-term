import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import pty from "node-pty";
import { streamChat, nl2cmdMessages, explainMessages, providerInfo } from "./ai.js";
import { AgentSession } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || ""; // set when hosting anywhere non-local!
const SHELL = process.env.SHELL_CMD || process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "bash");
const SCROLLBACK_BYTES = 32 * 1024; // ring buffer of recent output fed to the AI
// When you type plain text at the prompt and the shell can't find it as a
// command, auto-suggest what you probably meant instead of making you notice
// the error and press ⌘E yourself. Never auto-runs — same Insert/Run preview
// as ⌘K. Disable with AUTO_SUGGEST=off.
const AUTO_SUGGEST = process.env.AUTO_SUGGEST !== "off";
const COMMAND_NOT_FOUND_RE = /command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)/i;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
// Serve xterm.js assets straight from node_modules — no bundler needed.
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules/@xterm/xterm")));
app.use("/vendor/addon-fit", express.static(path.join(__dirname, "node_modules/@xterm/addon-fit")));
app.use("/vendor/addon-web-links", express.static(path.join(__dirname, "node_modules/@xterm/addon-web-links")));

app.get("/api/info", (req, res) => {
  res.json({ provider: providerInfo(), shell: SHELL, authRequired: Boolean(AUTH_TOKEN) });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/term" });

// Strip ANSI escape sequences before sending terminal output to the AI.
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-B]|[a-zA-Z=><])/g;
const stripAnsi = (s) => s.replace(ANSI_RE, "").replace(/\r/g, "");

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (AUTH_TOKEN && url.searchParams.get("token") !== AUTH_TOKEN) {
    ws.send(JSON.stringify({ type: "fatal", message: "Invalid or missing auth token." }));
    ws.close();
    return;
  }

  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;

  const shell = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME || process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });

  let outputBuffer = ""; // recent output, ring-buffered
  let aiBusy = false;
  let autoCounter = 0;
  let agent = null; // active AgentSession, one per connection

  // Best-effort tracker of the line currently being typed at the shell
  // prompt, built from raw keystrokes. Only used to power auto-suggest below
  // — never affects what's actually sent to the shell.
  const line = { buf: "", pending: null, armedUntil: 0 };
  function trackLine(raw) {
    // Drop escape sequences (arrow keys, home/end, etc.) before reading chars.
    const data = raw.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "").replace(/\x1b./g, "");
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        const submitted = line.buf.trim();
        line.buf = "";
        if (submitted) {
          line.pending = submitted;
          line.armedUntil = Date.now() + 1800;
        }
      } else if (code === 0x7f || code === 0x08) {
        line.buf = line.buf.slice(0, -1);
      } else if (code === 0x15) {
        line.buf = ""; // Ctrl+U
      } else if (code === 0x03) {
        line.buf = "";
        line.pending = null; // Ctrl+C — interrupted, don't suggest
      } else if (code >= 0x20) {
        line.buf += ch;
      }
    }
  }

  async function triggerAutoSuggest(originalText) {
    if (aiBusy) return; // don't collide with a manual ⌘K/⌘E request
    aiBusy = true;
    const id = `auto-${++autoCounter}`;
    try {
      ws.send(JSON.stringify({ type: "ai-start", id, mode: "nl2cmd", auto: true, originalText }));
      const messages = nl2cmdMessages(originalText, { cwd: process.env.HOME });
      for await (const chunk of streamChat(messages)) {
        if (ws.readyState !== ws.OPEN) break;
        ws.send(JSON.stringify({ type: "ai-chunk", id, data: chunk }));
      }
      ws.send(JSON.stringify({ type: "ai-done", id }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "ai-error", id, message: String(err.message || err) }));
    } finally {
      aiBusy = false;
    }
  }

  shell.onData((data) => {
    outputBuffer = (outputBuffer + data).slice(-SCROLLBACK_BYTES);

    if (AUTO_SUGGEST && line.pending && Date.now() < line.armedUntil) {
      if (COMMAND_NOT_FOUND_RE.test(stripAnsi(data))) {
        const failedText = line.pending;
        line.pending = null; // fire once per submitted line
        triggerAutoSuggest(failedText);
      }
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });

  shell.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", exitCode }));
      ws.close();
    }
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "input":
        trackLine(msg.data);
        shell.write(msg.data);
        break;

      case "resize":
        if (msg.cols > 0 && msg.rows > 0) shell.resize(msg.cols, msg.rows);
        break;

      case "ai": {
        // msg.mode: "nl2cmd" | "explain"; msg.text: user input (optional for explain)
        if (aiBusy) {
          ws.send(JSON.stringify({ type: "ai-error", id: msg.id, message: "An AI request is already running." }));
          return;
        }
        aiBusy = true;
        try {
          let messages;
          if (msg.mode === "nl2cmd") {
            messages = nl2cmdMessages(msg.text, { cwd: process.env.HOME });
          } else {
            const recent = stripAnsi(outputBuffer).slice(-6000);
            messages = explainMessages(recent, msg.text);
          }
          ws.send(JSON.stringify({ type: "ai-start", id: msg.id, mode: msg.mode }));
          for await (const chunk of streamChat(messages)) {
            if (ws.readyState !== ws.OPEN) break;
            ws.send(JSON.stringify({ type: "ai-chunk", id: msg.id, data: chunk }));
          }
          ws.send(JSON.stringify({ type: "ai-done", id: msg.id }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "ai-error", id: msg.id, message: String(err.message || err) }));
        } finally {
          aiBusy = false;
        }
        break;
      }

      case "agent-start": {
        if (agent?.active) {
          ws.send(JSON.stringify({ type: "agent-error", message: "An agent session is already running — stop it first." }));
          return;
        }
        agent = new AgentSession(ws, { task: msg.task, root: msg.root, autoApprove: msg.autoApprove });
        agent.run().catch((err) => {
          ws.send(JSON.stringify({ type: "agent-error", message: String(err.message || err) }));
        });
        break;
      }

      case "agent-approve":
        agent?.resolveApproval(msg.id, msg.approved);
        break;

      case "agent-stop":
        agent?.stop();
        ws.send(JSON.stringify({ type: "agent-update", kind: "info", text: "Agent stopped by user." }));
        break;
    }
  });

  ws.on("close", () => {
    agent?.stop();
    try {
      shell.kill();
    } catch {}
  });
});

server.listen(PORT, () => {
  const info = providerInfo();
  console.log(`\n  warpterm running at http://localhost:${PORT}`);
  console.log(`  shell: ${SHELL}`);
  console.log(`  AI: ${info.baseUrl} (model: ${info.model})${info.hasKey ? "" : "  ⚠ no AI_API_KEY set — AI features will fail unless using Ollama"}`);
  if (!AUTH_TOKEN) console.log(`  ⚠ no AUTH_TOKEN set — only run on localhost. Set AUTH_TOKEN before exposing this anywhere.\n`);
});
