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
    isCollapsed: false,
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
  expect(await idle.find({ type: 'Text', text: /^ctx 212k$/ })).toBeDefined()
  expect(await idle.find({ type: 'Text', text: /21%/ })).toBeUndefined()
  expect((await idle.find({ type: 'Text', text: /^5h 92%$/ }))?.props.color).toBe('error')
  expect(await idle.find({ type: 'Text', text: /^1h12m$/ })).toBeDefined()
  expect((await idle.find({ type: 'Text', text: /^wk 71%$/ }))?.props.color).toBeUndefined()
  expect((await idle.find({ type: 'Text', text: /^· out (\w{3}|\d\d:\d\d)$/ }))?.props.color).toBe('warning')
  expect(await idle.find({ type: 'Text', text: /^fable 12%$/ })).toBeDefined()
  expect(await idle.findAll({ type: 'Text', text: /^│$/ })).toHaveLength(3)
  await idle.unmount()

  await step($)
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(4)
  expect((await desktop.find({ type: 'Text', text: /^5h 92%$/ }))?.props.color).toBe('error')
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
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  let compactions = 0
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: START, context: { tokens: 30_000, window: 1_000_000, percent: 3 }, rateLimits: [] },
  }))
  on('command.run', { command: 'compact' }, () => {
    compactions += 1

    return { text: '' }
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
  await clock.advance(1)
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

test('Compact also appears once the cache is cold', { options: { ttl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 120_000, window: 1_000_000, percent: 12 },
    rateLimits: [],
    changed: ['context'],
  })
  await step($)

  const warm = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await warm.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  await warm.unmount()

  await clock.advance(301_000)
  for (const surface of SURFACES) {
    const cold = await $.ui.mount({ ...BAND, surface })
    expect(await cold.find({ type: 'Text', text: /^cold$/ })).toBeDefined()
    expect(await cold.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await cold.unmount()
  }
})

const HOUR = 3_600_000
const HIT = {
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 16, output_tokens: 1, cache_read_input_tokens: 212_000, cache_creation_input_tokens: 4 },
} as const

function answerFork(on: On, counter: { forks: number }, reply: () => unknown = () => HIT) {
  on('model.fork', () => {
    counter.forks += 1

    return { value: reply() as typeof HIT }
  })
}

function answerToasts(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return toasts
}

function holdAsk(args: string) {
  return { ...ASK, command: 'hold', args }
}

test('the hold row appears five minutes before a 1h cache goes cold', { options: { ttl: '1h' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  answerStart(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)

  const early = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await early.find({ type: 'Button', key: 'hold-3h' })).toBeUndefined()
  await early.unmount()

  await clock.advance(55 * 60_000 + 1000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    for (const key of ['hold-1h', 'hold-3h', 'hold-8h', 'hold-12h', 'hold-morning', 'other', 'compact-now', 'cold']) {
      expect(await ui.find({ type: 'Button', key })).toBeDefined()
    }
    expect(await ui.find({ type: 'Button', key: 'warm' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a chip keeps the cache warm until that time, then ends', { options: { ttl: '1h' }, timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const counter = { forks: 0 }
  answerBand(on)
  answerSteps(on, CACHED)
  answerStart(on)
  answerFork(on, counter)
  const toasts = answerToasts(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await clock.advance(55 * 60_000 + 1000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hold-3h' })
  expect((await ui.find({ type: 'Text', text: /^warm until / }))?.props.color).toBe('success')
  expect(await ui.find({ type: 'Button', key: 'hold-3h' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()

  await clock.advance(2000)
  expect(counter.forks).toBe(1)

  await clock.advance(54 * 60_000)
  expect(counter.forks).toBe(1)
  await clock.advance(2 * 60_000)
  expect(counter.forks).toBe(2)

  await clock.advance(2 * HOUR + 10 * 60_000)
  expect(counter.forks).toBe(4)
  expect(toasts.some(text => text.startsWith('Hold ended at'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^warm until / })).toBeUndefined()
  await ui.unmount()
})

test('/hold reads durations and times of day', { options: { ttl: '1h' } }, async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  expect((await $.command.run(holdAsk('1h'))).text).toContain('Nothing is cached yet')

  await step($)
  expect((await $.command.run(holdAsk(''))).text).toContain('No hold.')
  expect((await $.command.run(holdAsk('banana'))).text).toContain('Could not read "banana"')
  expect((await $.command.run(holdAsk('30h'))).text).toContain('24 hours at most')
  expect((await $.command.run(holdAsk('25:00'))).text).toContain('not a time of day')
  expect((await $.command.run(holdAsk('1h30m'))).text).toContain('1h 30m from now')
  expect((await $.command.run(holdAsk(''))).text).toContain('Keeping the cache warm until')
  expect((await $.command.run(holdAsk('7pm'))).text).toMatch(/until (\w{3} )?19:00/)
  expect((await $.command.run(holdAsk('07:30'))).text).toMatch(/until (\w{3} )?07:30/)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^warm until (\w{3} )?07:30$/ })).toBeDefined()
  await ui.unmount()

  expect((await $.command.run(holdAsk('off'))).text).toContain('Hold stopped')
  expect((await $.command.run(holdAsk('off'))).text).toContain('No hold to stop')
})

test('a message from the person ends the hold, a task notification does not', { options: { ttl: '1h' } }, async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await step($)
  await $.command.run(holdAsk('8h'))

  await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } } as never)
  expect((await $.command.run(holdAsk(''))).text).toContain('Keeping the cache warm until')

  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } } as never)
  expect((await $.command.run(holdAsk(''))).text).toContain('No hold.')
})

test('a full 5-hour limit pauses the hold and says so', { options: { ttl: '1h' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const counter = { forks: 0 }
  answerBand(on)
  answerSteps(on, CACHED)
  answerStart(on)
  answerFork(on, counter)
  const toasts = answerToasts(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const resetsAt = new Date(START + 2 * HOUR).toISOString()
  const measure = (percentUsed: number) =>
    $.session.measure({
      context: { tokens: 212_000, window: 1_000_000, percent: 21 },
      rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }],
      changed: ['rateLimits'],
    })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure(100)
  await step($)
  await $.command.run(holdAsk('3h'))
  await clock.advance(55 * 60_000 + 2000)
  expect(counter.forks).toBe(0)
  expect(toasts.some(text => text.includes('5-hour limit is full'))).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^can't keep warm until / }))?.props.color).toBe('warning')

  await measure(40)
  await clock.advance(61_000)
  expect(counter.forks).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^can't keep warm/ })).toBeUndefined()
  await ui.unmount()
})

test('a rate-limited ping keeps retrying until the cache goes cold', { options: { ttl: '1h' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const counter = { forks: 0 }
  answerBand(on)
  answerSteps(on, CACHED)
  answerStart(on)
  answerFork(on, counter, () => ({
    isAnswered: false,
    reason: 'api-error',
    status: 429,
    error: 'rate_limit',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }))
  const toasts = answerToasts(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await $.command.run(holdAsk('3h'))
  await clock.advance(55 * 60_000 + 2000)
  expect(counter.forks).toBe(1)
  await clock.advance(61_000)
  expect(counter.forks).toBe(2)

  await clock.advance(5 * 60_000)
  expect(toasts.at(-1)).toContain('went cold while the 5-hour limit was full')
  expect(toasts.filter(text => text.includes('went cold'))).toHaveLength(1)
  expect((await $.command.run(holdAsk(''))).text).toContain('No hold.')
})

test('Let it go cold hides the row, Other… takes a typed time', { options: { ttl: '1h' } }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  answerBand(on)
  answerSteps(on, CACHED)
  answerStart(on)
  const toasts = answerToasts(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($)
  await clock.advance(56 * 60_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'cold' })
  expect(await ui.find({ type: 'Button', key: 'hold-1h' })).toBeUndefined()
  await ui.unmount()

  await step($)
  await clock.advance(56 * 60_000)
  const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await again.press({ key: 'other' })
  expect(await again.find({ type: 'Input', key: 'back' })).toBeDefined()
  await again.input({ key: 'back', text: 'soon' })
  expect(toasts.at(-1)).toContain('Could not read "soon"')
  await again.input({ key: 'back', text: '2h' })
  expect(await again.find({ type: 'Text', text: /^warm until / })).toBeDefined()
  expect(await again.find({ type: 'Input', key: 'back' })).toBeUndefined()
  await again.unmount()
})

test('the week meter says when it runs out, and only then', async ($, on) => {
  mock.clock(on, { now: START })
  answerBand(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const week = (percentUsed: number, hoursLeft: number, fable?: number) =>
    $.session.measure({
      context: { tokens: 50_000, window: 1_000_000, percent: 5 },
      rateLimits: [
        { kind: 'seven_day', percentUsed, resetsAt: new Date(START + hoursLeft * HOUR).toISOString() },
        ...(fable === undefined
          ? []
          : [{ kind: 'seven_day_fable', percentUsed: fable, resetsAt: new Date(START + hoursLeft * HOUR).toISOString() }]),
      ],
      changed: ['rateLimits'],
    })

  await week(30, 112, 30)
  const calm = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await calm.find({ type: 'Text', text: /^wk 30%$/ })).toBeDefined()
  expect(await calm.find({ type: 'Text', text: /out|pace/ })).toBeUndefined()
  expect(await calm.find({ type: 'Text', text: /^fable/ })).toBeUndefined()
  await calm.unmount()

  await week(45, 112, 50)
  const ahead = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ahead.find({ type: 'Text', text: /^wk 45%$/ }))?.props.color).toBeUndefined()
  expect(await ahead.findAll({ type: 'Text', text: /^· out / })).toHaveLength(2)
  expect(await ahead.find({ type: 'Text', text: /^fable 50%$/ })).toBeDefined()
  await ahead.unmount()

  await week(4, 162)
  const fresh = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await fresh.find({ type: 'Text', text: /^wk 4%$/ })).toBeDefined()
  expect(await fresh.find({ type: 'Text', text: /out|6d18h/ })).toBeUndefined()
  await fresh.unmount()

  await week(100, 30)
  const out = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await out.find({ type: 'Text', text: /^· out until / }))?.props.color).toBe('warning')
  expect((await out.find({ type: 'Text', text: /^wk 100%$/ }))?.props.color).toBe('error')
  await out.unmount()
})
