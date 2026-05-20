import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useRaceData } from './hooks/useRaceData'
import { BetEntry } from './types'
import StatusBar from './components/StatusBar'
import RaceButtons from './components/RaceButtons'
import BetTable from './components/BetTable'
import HighAmountBetList from './components/HighAmountBetList'
import HorseInfoTable from './components/HorseInfoTable'
import TrainerGrid from './components/TrainerGrid'
import { apiUrl } from './config'

// Lazy-load: pulls Recharts (heavy) + admin/archive pages into separate chunks.
const TrendChart = lazy(() => import('./components/TrendChart'))
const BetAmountChart = lazy(() => import('./components/BetAmountChart'))
const ComboBetChart = lazy(() => import('./components/ComboBetChart'))
const ComboHorsePieChart = lazy(() => import('./components/ComboHorsePieChart'))
const ArchivePage = lazy(() => import('./components/ArchivePage'))
const SourcesPage = lazy(() => import('./components/SourcesPage'))

const ChartFallback = () => (
  <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 12 }}>
    Loading chart…
  </div>
)

const HIGH_BET_THRESHOLD = 500_000

export default function App() {
  const { status, messages, latestSnapshot } = useWebSocket()
  const [activeRace, setActiveRace] = useState<number | null>(null)
  const { aggregates, horseSeries, comboSeries, allHorseNumbers, comboAggregates, snapshotCount, snapshotInterval } = useRaceData(messages, activeRace)
  const [showSources, setShowSources] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [visibleHorses, setVisibleHorses] = useState<Set<string>>(new Set())
  const [highBets, setHighBets] = useState<(BetEntry & { race_no: number })[]>([])
  const seenKeys = useRef<Set<string>>(new Set())
  const [raceStartTime, setRaceStartTime] = useState<string | null>(null)
  const [horseNames, setHorseNames] = useState<Record<string, string>>({})
  const [horseBarriers, setHorseBarriers] = useState<Record<string, string>>({})
  const [meetingRefreshKey, setMeetingRefreshKey] = useState(0)

  // Fetch horse names from race card when race changes or as data loads in
  useEffect(() => {
    if (!activeRace) { setHorseNames({}); setHorseBarriers({}); return }
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/races/${activeRace}/horse-info`))
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (data.horses?.length > 0) {
          const names: Record<string, string> = {}
          const barriers: Record<string, string> = {}
          for (const h of data.horses) {
            names[String(h.horse_no)] = h.horse_name
            if (h.barrier) barriers[String(h.horse_no)] = h.barrier
          }
          if (!cancelled) {
            setHorseNames(names)
            setHorseBarriers(barriers)
          }
        }
        if (data.status !== 'ready' && !cancelled) {
          setTimeout(poll, 4000)
        }
      } catch { /* ignore */ }
    }
    poll()
    return () => { cancelled = true }
  }, [activeRace])

  // Sync visible horses when new horses appear
  useEffect(() => {
    setVisibleHorses(prev => {
      const next = new Set(prev)
      for (const h of allHorseNumbers) next.add(h)
      return next
    })
  }, [allHorseNumbers])

  // Pick up race_changed events
  useEffect(() => {
    const last = messages.at(-1)
    if (last?.type === 'race_changed' && last.race_no) {
      setActiveRace(last.race_no)
      // The previous race likely just finished — refresh the meeting grid in
      // 30s to give HKJC time to publish results.
      const t = setTimeout(() => setMeetingRefreshKey(k => k + 1), 30_000)
      return () => clearTimeout(t)
    }
  }, [messages])

  // Pick up race_start_time from snapshots — only for the race currently viewed
  useEffect(() => {
    if (activeRace === null) { setRaceStartTime(null); return }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === 'snapshot' && m.race_no === activeRace && m.race_start_time) {
        setRaceStartTime(m.race_start_time)
        return
      }
    }
  }, [messages, activeRace])

  // Accumulate high-amount bets (>= 500K) across ALL tracked races,
  // tagging each entry with its race_no so the table can show a Race column.
  useEffect(() => {
    const last = messages.at(-1)
    if (last?.type !== 'snapshot' || !last.entries || last.race_no == null) return
    const raceNo = last.race_no
    const newBig: (BetEntry & { race_no: number })[] = []
    for (const entry of last.entries) {
      if (entry.amount < HIGH_BET_THRESHOLD) continue
      const key = `${raceNo}|${entry.scraped_at}|${entry.horse_number}|${entry.bet_type}|${entry.amount}`
      if (!seenKeys.current.has(key)) {
        seenKeys.current.add(key)
        newBig.push({ ...entry, race_no: raceNo })
      }
    }
    if (newBig.length > 0) {
      setHighBets(prev => [...newBig, ...prev])
    }
  }, [messages])

  const toggleHorse = (h: string) => {
    setVisibleHorses(prev => {
      const next = new Set(prev)
      next.has(h) ? next.delete(h) : next.add(h)
      return next
    })
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{ background: '#0e1e52', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>
          大票房 Bet Tracker
        </h1>
        {!showSources && !showArchive && (
          <RaceButtons activeRace={activeRace} onSelect={(rn) => {
            setActiveRace(rn)
            fetch(apiUrl('/api/races/active'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ race_no: rn }),
            }).catch(() => {})
          }} />
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => { setShowArchive(p => !p); setShowSources(false) }}
            title={showArchive ? 'Back to dashboard' : 'Final results archive'}
            style={{
              background: showArchive ? '#1d4ed8' : 'rgba(255,255,255,0.08)',
              border: 'none', borderRadius: 8, padding: '6px 12px',
              color: '#e2e8f0', fontSize: 13, cursor: 'pointer',
            }}
          >
            {showArchive ? '← Dashboard' : '🏁 Archive'}
          </button>
          <button
            onClick={() => { setShowSources(p => !p); setShowArchive(false) }}
            title={showSources ? 'Back to dashboard' : 'Data sources'}
            style={{
              background: showSources ? '#1d4ed8' : 'rgba(255,255,255,0.08)',
              border: 'none', borderRadius: 8, padding: '6px 12px',
              color: '#e2e8f0', fontSize: 13, cursor: 'pointer',
            }}
          >
            {showSources ? '← Dashboard' : '⚙ Sources'}
          </button>
        </span>
      </header>

      <StatusBar
        status={status}
        lastUpdated={latestSnapshot?.scraped_at ?? null}
        raceNo={activeRace}
        snapshotCount={snapshotCount}
        snapshotInterval={snapshotInterval}
        raceStartTime={raceStartTime}
      />

      {showSources && (
        <div style={{ flex: 1, background: '#0f172a', minHeight: '100vh' }}>
          <Suspense fallback={<div style={{ padding: 40, color: '#64748b' }}>Loading…</div>}>
            <SourcesPage activeRace={activeRace} />
          </Suspense>
        </div>
      )}

      {showArchive && (
        <div style={{ flex: 1, background: '#0f172a', minHeight: '100vh' }}>
          <Suspense fallback={<div style={{ padding: 40, color: '#64748b' }}>Loading archive…</div>}>
            <ArchivePage />
          </Suspense>
        </div>
      )}

      <main style={{ flex: 1, padding: '16px 20px', display: (showSources || showArchive) ? 'none' : 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Horse filter toggles */}
        {allHorseNumbers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={{ color: '#64748b', fontSize: 12, alignSelf: 'center' }}>Show horses:</span>
            {allHorseNumbers.map(h => (
              <button
                key={h}
                onClick={() => toggleHorse(h)}
                style={{
                  padding: '3px 10px', borderRadius: 12, fontSize: 12, border: 'none', cursor: 'pointer',
                  background: visibleHorses.has(h) ? '#3b82f6' : '#334155',
                  color: visibleHorses.has(h) ? '#fff' : '#94a3b8',
                  fontWeight: 600,
                }}
              >
                #{h}
              </button>
            ))}
          </div>
        )}

        {/* Trend charts row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
          <section style={{ background: '#1e293b', borderRadius: 8, padding: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', marginBottom: 12 }}>
              獨贏及位罝走勢
            </h2>
            <Suspense fallback={<ChartFallback />}>
              <TrendChart
                series={horseSeries}
                visibleKeys={visibleHorses}
                keyLabel={k => `#${k}`}
              />
            </Suspense>
          </section>

          <section style={{ background: '#1e293b', borderRadius: 8, padding: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', marginBottom: 12 }}>
              連贏走勢
            </h2>
            <Suspense fallback={<ChartFallback />}>
              <TrendChart
                series={comboSeries}
                emptyText="Collecting combo trend data…"
              />
            </Suspense>
          </section>
        </div>

        {/* Total Bets by Horse — full width horizontal bar chart */}
        <section style={{ background: '#1e293b', borderRadius: 8, padding: 16 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', marginBottom: 12 }}>
            獨贏及位罝入飛比較
          </h2>
          <Suspense fallback={<ChartFallback />}>
            <BetAmountChart aggregates={aggregates} horseNames={horseNames} horseBarriers={horseBarriers} />
          </Suspense>
        </section>

        {/* Combo bets — bar chart + horse pie chart */}
        {comboAggregates.length > 0 && (
          <section style={{ background: '#1e293b', borderRadius: 8, padding: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', marginBottom: 4 }}>
              Combo Bets — 連贏 (Q) &amp; 位置Q (PQ)
            </h2>
            <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
              Top {Math.min(comboAggregates.length, 15)} pairs by total HK$ · sorted by amount · from latest snapshot
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(280px, 380px)', gap: 24, alignItems: 'start' }}>
              <Suspense fallback={<ChartFallback />}>
                <ComboBetChart combos={comboAggregates} />
              </Suspense>
              <div>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
                  Most Picked Horses in Combos
                </h3>
                <Suspense fallback={<ChartFallback />}>
                  <ComboHorsePieChart combos={comboAggregates} />
                </Suspense>
              </div>
            </div>
          </section>
        )}

        {/* High Amount Bets — >= 500K */}
        <section style={{ background: '#1e293b', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', margin: 0 }}>
              大額落注紀錄
            </h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>&gt; HK$500K</span>
            {highBets.length > 0 && (
              <span style={{
                marginLeft: 'auto', background: '#dc2626', color: '#fff',
                borderRadius: 12, padding: '1px 8px', fontSize: 11, fontWeight: 700,
              }}>
                {highBets.length}
              </span>
            )}
          </div>
          <HighAmountBetList bets={highBets} />
        </section>

        {/* Trainer × Race Grid — meeting-wide view */}
        <TrainerGrid refreshSignal={meetingRefreshKey} />

        {/* Horse Info Table — above Live Bet Summary */}
        <HorseInfoTable raceNo={activeRace} />

        {/* Live Bet Summary — bottom */}
        <section style={{ background: '#1e293b', borderRadius: 8, overflow: 'hidden' }}>
          <h2 style={{ padding: '12px 16px', fontSize: 14, fontWeight: 600, color: '#cbd5e1', borderBottom: '1px solid #334155' }}>
            Live Bet Summary
          </h2>
          <BetTable aggregates={aggregates} />
        </section>

        {!activeRace && (
          <div style={{ textAlign: 'center', color: '#475569', paddingTop: 60 }}>
            <div style={{ fontSize: 48 }}>🏇</div>
            <p style={{ marginTop: 12 }}>Enter a race number above and click <strong>Track</strong> to start.</p>
          </div>
        )}
      </main>
    </div>
  )
}
