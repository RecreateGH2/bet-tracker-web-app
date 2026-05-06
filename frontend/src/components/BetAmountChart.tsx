import { useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LabelList,
} from 'recharts'
import { HorseAggregate } from '../types'

interface Props {
  aggregates: HorseAggregate[]
  horseNames?: Record<string, string>
  horseBarriers?: Record<string, string>
}

type SortMode = 'horse' | 'barrier'

const fmtK = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v}`

// Custom Y-axis tick: renders "[檔]" then "#N" then "馬名" on one line
function HorseTick({ x, y, payload, horseNames, horseBarriers }: any) {
  const raw: string = payload.value          // e.g. "1"
  const name: string = horseNames?.[raw] ?? ''
  const barrier: string = horseBarriers?.[raw] ?? ''
  return (
    <g transform={`translate(${x},${y})`}>
      {/* 馬名 — far left */}
      {name && (
        <text x={-58} dy="0.35em" textAnchor="end" fontSize={12} fill="#cbd5e1">
          {name}
        </text>
      )}
      {/* 馬號 */}
      <text x={-32} dy="0.35em" textAnchor="end" fontSize={12} fontWeight={700} fill="#93c5fd">
        #{raw}
      </text>
      {/* 檔位 — closest to chart bars */}
      {barrier ? (
        <text x={-4} dy="0.35em" textAnchor="end" fontSize={11} fontWeight={700} fill="#fbbf24">
          [{barrier}]
        </text>
      ) : (
        <text x={-4} dy="0.35em" textAnchor="end" fontSize={11} fill="#475569">
          [—]
        </text>
      )}
    </g>
  )
}

export default function BetAmountChart({ aggregates, horseNames = {}, horseBarriers = {} }: Props) {
  const [sortMode, setSortMode] = useState<SortMode>('horse')

  if (aggregates.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
        No data yet…
      </div>
    )
  }

  const hasNames = Object.keys(horseNames).length > 0
  const hasBarriers = Object.keys(horseBarriers).length > 0

  const sortFn = sortMode === 'barrier'
    ? (a: HorseAggregate, b: HorseAggregate) => {
        const ba = parseInt(horseBarriers[a.horse_number] ?? '') || 999
        const bb = parseInt(horseBarriers[b.horse_number] ?? '') || 999
        if (ba !== bb) return ba - bb
        return (parseInt(a.horse_number) || 0) - (parseInt(b.horse_number) || 0)
      }
    : (a: HorseAggregate, b: HorseAggregate) =>
        (parseInt(a.horse_number) || 0) - (parseInt(b.horse_number) || 0)

  const data = [...aggregates]
    .filter(a => !a.horse_number.includes('-'))
    .sort(sortFn)
    .map(a => ({
      horse: a.horse_number,
      Win: a.total_win_amount,
      Place: a.total_place_amount,
      total: a.total_win_amount + a.total_place_amount,
    }))

  const chartHeight = Math.max(300, data.length * 40 + 60)
  // Width: name (~80px) + gap + #N (~24px) + gap + [檔] (~32px) ≈ 150px
  const yAxisWidth = hasNames ? 150 : 80

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 12px',
    borderRadius: 6,
    border: 'none',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    background: active ? '#3b82f6' : '#334155',
    color: active ? '#fff' : '#94a3b8',
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: '#64748b', marginRight: 4 }}>Sort:</span>
        <button style={btnStyle(sortMode === 'horse')} onClick={() => setSortMode('horse')}>
          by 馬號
        </button>
        <button
          style={{ ...btnStyle(sortMode === 'barrier'), opacity: hasBarriers ? 1 : 0.4 }}
          onClick={() => hasBarriers && setSortMode('barrier')}
          disabled={!hasBarriers}
          title={hasBarriers ? '' : 'Barrier data not loaded yet'}
        >
          by 檔位
        </button>
      </div>

      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 5, right: 80, left: 10, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={fmtK}
            tick={{ fontSize: 11, fill: '#64748b' }}
          />
          <YAxis
            type="category"
            dataKey="horse"
            tick={<HorseTick horseNames={horseNames} horseBarriers={horseBarriers} />}
            width={yAxisWidth}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
            formatter={(v: number) => `HK$${v.toLocaleString()}`}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Win" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]} />
          <Bar dataKey="Place" stackId="a" fill="#22c55e" radius={[0, 3, 3, 0]}>
            <LabelList
              valueAccessor={(entry: any) => entry.Win + entry.Place}
              position="right"
              formatter={(v: number) => v > 0 ? fmtK(v) : ''}
              style={{ fontSize: 11, fill: '#94a3b8' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
