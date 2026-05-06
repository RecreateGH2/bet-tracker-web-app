import { useState } from 'react'
import { apiUrl } from '../config'

interface Props {
  activeRace: number | null
  onSelect: (raceNo: number) => void
}

export default function RaceSelector({ activeRace, onSelect }: Props) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = parseInt(input)
    if (isNaN(n) || n < 1 || n > 12) return
    setLoading(true)
    try {
      await fetch(apiUrl('/api/races/active'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ race_no: n }),
      })
      onSelect(n)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label style={{ fontWeight: 600, color: '#cbd5e1' }}>Race #</label>
      <input
        type="number" min={1} max={12} value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="1–12"
        style={{
          width: 70, padding: '6px 10px', borderRadius: 6,
          border: '1px solid #334155', background: '#1e293b',
          color: '#e2e8f0', fontSize: 14, outline: 'none',
        }}
      />
      <button
        type="submit" disabled={loading}
        style={{
          padding: '6px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
          background: loading ? '#475569' : '#3b82f6', color: '#fff', fontWeight: 600,
        }}
      >
        {loading ? '…' : 'Track'}
      </button>
      {activeRace && (
        <span style={{ color: '#94a3b8', fontSize: 13 }}>
          Tracking Race #{activeRace}
        </span>
      )}
    </form>
  )
}
