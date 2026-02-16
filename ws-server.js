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
const SESSION_PREFIX = process.env.SESSION_PREFIX || "stt-session-events";
const SESSION_CORRECTION_PREFIX = process.env.SESSION_CORRECTION_PREFIX || "stt-session-corrections";
const MAX_API_LIMIT = 500;
const STATIC_ROOT = process.env.STATIC_ROOT || process.cwd();
const INTRO_PHRASE = "신한투자증권서인원입니다";
const MAX_BODY_SIZE = 1024 * 1024;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
const clientSessions = new Map();

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

function getDailySessionEventFile(date = new Date()) {
  return path.join(LOG_DIR, `${SESSION_PREFIX}-${getDateKey(date)}.ndjson`);
}

function getDailySessionCorrectionFile(date = new Date()) {
  return path.join(LOG_DIR, `${SESSION_CORRECTION_PREFIX}-${getDateKey(date)}.ndjson`);
}

function getSessionEventFileByDay(day) {
  return path.join(LOG_DIR, `${SESSION_PREFIX}-${day}.ndjson`);
}

function getSessionCorrectionFileByDay(day) {
  return path.join(LOG_DIR, `${SESSION_CORRECTION_PREFIX}-${day}.ndjson`);
}

function getTargetLogFile(date = new Date()) {
  if (LOG_FILE) return LOG_FILE;
  return getDailyLogFile(date);
}

function appendNdjson(filePath, entry) {
  ensureLogDirectoryForFile(filePath);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFile(filePath, line, (error) => {
    if (error) {
      console.error("[ws-server] log write failed:", error.message);
    }
  });
}

function appendLog(entry, date = new Date()) {
  const targetFile = getTargetLogFile(date);
  appendNdjson(targetFile, entry);
}

function appendSessionEvent(entry, date = new Date()) {
  const targetFile = getDailySessionEventFile(date);
  appendNdjson(targetFile, entry);
}

function appendSessionCorrection(entry, date = new Date()) {
  const targetFile = getDailySessionCorrectionFile(date);
  appendNdjson(targetFile, entry);
}

function normalizeForMatch(text = "") {
  return text.replace(/\s+/g, "").replace(/[.,!?]/g, "").trim();
}

function isIntroPhrase(text = "") {
  return normalizeForMatch(text).includes(INTRO_PHRASE);
}

function detectCustomerName(text = "") {
  const patterns = [
    /([가-힣]{2,5})\s*고객님(?:\s*맞으신가요)?/g,
    /([가-힣]{2,5})\s*고객(?:님)?/g
  ];

  for (const pattern of patterns) {
    const matched = pattern.exec(text);
    if (matched && matched[1]) {
      return matched[1];
    }
  }
  return null;
}

function newSessionId(date = new Date()) {
  const day = getDateKey(date);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${day}-${Date.now()}-${rand}`;
}

function createSession(client, reason, now = new Date()) {
  const session = {
    sessionId: newSessionId(now),
    startedAt: now.toISOString(),
    startedReason: reason,
    customerName: "미인식",
    customerStatus: "unrecognized",
    messageCount: 0,
    lastMessageAt: now.toISOString(),
    client
  };
  clientSessions.set(client, session);
  appendSessionEvent({
    type: "session_start",
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    startedReason: session.startedReason,
    customerName: session.customerName,
    customerStatus: session.customerStatus,
    client
  }, now);
  return session;
}

function getOrCreateSession(client, now = new Date()) {
  const current = clientSessions.get(client);
  if (current) return current;
  return createSession(client, "implicit_start", now);
}

function parseIncomingStt(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.text === "string") return parsed.text.trim();
      return rawText;
    }
  } catch (_error) {
    return rawText.trim();
  }
  return rawText.trim();
}

function readNdjson(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function summarizeSessions(events) {
  const map = new Map();
  for (const event of events) {
    const sid = event.sessionId;
    if (!sid) continue;

    const current = map.get(sid) || {
      sessionId: sid,
      startedAt: event.startedAt || event.loggedAt || null,
      startedReason: event.startedReason || "unknown",
      customerName: "미인식",
      customerStatus: "unrecognized",
      client: event.client || null,
      messageCount: 0,
      lastMessageAt: event.loggedAt || event.startedAt || null
    };

    if (event.type === "session_start") {
      current.startedAt = event.startedAt || current.startedAt;
      current.startedReason = event.startedReason || current.startedReason;
      current.client = event.client || current.client;
    }

    if (event.type === "customer_detected") {
      current.customerName = event.customerName || current.customerName;
      current.customerStatus = event.customerStatus || current.customerStatus;
    }

    if (event.type === "message") {
      current.messageCount += 1;
      current.lastMessageAt = event.loggedAt || current.lastMessageAt;
      if (event.customerName) current.customerName = event.customerName;
      if (event.customerStatus) current.customerStatus = event.customerStatus;
    }

    map.set(sid, current);
  }

  return [...map.values()].sort((a, b) => {
    const left = new Date(a.startedAt || 0).getTime();
    const right = new Date(b.startedAt || 0).getTime();
    return right - left;
  });
}

function applySessionCorrections(sessions, corrections) {
  if (!corrections.length) return sessions;

  const latestBySessionId = new Map();
  for (const correction of corrections) {
    if (!correction.sessionId) continue;
    latestBySessionId.set(correction.sessionId, correction);
  }

  return sessions.map((session) => {
    const correction = latestBySessionId.get(session.sessionId);
    if (!correction) return session;
    return {
      ...session,
      customerName: correction.customerName || session.customerName,
      customerStatus: correction.customerName ? "corrected" : session.customerStatus,
      correctedAt: correction.correctedAt || null,
      correctedBy: correction.correctedBy || null
    };
  });
}

function readSessionSummaryByDate(day) {
  const file = getSessionEventFileByDay(day);
  const correctionFile = getSessionCorrectionFileByDay(day);
  const events = fs.existsSync(file) ? readNdjson(file) : [];
  const corrections = fs.existsSync(correctionFile) ? readNdjson(correctionFile) : [];
  const sessions = applySessionCorrections(summarizeSessions(events), corrections);
  return { file, correctionFile, sessions };
}

function getDailyMessageLogFile(day) {
  return path.join(LOG_DIR, `${LOG_PREFIX}-${day}.ndjson`);
}

function parseUnrecognizedFilter(urlObj) {
  return urlObj.searchParams.get("status") === "unrecognized";
}

function readCustomerConversationsByDate(day, options = {}) {
  const { onlyUnrecognized = false } = options;
  const messageFile = getDailyMessageLogFile(day);
  const { file: sessionFile, sessions: sessionSummary } = readSessionSummaryByDate(day);
  const sessionMap = new Map();

  for (const session of sessionSummary) {
    sessionMap.set(session.sessionId, {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      startedReason: session.startedReason,
      customerName: session.customerName || "미인식",
      customerStatus: session.customerStatus || "unrecognized",
      client: session.client || null,
      messageCount: session.messageCount || 0,
      lastMessageAt: session.lastMessageAt || null,
      messages: []
    });
  }

  const messageEntries = fs.existsSync(messageFile) ? readNdjson(messageFile) : [];
  for (const entry of messageEntries) {
    if (entry.type !== "stt") continue;
    const sid = entry.session && entry.session.sessionId;
    if (!sid) continue;

    const fromSummary = sessionMap.get(sid) || null;
    const current = fromSummary || {
      sessionId: sid,
      startedAt: (entry.session && entry.session.startedAt) || entry.loggedAt || null,
      startedReason: (entry.session && entry.session.startedReason) || "unknown",
      customerName: (entry.session && entry.session.customerName) || "미인식",
      customerStatus: (entry.session && entry.session.customerStatus) || "unrecognized",
      client: entry.client || null,
      messageCount: 0,
      lastMessageAt: entry.loggedAt || null,
      messages: []
    };

    if (!fromSummary) {
      current.customerName = (entry.session && entry.session.customerName) || current.customerName;
      current.customerStatus = (entry.session && entry.session.customerStatus) || current.customerStatus;
    }
    current.lastMessageAt = entry.loggedAt || current.lastMessageAt;
    current.messages.push({
      loggedAt: entry.loggedAt || null,
      text: String(entry.payload || ""),
      client: entry.client || null
    });
    current.messageCount = current.messages.length;
    sessionMap.set(sid, current);
  }

  let sessions = [...sessionMap.values()];
  if (onlyUnrecognized) {
    sessions = sessions.filter((session) => session.customerStatus === "unrecognized");
  }

  sessions.forEach((session) => {
    session.messages.sort((a, b) => {
      const left = new Date(a.loggedAt || 0).getTime();
      const right = new Date(b.loggedAt || 0).getTime();
      return left - right;
    });
  });

  const customerMap = new Map();
  for (const session of sessions) {
    const key = `${session.customerStatus}::${session.customerName}`;
    const current = customerMap.get(key) || {
      customerName: session.customerName,
      customerStatus: session.customerStatus,
      firstStartedAt: session.startedAt || null,
      lastMessageAt: session.lastMessageAt || null,
      sessionCount: 0,
      messageCount: 0,
      sessions: []
    };

    current.sessionCount += 1;
    current.messageCount += session.messageCount || 0;
    if (session.startedAt && (!current.firstStartedAt || new Date(session.startedAt) < new Date(current.firstStartedAt))) {
      current.firstStartedAt = session.startedAt;
    }
    if (session.lastMessageAt && (!current.lastMessageAt || new Date(session.lastMessageAt) > new Date(current.lastMessageAt))) {
      current.lastMessageAt = session.lastMessageAt;
    }
    current.sessions.push(session);
    customerMap.set(key, current);
  }

  const customers = [...customerMap.values()]
    .map((customer) => {
      customer.sessions.sort((a, b) => {
        const left = new Date(a.startedAt || 0).getTime();
        const right = new Date(b.startedAt || 0).getTime();
        return right - left;
      });
      return customer;
    })
    .sort((a, b) => {
      const left = new Date(a.firstStartedAt || 0).getTime();
      const right = new Date(b.firstStartedAt || 0).getTime();
      return right - left;
    });

  return { day, messageFile, sessionFile, customers };
}

function currentSessionView(session) {
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    startedReason: session.startedReason,
    customerName: session.customerName,
    customerStatus: session.customerStatus,
    messageCount: session.messageCount,
    lastMessageAt: session.lastMessageAt
  };
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

function sendText(res, statusCode, contentType, text, fileName) {
  const headers = { "content-type": contentType };
  if (fileName) {
    headers["content-disposition"] = `attachment; filename="${fileName}"`;
  }
  res.writeHead(statusCode, headers);
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_SIZE) {
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function inferCustomerReaction(texts) {
  const all = texts.join(" ");
  const positive = /(좋|가능|관심|진행|검토해볼게|오케이|괜찮)/;
  const negative = /(어렵|부담|거절|힘들|아니|안\s?할|보류)/;
  if (positive.test(all) && !negative.test(all)) return "관심/긍정 반응이 확인되었습니다.";
  if (negative.test(all) && !positive.test(all)) return "신중/보류 또는 거절 반응이 확인되었습니다.";
  if (positive.test(all) && negative.test(all)) return "긍정과 신중 반응이 혼재되어 추가 확인이 필요합니다.";
  return "반응이 명확히 분류되지 않아 후속 확인이 필요합니다.";
}

function normalizeConversationTexts(texts) {
  const seen = new Set();
  const normalized = [];
  for (const text of texts) {
    const value = String(text || "").trim();
    if (!value) continue;
    if (normalizeForMatch(value).includes(INTRO_PHRASE)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function buildSalesContent(texts) {
  const normalized = normalizeConversationTexts(texts);
  if (!normalized.length) {
    return "통화 핵심 내용이 충분히 기록되지 않아 수기 보완이 필요합니다.";
  }
  return normalized.slice(0, 4).join(" / ");
}

function buildNextPlan(customerStatus) {
  if (customerStatus === "unrecognized") {
    return "고객명 수기 보정 후 상담 목적/관심 상품을 재정리하고 재통화 계획을 수립합니다.";
  }
  if (customerStatus === "corrected") {
    return "보정된 고객 정보 기준으로 CRM 반영 후, 다음 통화에서 니즈를 재확인합니다.";
  }
  return "다음 통화에서 관심도 확인 및 구체 조건(금액/기간/위험성향)을 확정합니다.";
}

function escapeCsvCell(value) {
  const raw = String(value ?? "");
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

function buildReportCsv(report) {
  const header = [
    "date",
    "customerName",
    "customerStatus",
    "firstStartedAt",
    "lastMessageAt",
    "sessionCount",
    "messageCount",
    "salesContent",
    "customerReaction",
    "nextPlan"
  ].join(",");

  const rows = report.reports.map((item) => {
    return [
      report.date,
      item.customerName,
      item.customerStatus,
      item.firstStartedAt || "",
      item.lastMessageAt || "",
      item.sessionCount,
      item.messageCount,
      item.draft.salesContent,
      item.draft.customerReaction,
      item.draft.nextPlan
    ].map(escapeCsvCell).join(",");
  });

  return [header, ...rows].join("\n");
}

function buildReportMarkdown(report) {
  const lines = [`# 영업일지 (${report.date})`, ""];

  for (const item of report.reports) {
    lines.push(`## ${item.customerName} (${item.customerStatus})`);
    lines.push(`- 통화 시작: ${item.firstStartedAt || "-"}`);
    lines.push(`- 최근 통화: ${item.lastMessageAt || "-"}`);
    lines.push(`- 세션 수: ${item.sessionCount}, 발화 수: ${item.messageCount}`);
    lines.push("");
    lines.push("### 영업 내용");
    lines.push(item.draft.salesContent);
    lines.push("");
    lines.push("### 고객 반응");
    lines.push(item.draft.customerReaction);
    lines.push("");
    lines.push("### 향후 계획");
    lines.push(item.draft.nextPlan);
    lines.push("");
  }

  return lines.join("\n");
}

function buildDailyReportByDate(day, options = {}) {
  const { onlyUnrecognized = false } = options;
  const result = readCustomerConversationsByDate(day, { onlyUnrecognized });
  const reports = result.customers.map((customer) => {
    const allMessages = customer.sessions.flatMap((session) => session.messages || []);
    const sortedMessages = allMessages.sort((a, b) => {
      const left = new Date(a.loggedAt || 0).getTime();
      const right = new Date(b.loggedAt || 0).getTime();
      return left - right;
    });
    const texts = sortedMessages.map((message) => message.text).filter(Boolean);
    const salesSummary = normalizeConversationTexts(texts).slice(0, 5);
    const salesContent = buildSalesContent(texts);
    const customerReaction = inferCustomerReaction(texts);
    const nextPlan = buildNextPlan(customer.customerStatus);
    const dailyNote = [
      `[고객] ${customer.customerName} (${customer.customerStatus})`,
      `[통화 시작] ${customer.firstStartedAt || "-"}`,
      `[영업 내용] ${salesContent}`,
      `[고객 반응] ${customerReaction}`,
      `[향후 계획] ${nextPlan}`
    ].join("\n");

    return {
      customerName: customer.customerName,
      customerStatus: customer.customerStatus,
      firstStartedAt: customer.firstStartedAt,
      lastMessageAt: customer.lastMessageAt,
      sessionCount: customer.sessionCount,
      messageCount: customer.messageCount,
      draft: {
        salesSummary: salesSummary.length
          ? salesSummary
          : ["대화 텍스트가 부족하여 수기 보완이 필요합니다."],
        salesContent,
        customerReaction,
        nextPlan,
        dailyNote
      }
    };
  });

  return {
    date: day,
    messageFile: result.messageFile,
    sessionFile: result.sessionFile,
    correctionFile: getSessionCorrectionFileByDay(day),
    count: reports.length,
    reports
  };
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

const server = http.createServer(async (req, res) => {
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

  if (req.method === "POST" && urlObj.pathname === "/sessions/correct") {
    try {
      const body = await readJsonBody(req);
      const day = String(body.date || "").trim();
      const sessionId = String(body.sessionId || "").trim();
      const customerName = String(body.customerName || "").trim();
      const correctedBy = String(body.correctedBy || "manual").trim();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        sendJson(res, 400, { error: "date is required as YYYY-MM-DD" });
        return;
      }
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      if (!customerName) {
        sendJson(res, 400, { error: "customerName is required" });
        return;
      }

      const now = new Date();
      const dayDate = new Date(`${day}T00:00:00.000Z`);
      const correction = {
        type: "session_correction",
        correctedAt: now.toISOString(),
        correctedBy,
        day,
        sessionId,
        customerName
      };
      appendSessionCorrection(correction, dayDate);

      sendJson(res, 200, {
        ok: true,
        correctionFile: getSessionCorrectionFileByDay(day),
        correction
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Invalid request body" });
    }
    return;
  }

  if (urlObj.pathname === "/sessions/today") {
    const day = getDateKey(new Date());
    const { file, correctionFile, sessions } = readSessionSummaryByDate(day);
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const filtered = onlyUnrecognized
      ? sessions.filter((session) => session.customerStatus === "unrecognized")
      : sessions;
    sendJson(res, 200, {
      date: day,
      file,
      correctionFile,
      count: filtered.length,
      sessions: filtered
    });
    return;
  }

  if (urlObj.pathname.startsWith("/sessions/")) {
    const day = urlObj.pathname.replace("/sessions/", "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "Invalid date format. Use /sessions/YYYY-MM-DD" });
      return;
    }
    const { file, correctionFile, sessions } = readSessionSummaryByDate(day);
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const filtered = onlyUnrecognized
      ? sessions.filter((session) => session.customerStatus === "unrecognized")
      : sessions;
    sendJson(res, 200, {
      date: day,
      file,
      correctionFile,
      count: filtered.length,
      sessions: filtered
    });
    return;
  }

  if (urlObj.pathname === "/customers/today") {
    const day = getDateKey(new Date());
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const result = readCustomerConversationsByDate(day, { onlyUnrecognized });
    sendJson(res, 200, {
      date: day,
      messageFile: result.messageFile,
      sessionFile: result.sessionFile,
      correctionFile: getSessionCorrectionFileByDay(day),
      count: result.customers.length,
      customers: result.customers
    });
    return;
  }

  if (urlObj.pathname.startsWith("/customers/")) {
    const day = urlObj.pathname.replace("/customers/", "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "Invalid date format. Use /customers/YYYY-MM-DD" });
      return;
    }
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const result = readCustomerConversationsByDate(day, { onlyUnrecognized });
    sendJson(res, 200, {
      date: day,
      messageFile: result.messageFile,
      sessionFile: result.sessionFile,
      correctionFile: getSessionCorrectionFileByDay(day),
      count: result.customers.length,
      customers: result.customers
    });
    return;
  }

  if (urlObj.pathname === "/reports/today/export") {
    const day = getDateKey(new Date());
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const report = buildDailyReportByDate(day, { onlyUnrecognized });
    const format = String(urlObj.searchParams.get("format") || "md").toLowerCase();
    if (format === "md") {
      sendText(res, 200, "text/markdown; charset=utf-8", buildReportMarkdown(report), `daily-report-${day}.md`);
      return;
    }
    if (format === "csv") {
      sendText(res, 200, "text/csv; charset=utf-8", buildReportCsv(report), `daily-report-${day}.csv`);
      return;
    }
    sendJson(res, 400, { error: "Invalid format. Use ?format=md or ?format=csv" });
    return;
  }

  if (urlObj.pathname === "/reports/today") {
    const day = getDateKey(new Date());
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const report = buildDailyReportByDate(day, { onlyUnrecognized });
    sendJson(res, 200, report);
    return;
  }

  if (urlObj.pathname.startsWith("/reports/") && urlObj.pathname.endsWith("/export")) {
    const day = urlObj.pathname.replace("/reports/", "").replace("/export", "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "Invalid date format. Use /reports/YYYY-MM-DD/export" });
      return;
    }
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const report = buildDailyReportByDate(day, { onlyUnrecognized });
    const format = String(urlObj.searchParams.get("format") || "md").toLowerCase();
    if (format === "md") {
      sendText(res, 200, "text/markdown; charset=utf-8", buildReportMarkdown(report), `daily-report-${day}.md`);
      return;
    }
    if (format === "csv") {
      sendText(res, 200, "text/csv; charset=utf-8", buildReportCsv(report), `daily-report-${day}.csv`);
      return;
    }
    sendJson(res, 400, { error: "Invalid format. Use ?format=md or ?format=csv" });
    return;
  }

  if (urlObj.pathname.startsWith("/reports/")) {
    const day = urlObj.pathname.replace("/reports/", "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      sendJson(res, 400, { error: "Invalid date format. Use /reports/YYYY-MM-DD" });
      return;
    }
    const onlyUnrecognized = parseUnrecognizedFilter(urlObj);
    const report = buildDailyReportByDate(day, { onlyUnrecognized });
    sendJson(res, 200, report);
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
    const now = new Date();
    const rawText = raw.toString();
    const text = parseIncomingStt(rawText);
    let session = clientSessions.get(client) || null;
    if (isIntroPhrase(text)) {
      session = createSession(client, "intro_phrase_detected", now);
    } else if (!session) {
      session = createSession(client, "implicit_start", now);
    }

    const detectedName = detectCustomerName(text);
    if (detectedName && session.customerStatus === "unrecognized") {
      session.customerName = detectedName;
      session.customerStatus = "recognized";
      appendSessionEvent({
        type: "customer_detected",
        sessionId: session.sessionId,
        customerName: session.customerName,
        customerStatus: session.customerStatus,
        detectedAt: now.toISOString(),
        sourceText: text,
        client
      }, now);
    }

    session.messageCount += 1;
    session.lastMessageAt = now.toISOString();

    console.log(`[ws-server] message from ${client}: ${text}`);
    appendLog({
      type: "stt",
      loggedAt: now.toISOString(),
      client,
      payload: text,
      session: currentSessionView(session)
    }, now);
    appendSessionEvent({
      type: "message",
      loggedAt: now.toISOString(),
      sessionId: session.sessionId,
      client,
      customerName: session.customerName,
      customerStatus: session.customerStatus
    }, now);

    socket.send(
      JSON.stringify({
        type: "ack",
        receivedAt: now.toISOString(),
        payload: text,
        session: currentSessionView(session)
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
