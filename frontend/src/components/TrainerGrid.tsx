import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MeetingHorse, TrainerGridResponse } from '../types'
import { apiUrl } from '../config'

// Used only while the initial scrape is still running on the backend.
const LOADING_POLL_MS = 4000

// 8 base hues × 5 patterns = 40 visually distinct combinations
const COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#a855f7', '#06b6d4', '#ec4899', '#84cc16',
]
const PATTERNS = ['solid', 'diag', 'diag-rev', 'horiz', 'dots'] as const
type Pattern = typeof PATTERNS[number]

// Stable hash of a string
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Darken a hex color by mixing with #000
function darken(hex: string, amt = 0.35): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.round(((n >> 16) & 0xff) * (1 - amt))
  const g = Math.round(((n >> 8) & 0xff) * (1 - amt))
  const b = Math.round((n & 0xff) * (1 - amt))
  return `rgb(${r},${g},${b})`
}

interface Style { color: string; pattern: Pattern; bg: string }

function jockeyStyle(jockey: string): Style {
  if (!jockey) return { color: '#475569', pattern: 'solid', bg: '#475569' }
  const h = hash(jockey)
  const color = COLORS[h % COLORS.length]
  const pattern = PATTERNS[Math.floor(h / COLORS.length) % PATTERNS.length]
  const dark = darken(color, 0.35)
  let bg: string
  switch (pattern) {
    case 'diag':
      bg = `repeating-linear-gradient(45deg, ${color} 0 5px, ${dark} 5px 9px)`
      break
    case 'diag-rev':
      bg = `repeating-linear-gradient(-45deg, ${color} 0 5px, ${dark} 5px 9px)`
      break
    case 'horiz':
      bg = `repeating-linear-gradient(0deg, ${color} 0 4px, ${dark} 4px 7px)`
      break
    case 'dots':
      bg = `radial-gradient(${dark} 1.6px, ${color} 1.8px) 0 0 / 6px 6px`
      break
    default:
      bg = color
  }
  return { color, pattern, bg }
}

function labelFor(h: MeetingHorse): { text: string; color: string } | null {
  if (h.finish_position === 1) return { text: 'W', color: '#22c55e' }
  if (h.finish_position === 2 || h.finish_position === 3) return { text: 'Q', color: '#3b82f6' }
  if (h.is_favorite) return { text: 'F', color: '#f59e0b' }
  return null
}

interface Props {
  // Bumped by the parent whenever a race finishes (e.g. on race_changed WS event).
  refreshSignal?: number
}

export default function TrainerGrid({ refreshSignal = 0 }: Props) {
  const [data, setData] = useState<TrainerGridResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [selJockeys, setSelJockeys] = useState<Set<string>>(new Set())
  const [selTrainers, setSelTrainers] = useState<Set<string>>(new Set())

  // Tracks whether a poll loop is currently waiting for the backend to finish
  // its initial scrape — used to avoid stacking timers across renders.
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearLoadingTimer = () => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current)
      loadingTimerRef.current = null
    }
  }

  // Single fetch — if backend reports "loading", queues a follow-up until ready.
  // No timer-based renewal once data is "ready"; refresh only happens via
  // the manual button or a parent-driven `refreshSignal` change.
  const fetchOnce = useCallback(async (force = false): Promise<void> => {
    try {
      if (force) {
        await fetch(apiUrl('/api/meeting/trainer-grid'), { method: 'DELETE' })
      }
      const res = await fetch(apiUrl('/api/meeting/trainer-grid'))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: TrainerGridResponse = await res.json()
      setData(json)
      setError(null)
      clearLoadingTimer()
      if (json.status === 'loading') {
        loadingTimerRef.current = setTimeout(() => fetchOnce(false), LOADING_POLL_MS)
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load')
      clearLoadingTimer()
      loadingTimerRef.current = setTimeout(() => fetchOnce(false), 8000)
    }
  }, [])

  // Initial mount
  useEffect(() => {
    fetchOnce(false)
    return clearLoadingTimer
  }, [fetchOnce])

  // Race-finished signal from parent → force a fresh scrape
  useEffect(() => {
    if (refreshSignal > 0) fetchOnce(true)
  }, [refreshSignal, fetchOnce])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await fetchOnce(true)
    } finally {
      setRefreshing(false)
    }
  }

  const toggleSet = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    next.has(key) ? next.delete(key) : next.add(key)
    setter(next)
  }
  const clearAll = () => { setSelJockeys(new Set()); setSelTrainers(new Set()) }

  // Build derived structures
  const { trainers, jockeys, races, grid } = useMemo(() => {
    const trainerSet = new Set<string>()
    const jockeySet = new Set<string>()
    const races: number[] = []
    const grid = new Map<string, Map<number, MeetingHorse[]>>()
    if (data?.summary) {
      for (const r of data.summary.races) {
        races.push(r.race_no)
        for (const h of r.horses) {
          if (h.trainer) trainerSet.add(h.trainer)
          if (h.jockey) jockeySet.add(h.jockey)
          if (!h.trainer) continue
          if (!grid.has(h.trainer)) grid.set(h.trainer, new Map())
          const inner = grid.get(h.trainer)!
          if (!inner.has(r.race_no)) inner.set(r.race_no, [])
          inner.get(r.race_no)!.push(h)
        }
      }
    }
    return {
      trainers: Array.from(trainerSet).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
      jockeys: Array.from(jockeySet).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
      races,
      grid,
    }
  }, [data])

  const filtering = selJockeys.size > 0 || selTrainers.size > 0

  const isMatch = (h: MeetingHorse) => {
    if (!filtering) return false
    const jOk = selJockeys.size === 0 || selJockeys.has(h.jockey)
    const tOk = selTrainers.size === 0 || selTrainers.has(h.trainer)
    return jOk && tOk
  }

  // Track which trainer rows have any matching horse — for the dotted alignment line
  const rowHasMatch = useMemo(() => {
    const out = new Set<string>()
    if (!filtering) return out
    for (const tr of trainers) {
      const inner = grid.get(tr)
      if (!inner) continue
      for (const horses of inner.values()) {
        if (horses.some(isMatch)) { out.add(tr); break }
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, trainers, filtering, selJockeys, selTrainers])

  // ── Styles ───────────────────────────────────────────────────────────────
  const headerStyle: React.CSSProperties = {
    padding: '12px 16px',
    borderBottom: '1px solid #334155',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  }
  const thStyle: React.CSSProperties = {
    padding: '10px 8px', fontSize: 14, fontWeight: 700, color: '#cbd5e1',
    background: '#0f172a', borderBottom: '2px solid #334155',
    borderRight: '1px solid #1e293b',
    position: 'sticky', top: 0, zIndex: 1, minWidth: 160, whiteSpace: 'nowrap',
  }
  const trainerHeaderStyle: React.CSSProperties = {
    ...thStyle, textAlign: 'left', paddingLeft: 12, minWidth: 130,
    position: 'sticky', left: 0, zIndex: 2,
  }

  return (
    <section style={{ background: '#1e293b', borderRadius: 8, overflow: 'hidden' }}>
      <div style={headerStyle}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', margin: 0 }}>
          Trainer × Race Grid
        </h2>
        {data?.summary && (
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {data.summary.race_date} · {data.summary.venue_name} · {data.summary.total_races} races
          </span>
        )}
        {data?.status === 'loading' && (
          <span style={{ fontSize: 11, color: '#f59e0b' }}>Loading…</span>
        )}
        {error && <span style={{ fontSize: 11, color: '#ef4444' }}>{error}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
          <Legend />
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              background: 'none', border: '1px solid #334155', borderRadius: 6,
              padding: '4px 12px', color: '#94a3b8', fontSize: 11,
              cursor: refreshing ? 'wait' : 'pointer', opacity: refreshing ? 0.5 : 1,
            }}
          >
            {refreshing ? '…' : '↺ Refresh'}
          </button>
        </span>
      </div>

      {/* ── Index / selectable jockeys & trainers ───────────────────────── */}
      {data?.summary && (
        <div style={{
          padding: '10px 16px',
          background: '#172032',
          borderBottom: '1px solid #334155',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <IndexRow
            label="騎師"
            items={jockeys}
            selected={selJockeys}
            onToggle={k => toggleSet(selJockeys, k, setSelJockeys)}
            renderSwatch={j => <Swatch style={jockeyStyle(j)} />}
          />
          <IndexRow
            label="練馬師"
            items={trainers}
            selected={selTrainers}
            onToggle={k => toggleSet(selTrainers, k, setSelTrainers)}
          />
          {filtering && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>
                {selJockeys.size + selTrainers.size} selected — matching horses outlined with dashed line
              </span>
              <button
                onClick={clearAll}
                style={{
                  background: '#dc2626', color: '#fff', border: 'none',
                  borderRadius: 4, padding: '2px 10px', fontSize: 10,
                  fontWeight: 700, cursor: 'pointer',
                }}
              >Clear</button>
            </div>
          )}
        </div>
      )}

      {!data?.summary ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#475569', fontSize: 13 }}>
          {data?.status === 'loading' ? 'Loading meeting data…' : 'No meeting data'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={trainerHeaderStyle}>練馬師</th>
                {races.map(rn => <th key={rn} style={thStyle}>R{rn}</th>)}
              </tr>
            </thead>
            <tbody>
              {trainers.map((tr, i) => {
                const rowMatched = rowHasMatch.has(tr)
                const trainerSelected = selTrainers.has(tr)
                const baseBg = i % 2 === 0 ? '#1e293b' : '#172032'
                const stickyBg = i % 2 === 0 ? '#0f172a' : '#0a1326'
                return (
                  <tr key={tr} style={{ background: baseBg, position: 'relative' }}>
                    <td
                      onClick={() => toggleSet(selTrainers, tr, setSelTrainers)}
                      style={{
                        padding: '8px 12px', fontSize: 14, fontWeight: 600,
                        color: trainerSelected ? '#fbbf24' : '#e2e8f0',
                        background: stickyBg,
                        borderBottom: '1px solid #1e293b',
                        borderRight: '1px solid #334155',
                        position: 'sticky', left: 0, whiteSpace: 'nowrap',
                        minWidth: 130, cursor: 'pointer',
                        outline: trainerSelected ? '2px dashed #fbbf24' : 'none',
                        outlineOffset: -2,
                      }}
                    >
                      {tr}
                    </td>
                    {races.map(rn => {
                      const horses = grid.get(tr)?.get(rn) ?? []
                      return (
                        <td key={rn} style={{
                          padding: 5,
                          borderBottom: '1px solid #1e293b',
                          borderRight: '1px solid #1e293b',
                          verticalAlign: 'top', minWidth: 160,
                          position: 'relative',
                          // dotted alignment line across all cells in a matching row
                          backgroundImage: rowMatched
                            ? 'linear-gradient(to right, transparent 0, transparent 6px, #fbbf24 6px, #fbbf24 10px, transparent 10px)'
                            : 'none',
                          backgroundSize: rowMatched ? '14px 1px' : undefined,
                          backgroundRepeat: rowMatched ? 'repeat-x' : undefined,
                          backgroundPosition: rowMatched ? 'left center' : undefined,
                        }}>
                          {horses.map(h => (
                            <HorseChip
                              key={h.horse_no}
                              horse={h}
                              filtering={filtering}
                              match={isMatch(h)}
                            />
                          ))}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function HorseChip({ horse, filtering, match }: {
  horse: MeetingHorse
  filtering: boolean
  match: boolean
}) {
  const style = jockeyStyle(horse.jockey)
  const lbl = labelFor(horse)
  const dim = filtering && !match
  return (
    <div
      title={`#${horse.horse_no} ${horse.horse_name} — 練馬師 ${horse.trainer} / 騎師 ${horse.jockey}`}
      style={{
        background: style.bg,
        color: '#fff',
        borderRadius: 6,
        padding: '5px 8px',
        fontSize: 13,
        marginBottom: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        lineHeight: 1.25,
        position: 'relative',
        textShadow: '0 0 2px rgba(0,0,0,0.7)',
        opacity: dim ? 0.18 : 1,
        outline: match ? '2px dashed #fbbf24' : 'none',
        outlineOffset: 1,
        boxShadow: match ? '0 0 0 2px #1e293b' : 'none',
        transition: 'opacity 0.15s, outline-color 0.15s',
      }}
    >
      <span style={{ fontWeight: 700, opacity: 0.9 }}>#{horse.horse_no}</span>
      <span style={{
        flex: 1, fontWeight: 600, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {horse.horse_name}
      </span>
      {lbl && (
        <span style={{
          background: lbl.color, color: '#0f172a',
          fontSize: 12, fontWeight: 800, borderRadius: 3,
          padding: '0 5px', lineHeight: '16px',
          minWidth: 16, textAlign: 'center',
        }}>{lbl.text}</span>
      )}
      <span style={{ fontSize: 12, opacity: 0.95, whiteSpace: 'nowrap' }}>
        {horse.jockey}
      </span>
    </div>
  )
}

function Swatch({ style }: { style: Style }) {
  return (
    <span
      style={{
        display: 'inline-block', width: 14, height: 14,
        borderRadius: 3, background: style.bg, border: '1px solid #334155',
        flexShrink: 0,
      }}
    />
  )
}

function IndexRow({
  label, items, selected, onToggle, renderSwatch,
}: {
  label: string
  items: string[]
  selected: Set<string>
  onToggle: (k: string) => void
  renderSwatch?: (k: string) => React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontSize: 13, fontWeight: 700, color: '#94a3b8',
        minWidth: 50, marginRight: 4,
      }}>{label}:</span>
      {items.map(k => {
        const isSelected = selected.has(k)
        return (
          <button
            key={k}
            onClick={() => onToggle(k)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px',
              borderRadius: 12,
              border: isSelected ? '1.5px solid #fbbf24' : '1px solid #334155',
              background: isSelected ? '#3a2e0a' : '#0f172a',
              color: isSelected ? '#fbbf24' : '#cbd5e1',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
              outline: 'none', whiteSpace: 'nowrap',
            }}
          >
            {renderSwatch && renderSwatch(k)}
            {k}
          </button>
        )
      })}
    </div>
  )
}

function Legend() {
  const item = (color: string, label: string, txt: string) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        background: color, color: '#0f172a',
        fontSize: 10, fontWeight: 800,
        borderRadius: 3, padding: '0 4px', lineHeight: '14px',
      }}>{label}</span>
      <span style={{ fontSize: 10, color: '#64748b' }}>{txt}</span>
    </span>
  )
  return (
    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {item('#f59e0b', 'F', 'favourite')}
      {item('#22c55e', 'W', 'won')}
      {item('#3b82f6', 'Q', '2nd / 3rd')}
    </span>
  )
}
