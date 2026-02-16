A simple HTML/JS/CSS starter template

## Realtime STT + WebSocket Test Server

### 1) Start app (web + WebSocket on one port)

```bash
npm install
npm run ws:server
```

Open:

- `http://localhost:8080`

Health check:

- `http://localhost:8080/health`
- Daily log file (default): `logs/stt-messages-YYYY-MM-DD.ndjson`
- Custom log file: `LOG_FILE=/path/to/file.ndjson npm run ws:server`

Logs API:

- `http://localhost:8080/logs` (log files list)
- `http://localhost:8080/logs/latest?limit=100` (latest file entries)
- `http://localhost:8080/logs/YYYY-MM-DD?limit=200` (entries by date)
- `http://localhost:8080/sessions/today` (고객 인식 세션 요약)
- `http://localhost:8080/sessions/today?status=unrecognized` (오늘 미인식 세션만)
- `http://localhost:8080/sessions/YYYY-MM-DD` (날짜별 세션 요약)
- `http://localhost:8080/sessions/YYYY-MM-DD?status=unrecognized` (미인식만 조회)
- `http://localhost:8080/customers/today` (고객별 대화 묶음 + 시작 시각)
- `http://localhost:8080/customers/YYYY-MM-DD?status=unrecognized` (날짜별 고객 대화, 미인식 필터)
- `http://localhost:8080/reports/today` (고객별 영업일지 초안: 영업 내용/고객 반응/향후 계획)
- `http://localhost:8080/reports/YYYY-MM-DD` (날짜별 영업일지 초안)

Manual correction API (미인식 수기 보정):

```bash
curl -X POST http://localhost:8080/sessions/correct \
  -H "content-type: application/json" \
  -d '{
    "date":"2026-02-16",
    "sessionId":"2026-02-16-1771245103174-7droiz",
    "customerName":"홍길동",
    "correctedBy":"seo.pb"
  }'
```

### 3) Connect from STT page

1. Keep `WebSocket URL` as `ws://localhost:8080`.
2. Click `연결`.
3. Click `인식 시작` and speak.
4. Confirm server logs incoming STT payload.

Customer recognition rule:

- 통화 시작 멘트로 `신한투자증권 서인원입니다`를 감지하면 새 세션 시작
- `홍길동 고객님`, `김신한 고객님 맞으신가요` 형태를 고객명으로 인식
- 이름 미인식 시 `미인식` 상태로 세션 유지

## Deploy (Render)

1. Push this repo to GitHub.
2. In Render, create `New +` -> `Blueprint`.
3. Select this repo (it will use `render.yaml` automatically).
4. Deploy, then open your Render URL.
5. In page `WebSocket URL`, use:
`wss://<your-render-domain>`
