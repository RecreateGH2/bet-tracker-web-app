import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { ComboAggregate } from '../types'

interface Props {
  combos: ComboAggregate[]
}

const COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6',
  '#6366f1', '#e11d48', '#65a30d', '#d97706', '#7c3aed',
]

const fmtK = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}K` : `$${v}`

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  const { name, value, payload: d } = payload[0]
  return (
    <div style={{
      background: '#1e293b', border: '1px solid #334155',
      borderRadius: 6, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Horse #{name}</div>
      <div style={{ color: '#94a3b8' }}>Total: HK${value.toLocaleString()}</div>
      <div style={{ color: '#94a3b8' }}>{d.pct.toFixed(1)}% of combo pool</div>
      <div style={{ color: '#64748b', marginTop: 2 }}>{d.count} combo pair{d.count !== 1 ? 's' : ''}</div>
    </div>
  )
}

export default function ComboHorsePieChart({ combos }: Props) {
  if (combos.length === 0) return null

  // Aggregate total amount and pair count per individual horse number
  const horseMap = new Map<string, { amount: number; count: number }>()
  for (const c of combos) {
    const [h1, h2] = c.pair.split('-')
    for (const h of [h1, h2]) {
      if (!h) continue
      const prev = horseMap.get(h) ?? { amount: 0, count: 0 }
      horseMap.set(h, { amount: prev.amount + c.total_amount, count: prev.count + 1 })
    }
  }

  const total = Array.from(horseMap.values()).reduce((s, v) => s + v.amount, 0) || 1

  const data = Array.from(horseMap.entries())
    .map(([horse, { amount, count }]) => ({
      name: horse,
      value: amount,
      count,
      pct: (amount / total) * 100,
    }))
    .sort((a, b) => b.value - a.value)

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={110}
          label={({ name, pct }) => `#${name} ${pct.toFixed(1)}%`}
          labelLine={true}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          formatter={(value) => <span style={{ color: '#94a3b8', fontSize: 12 }}>#{value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}
