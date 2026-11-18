import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  Register,
  RenderElement,
  SessionContextUsage,
  SessionRateLimit,
  TurnUsage,
} from 'claude-code'

import type { Busy, CacheTier, CacheTouch, Gauges, Hold, HoldIssue, Meter, Offer } from '../types'

type Phase = 'warm' | 'soon' | 'cold'
type Level = 'calm' | 'full'
type MeterView = {
  label: string
  lead: string | null
  percent: number
  level: Level
  trail: string | null
  isNews: boolean
  isContext: boolean
  pace: Pace | null
  isHidden: boolean
}
type Pace = {
  par: number
  projected: number | null
  isAhead: boolean
  news: string | null
}
type View = {
  tier: CacheTier
  isKnown: boolean
  phase: Phase
  leftMs: number
  time: string
  fraction: number
  life: string
  note: string | null
  isNoteWarning: boolean
}
type HoldView = { label: string; fraction: number; issue: string | null }
type Chip = { key: string; label: string }
type OfferMode = 'chips' | 'field'
type Scene = {
  view: View | null
  meters: MeterView[]
  busy: Busy | null
  canWarm: boolean
  canCompact: boolean
  hold: HoldView | null
  offer: OfferMode | null
  chips: Chip[]
  canCompactNow: boolean
}
type Actions = {
  onWarm: () => unknown
  onCompact: () => unknown
  onChip: (key: string) => unknown
  onOther: () => unknown
  onBack: () => unknown
  onSubmit: (text: string) => unknown
  onCold: () => unknown
  onStop: () => unknown
}
type Ping =
  | { kind: 'warm'; served: number }
  | { kind: 'missed'; written: number }
  | { kind: 'limit' }
  | { kind: 'failed' }
  | { kind: 'nothing' }
type Back = { until: number } | { isOff: true } | { error: string }

type TranscriptRow = {
  type?: string
  isSidechain?: boolean
  message?: {
    usage?: {
      cache_creation?: {
        ephemeral_5m_input_tokens?: number
        ephemeral_1h_input_tokens?: number
      }
    }
  }
}

const ALL_TIERS: readonly CacheTier[] = ['5m', '1h']
const TTL_MS: Record<CacheTier, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const WARN_MS: Record<CacheTier, number> = { '5m': 60_000, '1h': 5 * 60_000 }
const SEGMENTS: Record<CacheTier, number> = { '5m': 5, '1h': 6 }
const WRITTEN_FIELD = {
  '5m': 'ephemeral_5m_input_tokens',
  '1h': 'ephemeral_1h_input_tokens',
} as const
const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'wk',
  spend_limit: 'spend',
}
const PHASE_COLOR: Record<Phase, string | null> = { warm: null, soon: 'warning', cold: 'error' }
const LEVEL_COLOR: Record<Level, string | null> = { calm: null, full: 'error' }
const SVG_CALM = '#8a9692'
const SVG_FILL: Record<Phase, string> = { warm: SVG_CALM, soon: '#d99a2b', cold: '#e0604a' }
const FUSE_PX = 220
const BAR_HEIGHT_PX = 12
const DIVIDER_WIDTH_PX = 9
const DIVIDER_HEIGHT_PX = 16
const DIVIDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_WIDTH_PX}" height="${DIVIDER_HEIGHT_PX}" viewBox="0 0 ${DIVIDER_WIDTH_PX} ${DIVIDER_HEIGHT_PX}"><rect x="4" width="1" height="${DIVIDER_HEIGHT_PX}" fill="${SVG_CALM}" fill-opacity="0.85"/></svg>`
const TERMINAL_CELLS = 24
const TAIL_BYTES = 400_000
const EXPIRY_TOAST_WINDOW_MS = 10_000
const REBUILD_MIN_TOKENS = 10_000
const WORTH_ACTING_TOKENS = 20_000
const COMPACT_MIN_TOKENS = 200_000
const REFUSAL_MARKER = '$.command.run: '
const KEEP_WARM_PROMPT = 'Reply with the single word: ok'
const NO_GAUGES: Gauges = { tokens: null, meters: [] }
const WEEK_MS = 7 * 24 * 60 * 60_000
const PACE_SETTLE_MS = 12 * 60 * 60_000
const MAIN_WEEK = 'wk'
const HOUR_MS = 60 * 60_000
const HOLD_MIN_MS = 60_000
const HOLD_MAX_MS = 24 * HOUR_MS
const HOLD_RETRY_MS = 60_000
const HOLD_HOURS = [1, 3, 8, 12] as const
const MORNING_HOUR = 9
const SVG_OK = '#5fbf8f'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const STOP_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])
const HOLD_USAGE = 'Say when you will be back: /hold 12h, /hold 90m, /hold 07:30, /hold 7pm, or /hold off.'

const touch = atom({ plugin: 'cache-countdown', key: 'touch' } as const, null)
const tiers = atom({ plugin: 'cache-countdown', key: 'tiers' } as const, [])
const transcript = atom({ plugin: 'cache-countdown', key: 'transcript' } as const, null)
const gauges = atom({ plugin: 'cache-countdown', key: 'gauges' } as const, NO_GAUGES)
const busy = atom({ plugin: 'cache-countdown', key: 'busy' } as const, null)
const hold = atom({ plugin: 'cache-countdown', key: 'hold' } as const, null)
const offer = atom({ plugin: 'cache-countdown', key: 'offer' } as const, null)

let drawn = ''
let flying = 0
let pinging = false
let toastedAt = 0
const toasted = new Set<string>()

function clockOf(ms: number): string {
  const seconds = Math.ceil(ms / 1000)

  if (seconds >= 600) {
    return `${Math.ceil(seconds / 60)}m`
  }

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function compactOf(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }

  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

function resetsOf(resetsAt: string | null, now: number): string | null {
  const ms = resetsAt === null ? Number.NaN : Date.parse(resetsAt) - now

  if (Number.isNaN(ms) || ms <= 0) {
    return null
  }

  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)

  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d${hours % 24}h`
  }

  return hours >= 1 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function timeOf(at: number, now: number): string {
  const date = new Date(at)
  const isToday = date.toDateString() === new Date(now).toDateString()

  return isToday ? hhmm(date) : `${DAYS[date.getDay()]} ${hhmm(date)}`
}

function spanOf(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  if (hours === 0) {
    return `${rest}m`
  }

  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

function nextClock(hours: number, minutes: number, now: number): number {
  const date = new Date(now)
  date.setHours(hours, minutes, 0, 0)

  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1)
  }

  return date.getTime()
}

function morningOf(now: number): { until: number; label: string } {
  const until = nextClock(MORNING_HOUR, 0, now)
  const isToday = new Date(until).toDateString() === new Date(now).toDateString()

  return { until, label: isToday ? `${MORNING_HOUR}:00` : `${MORNING_HOUR}:00 tomorrow` }
}

function backOf(text: string, now: number): Back {
  const typed = text.trim().toLowerCase()

  if (['off', 'stop', 'cancel', 'none'].includes(typed)) {
    return { isOff: true }
  }

  const clock = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(typed)

  if (clock !== null && (clock[2] !== undefined || clock[3] !== undefined)) {
    const minutes = Number(clock[2] ?? 0)
    let hours = Number(clock[1])

    if (clock[3] !== undefined) {
      hours = hours < 1 || hours > 12 ? Number.NaN : (hours % 12) + (clock[3] === 'pm' ? 12 : 0)
    }

    if (Number.isNaN(hours) || hours > 23 || minutes > 59) {
      return { error: `${text.trim()} is not a time of day. ${HOLD_USAGE}` }
    }

    return { until: nextClock(hours, minutes, now) }
  }

  const span = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/.exec(typed)

  if (span !== null && (span[1] !== undefined || span[2] !== undefined)) {
    return { until: now + Number(span[1] ?? 0) * HOUR_MS + Number(span[2] ?? 0) * 60_000 }
  }

  return { error: typed === '' ? HOLD_USAGE : `Could not read "${text.trim()}". ${HOLD_USAGE}` }
}

function fiveHourOf(held: Gauges): Meter | null {
  return held.meters.find(meter => meter.label === WINDOW_LABEL.five_hour) ?? null
}

function issueOf(issue: HoldIssue | null, held: Gauges, now: number): string | null {
  if (issue === 'limit') {
    const resetsAt = fiveHourOf(held)?.resetsAt ?? null
    const at = resetsAt === null ? Number.NaN : Date.parse(resetsAt)

    return Number.isNaN(at) || at <= now
      ? "can't keep warm: 5-hour limit full"
      : `can't keep warm until ${timeOf(at, now)}: 5-hour limit full`
  }

  return issue === 'failed' ? 'last keep-warm failed, retrying' : null
}

function tint(color: string | null): { color?: string } {
  return color === null ? {} : { color }
}

function noteOf(last: CacheTouch, phase: Phase, tokens: number | null): string | null {
  if (phase === 'cold') {
    return tokens === null
      ? 'next message rewrites the whole context'
      : `next message rewrites ${compactOf(tokens)} tokens`
  }

  if (last.isRebuilt) {
    return `last request rewrote ${compactOf(last.written)} tokens`
  }

  return phase === 'soon' ? 'about to lapse' : null
}

function viewOf(
  last: CacheTouch,
  forced: CacheTier | null,
  detected: readonly CacheTier[],
  tokens: number | null,
  now: number,
): View {
  const only = detected.length === 1 ? detected[0] : undefined
  const isFiveLive = last.at + TTL_MS['5m'] - now > 0
  const tier = forced ?? only ?? (isFiveLive ? '5m' : '1h')
  const isKnown = forced !== null || only !== undefined
  const isMixed = detected.length > 1
  const guess = isFiveLive
    ? isMixed
      ? '5m, then 1h'
      : '5m or 1h'
    : isMixed
      ? '1h, 5m part lapsed'
      : '1h, if not on 5m'
  const leftMs = last.at + TTL_MS[tier] - now
  const phase: Phase = leftMs <= 0 ? 'cold' : leftMs <= WARN_MS[tier] ? 'soon' : 'warm'

  return {
    tier,
    isKnown,
    phase,
    leftMs,
    time: phase === 'cold' ? 'cold' : clockOf(leftMs),
    fraction: Math.max(0, Math.min(1, leftMs / TTL_MS[tier])),
    life: isKnown ? tier : guess,
    note: noteOf(last, phase, tokens),
    isNoteWarning: phase !== 'cold' && last.isRebuilt,
  }
}

function dayOf(at: number, now: number): string {
  const date = new Date(at)

  return date.toDateString() === new Date(now).toDateString() ? hhmm(date) : (DAYS[date.getDay()] ?? hhmm(date))
}

function paceOf(meter: Meter, now: number): Pace | null {
  const end = meter.isWeekly === true && meter.resetsAt !== null ? Date.parse(meter.resetsAt) : Number.NaN
  const start = end - WEEK_MS
  const elapsed = now - start

  if (Number.isNaN(end) || elapsed <= 0 || elapsed > WEEK_MS) {
    return null
  }

  const par = (elapsed / WEEK_MS) * 100

  if (elapsed < PACE_SETTLE_MS || meter.percent <= 0) {
    return { par, projected: null, isAhead: false, news: null }
  }

  const projected = (meter.percent / elapsed) * WEEK_MS
  const runsOutAt = start + (100 / meter.percent) * elapsed

  if (meter.percent >= 100) {
    return { par, projected, isAhead: true, news: `out until ${dayOf(end, now)}` }
  }

  return projected > 100
    ? { par, projected, isAhead: true, news: `out ${dayOf(runsOutAt, now)}` }
    : { par, projected, isAhead: false, news: null }
}

function meterViewOf(meter: Meter, now: number): MeterView {
  const pace = paceOf(meter, now)
  const level: Level = meter.percent >= 90 ? 'full' : 'calm'
  const news = pace?.news ?? null

  return {
    label: meter.label,
    lead: meter.tokens === null ? null : compactOf(meter.tokens),
    percent: Math.round(meter.percent),
    level,
    trail: news ?? (level === 'full' ? resetsOf(meter.resetsAt, now) : null),
    isNews: news !== null,
    isContext: meter.tokens !== null,
    pace,
    isHidden: meter.label !== MAIN_WEEK && pace !== null && pace.projected !== null && !pace.isAhead,
  }
}

function gaugesOf(context: SessionContextUsage, limits: readonly SessionRateLimit[]): Gauges {
  const fill: Meter[] =
    context.percent === undefined
      ? []
      : [{ label: 'ctx', percent: context.percent, tokens: context.tokens ?? 0, resetsAt: null }]
  const windows = limits.map(limit => ({
    label: WINDOW_LABEL[limit.kind] ?? limit.kind.replace(/^seven_day_/, '').replaceAll('_', ' '),
    percent: limit.percentUsed,
    tokens: null,
    resetsAt: limit.resetsAt ?? null,
    isWeekly: limit.kind.startsWith('seven_day'),
  }))

  return { tokens: context.tokens ?? null, meters: [...fill, ...windows] }
}

function barSvg(width: number, segments: number, fraction: number, fill: string, track: string): string {
  const gap = 2
  const segment = (width - gap * (segments - 1)) / segments
  const filled = fraction * width
  const y = (BAR_HEIGHT_PX - 4) / 2
  const rects: string[] = []

  for (let i = 0; i < segments; i += 1) {
    const x = i * (segment + gap)
    const lit = Math.max(0, Math.min(segment, filled - x))
    rects.push(
      `<rect x="${x.toFixed(2)}" y="${y}" width="${segment.toFixed(2)}" height="4" rx="2" fill="${track}" fill-opacity="0.32"/>`,
    )

    if (lit > 0) {
      rects.push(
        `<rect x="${x.toFixed(2)}" y="${y}" width="${lit.toFixed(2)}" height="4" rx="2" fill="${fill}"/>`,
      )
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT_PX}" viewBox="0 0 ${width} ${BAR_HEIGHT_PX}">${rects.join('')}</svg>`
}

function fuseSvg(view: View): string {
  const track = view.phase === 'cold' ? SVG_FILL.cold : SVG_CALM

  return barSvg(FUSE_PX, SEGMENTS[view.tier], view.fraction, SVG_FILL[view.phase], track)
}

function headOf(meter: MeterView): string {
  return meter.isContext ? `${meter.label} ${meter.lead ?? ''}`.trim() : `${meter.label} ${meter.percent}%`
}

function trailOf(meter: MeterView): string | null {
  if (meter.trail === null) {
    return null
  }

  return meter.isNews ? `· ${meter.trail}` : meter.trail
}

function meterText(meter: MeterView): string {
  const trail = trailOf(meter)

  return trail === null ? headOf(meter) : `${headOf(meter)} ${trail}`
}

function tiersOfRow(line: string): CacheTier[] {
  if (!line.includes('"cache_creation"')) {
    return []
  }

  let row: TranscriptRow | null = null

  try {
    row = JSON.parse(line) as TranscriptRow | null
  } catch {
    return []
  }

  const isMainReply =
    row !== null && typeof row === 'object' && row.type === 'assistant' && row.isSidechain !== true

  if (!isMainReply) {
    return []
  }

  const written = row?.message?.usage?.cache_creation

  return ALL_TIERS.filter(tier => (written?.[WRITTEN_FIELD[tier]] ?? 0) > 0)
}

function tiersOfTranscript(text: string): CacheTier[] {
  const lines = text.split('\n')

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const found = tiersOfRow(lines[i] ?? '')

    if (found.length > 0) {
      return found
    }
  }

  return []
}

async function tailOf($: EngineInterface, path: string): Promise<string> {
  const tail = await $.process
    .run(['tail', '-c', String(TAIL_BYTES), path])
    .catch(() => null)

  if (tail !== null && tail.exitCode === 0) {
    return tail.stdout
  }

  return $.fs.read(path).catch(() => '')
}

async function remember($: EngineInterface, path: string): Promise<void> {
  if ((await read($, transcript)) !== path) {
    await update($, transcript, () => path)
  }
}

async function detect($: EngineInterface): Promise<void> {
  const path = await read($, transcript)

  if (path === null) {
    return
  }

  const found = tiersOfTranscript(await tailOf($, path))
  const known = await read($, tiers)

  if (found.length > 0 && found.join() !== known.join()) {
    await update($, tiers, () => found)
  }
}

async function measure(
  $: EngineInterface,
  context: SessionContextUsage,
  limits: readonly SessionRateLimit[],
): Promise<void> {
  const next = gaugesOf(context, limits)
  await update($, gauges, () => next)
}

async function remeasure($: EngineInterface): Promise<void> {
  const usage = await $.session.usage().catch(() => null)

  if (usage !== null) {
    await measure($, usage.context, usage.rateLimits)
  }
}

async function note(
  $: EngineInterface,
  sentAt: number,
  usage: TurnUsage,
  forced: CacheTier | null,
): Promise<void> {
  if (usage.cache_read_input_tokens + usage.cache_creation_input_tokens === 0) {
    return
  }

  const before = await read($, touch)
  const isRebuilt =
    before !== null &&
    usage.cache_creation_input_tokens >= REBUILD_MIN_TOKENS &&
    usage.cache_creation_input_tokens > usage.cache_read_input_tokens
  const next: CacheTouch = {
    at: sentAt,
    read: usage.cache_read_input_tokens,
    written: usage.cache_creation_input_tokens,
    uncached: usage.input_tokens,
    model: usage.model,
    isRebuilt,
  }
  await update($, touch, () => next)

  if (forced === null && (await read($, tiers)).length === 0) {
    await detect($)
  }
}

async function ping($: EngineInterface): Promise<Ping> {
  const last = await read($, touch)

  if (last === null) {
    return { kind: 'nothing' }
  }

  await update($, busy, () => 'warming')

  try {
    const sentAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })

    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      return { kind: 'nothing' }
    }

    if (!reply.isAnswered && reply.reason === 'api-error' && reply.error === 'rate_limit') {
      return { kind: 'limit' }
    }

    const served = reply.usage.cache_read_input_tokens
    const written = reply.usage.cache_creation_input_tokens

    if (served > written) {
      const next: CacheTouch = {
        at: sentAt,
        read: served,
        written,
        uncached: reply.usage.input_tokens,
        model: last.model,
        isRebuilt: false,
      }
      await update($, touch, () => next)

      return { kind: 'warm', served }
    }

    return served + written === 0 ? { kind: 'failed' } : { kind: 'missed', written }
  } finally {
    await update($, busy, () => null)
  }
}

async function keepWarm($: EngineInterface): Promise<void> {
  if ((await read($, touch)) === null || (await read($, busy)) !== null || pinging) {
    return
  }

  pinging = true

  try {
    const outcome = await ping($)

    if (outcome.kind === 'nothing') {
      $.ui.toast('Nothing to keep warm yet.')
    } else if (outcome.kind === 'warm') {
      $.ui.toast(`Cache kept warm: ${compactOf(outcome.served)} tokens read from it.`)
    } else if (outcome.kind === 'limit') {
      $.ui.toast('Keep warm hit the 5-hour limit. The countdown is unchanged.', { timeoutMs: 12_000 })
    } else {
      $.ui.toast(
        outcome.kind === 'failed'
          ? 'Keep warm did not reach the model. The countdown is unchanged.'
          : `Keep warm missed the cache: ${compactOf(outcome.written)} tokens were written again. The countdown is unchanged.`,
        { timeoutMs: 12_000 },
      )
    }
  } finally {
    pinging = false
  }
}

async function startHold(
  $: EngineInterface,
  until: number,
  forced: CacheTier | null,
): Promise<string | null> {
  const last = await read($, touch)
  const now = await $.clock.now()

  if (last === null) {
    return 'Nothing is cached yet, so there is nothing to keep warm.'
  }

  const view = viewOf(last, forced, await read($, tiers), (await read($, gauges)).tokens, now)

  if (view.phase === 'cold') {
    return 'The cache is already cold. Send a message to cache the conversation again, then hold.'
  }

  if (until - now < HOLD_MIN_MS) {
    return 'That is less than a minute away.'
  }

  if (until - now > HOLD_MAX_MS) {
    return 'A hold lasts 24 hours at most. Past about a day and a half, the pings cost more than writing the cache again.'
  }

  const next: Hold = { startedAt: now, until, pings: 0, issue: null, retryAt: 0 }
  await update($, hold, () => next)
  await update($, offer, () => null)

  return null
}

async function endHold($: EngineInterface, text: string | null): Promise<void> {
  if ((await read($, hold)) === null) {
    return
  }

  await update($, hold, () => null)

  if (text !== null) {
    $.ui.toast(text, { timeoutMs: 12_000 })
  }
}

async function chooseOffer($: EngineInterface, mode: Offer['mode']): Promise<void> {
  const last = await read($, touch)

  if (last !== null) {
    const next: Offer = { at: last.at, mode }
    await update($, offer, () => next)
  }
}

async function holdFromChip($: EngineInterface, key: string, forced: CacheTier | null): Promise<void> {
  const now = await $.clock.now()
  const hours = HOLD_HOURS.find(count => key === `hold-${count}h`)
  const until = hours === undefined ? morningOf(now).until : now + hours * HOUR_MS
  const refused = await startHold($, until, forced)

  if (refused !== null) {
    $.ui.toast(refused)
  }
}

async function holdFromText($: EngineInterface, text: string, forced: CacheTier | null): Promise<void> {
  const back = backOf(text, await $.clock.now())

  if ('error' in back) {
    $.ui.toast(back.error, { timeoutMs: 12_000 })

    return
  }

  if ('isOff' in back) {
    await endHold($, null)
    await chooseOffer($, 'chips')

    return
  }

  const refused = await startHold($, back.until, forced)

  if (refused !== null) {
    $.ui.toast(refused, { timeoutMs: 12_000 })
  }
}

async function guardHold($: EngineInterface, last: CacheTouch, view: View, held: Gauges, now: number): Promise<void> {
  const current = await read($, hold)

  if (current === null) {
    return
  }

  if (now >= current.until) {
    await endHold(
      $,
      view.phase === 'cold'
        ? `Hold ended at ${timeOf(current.until, now)}.`
        : `Hold ended at ${timeOf(current.until, now)}. The cache stays warm for ${clockOf(view.leftMs)} more.`,
    )

    return
  }

  if (view.phase === 'cold') {
    toasted.add(`${view.tier}:cold`)
    await endHold(
      $,
      current.issue === 'limit'
        ? 'Hold ended: the cache went cold while the 5-hour limit was full.'
        : 'Hold ended: the cache went cold.',
    )

    return
  }

  const outlivesHold = last.at + TTL_MS[view.tier] >= current.until
  const isDue = view.leftMs <= WARN_MS[view.tier] && now >= current.retryAt

  if (outlivesHold || !isDue || pinging || flying > 0 || (await read($, busy)) !== null) {
    return
  }

  const five = fiveHourOf(held)

  if (five !== null && five.percent >= 100) {
    await holdIssue($, current, 'limit', now)

    return
  }

  pinging = true

  try {
    const outcome = await ping($)

    if (outcome.kind === 'warm') {
      const next: Hold = { ...current, pings: current.pings + 1, issue: null, retryAt: 0 }
      await update($, hold, () => next)
    } else if (outcome.kind === 'missed') {
      await endHold($, 'Hold stopped: the keep-warm request missed the cache and wrote it again.')
    } else {
      await holdIssue($, current, outcome.kind === 'limit' ? 'limit' : 'failed', now)
    }
  } finally {
    pinging = false
  }
}

async function holdIssue($: EngineInterface, current: Hold, issue: HoldIssue, now: number): Promise<void> {
  if (issue === 'limit' && current.issue !== 'limit') {
    $.ui.toast("Can't keep the cache warm: the 5-hour limit is full. Retrying every minute.", {
      timeoutMs: 12_000,
    })
  }

  const next: Hold = { ...current, issue, retryAt: now + HOLD_RETRY_MS }
  await update($, hold, () => next)
}

function refusalOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const at = text.lastIndexOf(REFUSAL_MARKER)

  return at === -1 ? text : text.slice(at + REFUSAL_MARKER.length)
}

async function compactNow($: EngineInterface): Promise<void> {
  if ((await read($, busy)) !== null) {
    return
  }

  await update($, busy, () => 'compacting')
  $.clock.after(0, () => runCompact($))
}

async function runCompact($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'compact' })
  } catch (error) {
    $.ui.toast(`Could not compact: ${refusalOf(error)}`)
  } finally {
    await update($, busy, () => null)
    await remeasure($)
  }
}

function announce($: EngineInterface, view: View): void {
  const isExpired = view.phase === 'cold'
  const isStale = isExpired && -view.leftMs > EXPIRY_TOAST_WINDOW_MS
  const id = `${view.tier}:${view.phase}`

  if (view.phase === 'warm' || isStale || toasted.has(id)) {
    return
  }

  toasted.add(id)
  $.ui.toast(
    isExpired
      ? `Prompt cache (${view.tier}) went cold. The next message caches the whole context again.`
      : `Prompt cache (${view.tier}) goes cold in ${clockOf(view.leftMs)}.`,
    { timeoutMs: 8000 },
  )
}

async function tick(
  $: EngineInterface,
  forced: CacheTier | null,
  isToasting: boolean,
): Promise<void> {
  const last = await read($, touch)
  const now = await $.clock.now()
  const held = await read($, gauges)
  const meters = held.meters.map(meter => meterText(meterViewOf(meter, now))).join()

  if (last === null) {
    if (meters !== drawn) {
      drawn = meters
      $.ui.invalidate('ui.render')
    }

    return
  }

  if (last.at !== toastedAt) {
    toasted.clear()
    toastedAt = last.at
  }

  const view = viewOf(last, forced, await read($, tiers), held.tokens, now)
  await guardHold($, last, view, held, now)
  const current = await read($, hold)
  const holding =
    current === null ? '' : [current.until, current.issue, Math.round(holdFraction(current, now) * FUSE_PX)].join(':')
  const label = [view.time, view.life, view.note, Math.round(view.fraction * FUSE_PX), meters, holding].join()

  if (label !== drawn) {
    drawn = label
    $.ui.invalidate('ui.render')
  }

  const isWorthIt = held.tokens === null || held.tokens >= WORTH_ACTING_TOKENS

  if (isToasting && view.isKnown && isWorthIt && flying === 0 && current === null) {
    announce($, view)
  }
}

function holdFraction(current: Hold, now: number): number {
  const span = current.until - current.startedAt

  return span <= 0 ? 0 : Math.max(0, Math.min(1, (current.until - now) / span))
}

async function sceneOf($: EngineInterface, forced: CacheTier | null): Promise<Scene | null> {
  const last = await read($, touch)
  const held = await read($, gauges)

  if (last === null && held.meters.length === 0) {
    return null
  }

  const now = await $.clock.now()
  const view = last === null ? null : viewOf(last, forced, await read($, tiers), held.tokens, now)

  const tokens = held.tokens ?? 0
  const isColdAndLarge = view !== null && view.phase === 'cold' && tokens >= WORTH_ACTING_TOKENS
  const isWorthIt = held.tokens === null || held.tokens >= WORTH_ACTING_TOKENS
  const current = await read($, hold)
  const chosen = await read($, offer)
  const isThisTouch = last !== null && chosen !== null && chosen.at === last.at
  const canOffer =
    view !== null && current === null && view.tier === '1h' && view.phase === 'soon' && isWorthIt
  const offerMode: OfferMode | null =
    isThisTouch && chosen.mode === 'field' && view?.phase !== 'cold'
      ? 'field'
      : canOffer && !(isThisTouch && chosen.mode === 'dismissed')
        ? 'chips'
        : null
  const morning = morningOf(now)

  return {
    view,
    meters: held.meters.map(meter => meterViewOf(meter, now)).filter(meter => !meter.isHidden),
    busy: await read($, busy),
    canWarm: view !== null && view.phase === 'soon' && view.tier === '5m' && current === null,
    canCompact: (tokens > COMPACT_MIN_TOKENS || isColdAndLarge) && offerMode === null,
    hold:
      current === null
        ? null
        : {
            label: `warm until ${timeOf(current.until, now)}`,
            fraction: holdFraction(current, now),
            issue: issueOf(current.issue, held, now),
          },
    offer: offerMode,
    chips: [
      ...HOLD_HOURS.map(count => ({ key: `hold-${count}h`, label: `${count}h` })),
      { key: 'hold-morning', label: morning.label },
    ],
    canCompactNow: isWorthIt,
  }
}

function holdSvg(hold: HoldView): string {
  return barSvg(FUSE_PX, SEGMENTS['1h'], hold.fraction, SVG_OK, SVG_CALM)
}

function offerDesktop(table: Elements['desktop'], scene: Scene, actions: Actions): RenderElement | null {
  const { Box, Text, Button, Input } = table

  if (scene.offer === 'field') {
    return (
      <Box columnGap={1} alignItems="center">
        <Input
          key="back"
          label="Back at"
          placeholder="12h, 90m, 07:30 or 7pm"
          submitLabel="keep warm"
          autoFocus
          onSubmit={actions.onSubmit}
        />
        <Button key="chips" label="Back" onPress={actions.onBack} />
      </Box>
    )
  }

  if (scene.offer !== 'chips') {
    return null
  }

  return (
    <Box columnGap={1} flexWrap="wrap" alignItems="center">
      <Text>Back in</Text>
      {scene.chips.map(chip => (
        <Button key={chip.key} label={chip.label} onPress={() => actions.onChip(chip.key)} />
      ))}
      <Button key="other" label="Other…" onPress={actions.onOther} />
      {scene.canCompactNow && scene.busy === null && (
        <Button key="compact-now" label="Compact now" onPress={actions.onCompact} />
      )}
      <Button key="cold" label="Let it go cold" onPress={actions.onCold} />
    </Box>
  )
}

function offerTerminal(table: Elements['terminal'], scene: Scene, actions: Actions): RenderElement | null {
  const { Box, Text, Button, Input } = table

  if (scene.offer === 'field') {
    return (
      <Box columnGap={1}>
        <Input
          key="back"
          label="back at"
          placeholder="12h, 90m, 07:30 or 7pm"
          submitLabel="keep warm"
          autoFocus
          onSubmit={actions.onSubmit}
        />
        <Button key="chips" label="back" onPress={actions.onBack} />
      </Box>
    )
  }

  if (scene.offer !== 'chips') {
    return null
  }

  return (
    <Box columnGap={2} flexWrap="wrap">
      <Text>back in</Text>
      {scene.chips.map(chip => (
        <Button key={chip.key} label={chip.label} onPress={() => actions.onChip(chip.key)} />
      ))}
      <Button key="other" label="other…" onPress={actions.onOther} />
      <Text>│</Text>
      {scene.canCompactNow && scene.busy === null && (
        <Button key="compact-now" label="Compact now" onPress={actions.onCompact} />
      )}
      <Button key="cold" label="Let it go cold" onPress={actions.onCold} />
    </Box>
  )
}

function drawDesktop(table: Elements['desktop'], scene: Scene, actions: Actions): RenderElement {
  const { Box, Text, Svg, Button } = table
  const { view, meters, hold: holding } = scene
  const offered = offerDesktop(table, scene, actions)

  const row = (
    <Box columnGap={3} flexWrap="wrap" alignItems="center" justifyContent="space-between">
      {holding !== null && (
        <Box columnGap={1} alignItems="center">
          <Text bold color="success">
            {holding.label}
          </Text>
          <Svg
            source={holdSvg(holding)}
            alt={`${Math.round(holding.fraction * 100)}% of the hold left`}
            width={FUSE_PX}
            height={BAR_HEIGHT_PX}
          />
          {holding.issue !== null && <Text color="warning">{holding.issue}</Text>}
          {scene.busy === 'warming' && <Text>warming</Text>}
          <Button key="change" label="Change" onPress={actions.onOther} />
          <Button key="stop" label="Stop" onPress={actions.onStop} />
        </Box>
      )}
      {holding === null && view !== null && (
        <Box columnGap={1} alignItems="center">
          <Text bold {...tint(PHASE_COLOR[view.phase])}>
            {view.time}
          </Text>
          <Svg
            source={fuseSvg(view)}
            alt={`${Math.round(view.fraction * 100)}% of the cache lifetime left`}
            width={FUSE_PX}
            height={BAR_HEIGHT_PX}
          />
          <Text>{view.life}</Text>
          {view.note !== null && (
            <Text {...tint(view.isNoteWarning ? 'warning' : null)}>{view.note}</Text>
          )}
          {scene.busy === 'warming' && <Text>warming</Text>}
          {scene.canWarm && scene.busy === null && (
            <Button key="warm" label="Keep warm" variant="primary" onPress={actions.onWarm} />
          )}
        </Box>
      )}
      <Box columnGap={2} flexWrap="wrap" alignItems="center">
        {meters.map((meter, index) => (
          <Box columnGap={1} alignItems="center">
            {index > 0 && (
              <Svg
                source={DIVIDER_SVG}
                alt="divider"
                width={DIVIDER_WIDTH_PX}
                height={DIVIDER_HEIGHT_PX}
              />
            )}
            {meterRun(table, meter)}
            {meter.isContext && scene.busy === 'compacting' && <Text>compacting</Text>}
            {meter.isContext && scene.canCompact && scene.busy === null && (
              <Button key="compact" label="Compact" onPress={actions.onCompact} />
            )}
          </Box>
        ))}
      </Box>
    </Box>
  )

  return offered === null ? (
    row
  ) : (
    <Box flexDirection="column" rowGap={1}>
      {row}
      {offered}
    </Box>
  )
}

function meterRun(table: Elements['terminal'] | Elements['desktop'], meter: MeterView): RenderElement {
  const { Box, Text } = table
  const trail = trailOf(meter)

  return (
    <Box columnGap={1}>
      <Text {...tint(LEVEL_COLOR[meter.level])}>{headOf(meter)}</Text>
      {trail !== null && <Text {...tint(meter.isNews ? 'warning' : null)}>{trail}</Text>}
    </Box>
  )
}

function drawTerminal(table: Elements['terminal'], scene: Scene, actions: Actions): RenderElement {
  const { Box, Text, Button } = table
  const { view, meters, hold: holding } = scene
  const lit = view === null ? 0 : Math.ceil(view.fraction * TERMINAL_CELLS)
  const held = holding === null ? 0 : Math.ceil(holding.fraction * TERMINAL_CELLS)
  const offered = offerTerminal(table, scene, actions)

  const row = (
    <Box columnGap={2} flexWrap="wrap">
      {holding !== null && (
        <Box columnGap={1}>
          <Text bold color="success">
            {holding.label}
          </Text>
          <Box>
            <Text color="success">{'━'.repeat(held)}</Text>
            <Text>{'─'.repeat(TERMINAL_CELLS - held)}</Text>
          </Box>
          {holding.issue !== null && <Text color="warning">{holding.issue}</Text>}
          {scene.busy === 'warming' && <Text>warming</Text>}
          <Button key="change" label="change" onPress={actions.onOther} />
          <Button key="stop" label="stop" onPress={actions.onStop} />
        </Box>
      )}
      {holding === null && view !== null && (
        <Box columnGap={1}>
          <Text bold {...tint(PHASE_COLOR[view.phase])}>
            {view.time}
          </Text>
          <Box>
            <Text {...tint(PHASE_COLOR[view.phase])}>{'━'.repeat(lit)}</Text>
            <Text>{'─'.repeat(TERMINAL_CELLS - lit)}</Text>
          </Box>
          <Text>{view.life}</Text>
          {view.note !== null && (
            <Text {...tint(view.isNoteWarning ? 'warning' : null)}>{view.note}</Text>
          )}
          {scene.busy === 'warming' && <Text>warming</Text>}
          {scene.canWarm && scene.busy === null && (
            <Button key="warm" label="Keep warm" variant="primary" onPress={actions.onWarm} />
          )}
        </Box>
      )}
      {meters.map((meter, index) => (
        <Box columnGap={2}>
          {index > 0 && <Text>│</Text>}
          {meterRun(table, meter)}
          {meter.isContext && scene.busy === 'compacting' && <Text>compacting</Text>}
          {meter.isContext && scene.canCompact && scene.busy === null && (
            <Button key="compact" label="Compact" onPress={actions.onCompact} />
          )}
        </Box>
      ))}
    </Box>
  )

  return offered === null ? (
    row
  ) : (
    <Box flexDirection="column">
      {row}
      {offered}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const forced: CacheTier | null = options.ttl === '5m' || options.ttl === '1h' ? options.ttl : null
  const isToasting = options.toast !== false

  on('session.start', async ($, e, next) => {
    $.clock.every(1000, () => {
      void tick($, forced, isToasting)
    })
    await update($, busy, () => null)
    await remeasure($)
    await $.command.register({
      name: 'cache-countdown',
      description: 'Show how long the prompt cache stays warm',
      immediate: true,
    })
    await $.command.register({
      name: 'hold',
      description: 'Keep the prompt cache warm until you are back: /hold 12h, /hold 07:30, /hold off',
      immediate: true,
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await measure($, e.context, e.rateLimits)

    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await remember($, e.transcript_path)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson = STOP_ORIGINS.has(e.origin.kind) && e.command === undefined && e.isMeta !== true

    if (isPerson) {
      await endHold($, null)
      await update($, offer, () => null)
    }

    return next(e)
  })

  on('command.run', { command: 'hold' }, async ($, e) => {
    const now = await $.clock.now()
    const current = await read($, hold)

    if (e.args.trim() === '') {
      return {
        text:
          current === null
            ? `No hold. ${HOLD_USAGE}`
            : `Keeping the cache warm until ${timeOf(current.until, now)}, ${spanOf(current.until - now)} from now, ${current.pings} ${current.pings === 1 ? 'ping' : 'pings'} so far. /hold off stops it.`,
      }
    }

    const back = backOf(e.args, now)

    if ('error' in back) {
      return { text: back.error }
    }

    if ('isOff' in back) {
      await endHold($, null)

      return { text: current === null ? 'No hold to stop.' : 'Hold stopped. The cache goes cold on its usual schedule.' }
    }

    const refused = await startHold($, back.until, forced)

    return {
      text:
        refused ??
        `Keeping the cache warm until ${timeOf(back.until, now)}, ${spanOf(back.until - now)} from now. Sending a message ends the hold.`,
    }
  })

  on('classic.Stop', async ($, e, next) => {
    await remember($, e.transcript_path)

    if (forced === null) {
      await detect($)
    }

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await remember($, e.transcript_path)
    await remeasure($)

    if (e.seconds_since_last_response !== undefined) {
      const at = (await $.clock.now()) - e.seconds_since_last_response * 1000
      const resumed: CacheTouch = {
        at,
        read: 0,
        written: 0,
        uncached: 0,
        model: e.model ?? '',
        isRebuilt: false,
      }
      await update($, touch, () => resumed)
    }

    if (forced === null) {
      await detect($)
    }

    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.source !== 'resume' && e.from_model !== e.to_model) {
      await update($, touch, () => null)

      if (forced === null) {
        await update($, tiers, () => [e.cache_ttl])
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const sentAt = await $.clock.now()
    flying += isMain ? 1 : 0

    try {
      const result = yield* next(e)

      if (isMain && result.usage !== null) {
        await note($, sentAt, result.usage, forced)
      }

      return result
    } finally {
      flying -= isMain ? 1 : 0
    }
  })

  on('command.run', { command: 'cache-countdown' }, async $ => {
    const last = await read($, touch)
    const held = await read($, gauges)
    const now = await $.clock.now()
    const meters = held.meters.map(meter => meterText(meterViewOf(meter, now)))
    const reported = meters.length === 0 ? [] : [meters.join(', ')]

    if (last === null) {
      return { text: ['No cached request seen in this conversation yet.', ...reported].join('\n') }
    }

    const view = viewOf(last, forced, await read($, tiers), held.tokens, now)
    const state = view.phase === 'cold' ? 'cold' : `${view.time} left`
    const total = last.read + last.written + last.uncached
    const share =
      total === 0
        ? []
        : [
            `Last request: ${Math.round((last.read / total) * 100)}% read from cache (${last.read} read, ${last.written} written, ${last.uncached} uncached).`,
          ]
    const lines = [
      `Prompt cache (${view.life}): ${state}${view.note === null ? '' : `, ${view.note}`}.`,
    ]

    return { text: [...lines, ...share, ...reported].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const scene = await sceneOf($, forced)

    if (e.props.hasSurvey || scene === null) {
      return next(e)
    }

    const actions: Actions = {
      onWarm: () => keepWarm($),
      onCompact: () => compactNow($),
      onChip: key => holdFromChip($, key, forced),
      onOther: () => chooseOffer($, 'field'),
      onBack: () => chooseOffer($, 'chips'),
      onSubmit: text => holdFromText($, text, forced),
      onCold: () => chooseOffer($, 'dismissed'),
      onStop: () => endHold($, null),
    }

    if (e.surface === 'desktop') {
      const table = $.ui.resolve(e)
      const { Box } = table

      return (
        <Box flexDirection="column">
          {drawDesktop(table, scene, actions)}
          {await next(e)}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const table = $.ui.resolve(e)
      const { Box } = table

      return (
        <Box flexDirection="column">
          {drawTerminal(table, scene, actions)}
          {await next(e)}
        </Box>
      )
    }

    return next(e)
  })
}
