import { useEffect, useRef, useState } from 'react'
import { HorseAggregate } from '../types'

interface Props {
  aggregates: HorseAggregate[]
}

const fmt = (n: number) => n.toLocaleString('zh-HK', { style: 'currency', currency: 'HKD', maximumFractionDigits: 0 })

export default function BetTable({ aggregates }: Props) {
  const [sortKey, setSortKey] = useState<keyof HorseAggregate>('win_share_pct')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const prevPcts = useRef<Map<string, number>>(new Map())
  const [flashClass, setFlashClass] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    const next = new Map<string, string>()
    for (const agg of aggregates) {
      const prev = prevPcts.current.get(agg.horse_number)
      if (prev !== undefined) {
        if (agg.win_share_pct > prev) next.set(agg.horse_number, 'flash-up')
        else if (agg.win_share_pct < prev) next.set(agg.horse_number, 'flash-down')
      }
    }
    setFlashClass(next)
    for (const agg of aggregates) prevPcts.current.set(agg.horse_number, agg.win_share_pct)
  }, [aggregates])

  const sorted = [...aggregates].sort((a, b) => {
    const va = a[sortKey] as number, vb = b[sortKey] as number
    return sortDir === 'desc' ? vb - va : va - vb
  })

  const onSort = (key: keyof HorseAggregate) => {
    if (key === sortKey) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const th = (label: string, key: keyof HorseAggregate) => (
    <th
      onClick={() => onSort(key)}
      style={{ padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
        color: sortKey === key ? '#60a5fa' : '#94a3b8', textAlign: 'right', whiteSpace: 'nowrap' }}
    >
      {label} {sortKey === key ? (sortDir === 'desc' ? '↓' : '↑') : ''}
    </th>
  )

  if (aggregates.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
        Waiting for race data…
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #334155', background: '#1e293b' }}>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'left' }}>Horse</th>
            {th('Win Bets', 'total_win_amount')}
            {th('Place Bets', 'total_place_amount')}
            {th('Win Count', 'win_bet_count')}
            {th('Win Pool %', 'win_share_pct')}
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'right' }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(agg => {
            const flash = flashClass.get(agg.horse_number) ?? ''
            const change = agg.pct_change
            return (
              <tr
                key={agg.horse_number}
                className={flash}
                style={{ borderBottom: '1px solid #1e293b' }}
              >
                <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                  #{agg.horse_number}
                  {agg.horse_name && (
                    <span style={{ marginLeft: 8, fontWeight: 400, color: '#94a3b8', fontSize: 12 }}>
                      {agg.horse_name}
                    </span>
                  )}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmt(agg.total_win_amount)}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmt(agg.total_place_amount)}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{agg.win_bet_count}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>
                  {agg.win_share_pct.toFixed(1)}%
                </td>
                <td style={{
                  padding: '8px 12px', textAlign: 'right', fontWeight: 600,
                  color: change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#94a3b8',
                }}>
                  {change > 0 ? `+${change.toFixed(1)}%` : change < 0 ? `${change.toFixed(1)}%` : '–'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
