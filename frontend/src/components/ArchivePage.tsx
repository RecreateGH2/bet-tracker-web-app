import { useEffect, useState } from 'react'
import { apiUrl } from '../config'
import { ArchivedRace } from '../types'

const fmtK = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v}`
const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'

export default function ArchivePage() {
  const [races, setRaces] = useState<ArchivedRace[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openRace, setOpenRace] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const res = await fetch(apiUrl('/api/races/archive'))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!cancelled) setRaces(json.races)
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'failed to load')
      }
    }
    fetchOnce()
    const t = setInterval(fetchOnce, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  if (error) return <div style={{ padding: 40, color: '#ef4444' }}>Error: {error}</div>
  if (races === null) return <div style={{ padding: 40, color: '#64748b' }}>Loading archive…</div>
  if (races.length === 0) {
    return (
      <div style={{ padding: 40, color: '#64748b', textAlign: 'center' }}>
        No finished races yet. As races end (start_time + 5 min), their final aggregates appear here.
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', marginBottom: 16 }}>
        Final Results Archive
      </h2>
      <div style={{ display: 'grid', gap: 14 }}>
        {races.map(r => {
          const open = openRace === r.race_no
          const topHorses = [...r.aggregates]
            .filter(a => !a.horse_number.includes('-'))
            .sort((a, b) => b.total_win_amount + b.total_place_amount - (a.total_win_amount + a.total_place_amount))
          const total = topHorses.reduce((s, h) => s + h.total_win_amount + h.total_place_amount, 0)
          return (
            <section key={r.race_no} style={{
              background: '#1e293b', borderRadius: 8, border: '1px solid #334155',
              overflow: 'hidden',
            }}>
              <button
                onClick={() => setOpenRace(open ? null : r.race_no)}
                style={{
                  width: '100%', textAlign: 'left', padding: '12px 16px',
                  background: 'none', border: 'none', color: '#e2e8f0',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 16,
                }}
              >
                <span style={{ fontSize: 16, fontWeight: 700, color: '#93c5fd', minWidth: 50 }}>
                  R{r.race_no}
                </span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>
                  Off {fmtTime(r.start_time)} · Ended {fmtTime(r.ended_at)}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#cbd5e1' }}>
                  Total HK${total.toLocaleString()} · {topHorses.length} horses
                </span>
                <span style={{ fontSize: 18, color: '#64748b' }}>{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div style={{ borderTop: '1px solid #334155', padding: 8 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#94a3b8' }}>
                        <th style={{ textAlign: 'left', padding: '6px 8px' }}>Horse</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>Win HK$</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>Place HK$</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>Total</th>
                        <th style={{ textAlign: 'right', padding: '6px 8px' }}>Win %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topHorses.map(h => (
                        <tr key={h.horse_number} style={{ borderTop: '1px solid #1e293b' }}>
                          <td style={{ padding: '6px 8px', color: '#93c5fd', fontWeight: 700 }}>
                            #{h.horse_number} {h.horse_name ?? ''}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#60a5fa' }}>
                            {fmtK(h.total_win_amount)}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#22c55e' }}>
                            {fmtK(h.total_place_amount)}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#e2e8f0', fontWeight: 600 }}>
                            {fmtK(h.total_win_amount + h.total_place_amount)}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>
                            {h.win_share_pct?.toFixed?.(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
