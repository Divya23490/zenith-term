/* warpterm frontend: xterm.js terminal + AI command bar + explain panel */

const params = new URLSearchParams(location.search);
const TOKEN = params.get("token") || "";

if (navigator.userAgent.includes("Electron")) document.body.classList.add("electron");

// ---------- terminal ----------
const term = new Terminal({
  fontFamily: "ui-monospace, Menlo, 'SF Mono', Consolas, monospace",
  fontSize: 13.5,
  lineHeight: 1.25,
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: true,
  theme: {
    background: "#0d1017",
    foreground: "#d6dbe5",
    cursor: "#7c6cf4",
    cursorAccent: "#0d1017",
    selectionBackground: "#7c6cf455",
    black: "#1a2030", red: "#e5534b", green: "#38c793", yellow: "#e0af68",
    blue: "#6ca4f8", magenta: "#b48ef2", cyan: "#56c2d6", white: "#d6dbe5",
    brightBlack: "#4a5570", brightRed: "#ff7b72", brightGreen: "#4ae2a8",
    brightYellow: "#f2cc60", brightBlue: "#8ab9ff", brightMagenta: "#cba6f7",
    brightCyan: "#76e3ea", brightWhite: "#ffffff",
  },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById("terminal"));
fitAddon.fit();
term.focus();

// ---------- websocket ----------
const statusEl = document.getElementById("conn-status");
let ws;
let wsReady = false;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ cols: term.cols, rows: term.rows });
  if (TOKEN) q.set("token", TOKEN);
  ws = new WebSocket(`${proto}://${location.host}/term?${q}`);

  ws.onopen = () => {
    wsReady = true;
    statusEl.textContent = "● connected";
    statusEl.className = "status ok";
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "data": term.write(msg.data); break;
      case "exit":
        term.write(`\r\n\x1b[90m[process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
        break;
      case "fatal":
        term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        break;
      case "ai-start": aiStart(msg); break;
      case "ai-chunk": aiChunk(msg); break;
      case "ai-done": aiDone(msg); break;
      case "ai-error": aiError(msg); break;
      case "agent-update": agentUpdate(msg); break;
      case "agent-approval": agentApproval(msg); break;
      case "agent-done": agentDone(msg); break;
      case "agent-error": agentError(msg); break;
    }
  };

  ws.onclose = () => {
    wsReady = false;
    statusEl.textContent = "○ disconnected — reload to reconnect";
    statusEl.className = "status err";
  };
}
connect();

term.onData((data) => {
  if (wsReady) ws.send(JSON.stringify({ type: "input", data }));
});

const doFit = () => {
  fitAddon.fit();
  if (wsReady) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
};
window.addEventListener("resize", doFit);

// ---------- AI panel ----------
const panel = document.getElementById("ai-panel");
const panelTitle = document.getElementById("panel-title");
const aiOutput = document.getElementById("ai-output");
const cmdPreview = document.getElementById("cmd-preview");
const cmdText = document.getElementById("cmd-text");

let currentMode = null;
let aiBuffer = "";
let autoBanner = "";
let reqCounter = 0;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function openPanel(title) {
  panel.classList.remove("hidden");
  panelTitle.textContent = title;
  doFit();
}

function closePanel() {
  panel.classList.add("hidden");
  cmdPreview.classList.add("hidden");
  doFit();
  term.focus();
}

document.getElementById("panel-close").addEventListener("click", closePanel);

// Minimal, safe markdown-ish rendering: bold + code blocks + inline code.
function renderMarkdown(text) {
  return escapeHtml(text)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function sendAi(mode, text) {
  if (!wsReady) return;
  currentMode = mode;
  aiBuffer = "";
  autoBanner = "";
  cmdPreview.classList.add("hidden");
  agentView.classList.add("hidden");
  aiOutput.classList.remove("hidden");
  openPanel(mode === "nl2cmd" ? "✨ Command suggestion" : "🩺 Explanation");
  aiOutput.innerHTML = '<span class="thinking">thinking…</span>';
  ws.send(JSON.stringify({ type: "ai", id: ++reqCounter, mode, text }));
}

// Server-initiated: fired when a typed line wasn't a recognized shell
// command, so we ask the AI what you probably meant. Same preview/Insert/Run
// flow as ⌘K — it never runs anything on its own.
function aiStart(msg) {
  if (msg?.auto) {
    currentMode = "nl2cmd";
    aiBuffer = "";
    cmdPreview.classList.add("hidden");
    agentView.classList.add("hidden");
    aiOutput.classList.remove("hidden");
    autoBanner = `<div class="auto-banner">🤖 <code>${escapeHtml(msg.originalText || "")}</code> wasn't a recognized command — here's a suggestion:</div>`;
    openPanel("Auto-suggestion");
    aiOutput.innerHTML = autoBanner + '<span class="thinking">thinking…</span>';
  } else {
    aiOutput.innerHTML = "";
  }
}

function aiChunk(msg) {
  aiBuffer += msg.data;
  const body =
    currentMode === "nl2cmd" ? `<pre><code>${escapeHtml(aiBuffer)}</code></pre>` : renderMarkdown(aiBuffer);
  aiOutput.innerHTML = autoBanner + body;
  aiOutput.scrollTop = aiOutput.scrollHeight;
}

function aiDone() {
  if (currentMode === "nl2cmd") {
    const cmd = aiBuffer.trim().replace(/^`+|`+$/g, "").replace(/^\$\s*/, "");
    if (cmd) {
      cmdText.textContent = cmd;
      cmdPreview.classList.remove("hidden");
    }
  }
}

function aiError(msg) {
  aiOutput.innerHTML = `<strong style="color:#e5534b">AI error:</strong> ${msg.message.replace(/</g, "&lt;")}<br><br><span class="thinking">Check your AI_API_KEY / AI_BASE_URL — see README.</span>`;
}

// Insert command into the shell prompt without executing (user reviews, then hits Enter).
document.getElementById("cmd-insert").addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "input", data: cmdText.textContent }));
  closePanel();
});

// Run immediately.
document.getElementById("cmd-run").addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "input", data: cmdText.textContent + "\r" }));
  closePanel();
});

// ---------- ask overlay (⌘K) ----------
const overlay = document.getElementById("ask-overlay");
const askInput = document.getElementById("ask-input");
overlay.classList.add("hidden");

function openAsk() {
  overlay.classList.remove("hidden");
  askInput.value = "";
  askInput.focus();
}

function closeAsk() {
  overlay.classList.add("hidden");
  term.focus();
}

askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && askInput.value.trim()) {
    sendAi("nl2cmd", askInput.value.trim());
    closeAsk();
  } else if (e.key === "Escape") {
    closeAsk();
  }
});

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeAsk();
});

document.getElementById("btn-ask").addEventListener("click", openAsk);
document.getElementById("btn-explain").addEventListener("click", () => sendAi("explain", ""));

// ---------- agent mode (⌘J) ----------
const agentView = document.getElementById("agent-view");
const agentForm = document.getElementById("agent-form");
const agentTask = document.getElementById("agent-task");
const agentRoot = document.getElementById("agent-root");
const agentAuto = document.getElementById("agent-auto");
const agentGo = document.getElementById("agent-go");
const agentStopBtn = document.getElementById("agent-stop-btn");
const agentLog = document.getElementById("agent-log");

let agentRunning = false;

function openAgent() {
  aiOutput.classList.add("hidden");
  cmdPreview.classList.add("hidden");
  agentView.classList.remove("hidden");
  openPanel("🤖 Agent");
  agentTask.focus();
}

function logEntry(cls, html) {
  const div = document.createElement("div");
  div.className = `log-entry ${cls}`;
  div.innerHTML = html;
  agentLog.appendChild(div);
  agentLog.scrollTop = agentLog.scrollHeight;
  return div;
}

function setAgentRunning(running) {
  agentRunning = running;
  agentGo.classList.toggle("hidden", running);
  agentStopBtn.classList.toggle("hidden", !running);
  agentTask.disabled = running;
  agentRoot.disabled = running;
  agentAuto.disabled = running;
}

agentForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!wsReady || agentRunning || !agentTask.value.trim()) return;
  agentLog.innerHTML = "";
  setAgentRunning(true);
  ws.send(JSON.stringify({
    type: "agent-start",
    task: agentTask.value.trim(),
    root: agentRoot.value.trim(),
    autoApprove: agentAuto.checked,
  }));
});

agentStopBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "agent-stop" }));
  setAgentRunning(false);
});

function agentUpdate(msg) {
  switch (msg.kind) {
    case "step": logEntry("step", `— step ${msg.step}/${msg.max} —`); break;
    case "note": logEntry("note", `💭 ${escapeHtml(msg.text)}`); break;
    case "action": logEntry("action", `▸ ${escapeHtml(msg.text)}`); break;
    case "result": logEntry("result", escapeHtml(msg.text)); break;
    case "output": logEntry("output", `<pre>${escapeHtml(msg.text)}</pre>`); break;
    case "info": logEntry("info", escapeHtml(msg.text)); break;
  }
}

function renderDiff(diffText) {
  return diffText.split("\n").map((line) => {
    const cls = line.startsWith("+") ? "dadd" : line.startsWith("-") ? "ddel" : "dctx";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join("\n");
}

function agentApproval(msg) {
  const desc = msg.kind === "write"
    ? `✏️ ${msg.exists ? "Overwrite" : "Create"} <code>${escapeHtml(msg.path)}</code>${msg.isDiff ? " (diff)" : ""}`
    : `⚡ Run: <code>${escapeHtml(msg.command)}</code>`;
  const body = msg.kind === "write" ? `<pre class="diff">${renderDiff(msg.diff || "")}</pre>` : "";
  const entry = logEntry("approval", `${desc}${body}
    <div class="approval-buttons">
      <button class="ap-yes">Approve</button>
      <button class="ap-no">Deny</button>
    </div>`);
  const finish = (approved) => {
    ws.send(JSON.stringify({ type: "agent-approve", id: msg.id, approved }));
    entry.querySelector(".approval-buttons").innerHTML =
      `<span class="${approved ? "ap-approved" : "ap-denied"}">${approved ? "✓ approved" : "✗ denied"}</span>`;
  };
  entry.querySelector(".ap-yes").addEventListener("click", () => finish(true));
  entry.querySelector(".ap-no").addEventListener("click", () => finish(false));
}

function agentDone(msg) {
  logEntry("done", `✅ <strong>Done in ${msg.steps} steps.</strong><br>${escapeHtml(msg.summary)}`);
  setAgentRunning(false);
}

function agentError(msg) {
  logEntry("error", `⛔ ${escapeHtml(msg.message)}`);
  setAgentRunning(false);
}

document.getElementById("btn-agent").addEventListener("click", openAgent);

// ---------- keyboard shortcuts ----------
// ⌘K / Ctrl+K → ask AI; ⌘E / Ctrl+E → explain. Captured at window level so
// they work even when the terminal has focus.
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      openAsk();
    } else if (mod && e.key.toLowerCase() === "e") {
      e.preventDefault();
      e.stopPropagation();
      sendAi("explain", "");
    } else if (mod && e.key.toLowerCase() === "j") {
      e.preventDefault();
      e.stopPropagation();
      openAgent();
    } else if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
      closeAsk();
    }
  },
  true
);

// Keep ⌘K/⌘E/⌘J from reaching the shell when terminal has focus.
term.attachCustomKeyEventHandler((e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && ["k", "e", "j"].includes(e.key.toLowerCase())) return false;
  return true;
});
