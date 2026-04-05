# Hosting Guide (Vercel + Railway)

This project runs three services:

1. Frontend (Vite static build)
2. Backend API (`/agent/turn`, `/media/requests/:id/status`, `/voice/room`)
3. Sync WebSocket server (room actions + chat + presence)

## 1) Deploy frontend to Vercel

- Root directory: `app/frontend`
- Build command: `pnpm --filter @ai-canvas/frontend build`
- Output directory: `app/frontend/dist`

Set frontend env vars in Vercel:

- `VITE_BACKEND_URL=https://<your-backend-service>.up.railway.app`
- `VITE_SYNC_URL=wss://<your-sync-service>.up.railway.app`

## 2) Deploy backend to Railway

- Root directory: `app/backend`
- Start command: `pnpm --filter @ai-canvas/backend start`
- Build command: `pnpm run build`

Set backend env vars in Railway:

- `PORT` (Railway sets this automatically)
- `GEMINI_API_KEY=<your-gemini-key>`
- `DAILY_API_KEY=<your-daily-key>`
- Optional: `AGENT_MIN_TURN_INTERVAL_MS=5000`
- Optional: `AGENT_MAX_ACTIONS_PER_TURN=50`

Health check path:

- `/health`

## 3) Deploy sync server to Railway

- Root directory: `app/sync-server`
- Start command: `pnpm --filter @ai-canvas/sync-server start`
- Build command: `pnpm run build`

Set sync env vars in Railway:

- `PORT` (Railway sets this automatically)

## 4) Daily voice setup

- Create API key in Daily dashboard.
- Put `DAILY_API_KEY` in backend service env vars.
- Frontend calls backend `POST /voice/room` to receive Daily room URL + token.

## 5) Smoke test after deploy

1. Open the Vercel URL in two browsers with same `?room=demo-room`.
2. Confirm both users see canvas changes in real time.
3. Send normal chat message and confirm both users receive it.
4. Send `@agent summarize this` and confirm AI runs once.
5. Join voice on both clients and confirm two-way audio.

## Notes

- Open-by-link room access is enabled for MVP.
- For stricter access control later, add auth before join/chat/agent endpoints.
