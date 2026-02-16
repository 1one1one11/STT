const sttStatusEl = document.getElementById("sttStatus");
const wsStatusEl = document.getElementById("wsStatus");
const sessionStatusEl = document.getElementById("sessionStatus");
const finalTextEl = document.getElementById("finalText");
const interimTextEl = document.getElementById("interimText");
const langSelectEl = document.getElementById("langSelect");
const autoNewlineEl = document.getElementById("autoNewline");
const autoSendEl = document.getElementById("autoSend");
const wsUrlEl = document.getElementById("wsUrl");
const wsMessagesEl = document.getElementById("wsMessages");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const sendNowBtn = document.getElementById("sendNowBtn");

const correctionDateEl = document.getElementById("correctionDate");
const loadUnrecognizedBtn = document.getElementById("loadUnrecognizedBtn");
const sessionSelectEl = document.getElementById("sessionSelect");
const correctCustomerNameEl = document.getElementById("correctCustomerName");
const correctedByEl = document.getElementById("correctedBy");
const applyCorrectionBtn = document.getElementById("applyCorrectionBtn");
const correctionStatusEl = document.getElementById("correctionStatus");

const reportDateEl = document.getElementById("reportDate");
const loadReportBtn = document.getElementById("loadReportBtn");
const exportMdBtn = document.getElementById("exportMdBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const reportStatusEl = document.getElementById("reportStatus");
const reportPreviewEl = document.getElementById("reportPreview");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let websocket = null;
let isListening = false;
let shouldKeepListening = false;
let shouldReconnect = true;
let reconnectTimer = null;
let reconnectAttempts = 0;
const WS_MESSAGE_LIMIT = 80;
const MAX_RECONNECT_DELAY_MS = 10000;

function setSttStatus(message) {
  sttStatusEl.textContent = `STT 상태: ${message}`;
}

function setWsStatus(message) {
  wsStatusEl.textContent = `WS 상태: ${message}`;
}

function setCorrectionStatus(message) {
  if (correctionStatusEl) {
    correctionStatusEl.textContent = `보정 상태: ${message}`;
  }
}

function setReportStatus(message) {
  if (reportStatusEl) {
    reportStatusEl.textContent = `리포트 상태: ${message}`;
  }
}

function setSessionStatus(session) {
  if (!session) {
    sessionStatusEl.textContent = "세션 상태: 미인식";
    return;
  }

  const customer = session.customerName || "미인식";
  const status = session.customerStatus || "unrecognized";
  const started = session.startedAt
    ? new Date(session.startedAt).toLocaleString()
    : "-";
  sessionStatusEl.textContent = `세션 상태: ${customer} (${status}) | 시작: ${started}`;
}

function isWsConnected() {
  return websocket && websocket.readyState === WebSocket.OPEN;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function normalizeWsUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    return parsed.toString();
  } catch (_error) {
    return value;
  }
}

function scheduleReconnect() {
  if (!shouldReconnect) return;
  clearReconnectTimer();
  reconnectAttempts += 1;
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
  setWsStatus(`재연결 대기 (${Math.round(delay / 1000)}초)`);
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

function appendWsMessage(line) {
  const current = wsMessagesEl.value ? wsMessagesEl.value.split("\n") : [];
  current.push(line);
  wsMessagesEl.value = current.slice(-WS_MESSAGE_LIMIT).join("\n");
  wsMessagesEl.scrollTop = wsMessagesEl.scrollHeight;
}

function formatWsIncoming(rawData) {
  const now = new Date().toLocaleTimeString();
  try {
    const parsed = JSON.parse(rawData);
    if (parsed.type === "ack") {
      setSessionStatus(parsed.session || null);
      return `[${now}] ACK ${parsed.receivedAt || ""} [고객:${parsed.session?.customerName || "미인식"}] ${String(parsed.payload || "").slice(0, 220)}`;
    }
    if (parsed.type === "welcome") {
      return `[${now}] WELCOME ${parsed.message || ""}`;
    }
    return `[${now}] JSON ${JSON.stringify(parsed)}`;
  } catch (_error) {
    return `[${now}] TEXT ${String(rawData)}`;
  }
}

function updateButtons() {
  startBtn.disabled = !recognition || isListening;
  stopBtn.disabled = !recognition || !isListening;
  connectBtn.disabled = isWsConnected();
  disconnectBtn.disabled = !isWsConnected();
  sendNowBtn.disabled = !isWsConnected() || !finalTextEl.value.trim();
}

function appendFinalText(text) {
  if (!text) return;
  const separator = autoNewlineEl.checked ? "\n" : " ";
  const trimmedCurrent = finalTextEl.value.trim();
  finalTextEl.value = trimmedCurrent ? `${trimmedCurrent}${separator}${text}` : text;
  sendNowBtn.disabled = !isWsConnected();
}

function sendWsPayload(text) {
  if (!isWsConnected()) return false;
  const payload = {
    type: "stt",
    text,
    lang: langSelectEl.value,
    createdAt: new Date().toISOString()
  };
  websocket.send(JSON.stringify(payload));
  return true;
}

function connectWebSocket() {
  const url = normalizeWsUrl(wsUrlEl.value);
  if (!url) {
    setWsStatus("URL을 입력하세요");
    return;
  }
  wsUrlEl.value = url;
  clearReconnectTimer();

  try {
    websocket = new WebSocket(url);
  } catch (error) {
    setWsStatus(`연결 실패 (${error.message})`);
    websocket = null;
    updateButtons();
    return;
  }

  setWsStatus("연결 시도 중...");
  updateButtons();

  websocket.onopen = () => {
    reconnectAttempts = 0;
    setWsStatus(`연결됨 (${url})`);
    setSessionStatus(null);
    appendWsMessage(`[${new Date().toLocaleTimeString()}] WS 연결됨`);
    updateButtons();
  };

  websocket.onmessage = (event) => {
    appendWsMessage(formatWsIncoming(event.data));
  };

  websocket.onclose = (event) => {
    const code = event && event.code ? event.code : "-";
    setWsStatus(`연결 종료 (code:${code})`);
    setSessionStatus(null);
    appendWsMessage(`[${new Date().toLocaleTimeString()}] WS 연결 종료 (code:${code})`);
    websocket = null;
    updateButtons();
    scheduleReconnect();
  };

  websocket.onerror = (event) => {
    const detail = event && event.message ? event.message : "서버 상태/URL 확인";
    setWsStatus(`오류 발생 (${detail})`);
    appendWsMessage(`[${new Date().toLocaleTimeString()}] WS 오류 (${detail})`);
    updateButtons();
  };
}

function disconnectWebSocket() {
  shouldReconnect = false;
  clearReconnectTimer();
  if (!websocket) return;
  websocket.close();
}

function initRecognition() {
  if (!SpeechRecognition) {
    setSttStatus("이 브라우저는 Web Speech API를 지원하지 않습니다 (Chrome 권장)");
    startBtn.disabled = true;
    stopBtn.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = langSelectEl.value;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isListening = true;
    setSttStatus("듣는 중");
    updateButtons();
  };

  recognition.onend = () => {
    isListening = false;
    if (shouldKeepListening) {
      setSttStatus("대기 중 (자동 재시작)");
      setTimeout(() => {
        if (!recognition || isListening || !shouldKeepListening) return;
        try {
          recognition.start();
        } catch (_error) {
          // 브라우저 상태에 따라 start 예외가 날 수 있어 다음 end 주기에서 재시도
        }
      }, 250);
    } else {
      setSttStatus("중지됨");
    }
    updateButtons();
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") {
      shouldKeepListening = false;
    }
    setSttStatus(`오류 (${event.error})`);
    updateButtons();
  };

  recognition.onresult = (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript.trim();
      if (!transcript) continue;

      if (event.results[i].isFinal) {
        appendFinalText(transcript);
        if (autoSendEl.checked) {
          const sent = sendWsPayload(transcript);
          if (!sent && isWsConnected()) {
            setWsStatus("전송 실패");
          }
        }
      } else {
        interim += `${transcript} `;
      }
    }

    interimTextEl.value = interim.trim();
    updateButtons();
  };

  updateButtons();
}

function toYmd(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function getApiBaseUrl() {
  const raw = wsUrlEl.value.trim();
  if (!raw) return window.location.origin;

  try {
    const url = new URL(raw);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (_error) {
    return window.location.origin;
  }
}

async function fetchJson(path, options) {
  const response = await fetch(`${getApiBaseUrl()}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json();
}

function setSessionOptions(sessions) {
  if (!sessionSelectEl) return;
  sessionSelectEl.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "미인식 세션 없음";
    sessionSelectEl.appendChild(empty);
    applyCorrectionBtn.disabled = true;
    return;
  }

  sessions.forEach((session) => {
    const option = document.createElement("option");
    option.value = session.sessionId;
    const started = session.startedAt ? new Date(session.startedAt).toLocaleString() : "-";
    option.textContent = `${session.sessionId} | ${session.customerName} | 시작:${started}`;
    sessionSelectEl.appendChild(option);
  });

  applyCorrectionBtn.disabled = false;
}

async function loadUnrecognizedSessions() {
  const day = correctionDateEl.value || toYmd();
  setCorrectionStatus("조회 중...");

  try {
    const data = await fetchJson(`/sessions/${day}?status=unrecognized`);
    setSessionOptions(data.sessions || []);
    setCorrectionStatus(`조회 완료 (${data.count || 0}건)`);
  } catch (error) {
    setCorrectionStatus(`조회 실패 (${error.message})`);
  }
}

async function applyCorrection() {
  const day = correctionDateEl.value || toYmd();
  const sessionId = sessionSelectEl.value;
  const customerName = correctCustomerNameEl.value.trim();
  const correctedBy = correctedByEl.value.trim() || "manual";

  if (!sessionId) {
    setCorrectionStatus("보정할 세션을 선택하세요");
    return;
  }
  if (!customerName) {
    setCorrectionStatus("고객명을 입력하세요");
    return;
  }

  setCorrectionStatus("저장 중...");

  try {
    await fetchJson("/sessions/correct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: day, sessionId, customerName, correctedBy })
    });
    setCorrectionStatus(`보정 완료 (${customerName})`);
    correctCustomerNameEl.value = "";
    await loadUnrecognizedSessions();
    await loadReport();
  } catch (error) {
    setCorrectionStatus(`보정 실패 (${error.message})`);
  }
}

function renderReportText(report) {
  if (!report || !Array.isArray(report.reports)) return "";
  const lines = [`[${report.date}] 고객별 영업일지 초안`, ""];

  report.reports.forEach((item, index) => {
    lines.push(`${index + 1}. 고객: ${item.customerName} (${item.customerStatus})`);
    lines.push(`통화 시작: ${item.firstStartedAt || "-"}`);
    lines.push(`영업 내용: ${item.draft.salesContent || "-"}`);
    lines.push(`고객 반응: ${item.draft.customerReaction || "-"}`);
    lines.push(`향후 계획: ${item.draft.nextPlan || "-"}`);
    lines.push("");
  });

  return lines.join("\n");
}

async function loadReport() {
  const day = reportDateEl.value || toYmd();
  setReportStatus("조회 중...");

  try {
    const report = await fetchJson(`/reports/${day}`);
    reportPreviewEl.value = renderReportText(report);
    setReportStatus(`조회 완료 (${report.count || 0}명)`);
  } catch (error) {
    setReportStatus(`조회 실패 (${error.message})`);
  }
}

async function exportReport(format) {
  const day = reportDateEl.value || toYmd();
  const url = `${getApiBaseUrl()}/reports/${day}/export?format=${format}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    const ext = format === "csv" ? "csv" : "md";
    link.href = URL.createObjectURL(blob);
    link.download = `daily-report-${day}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    setReportStatus(`${format.toUpperCase()} 내보내기 완료`);
  } catch (error) {
    setReportStatus(`내보내기 실패 (${error.message})`);
  }
}

const suggestedWsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
if (!wsUrlEl.value.trim() || wsUrlEl.value.trim() === "ws://localhost:8080") {
  wsUrlEl.value = suggestedWsUrl;
}

if (correctionDateEl) correctionDateEl.value = toYmd();
if (reportDateEl) reportDateEl.value = toYmd();

startBtn.addEventListener("click", () => {
  if (!recognition) return;
  shouldKeepListening = true;
  recognition.lang = langSelectEl.value;
  try {
    recognition.start();
  } catch (_error) {
    setSttStatus("이미 시작됨");
  }
});

stopBtn.addEventListener("click", () => {
  if (!recognition) return;
  shouldKeepListening = false;
  recognition.stop();
});

clearBtn.addEventListener("click", () => {
  finalTextEl.value = "";
  interimTextEl.value = "";
  updateButtons();
});

saveBtn.addEventListener("click", () => {
  const text = finalTextEl.value.trim();
  if (!text) {
    setSttStatus("저장할 텍스트가 없습니다");
    return;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = URL.createObjectURL(blob);
  link.download = `stt-${now}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
  setSttStatus("텍스트 저장 완료");
});

connectBtn.addEventListener("click", connectWebSocket);
disconnectBtn.addEventListener("click", disconnectWebSocket);

sendNowBtn.addEventListener("click", () => {
  const text = finalTextEl.value.trim();
  if (!text) {
    setWsStatus("전송할 확정 텍스트가 없습니다");
    return;
  }
  const sent = sendWsPayload(text);
  if (sent) {
    setWsStatus("확정 텍스트 전송 완료");
    appendWsMessage(`[${new Date().toLocaleTimeString()}] 전송 ${text.slice(0, 100)}`);
  } else {
    setWsStatus("전송 실패 (연결 확인)");
  }
});

langSelectEl.addEventListener("change", () => {
  if (!recognition || isListening) return;
  recognition.lang = langSelectEl.value;
});

if (loadUnrecognizedBtn) {
  loadUnrecognizedBtn.addEventListener("click", loadUnrecognizedSessions);
}

if (applyCorrectionBtn) {
  applyCorrectionBtn.addEventListener("click", applyCorrection);
}

if (loadReportBtn) {
  loadReportBtn.addEventListener("click", loadReport);
}

if (exportMdBtn) {
  exportMdBtn.addEventListener("click", () => exportReport("md"));
}

if (exportCsvBtn) {
  exportCsvBtn.addEventListener("click", () => exportReport("csv"));
}

window.addEventListener("beforeunload", () => {
  shouldKeepListening = false;
  shouldReconnect = false;
  clearReconnectTimer();
  if (recognition && isListening) recognition.stop();
  if (websocket) websocket.close();
});

initRecognition();
updateButtons();
loadUnrecognizedSessions();
loadReport();

shouldReconnect = true;
connectWebSocket();
