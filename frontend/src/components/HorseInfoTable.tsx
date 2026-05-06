import { useState, useEffect, useRef, useCallback } from 'react'
import { HorseInfo, HorseInfoResponse } from '../types'
import { apiUrl } from '../config'

interface Props {
  raceNo: number | null
}

const POLL_INTERVAL_MS = 4000

export default function HorseInfoTable({ raceNo }: Props) {
  const [horses, setHorses] = useState<HorseInfo[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastRaceRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const fetchHorseInfo = useCallback(async (race: number) => {
    try {
      const res = await fetch(apiUrl(`/api/races/${race}/horse-info`))
      if (!res.ok) {
        setStatus('error')
        stopPolling()
        return
      }
      const data: HorseInfoResponse = await res.json()
      setStatus(data.status === 'ready' ? 'ready' : 'loading')
      if (data.horses.length > 0) {
        setHorses(data.horses)
      }
      if (data.status === 'ready') {
        stopPolling()
      }
    } catch {
      setStatus('error')
      stopPolling()
    }
  }, [stopPolling])

  useEffect(() => {
    if (raceNo === null) {
      setHorses([])
      setStatus('idle')
      stopPolling()
      return
    }

    if (raceNo !== lastRaceRef.current) {
      lastRaceRef.current = raceNo
      setHorses([])
      setStatus('loading')
      stopPolling()
      fetchHorseInfo(raceNo)
      pollRef.current = setInterval(() => fetchHorseInfo(raceNo), POLL_INTERVAL_MS)
    }

    return () => stopPolling()
  }, [raceNo, fetchHorseInfo, stopPolling])

  if (raceNo === null || status === 'idle') return null

  const thStyle: React.CSSProperties = {
    padding: '8px 10px',
    textAlign: 'left',
    fontSize: 12,
    fontWeight: 600,
    color: '#94a3b8',
    background: '#0f172a',
    borderBottom: '1px solid #334155',
    whiteSpace: 'nowrap',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  }

  const tdStyle: React.CSSProperties = {
    padding: '7px 10px',
    fontSize: 12,
    color: '#e2e8f0',
    borderBottom: '1px solid #1e293b',
    whiteSpace: 'nowrap',
  }

  const tdDimStyle: React.CSSProperties = {
    ...tdStyle,
    color: '#64748b',
  }

  return (
    <section style={{ background: '#1e293b', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #334155',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', margin: 0 }}>
          馬匹資料
        </h2>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          Race #{raceNo} — 田草表現 · MA288評分
        </span>
        {status === 'loading' && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: '#f59e0b',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}>
            <span style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#f59e0b',
              animation: 'pulse 1.4s ease-in-out infinite',
            }} />
            正在載入馬匹資料…
          </span>
        )}
        {status === 'ready' && horses.length > 0 && (
          <button
            onClick={async () => {
              if (!raceNo) return
              setStatus('loading')
              setHorses([])
              await fetch(apiUrl(`/api/races/${raceNo}/horse-info`), { method: 'DELETE' })
              pollRef.current = setInterval(() => fetchHorseInfo(raceNo), POLL_INTERVAL_MS)
            }}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: '1px solid #334155',
              borderRadius: 6,
              padding: '3px 10px',
              color: '#64748b',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            重新載入
          </button>
        )}
        {status === 'error' && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#ef4444' }}>
            載入失敗
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>馬號</th>
              <th style={thStyle}>馬名</th>
              <th style={{ ...thStyle, color: '#60a5fa' }}>MA288評分</th>
              <th style={thStyle}>練馬師</th>
              <th style={thStyle}>騎師</th>
              <th style={{ ...thStyle, color: '#fbbf24' }}>近6次成績</th>
              <th style={{ ...thStyle, color: '#34d399' }}>賽道紀錄</th>
            </tr>
          </thead>
          <tbody>
            {horses.length === 0 && status === 'loading' && (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? '#1e293b' : '#172032' }}>
                  {[30, 80, 35, 60, 60, 80, 200].map((w, j) => (
                    <td key={j} style={tdStyle}>
                      <span style={{
                        display: 'inline-block',
                        width: w,
                        height: 10,
                        borderRadius: 4,
                        background: '#334155',
                        opacity: 0.6,
                      }} />
                    </td>
                  ))}
                </tr>
              ))
            )}
            {horses.map((h, i) => (
              <tr
                key={h.horse_no}
                style={{ background: i % 2 === 0 ? '#1e293b' : '#172032' }}
              >
                <td style={{ ...tdStyle, fontWeight: 700, color: '#93c5fd' }}>
                  #{h.horse_no}
                </td>
                <td style={{ ...tdStyle, fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {h.horse_name}
                  {h.horse_code && (
                    <span style={{ marginLeft: 5, fontSize: 10, color: '#475569' }}>
                      {h.horse_code}
                    </span>
                  )}
                </td>
                <td style={{
                  ...tdStyle,
                  fontWeight: 700,
                  color: h.ma288_score ? '#60a5fa' : '#475569',
                }}>
                  {h.ma288_score || '—'}
                </td>
                <td style={h.trainer ? tdStyle : tdDimStyle}>
                  {h.trainer || '—'}
                </td>
                <td style={h.jockey ? tdStyle : tdDimStyle}>
                  {h.jockey || '—'}
                </td>
                <td style={{
                  ...tdStyle,
                  color: h.recent_results ? '#fbbf24' : '#475569',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '0.03em',
                }}>
                  {h.recent_results || '—'}
                </td>
                <td style={{ ...tdStyle, padding: '4px 10px' }}>
                  {h.distance_summary_html
                    ? <div
                        className="dist-summary-wrap"
                        dangerouslySetInnerHTML={{ __html: h.distance_summary_html }}
                      />
                    : <span style={{ color: '#475569' }}>—</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        /* ── distanceSummary dark-theme styles ── */
        .dist-summary-wrap table.distanceSummary {
          border-collapse: collapse;
          font-size: 11px;
          color: #cbd5e1;
        }
        .dist-summary-wrap table.distanceSummary td {
          padding: 2px 6px;
          vertical-align: middle;
          border: none;
        }
        /* Venue labels (田草 / 谷草) */
        .dist-summary-wrap .venue {
          font-size: 10px;
          font-weight: 700;
          padding: 2px 5px;
          border-radius: 3px;
          white-space: nowrap;
        }
        .dist-summary-wrap .venue.st {
          background: #14532d;
          color: #4ade80;
        }
        .dist-summary-wrap .venue.hv {
          background: #1e3a5f;
          color: #60a5fa;
        }
        /* Distance columns */
        .dist-summary-wrap .head {
          font-size: 10px;
          color: #94a3b8;
          text-align: center;
        }
        .dist-summary-wrap .body {
          font-size: 11px;
          color: #e2e8f0;
          text-align: center;
          font-variant-numeric: tabular-nums;
        }
        /* Condition smallboxes */
        .dist-summary-wrap .smallbox {
          border: 1px solid #334155;
          border-radius: 4px;
          padding: 2px 5px;
          text-align: center;
          min-width: 52px;
        }
        .dist-summary-wrap .head.yield {
          color: #a78bfa;
        }
        .dist-summary-wrap .head.rainning {
          color: #38bdf8;
        }
      `}</style>
    </section>
  )
}
