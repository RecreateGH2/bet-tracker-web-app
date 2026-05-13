export interface BetEntry {
  horse_number: string
  horse_name: string | null
  bet_type: 'win' | 'place' | 'quin' | 'place-quin'
  amount: number
  is_parlay: boolean
  scraped_at: string
}

export interface HorseAggregate {
  horse_number: string
  horse_name: string | null
  total_win_amount: number
  total_place_amount: number
  win_bet_count: number
  place_bet_count: number
  win_share_pct: number
  prev_win_share_pct: number
  pct_change: number
}

export type RaceStatus = 'unknown' | 'pending' | 'pre' | 'active' | 'ended'

export interface WSMessage {
  type: 'snapshot' | 'status' | 'error' | 'race_changed' | 'race_ended'
  race_no: number | null
  scraped_at: string | null
  snapshot_id: number | null
  entry_count: number | null
  message: string | null
  race_start_time: string | null
  race_status?: RaceStatus
  entries: BetEntry[]
  aggregates: HorseAggregate[]
}

export interface TrackedRace {
  race_no: number
  start_time: string | null
  last_scrape_at: string | null
  status: RaceStatus
  ended_at: string | null
  manual_extend_until: string | null
  last_entry_count: number
}

export interface ArchivedRace {
  race_no: number
  start_time: string | null
  ended_at: string | null
  last_entry_count: number
  total_db_entries: number
  aggregates: HorseAggregate[]
}

export interface TimePoint {
  time: string      // ISO string
  win_share_pct: number
}

export interface ComboAggregate {
  pair: string          // e.g. "1-2"
  quin_amount: number   // total HK$ quinella bets on this pair
  place_quin_amount: number  // total HK$ quinella place bets
  quin_count: number
  place_quin_count: number
  total_amount: number
}

export interface HorseInfo {
  horse_no: number
  horse_name: string
  horse_code: string | null
  barrier: string           // 檔位 — from race card
  trainer: string           // 練馬師 — from race card
  jockey: string            // 騎師   — from race card
  recent_results: string    // 近6次成績 — from race card
  ma288_score: string       // from horse profile
  distance_summary_html: string  // raw outerHTML of table.distanceSummary
}

export interface HorseInfoResponse {
  status: 'ready' | 'loading'
  horses: HorseInfo[]
}

export interface MeetingHorse {
  horse_no: number
  horse_name: string
  trainer: string
  jockey: string
  is_favorite: boolean
  finish_position: number | null   // 1=W, 2 or 3=Q, null=no result yet
}

export interface MeetingRace {
  race_no: number
  horses: MeetingHorse[]
}

export interface MeetingSummary {
  race_date: string
  race_date_hkjc: string
  racecourse: string
  venue_name: string
  total_races: number
  races: MeetingRace[]
}

export interface TrainerGridResponse {
  status: 'ready' | 'loading'
  summary: MeetingSummary | null
}
