import { useMemo } from 'react'
import { WSMessage, HorseAggregate, TimePoint, ComboAggregate } from '../types'

export function useRaceData(messages: WSMessage[]) {
  const snapshots = useMemo(
    () => messages.filter(m => m.type === 'snapshot'),
    [messages]
  )

  // Latest aggregates (from the most recent snapshot)
  const aggregates: HorseAggregate[] = useMemo(() => {
    return snapshots.at(-1)?.aggregates ?? []
  }, [snapshots])

  // Per-horse time series: Map<horseNumber, TimePoint[]> — single horses only
  const horseSeries = useMemo(() => {
    const map = new Map<string, TimePoint[]>()
    for (const snap of snapshots) {
      if (!snap.scraped_at) continue
      for (const agg of snap.aggregates) {
        if (agg.horse_number.includes('-')) continue
        const key = agg.horse_number
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push({
          time: snap.scraped_at,
          win_share_pct: agg.win_share_pct,
        })
      }
    }
    return map
  }, [snapshots])

  const allHorseNumbers = useMemo(
    () => Array.from(new Set(aggregates.map(a => a.horse_number)))
      .filter(h => !h.includes('-'))
      .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0)),
    [aggregates]
  )

  // Per-pair combo time series: Map<pair, TimePoint[]>
  // win_share_pct here = this pair's share of the total combo pool per snapshot
  const comboSeries = useMemo(() => {
    const map = new Map<string, TimePoint[]>()
    for (const snap of snapshots) {
      if (!snap.scraped_at) continue
      const comboEntries = snap.entries.filter(
        e => e.bet_type === 'quin' || e.bet_type === 'place-quin'
      )
      const totalPool = comboEntries.reduce((s, e) => s + e.amount, 0) || 1
      const pairTotals = new Map<string, number>()
      for (const e of comboEntries) {
        pairTotals.set(e.horse_number, (pairTotals.get(e.horse_number) ?? 0) + e.amount)
      }
      for (const [pair, amount] of pairTotals) {
        if (!map.has(pair)) map.set(pair, [])
        map.get(pair)!.push({ time: snap.scraped_at, win_share_pct: amount / totalPool * 100 })
      }
    }
    return map
  }, [snapshots])

  // Combo aggregates: computed from LATEST snapshot's entries only.
  // Each snapshot is a full picture of all bets so far (not a delta),
  // so we must not sum across snapshots.
  const comboAggregates: ComboAggregate[] = useMemo(() => {
    const latestEntries = snapshots.at(-1)?.entries ?? []
    const map = new Map<string, ComboAggregate>()

    for (const e of latestEntries) {
      if (e.bet_type !== 'quin' && e.bet_type !== 'place-quin') continue
      // horse_number is stored as "1-2" for combos
      const pair = e.horse_number
      if (!map.has(pair)) {
        map.set(pair, {
          pair,
          quin_amount: 0,
          place_quin_amount: 0,
          quin_count: 0,
          place_quin_count: 0,
          total_amount: 0,
        })
      }
      const c = map.get(pair)!
      if (e.bet_type === 'quin') {
        c.quin_amount += e.amount
        c.quin_count += 1
      } else {
        c.place_quin_amount += e.amount
        c.place_quin_count += 1
      }
      c.total_amount = c.quin_amount + c.place_quin_amount
    }

    return Array.from(map.values()).sort((a, b) => b.total_amount - a.total_amount)
  }, [snapshots])

  // Combo trend limited to top 10 by current share.
  // If a brand-new pair (only 1 data point) just overtook #10, show it as #11.
  const filteredComboSeries = useMemo(() => {
    if (comboSeries.size <= 10) return comboSeries
    const ranked = Array.from(comboSeries.entries())
      .map(([key, pts]) => ({ key, latest: pts.at(-1)?.win_share_pct ?? 0, isNew: pts.length === 1 }))
      .sort((a, b) => b.latest - a.latest)
    const shown = new Set(ranked.slice(0, 10).map(x => x.key))
    const rank11 = ranked[10]
    if (rank11?.isNew) shown.add(rank11.key)
    const result = new Map<string, TimePoint[]>()
    for (const key of shown) result.set(key, comboSeries.get(key)!)
    return result
  }, [comboSeries])

  const snapshotInterval = useMemo(() => {
    if (snapshots.length < 2) return null
    const t1 = snapshots.at(-1)?.scraped_at
    const t2 = snapshots.at(-2)?.scraped_at
    if (!t1 || !t2) return null
    return Math.round((new Date(t1).getTime() - new Date(t2).getTime()) / 1000)
  }, [snapshots])

  return { aggregates, horseSeries, comboSeries: filteredComboSeries, allHorseNumbers, comboAggregates, snapshotCount: snapshots.length, snapshotInterval }
}
