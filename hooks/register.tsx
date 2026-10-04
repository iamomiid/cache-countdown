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

import type { Busy, CacheTier, CacheTouch, Gauges, Meter } from '../types'

type Phase = 'warm' | 'soon' | 'cold'
type Level = 'calm' | 'warn' | 'full'
type MeterView = {
  label: string
  lead: string | null
  percent: number
  level: Level
  trail: string | null
  isContext: boolean
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
type Scene = {
  view: View | null
  meters: MeterView[]
  busy: Busy | null
  canWarm: boolean
  canCompact: boolean
}
type Actions = { onWarm: () => unknown; onCompact: () => unknown }

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
const LEVEL_COLOR: Record<Level, string | null> = { calm: null, warn: 'warning', full: 'error' }
const SVG_CALM = '#8a9692'
const SVG_FILL: Record<Phase, string> = { warm: SVG_CALM, soon: '#d99a2b', cold: '#e0604a' }
const SVG_LEVEL: Record<Level, string> = { calm: SVG_CALM, warn: '#d99a2b', full: '#e0604a' }
const FUSE_PX = 220
const METER_PX = 26
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
const KEEP_WARM_PROMPT = 'Reply with the single word: ok'
const NO_GAUGES: Gauges = { tokens: null, meters: [] }

const touch = atom({ plugin: 'cache-countdown', key: 'touch' } as const, null)
const tiers = atom({ plugin: 'cache-countdown', key: 'tiers' } as const, [])
const transcript = atom({ plugin: 'cache-countdown', key: 'transcript' } as const, null)
const gauges = atom({ plugin: 'cache-countdown', key: 'gauges' } as const, NO_GAUGES)
const busy = atom({ plugin: 'cache-countdown', key: 'busy' } as const, null)

let drawn = ''
let flying = 0
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

function meterViewOf(meter: Meter, now: number): MeterView {
  const level: Level = meter.percent >= 90 ? 'full' : meter.percent >= 70 ? 'warn' : 'calm'

  return {
    label: meter.label,
    lead: meter.tokens === null ? null : compactOf(meter.tokens),
    percent: Math.round(meter.percent),
    level,
    trail: resetsOf(meter.resetsAt, now),
    isContext: meter.tokens !== null,
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

function meterSvg(meter: MeterView): string {
  return barSvg(METER_PX, 1, Math.min(1, meter.percent / 100), SVG_LEVEL[meter.level], SVG_CALM)
}

function meterText(meter: MeterView): string {
  const lead = meter.lead === null ? '' : ` ${meter.lead}`
  const trail = meter.trail === null ? '' : ` ${meter.trail}`

  return `${meter.label}${lead} ${meter.percent}%${trail}`
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

async function keepWarm($: EngineInterface): Promise<void> {
  const last = await read($, touch)

  if (last === null || (await read($, busy)) !== null) {
    return
  }

  await update($, busy, () => 'warming')

  try {
    const sentAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: KEEP_WARM_PROMPT })

    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      $.ui.toast('Nothing to keep warm yet.')

      return
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
      $.ui.toast(`Cache kept warm: ${compactOf(served)} tokens read from it.`)

      return
    }

    $.ui.toast(
      served + written === 0
        ? 'Keep warm did not reach the model. The countdown is unchanged.'
        : `Keep warm missed the cache: ${compactOf(written)} tokens were written again. The countdown is unchanged.`,
      { timeoutMs: 12_000 },
    )
  } finally {
    await update($, busy, () => null)
  }
}

async function compactNow($: EngineInterface): Promise<void> {
  if ((await read($, busy)) !== null) {
    return
  }

  await update($, busy, () => 'compacting')

  try {
    const outcome = await $.session.compact().catch(() => null)

    if (outcome === null) {
      $.ui.toast('Cannot compact while a turn is running.')
    } else if ('skip' in outcome) {
      $.ui.toast(`Compaction skipped: ${outcome.skip}`)
    }
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
  const label = [view.time, view.life, view.note, Math.round(view.fraction * FUSE_PX), meters].join()

  if (label !== drawn) {
    drawn = label
    $.ui.invalidate('ui.render')
  }

  const isWorthIt = held.tokens === null || held.tokens >= WORTH_ACTING_TOKENS

  if (isToasting && view.isKnown && isWorthIt && flying === 0) {
    announce($, view)
  }
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

  return {
    view,
    meters: held.meters.map(meter => meterViewOf(meter, now)),
    busy: await read($, busy),
    canWarm: view !== null && view.phase === 'soon',
    canCompact: tokens > COMPACT_MIN_TOKENS || isColdAndLarge,
  }
}

function drawDesktop(table: Elements['desktop'], scene: Scene, actions: Actions): RenderElement {
  const { Box, Text, Svg, Button } = table
  const { view, meters } = scene

  return (
    <Box columnGap={3} flexWrap="wrap" alignItems="center" justifyContent="space-between">
      {view !== null && (
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
            <Text>{meter.lead === null ? meter.label : `${meter.label} ${meter.lead}`}</Text>
            <Svg
              source={meterSvg(meter)}
              alt={`${meter.percent}% used`}
              width={METER_PX}
              height={BAR_HEIGHT_PX}
            />
            <Text {...tint(LEVEL_COLOR[meter.level])}>{meter.percent}%</Text>
            {meter.trail !== null && <Text>{meter.trail}</Text>}
            {meter.isContext && scene.busy === 'compacting' && <Text>compacting</Text>}
            {meter.isContext && scene.canCompact && scene.busy === null && (
              <Button key="compact" label="Compact" onPress={actions.onCompact} />
            )}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function drawTerminal(table: Elements['terminal'], scene: Scene, actions: Actions): RenderElement {
  const { Box, Text, Button } = table
  const { view, meters } = scene
  const lit = view === null ? 0 : Math.ceil(view.fraction * TERMINAL_CELLS)

  return (
    <Box columnGap={2} flexWrap="wrap">
      {view !== null && (
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
          <Text {...tint(LEVEL_COLOR[meter.level])}>{meterText(meter)}</Text>
          {meter.isContext && scene.busy === 'compacting' && <Text>compacting</Text>}
          {meter.isContext && scene.canCompact && scene.busy === null && (
            <Button key="compact" label="Compact" onPress={actions.onCompact} />
          )}
        </Box>
      ))}
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
