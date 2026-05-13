import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../config'
import { TrackedRace, TrainerGridResponse, RaceStatus } from '../types'

interface Props {
  activeRace: number | null
  onSelect: (raceNo: number) => void
}

const POLL_TRACKED_MS = 8_000   // re-poll backend state every 8s for status pills

const STATUS_LABEL: Record<RaceStatus, string> = {
  unknown: '?',
  pending: '—',
  pre: '●',
  active: '●',
  ended: '✓',
}

const STATUS_COLOR: Record<RaceStatus, string> = {
  unknown: '#475569',
  pending: '#475569',
  pre: '#f59e0b',
  active: '#22c55e',
  ended: '#94a3b8',
}

export default function RaceButtons({ activeRace, onSelect }: Props) {
  const [raceNos, setRaceNos] = useState<number[]>([])
  const [tracked, setTracked] = useState<Map<number, TrackedRace>>(new Map())

  // Discover races from the meeting trainer-grid (auto-detected, 1..N)
  useEffect(() => {
    let cancelled = false
    const fetchMeeting = async () => {
      try {
        const res = await fetch(apiUrl('/api/meeting/trainer-grid'))
        if (!res.ok) return
        const json: TrainerGridResponse = await res.json()
        if (!cancelled && json.summary) {
          const nums = json.summary.races.map(r => r.race_no).sort((a, b) => a - b)
          setRaceNos(nums)
        }
      } catch { /* ignore */ }
    }
    fetchMeeting()
    const t = setInterval(fetchMeeting, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Once we know the race numbers, register every one with the backend so
  // it scrapes them all in the background (idempotent — backend ignores dupes).
  useEffect(() => {
    if (raceNos.length === 0) return
    for (const rn of raceNos) {
      fetch(apiUrl(`/api/races/tracked/${rn}`), { method: 'POST' }).catch(() => {})
    }
  }, [raceNos])

  // Poll the tracked-state endpoint so buttons can reflect phase (pre/active/ended)
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(apiUrl('/api/races/tracked'))
        if (!res.ok) return
        const json = await res.json() as { races: TrackedRace[] }
        if (cancelled) return
        const m = new Map<number, TrackedRace>()
        for (const r of json.races) m.set(r.race_no, r)
        setTracked(m)
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, POLL_TRACKED_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const handleExtend = useCallback(async (rn: number) => {
    await fetch(apiUrl(`/api/races/tracked/${rn}/extend?minutes=10`), { method: 'POST' })
  }, [])

  // Combine: race numbers from meeting, augmented with tracked-state if known
  const items = useMemo(() => raceNos.map(rn => ({
    race_no: rn,
    state: tracked.get(rn),
  })), [raceNos, tracked])

  if (items.length === 0) {
    return <span style={{ color: '#64748b', fontSize: 13 }}>Loading races…</span>
  }

  const activeState = activeRace !== null ? tracked.get(activeRace) : undefined
  const canExtend = activeState && (
    activeState.status === 'ended' ||
    (activeState.start_time && new Date(activeState.start_time).getTime() < Date.now())
  )

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 600, marginRight: 4 }}>Race</span>
      {items.map(({ race_no, state }) => {
        const isActive = race_no === activeRace
        const status: RaceStatus = state?.status ?? 'unknown'
        return (
          <button
            key={race_no}
            onClick={() => onSelect(race_no)}
            title={state?.start_time ? `Off ${new Date(state.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${status}` : status}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: isActive ? '1.5px solid #fbbf24' : '1px solid #334155',
              background: isActive ? '#3b82f6' : '#1e293b',
              color: isActive ? '#fff' : '#cbd5e1',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
              minWidth: 38,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            R{race_no}
            <span style={{
              fontSize: 9,
              color: STATUS_COLOR[status],
              fontWeight: 800,
              ...(status === 'active' ? { animation: 'rb-pulse 1.4s ease-in-out infinite' } : {}),
            }}>
              {STATUS_LABEL[status]}
            </span>
          </button>
        )
      })}

      {canExtend && activeRace !== null && (
        <button
          onClick={() => handleExtend(activeRace)}
          style={{
            marginLeft: 10,
            padding: '5px 12px',
            borderRadius: 6,
            border: '1px solid #f59e0b',
            background: '#3a2e0a',
            color: '#fbbf24',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
          title="Keep scraping this race for another 10 minutes"
        >
          ⟳ Continue tracking
        </button>
      )}

      <style>{`@keyframes rb-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }`}</style>
    </div>
  )
}
