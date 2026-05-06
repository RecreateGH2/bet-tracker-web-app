import { useEffect, useState } from 'react'

interface Props {
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  lastUpdated: string | null
  raceNo: number | null
  snapshotCount: number
  snapshotInterval: number | null
  raceStartTime: string | null
}

const DOT: Record<Props['status'], string> = {
  connected: '#22c55e',
  connecting: '#f59e0b',
  disconnected: '#6b7280',
  error: '#ef4444',
}

const LABEL: Record<Props['status'], string> = {
  connected: 'Live',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  error: 'Error',
}

function useCountdown(raceStartTime: string | null) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (!raceStartTime) { setSecondsLeft(null); return }

    const tick = () => {
      const diff = Math.round((new Date(raceStartTime).getTime() - Date.now()) / 1000)
      setSecondsLeft(diff)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [raceStartTime])

  return secondsLeft
}

export default function StatusBar({ status, lastUpdated, raceNo, snapshotCount, snapshotInterval, raceStartTime }: Props) {
  const secondsLeft = useCountdown(raceStartTime)

  let countdownLabel: string | null = null
  let countdownColor = '#94a3b8'
  if (secondsLeft !== null) {
    const abs = Math.abs(secondsLeft)
    const mm = String(Math.floor(abs / 60)).padStart(2, '0')
    const ss = String(abs % 60).padStart(2, '0')
    if (secondsLeft > 0) {
      countdownLabel = `開跑 −${mm}:${ss}`
      countdownColor = secondsLeft <= 90 ? '#f59e0b' : '#94a3b8'
    } else {
      countdownLabel = `開跑 +${mm}:${ss}`
      countdownColor = '#22c55e'
    }
  }

  const isHighFreq = secondsLeft !== null && Math.abs(secondsLeft) <= 90

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '8px 20px', background: '#1e293b', fontSize: 13, color: '#94a3b8',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: DOT[status], display: 'inline-block',
          boxShadow: status === 'connected' ? `0 0 6px ${DOT[status]}` : 'none',
        }} />
        {LABEL[status]}
      </span>

      {raceNo && <span>Race #{raceNo}</span>}

      {countdownLabel && (
        <span style={{ fontWeight: 600, color: countdownColor }}>
          {countdownLabel}
        </span>
      )}

      {lastUpdated && (
        <span>Updated: {new Date(lastUpdated).toLocaleTimeString()}</span>
      )}

      {snapshotCount > 0 && (
        <span>
          {snapshotCount} snapshots
          {snapshotInterval !== null && (
            <span style={{ color: isHighFreq ? '#f59e0b' : '#64748b', marginLeft: 4 }}>
              · every {snapshotInterval}s{isHighFreq ? ' ⚡' : ''}
            </span>
          )}
        </span>
      )}
    </div>
  )
}
