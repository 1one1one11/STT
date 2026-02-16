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

### 3) Connect from STT page

1. Keep `WebSocket URL` as `ws://localhost:8080`.
2. Click `연결`.
3. Click `인식 시작` and speak.
4. Confirm server logs incoming STT payload.

## Deploy (Render)

1. Push this repo to GitHub.
2. In Render, create `New +` -> `Blueprint`.
3. Select this repo (it will use `render.yaml` automatically).
4. Deploy, then open your Render URL.
5. In page `WebSocket URL`, use:
`wss://<your-render-domain>`
