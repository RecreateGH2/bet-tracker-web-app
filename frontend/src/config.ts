// API base URL.
//
//   • In dev: VITE_API_BASE_URL is unset → calls go through Vite's /api proxy
//     (configured in vite.config.ts) and the WebSocket connects to the same
//     origin.
//   • In prod (Vercel): set VITE_API_BASE_URL to the backend's public URL,
//     e.g. https://bet-tracker-api.example.com — the frontend then calls the
//     backend directly (CORS is open in backend/main.py).

const RAW = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
export const API_BASE = RAW.replace(/\/$/, '')

export const apiUrl = (path: string): string => `${API_BASE}${path}`

export const wsUrl = (path: string = '/ws'): string => {
  if (API_BASE) {
    return API_BASE.replace(/^http/, 'ws') + path
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${path}`
}
