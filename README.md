# Bet Tracker Web App

Real-time Hong Kong horse-racing live-bet tracker for `racing.stheadline.com` (大票房).

- **Backend** — FastAPI + Playwright (headless Chromium) + SQLite + APScheduler
- **Frontend** — React + Vite + Recharts, with a WebSocket live feed

## Local development

### Backend
```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
uvicorn backend.main:app --reload --port 8000   # run from repo root
```

### Frontend
```bash
cd frontend
npm install
npm run dev    # http://localhost:5173 with /api and /ws proxied to :8000
```

## Production deployment

The recommended split is **frontend on Vercel (free) + backend on a small VM**.
The backend can't be hosted on Vercel because it depends on a long-running
Playwright browser, an APScheduler poll loop, persistent WebSocket connections,
and a SQLite file — none of which fit Vercel's serverless model.

### Backend → Hetzner CPX11 (or any 2 GB Linux VM)

The whole backend ships as one Docker container based on the official
Playwright image, so there's nothing to install on the host except Docker.

```bash
# On a fresh VM (Ubuntu 22.04+):
curl -fsSL https://get.docker.com | sh

git clone https://github.com/felix123recreate/bet-tracker-web-app.git
cd bet-tracker-web-app
docker compose up -d --build
```

The container exposes port `8000`. Put a reverse proxy (Caddy / nginx / Traefik)
in front of it for HTTPS — Caddy is simplest:

```
api.example.com {
    reverse_proxy localhost:8000
}
```

`./data` and `./backend/data` are bind-mounted, so the SQLite DB and your
edited `sources.json` survive `docker compose down`.

To redeploy after a `git pull`:
```bash
docker compose up -d --build
```

### Frontend → Vercel

1. **Import** `felix123recreate/bet-tracker-web-app` in the Vercel dashboard.
2. **Root directory**: `frontend`.
3. **Build settings** are picked up from `frontend/vercel.json` automatically
   (Vite framework, `npm run build`, `dist` output).
4. **Environment variable** — add a single one:
   - `VITE_API_BASE_URL` = `https://api.example.com`  *(your backend URL,
     no trailing slash)*
5. Deploy.

The frontend reads `VITE_API_BASE_URL` at build time (see
[`frontend/src/config.ts`](frontend/src/config.ts)) and uses it for both
HTTP fetches and the WebSocket connection (`http→ws` / `https→wss`).

### Backend CORS

`backend/main.py` currently sets `allow_origins=["*"]`, which works out of the
box. Once you have a production frontend URL, tighten it to
`["https://your-vercel-domain.vercel.app"]`.

## Repo layout

```
backend/           FastAPI app + Playwright scrapers
  Dockerfile       Production container
  data/            horse.rtf lookup table (committed)
                   sources.json (runtime, gitignored)
frontend/          Vite + React app
  vercel.json      Vercel build config
  .env.example     VITE_API_BASE_URL template
docker-compose.yml Backend stack for the VM
data/              SQLite database (runtime, gitignored)
```
