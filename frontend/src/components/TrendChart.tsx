import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { TimePoint } from '../types'

interface Props {
  series: Map<string, TimePoint[]>
  visibleKeys?: Set<string>      // if omitted, all keys are shown
  keyLabel?: (k: string) => string  // how to display a key in the legend
  emptyText?: string
}

const COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6',
  '#6366f1', '#e11d48', '#65a30d', '#d97706', '#7c3aed',
]

const WINDOW_MINUTES = 15

function toMinuteKey(isoTime: string): string {
  const d = new Date(isoTime)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function TrendChart({
  series,
  visibleKeys,
  keyLabel = k => k,
  emptyText = 'Collecting trend data…',
}: Props) {
  const activeKeys = visibleKeys
    ? Array.from(series.keys()).filter(k => visibleKeys.has(k))
    : Array.from(series.keys())

  const allTimes = Array.from(
    new Set(Array.from(series.values()).flatMap(pts => pts.map(p => p.time)))
  ).sort()

  if (allTimes.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>{emptyText}</div>
  }

  // 15-minute rolling window
  const latest = new Date(allTimes.at(-1)!).getTime()
  const cutoff = latest - WINDOW_MINUTES * 60 * 1000
  const windowTimes = allTimes.filter(t => new Date(t).getTime() >= cutoff)

  // Bucket per minute: last reading wins
  const buckets = new Map<string, Record<string, number>>()
  for (const time of windowTimes) {
    const key = toMinuteKey(time)
    if (!buckets.has(key)) buckets.set(key, {})
    for (const k of activeKeys) {
      const pt = series.get(k)?.find(p => p.time === time)
      if (pt) buckets.get(key)![keyLabel(k)] = pt.win_share_pct
    }
  }

  const chartData = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, vals]) => ({ time, ...vals }))

  const displayKeys = activeKeys.map(keyLabel)

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#64748b' }} interval={0} minTickGap={40} />
        <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#64748b' }} domain={[0, 'auto']} />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
          labelStyle={{ color: '#e2e8f0' }}
          formatter={(v: number) => `${v.toFixed(1)}%`}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {displayKeys.map((label, i) => (
          <Line
            key={label}
            type="monotone"
            dataKey={label}
            stroke={COLORS[i % COLORS.length]}
            dot={false}
            strokeWidth={2}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
