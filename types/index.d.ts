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
}

export type Gauges = {
  tokens: number | null
  meters: Meter[]
}

export type Busy = 'warming' | 'compacting'

declare module 'claude-code' {
  interface PluginState {
    'cache-countdown': {
      touch: CacheTouch | null
      tiers: CacheTier[]
      transcript: string | null
      gauges: Gauges
      busy: Busy | null
    }
  }
}
