import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const START = 1_700_000_000_000
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'cache-countdown',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const
const ASK = {
  command: 'cache-countdown',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const
const CACHED: TurnUsage = {
  input_tokens: 0,
  output_tokens: 50,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 100,
  model: 'claude-test',
}
const HOUR_ROW = JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  message: {
    usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } },
  },
})

function answerSteps(on: On, usage: TurnUsage | null) {
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage,
    }
  })
}

function answerBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: ['empty band'] })
  })
}

function answerStart(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
}

async function step($: Engine, agentId?: string) {
  const input = { turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 }
  const stream = $.turn.step(agentId === undefined ? input : { ...input, agentId })

  for await (const _chunk of stream) {
    continue
  }
}

test('draws nothing before a cached request or a usage reading', async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /empty band/ })).toBeDefined()
    await ui.unmount()
  }
})

test('burns down from the last main request', { options: { ttl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  answerStart(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /^5:00$/ })).toBeDefined()
  expect((await desktop.find({ type: 'Svg' }))?.props.alt).toBe('100% of the cache lifetime left')
  expect(await desktop.find({ type: 'Text', text: /^5m$/ })).toBeDefined()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /^━+$/ }))?.text).toHaveLength(24)

  await clock.advance(270_000)
  expect((await desktop.find({ type: 'Text', text: /^0:30$/ }))?.props.color).toBe('warning')
  expect(await desktop.find({ type: 'Text', text: /about to lapse/ })).toBeDefined()
  expect((await terminal.find({ type: 'Text', text: /^━+$/ }))?.text).toHaveLength(3)

  await clock.advance(60_000)
  expect((await desktop.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('error')
  expect(await desktop.find({ type: 'Text', text: /next message rewrites the whole context/ })).toBeDefined()
  expect((await terminal.find({ type: 'Text', text: /^─+$/ }))?.text).toHaveLength(24)
  await desktop.unmount()
  await terminal.unmount()
})

test('an unconfirmed lifetime counts 5m first, then 1h', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  await step($)

  const early = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await early.find({ type: 'Text', text: /^5:00$/ })).toBeDefined()
  expect(await early.find({ type: 'Text', text: /^5m or 1h$/ })).toBeDefined()
  await early.unmount()

  await clock.advance(360_000)
  const late = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await late.find({ type: 'Text', text: /^54m$/ })).toBeDefined()
  expect(await late.find({ type: 'Text', text: /^1h, if not on 5m$/ })).toBeDefined()
  await late.unmount()
})

test('a subagent request does not reset the fuse', { options: { ttl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  await step($)
  await clock.advance(120_000)
  await step($, 'agent-1')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^3:00$/ })).toBeDefined()
  await ui.unmount()
})

test('a request with no cache activity is not a touch', async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, { ...CACHED, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /empty band/ })).toBeDefined()
  await ui.unmount()
})

test('reads the lifetime from the transcript', async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: `{"type":"user"}\n${HOUR_ROW}\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('classic.UserPromptSubmit', () => ({}))
  await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: '/tmp/session.jsonl' })
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^60m$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1h$/ })).toBeDefined()
  await ui.unmount()
})

test('flags a request that rewrote the cache', { options: { ttl: '1h' } }, async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  let usage = CACHED
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage,
    }
  })
  await step($)
  usage = { ...CACHED, cache_read_input_tokens: 0, cache_creation_input_tokens: 203_000 }
  await step($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const flag = await ui.find({ type: 'Text', text: /last request rewrote 203k tokens/ })
  expect(flag?.props.color).toBe('warning')
  await ui.unmount()
})

test('shows context and rate limit meters', { options: { ttl: '1h' } }, async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 212_000, window: 1_000_000, percent: 21 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 92, resetsAt: new Date(START + 72 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 71.4, resetsAt: new Date(START + 100 * 3_600_000).toISOString() },
      { kind: 'seven_day_fable', percentUsed: 12 },
    ],
    changed: ['context', 'rateLimits'],
  })

  const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await idle.find({ type: 'Text', text: /^ctx 212k 21%$/ })).toBeDefined()
  expect((await idle.find({ type: 'Text', text: /^5h 92% 1h12m$/ }))?.props.color).toBe('error')
  expect((await idle.find({ type: 'Text', text: /^wk 71% 4d4h$/ }))?.props.color).toBe('warning')
  expect(await idle.find({ type: 'Text', text: /^fable 12%$/ })).toBeDefined()
  expect(await idle.findAll({ type: 'Text', text: /^│$/ })).toHaveLength(3)
  await idle.unmount()

  await step($)
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(8)
  expect((await desktop.find({ type: 'Text', text: /^92%$/ }))?.props.color).toBe('error')
  expect(await desktop.find({ type: 'Text', text: /^1h12m$/ })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^ctx 212k$/ })).toBeDefined()
  await desktop.unmount()
})

test('/cache-countdown answers in text', { options: { ttl: '5m' } }, async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  expect((await $.command.run(ASK)).text).toContain('No cached request')

  await step($)
  const answer = await $.command.run(ASK)
  expect(answer.text).toContain('Prompt cache (5m): 5:00 left.')
  expect(answer.text).toContain('90% read from cache')
})

test('toasts before and at expiry of a known lifetime', { options: { ttl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  const toasts: string[] = []
  answerSteps(on, CACHED)
  answerStart(on)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)

  await clock.advance(230_000)
  expect(toasts).toEqual([])

  await clock.advance(15_000)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('goes cold in')

  await clock.advance(60_000)
  expect(toasts).toHaveLength(2)
  expect(toasts[1]).toContain('went cold')

  await clock.advance(600_000)
  expect(toasts).toHaveLength(2)
})

test('Keep warm appears near expiry and restarts the fuse on a cache hit', { options: { ttl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  const toasts: string[] = []
  answerSteps(on, CACHED)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'ok',
      usage: {
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: 212_000,
        cache_creation_input_tokens: 0,
      },
    },
  }))
  await step($)

  for (const surface of SURFACES) {
    const early = await $.ui.mount({ ...BAND, surface })
    expect(await early.find({ type: 'Button', key: 'warm' })).toBeUndefined()
    await early.unmount()
  }

  await clock.advance(270_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'warm' })).toBeDefined()
  await ui.press({ key: 'warm' })
  expect(await ui.find({ type: 'Text', text: /^5:00$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'warm' })).toBeUndefined()
  expect(toasts.at(-1)).toContain('212k tokens read')
  await ui.unmount()
})

test('Keep warm leaves the countdown alone when the request misses the cache', { options: { ttl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  const toasts: string[] = []
  answerSteps(on, CACHED)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: 'ok',
      usage: {
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 212_000,
      },
    },
  }))
  await step($)
  await clock.advance(270_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'warm' })
  expect(await ui.find({ type: 'Text', text: /^0:30$/ })).toBeDefined()
  expect(toasts.at(-1)).toContain('missed the cache')
  await ui.unmount()
})

test('Compact appears past 200k tokens of context and compacts', async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  let compactions = 0
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: START, context: { tokens: 30_000, window: 1_000_000, percent: 3 }, rateLimits: [] },
  }))
  on('session.compact', () => {
    compactions += 1

    return { messages: [] }
  })
  await $.session.measure({
    context: { tokens: 150_000, window: 1_000_000, percent: 15 },
    rateLimits: [],
    changed: ['context'],
  })

  const small = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await small.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await small.unmount()

  await $.session.measure({
    context: { tokens: 460_000, window: 1_000_000, percent: 46 },
    rateLimits: [],
    changed: ['context'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect(compactions).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^ctx 30k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await ui.unmount()
})

test('keeps what other mods draw in the band', { options: { ttl: '5m' } }, async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  await step($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^5:00$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /empty band/ })).toBeDefined()
    await ui.unmount()
  }
})
