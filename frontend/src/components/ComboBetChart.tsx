import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { ComboAggregate } from '../types'

interface Props {
  combos: ComboAggregate[]
}

const fmtK = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v}`

// Custom tooltip
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#1e293b', border: '1px solid #334155',
      borderRadius: 6, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: '#e2e8f0' }}>Pair {label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.fill, marginBottom: 2 }}>
          {p.name}: HK${p.value.toLocaleString()} ({p.payload[`${p.dataKey}_count`]} bets)
        </div>
      ))}
    </div>
  )
}

export default function ComboBetChart({ combos }: Props) {
  if (combos.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
        No combo bets yet…
      </div>
    )
  }

  // Show top 15 combos to keep the chart readable
  const data = combos.slice(0, 15).map(c => ({
    pair: c.pair,
    '連贏 Q': c.quin_amount,
    '位Q PQ': c.place_quin_amount,
    '連贏 Q_count': c.quin_count,
    '位Q PQ_count': c.place_quin_count,
  }))

  const chartHeight = Math.max(260, data.length * 32 + 60)

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 5, right: 60, left: 20, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={fmtK}
          tick={{ fontSize: 11, fill: '#64748b' }}
        />
        <YAxis
          type="category"
          dataKey="pair"
          tick={{ fontSize: 12, fill: '#cbd5e1', fontWeight: 600 }}
          width={40}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
          formatter={(value) => <span style={{ color: '#94a3b8' }}>{value}</span>}
        />
        <Bar dataKey="連贏 Q" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill="#3b82f6" />)}
        </Bar>
        <Bar dataKey="位Q PQ" stackId="a" fill="#a855f7" radius={[0, 3, 3, 0]}>
          {data.map((_, i) => <Cell key={i} fill="#a855f7" />)}
          <LabelList
            valueAccessor={(entry: any) => entry['連贏 Q'] + entry['位Q PQ']}
            position="right"
            formatter={(v: number) => v > 0 ? fmtK(v) : ''}
            style={{ fontSize: 11, fill: '#94a3b8' }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
