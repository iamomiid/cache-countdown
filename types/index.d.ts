export type CacheTier = '5m' | '1h'

export type CacheTouch = {
  at: number
  read: number
  written: number
  uncached: number
  model: string
  isRebuilt: boolean
}

export type Meter = {
  label: string
  percent: number
  tokens: number | null
  resetsAt: string | null
  isWeekly?: boolean
}

export type Gauges = {
  tokens: number | null
  meters: Meter[]
}

export type Busy = 'warming' | 'compacting'

export type HoldIssue = 'limit' | 'missed' | 'failed'

export type Hold = {
  startedAt: number
  until: number
  pings: number
  issue: HoldIssue | null
  retryAt: number
}

export type Offer = {
  at: number
  mode: 'chips' | 'field' | 'dismissed'
}

declare module 'claude-code' {
  interface PluginState {
    'cache-countdown': {
      touch: CacheTouch | null
      tiers: CacheTier[]
      transcript: string | null
      gauges: Gauges
      busy: Busy | null
      hold: Hold | null
      offer: Offer | null
    }
  }
}
