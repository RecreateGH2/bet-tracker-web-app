import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { TimePoint } from '../types'

interface Props {
  horseSeries: Map<string, TimePoint[]>
  visibleHorses: Set<string>
}

const COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6',
  '#6366f1', '#e11d48', '#65a30d', '#d97706', '#7c3aed',
]

const WINDOW_MINUTES = 15

/** Floor a timestamp to its minute bucket key, e.g. "22:07" */
function toMinuteKey(isoTime: string): string {
  const d = new Date(isoTime)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function OddsTrendChart({ horseSeries, visibleHorses }: Props) {
  // Build a unified sorted list of all raw timestamps
  const allTimes = Array.from(
    new Set(Array.from(horseSeries.values()).flatMap(pts => pts.map(p => p.time)))
  ).sort()

  if (allTimes.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
        Collecting trend data…
      </div>
    )
  }

  // 15-minute rolling window cutoff
  const latest = new Date(allTimes.at(-1)!).getTime()
  const cutoff = latest - WINDOW_MINUTES * 60 * 1000
  const windowTimes = allTimes.filter(t => new Date(t).getTime() >= cutoff)

  // Bucket by minute: for each horse, keep the last reading per minute bucket
  const minuteBuckets = new Map<string, Record<string, number>>()
  for (const time of windowTimes) {
    const key = toMinuteKey(time)
    if (!minuteBuckets.has(key)) minuteBuckets.set(key, {})
    for (const [horse, points] of horseSeries) {
      if (!visibleHorses.has(horse)) continue
      const pt = points.find(p => p.time === time)
      if (pt) minuteBuckets.get(key)![`#${horse}`] = pt.win_share_pct
    }
  }

  // Build chart data sorted by minute key
  const chartData = Array.from(minuteBuckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, vals]) => ({ time, ...vals }))

  const horseKeys = Array.from(visibleHorses).sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0))

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: '#64748b' }}
          interval={0}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={v => `${v}%`}
          tick={{ fontSize: 11, fill: '#64748b' }}
          domain={[0, 'auto']}
        />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
          labelStyle={{ color: '#e2e8f0' }}
          formatter={(v: number) => `${v.toFixed(1)}%`}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {horseKeys.map((horse, i) => (
          <Line
            key={horse}
            type="monotone"
            dataKey={`#${horse}`}
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
