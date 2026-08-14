// Agent mode: a multi-step AI loop that can read/list/write files and run
// commands inside ONE workspace directory, to accomplish tasks like "add a
// --json flag to this CLI and make the tests pass".
//
// Safety model:
//   - Confined to a workspace root; any path that resolves outside it is refused.
//   - Every file write is shown to the user as a diff and requires approval.
//   - Every command is shown to the user and requires approval.
//   - "Auto-approve" mode (opt-in, per session) skips those prompts, but
//     clearly-dangerous commands still require a manual click.
//   - Hard step cap per session; one session at a time per connection.
//
// Model protocol: works with any chat model (no native tool-calling needed).
// The model must reply with exactly one JSON action object per step.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { streamChat } from "./ai.js";

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 25);
const MAX_TOOL_RESULT = 6000; // chars of any tool result fed back to the model
const MAX_FILE_READ = 12000;
const CMD_TIMEOUT_MS = 90_000;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

// Even with auto-approve on, these still require a manual click.
const ALWAYS_ASK_RE = /(^|[\s;&|])(sudo|rm\s+-rf?\s+[\/~]|mkfs|diskutil|shutdown|reboot|dd\s+if=|:\(\)\s*\{|chmod\s+-R\s+777\s+\/)/;

const SYSTEM_PROMPT = (root) => `You are an autonomous coding agent working inside the user's project directory: ${root} (OS: ${process.platform}).
You accomplish the task by taking ONE action at a time.

Respond with EXACTLY ONE JSON object and NOTHING else — no prose before or after, no markdown fences. Schema:
{"note": "<one short sentence: what you're doing and why>", "action": "<name>", ...fields}

Actions:
- {"note":"...","action":"list","path":"."}                      → directory listing (relative path)
- {"note":"...","action":"read","path":"src/app.js"}             → file contents
- {"note":"...","action":"write","path":"src/app.js","content":"<FULL new file content>"} → create/overwrite a file (user approves a diff)
- {"note":"...","action":"run","command":"npm test"}             → run a shell command in the project root (user approves)
- {"note":"...","action":"done","summary":"<what you did and the verified outcome>"}

Rules:
- Paths are relative to the project root. You cannot access anything outside it.
- "write" replaces the ENTIRE file. Always output the complete file — never fragments, never placeholders like "... rest unchanged".
- Read a file before you modify it.
- Verify your work: after writing code, run it or its tests before declaring done.
- If a result says DENIED, the user rejected that step — take a different approach, never repeat the identical request.
- All strings must be valid JSON: escape newlines as \\n and quotes as \\".
- Never touch files outside the task's scope; never run destructive commands.`;

// Extract the first balanced JSON object from model text (tolerates ```json fences and stray prose).
function parseAction(text) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      else if (!inStr && c === "{") depth++;
      else if (!inStr && c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(cleaned.slice(start, i + 1));
            if (obj && typeof obj.action === "string") return obj;
          } catch {}
          break; // balanced but unparseable — try next '{'
        }
      }
    }
  }
  return null;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length - n} more chars]` : s);

// Compact line diff (LCS). Falls back to a plain preview for very large files.
function lineDiff(oldStr, newStr) {
  const a = oldStr.split("\n"), b = newStr.split("\n");
  if (a.length > 600 || b.length > 600) return null;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(" " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("-" + a[i]); i++; }
    else { out.push("+" + b[j]); j++; }
  }
  while (i < a.length) out.push("-" + a[i++]);
  while (j < b.length) out.push("+" + b[j++]);
  // Collapse long unchanged runs.
  const collapsed = [];
  let run = [];
  for (const line of out) {
    if (line.startsWith(" ")) run.push(line);
    else {
      if (run.length > 6) collapsed.push(...run.slice(0, 3), `  ⋯ ${run.length - 6} unchanged lines ⋯`, ...run.slice(-3));
      else collapsed.push(...run);
      run = [];
      collapsed.push(line);
    }
  }
  if (run.length > 6) collapsed.push(...run.slice(0, 3), `  ⋯ ${run.length - 6} unchanged lines ⋯`, ...run.slice(-3));
  else collapsed.push(...run);
  return collapsed.join("\n");
}

export class AgentSession {
  constructor(ws, { task, root, autoApprove }) {
    this.ws = ws;
    this.task = String(task || "").slice(0, 4000);
    this.autoApprove = Boolean(autoApprove);
    this.active = true;
    this.pending = null; // { id, resolve }
    this.approvalCounter = 0;

    const requested = String(root || "").trim() || process.env.AGENT_ROOT || os.homedir();
    this.root = path.resolve(requested.replace(/^~(?=$|\/)/, os.homedir()));
  }

  send(obj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }

  emit(kind, data = {}) {
    this.send({ type: "agent-update", kind, ...data });
  }

  stop() {
    this.active = false;
    if (this.pending) {
      this.pending.resolve(false);
      this.pending = null;
    }
  }

  resolveApproval(id, approved) {
    if (this.pending && this.pending.id === id) {
      this.pending.resolve(Boolean(approved));
      this.pending = null;
    }
  }

  askApproval(payload) {
    const id = `ap-${++this.approvalCounter}`;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      this.send({ type: "agent-approval", id, ...payload });
      setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = null;
          this.emit("info", { text: "Approval timed out — treated as denied." });
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
    });
  }

  resolvePath(p) {
    const raw = String(p || "");
    if (raw.startsWith("~")) throw new Error(`use paths relative to the workspace root, not ${raw}`);
    const abs = path.resolve(this.root, raw);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes the workspace root: ${p}`);
    }
    return abs;
  }

  listDir(rel) {
    const abs = this.resolvePath(rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== ".git" && e.name !== "node_modules")
      .slice(0, 200)
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    return entries.join("\n") || "(empty)";
  }

  runCommand(command) {
    return new Promise((resolve) => {
      exec(command, { cwd: this.root, timeout: CMD_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (err.killed ? "timeout" : err.code ?? 1) : 0;
        resolve(`exit: ${code}\n${stdout || ""}${stderr ? "\n[stderr]\n" + stderr : ""}`);
      });
    });
  }

  async execute(action) {
    switch (action.action) {
      case "list": {
        const listing = this.listDir(action.path ?? ".");
        this.emit("action", { text: `list ${action.path ?? "."}` });
        return `Listing of ${action.path ?? "."}:\n${listing}`;
      }

      case "read": {
        const abs = this.resolvePath(action.path);
        this.emit("action", { text: `read ${action.path}` });
        if (!fs.existsSync(abs)) return `ERROR: ${action.path} does not exist`;
        const content = fs.readFileSync(abs, "utf8");
        return `Contents of ${action.path}:\n${truncate(content, MAX_FILE_READ)}`;
      }

      case "write": {
        const abs = this.resolvePath(action.path);
        const newContent = String(action.content ?? "");
        const exists = fs.existsSync(abs);
        const oldContent = exists ? fs.readFileSync(abs, "utf8") : "";
        const diff = exists ? lineDiff(oldContent, newContent) : null;

        let approved = this.autoApprove;
        if (!approved) {
          approved = await this.askApproval({
            kind: "write",
            path: action.path,
            exists,
            diff: diff ?? truncate(newContent, 4000),
            isDiff: Boolean(diff),
          });
        } else {
          this.emit("action", { text: `write ${action.path} (auto-approved)` });
        }
        if (!this.active) return "DENIED: session stopped";
        if (!approved) return `DENIED: the user rejected writing ${action.path}`;

        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, newContent);
        this.emit("result", { text: `✓ wrote ${action.path} (${newContent.length} chars)` });
        return `OK: wrote ${action.path}`;
      }

      case "run": {
        const command = String(action.command ?? "").slice(0, 2000);
        if (!command) return "ERROR: empty command";

        let approved = this.autoApprove && !ALWAYS_ASK_RE.test(command);
        if (!approved) {
          approved = await this.askApproval({ kind: "run", command });
        } else {
          this.emit("action", { text: `run: ${command} (auto-approved)` });
        }
        if (!this.active) return "DENIED: session stopped";
        if (!approved) return `DENIED: the user rejected running that command`;

        const output = await this.runCommand(command);
        this.emit("output", { text: truncate(output, 3000) });
        return `Command: ${command}\n${truncate(output, MAX_TOOL_RESULT)}`;
      }

      default:
        return `ERROR: unknown action "${action.action}". Use list / read / write / run / done.`;
    }
  }

  // Public entry point. Guarantees `active` is cleared however the session
  // ends (done / error / step limit / throw) — otherwise the connection's
  // "already running" guard would block every future session.
  async run() {
    try {
      await this.#loop();
    } finally {
      this.active = false;
    }
  }

  async #loop() {
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      this.send({ type: "agent-error", message: `Workspace root does not exist: ${this.root}` });
      return;
    }

    this.emit("info", { text: `Workspace: ${this.root}${this.autoApprove ? " · auto-approve ON" : ""}` });

    let seedListing = "";
    try { seedListing = this.listDir("."); } catch { /* unreadable root */ }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT(this.root) },
      { role: "user", content: `Task: ${this.task}\n\nTop-level listing of the project root:\n${seedListing}` },
    ];

    let malformedStreak = 0;

    for (let step = 1; step <= MAX_STEPS && this.active; step++) {
      this.emit("step", { step, max: MAX_STEPS });

      let text = "";
      // Free tiers have tokens-per-minute caps (Groq: 12K TPM) — on a 429,
      // wait the suggested time and retry instead of killing the session.
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok && this.active; attempt++) {
        text = "";
        try {
          for await (const chunk of streamChat(messages, { maxTokens: 4000 })) {
            text += chunk;
            if (!this.active) return;
          }
          ok = true;
        } catch (err) {
          const m = String(err.message || err);
          const isRate = /429|rate.?limit/i.test(m);
          if (isRate && attempt < 3) {
            const waitSec = Math.min(Number(m.match(/try again in ([\d.]+)s/i)?.[1] || 25) + 2, 90);
            this.emit("info", { text: `Rate-limited by the free tier — waiting ${Math.round(waitSec)}s…` });
            await new Promise((r) => setTimeout(r, waitSec * 1000));
          } else {
            this.send({ type: "agent-error", message: m });
            return;
          }
        }
      }
      if (!ok) return;

      const action = parseAction(text);
      if (!action) {
        malformedStreak++;
        if (malformedStreak >= 3) {
          this.send({ type: "agent-error", message: "Model failed to follow the action protocol 3 times in a row — stopping. Try a different model." });
          return;
        }
        messages.push(
          { role: "assistant", content: truncate(text, 2000) },
          { role: "user", content: "ERROR: that was not a single valid JSON action object. Reply with EXACTLY one JSON object per the schema, nothing else." }
        );
        continue;
      }
      malformedStreak = 0;

      if (action.note) this.emit("note", { text: String(action.note).slice(0, 300) });

      if (action.action === "done") {
        this.send({ type: "agent-done", summary: String(action.summary || "Task finished.").slice(0, 2000), steps: step });
        return;
      }

      let result;
      try {
        result = await this.execute(action);
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      if (!this.active) return;

      messages.push(
        { role: "assistant", content: JSON.stringify({ note: action.note, action: action.action, path: action.path, command: action.command }) },
        { role: "user", content: `Result:\n${truncate(result, MAX_TOOL_RESULT)}` }
      );

      // Trim history: keep system + task + the most recent exchanges.
      if (messages.length > 26) {
        messages.splice(2, messages.length - 24, { role: "user", content: "(earlier steps trimmed to save context)" });
      }
    }

    if (this.active) {
      this.send({ type: "agent-error", message: `Reached the ${MAX_STEPS}-step limit without "done". Partial work may exist in the workspace.` });
    }
  }
}
