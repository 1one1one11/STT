"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch (_error) {
  console.error("[ws-server] Missing dependency: ws");
  console.error("[ws-server] Install it with: npm install ws");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const LOG_FILE = process.env.LOG_FILE || "";
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), "logs");
const LOG_PREFIX = process.env.LOG_PREFIX || "stt-messages";
const MAX_API_LIMIT = 500;
const STATIC_ROOT = process.env.STATIC_ROOT || process.cwd();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureLogDirectoryForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getDailyLogFile(date = new Date()) {
  return path.join(LOG_DIR, `${LOG_PREFIX}-${getDateKey(date)}.ndjson`);
}

function getTargetLogFile(date = new Date()) {
  if (LOG_FILE) return LOG_FILE;
  return getDailyLogFile(date);
}

function appendLog(entry, date = new Date()) {
  const targetFile = getTargetLogFile(date);
  ensureLogDirectoryForFile(targetFile);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFile(targetFile, line, (error) => {
    if (error) {
      console.error("[ws-server] log write failed:", error.message);
    }
  });
}

function listLogFiles() {
  try {
    const names = fs.readdirSync(LOG_DIR);
    return names
      .filter((name) => name.endsWith(".ndjson"))
      .sort()
      .reverse();
  } catch (_error) {
    return [];
  }
}

function parseLimit(urlObj, fallback) {
  const raw = urlObj.searchParams.get("limit");
  const parsed = Number(raw || fallback);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_API_LIMIT);
}

function readLastLines(filePath, limit) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return { raw: line };
      }
    });
  } catch (_error) {
    return [];
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function resolveStaticPath(pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requestPath);
  const target = path.resolve(STATIC_ROOT, `.${decoded}`);
  const root = path.resolve(STATIC_ROOT);
  if (!target.startsWith(root + path.sep) && target !== root) return null;
  return target;
}

function serveStatic(res, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "content-type": contentType });
  res.end(content);
  return true;
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (urlObj.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "stt-ws-server" });
    return;
  }

  if (urlObj.pathname === "/logs") {
    const files = listLogFiles();
    sendJson(res, 200, {
      mode: LOG_FILE ? "fixed_file" : "daily_rollover",
      files
    });
    return;
  }

  if (urlObj.pathname === "/logs/latest") {
    const limit = parseLimit(urlObj, 100);
    const latestName = listLogFiles()[0];
    const latestFile = LOG_FILE || (latestName ? path.join(LOG_DIR, latestName) : null);
    const entries = latestFile && fs.existsSync(latestFile) ? readLastLines(latestFile, limit) : [];
    sendJson(res, 200, {
      file: latestFile || null,
      count: entries.length,
      entries
    });
    return;
  }

  if (urlObj.pathname.startsWith("/logs/")) {
    const day = urlObj.pathname.replace("/logs/", "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "Invalid date format. Use /logs/YYYY-MM-DD" });
      return;
    }
    const limit = parseLimit(urlObj, 200);
    const file = path.join(LOG_DIR, `${LOG_PREFIX}-${day}.ndjson`);
    const entries = fs.existsSync(file) ? readLastLines(file, limit) : [];
    sendJson(res, 200, {
      date: day,
      file,
      count: entries.length,
      entries
    });
    return;
  }

  if (serveStatic(res, urlObj.pathname)) return;

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket, req) => {
  const client = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[ws-server] connected: ${client}`);

  socket.send(
    JSON.stringify({
      type: "welcome",
      message: "Connected to STT test server",
      connectedAt: new Date().toISOString()
    })
  );

  socket.on("message", (raw) => {
    const text = raw.toString();
    console.log(`[ws-server] message from ${client}: ${text}`);
    appendLog({
      type: "stt",
      loggedAt: new Date().toISOString(),
      client,
      payload: text
    });

    socket.send(
      JSON.stringify({
        type: "ack",
        receivedAt: new Date().toISOString(),
        payload: text
      })
    );
  });

  socket.on("close", () => {
    console.log(`[ws-server] disconnected: ${client}`);
  });

  socket.on("error", (error) => {
    console.error(`[ws-server] socket error (${client}):`, error.message);
  });
});

ensureDirectory(LOG_DIR);
if (LOG_FILE) ensureLogDirectoryForFile(LOG_FILE);

server.listen(PORT, HOST, () => {
  console.log(`[ws-server] listening on ws://${HOST}:${PORT}`);
  console.log(`[ws-server] health check: http://localhost:${PORT}/health`);
  console.log(`[ws-server] log mode: ${LOG_FILE ? "fixed_file" : "daily_rollover"}`);
  if (LOG_FILE) {
    console.log(`[ws-server] logging to: ${LOG_FILE}`);
  } else {
    console.log(`[ws-server] logging to: ${path.join(LOG_DIR, `${LOG_PREFIX}-YYYY-MM-DD.ndjson`)}`);
  }
  console.log(`[ws-server] logs api: http://localhost:${PORT}/logs`);
});
