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

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let websocket = null;
let isListening = false;
const WS_MESSAGE_LIMIT = 80;

function setSttStatus(message) {
  sttStatusEl.textContent = `STT 상태: ${message}`;
}

function setWsStatus(message) {
  wsStatusEl.textContent = `WS 상태: ${message}`;
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
  const url = wsUrlEl.value.trim();
  if (!url) {
    setWsStatus("URL을 입력하세요");
    return;
  }

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
    setWsStatus(`연결됨 (${url})`);
    setSessionStatus(null);
    appendWsMessage(`[${new Date().toLocaleTimeString()}] WS 연결됨`);
    updateButtons();
  };

  websocket.onmessage = (event) => {
    appendWsMessage(formatWsIncoming(event.data));
  };

  websocket.onclose = () => {
    setWsStatus("연결 종료");
    setSessionStatus(null);
    appendWsMessage(`[${new Date().toLocaleTimeString()}] WS 연결 종료`);
    websocket = null;
    updateButtons();
  };

  websocket.onerror = () => {
    setWsStatus("오류 발생");
    appendWsMessage(`[${new Date().toLocaleTimeString()}] WS 오류`);
    updateButtons();
  };
}

function disconnectWebSocket() {
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
    setSttStatus("중지됨");
    updateButtons();
  };

  recognition.onerror = (event) => {
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

const suggestedWsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
if (!wsUrlEl.value.trim() || wsUrlEl.value.trim() === "ws://localhost:8080") {
  wsUrlEl.value = suggestedWsUrl;
}

startBtn.addEventListener("click", () => {
  if (!recognition) return;
  recognition.lang = langSelectEl.value;
  try {
    recognition.start();
  } catch (_error) {
    setSttStatus("이미 시작됨");
  }
});

stopBtn.addEventListener("click", () => {
  if (!recognition) return;
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

window.addEventListener("beforeunload", () => {
  if (recognition && isListening) recognition.stop();
  if (websocket) websocket.close();
});

initRecognition();
updateButtons();
