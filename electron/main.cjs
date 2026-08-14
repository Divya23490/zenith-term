// Electron shell for warpterm: starts the Node server as a child process,
// then opens a native window pointing at it. node-pty's prebuild is N-API,
// so it loads fine under Electron's embedded Node (ELECTRON_RUN_AS_NODE).
const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");

const APP_ROOT = path.join(__dirname, "..");
let serverProc = null;
let win = null;

// Load .env from the app root so the packaged app picks up keys/config.
function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(APP_ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*))/);
      if (m && !(m[1] in env)) env[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    }
  } catch {}
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function waitForServer(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http
        .get({ host: "127.0.0.1", port, path: "/api/info", timeout: 500 }, () => resolve())
        .on("error", () => (n > 0 ? setTimeout(() => attempt(n - 1), 250) : reject(new Error("server did not start"))));
    };
    attempt(tries);
  });
}

async function start() {
  const port = await freePort();
  const env = loadEnv();
  env.PORT = String(port);
  env.ELECTRON_RUN_AS_NODE = "1";

  // Run server.js with Electron's own binary in Node mode — no system Node needed.
  serverProc = spawn(process.execPath, [path.join(APP_ROOT, "server.js")], {
    env,
    cwd: APP_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on("exit", (code) => {
    if (win && !win.isDestroyed() && code !== 0 && code !== null) {
      dialog.showErrorBox("warpterm", `Terminal server exited unexpectedly (code ${code}).`);
      app.quit();
    }
  });

  try {
    await waitForServer(port);
  } catch (err) {
    dialog.showErrorBox("warpterm", `Could not start the terminal server: ${err.message}`);
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 400,
    title: "warpterm",
    backgroundColor: "#0d1017",
    titleBarStyle: "hiddenInset",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}`);

  // External links open in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(start);

app.on("window-all-closed", () => app.quit());

app.on("quit", () => {
  try {
    serverProc?.kill();
  } catch {}
});
