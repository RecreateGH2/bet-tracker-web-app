import { BetEntry } from '../types'

interface Props {
  bets: (BetEntry & { race_no: number })[]
}

const BET_TYPE_LABEL: Record<string, string> = {
  win: 'W',
  place: 'PLA',
  quin: 'Q',
  'place-quin': 'PQ',
}

const BET_TYPE_COLOR: Record<string, string> = {
  win: '#3b82f6',
  place: '#22c55e',
  quin: '#f59e0b',
  'place-quin': '#a78bfa',
}

const fmt = (n: number) =>
  n.toLocaleString('zh-HK', { style: 'currency', currency: 'HKD', maximumFractionDigits: 0 })

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  } catch {
    return iso
  }
}

export default function HighAmountBetList({ bets }: Props) {
  if (bets.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#475569', fontSize: 13 }}>
        No bets over HK$500K detected yet.
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #334155', background: '#1e293b' }}>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'left', whiteSpace: 'nowrap' }}>Time</th>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'center', whiteSpace: 'nowrap' }}>Race</th>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'left' }}>Horse</th>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'left' }}>Type</th>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'right', whiteSpace: 'nowrap' }}>Amount</th>
            <th style={{ padding: '8px 12px', color: '#94a3b8', textAlign: 'center' }}>Parlay</th>
          </tr>
        </thead>
        <tbody>
          {bets.map((bet, i) => (
            <tr
              key={i}
              style={{
                borderBottom: '1px solid #1e293b',
                background: i % 2 === 0 ? '#0f172a' : '#1e293b',
              }}
            >
              <td style={{ padding: '7px 12px', color: '#64748b', whiteSpace: 'nowrap' }}>
                {formatTime(bet.scraped_at)}
              </td>
              <td style={{ padding: '7px 12px', textAlign: 'center' }}>
                <span style={{
                  display: 'inline-block',
                  padding: '2px 7px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  background: '#1e3a8a',
                  color: '#93c5fd',
                  minWidth: 26,
                  textAlign: 'center',
                }}>
                  R{bet.race_no}
                </span>
              </td>
              <td style={{ padding: '7px 12px', fontWeight: 700, color: '#f1f5f9' }}>
                #{bet.horse_number}
              </td>
              <td style={{ padding: '7px 12px' }}>
                <span style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  background: BET_TYPE_COLOR[bet.bet_type] ?? '#475569',
                  color: '#fff',
                }}>
                  {BET_TYPE_LABEL[bet.bet_type] ?? bet.bet_type.toUpperCase()}
                </span>
              </td>
              <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: '#fbbf24', fontSize: 14 }}>
                {fmt(bet.amount)}
              </td>
              <td style={{ padding: '7px 12px', textAlign: 'center' }}>
                {bet.is_parlay && (
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#a855f7' }} title="Parlay" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
