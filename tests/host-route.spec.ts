import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { SIDEBARQA_DEFAULTS, type SidebarqaConfig, type SidebarqaLiveConfig } from '../src/config.ts'
import type { Context, SidebarqaLlmRequest, SidebarqaStreamChunk } from '../src/context-types.ts'
import type { ContextResult } from '../src/client/api.ts'

/**
 * Wiring test for the /sidebarqa/api trust fence: `apply` must read the
 * authorities from the CURRENT host face (`webStartup`), fall back to the legacy
 * `webRuntime` / loader literal, and accept the listener's bind address.
 *
 * The fence itself is covered by `trust-fence.spec.ts`; this file proves the
 * route is actually wired to those sources. It reproduced the 0.2.1 regression
 * where the fence read only `webRuntime` (removed) and silently degraded to
 * loopback-only.
 */

interface FakeResponse {
  statusCode: number
  body: string
  writeHead(status: number): void
  end(body: string): void
}

function fakeRequest(headers: Record<string, string>, method = 'config', payload: object = {}): unknown {
  return {
    method: 'POST',
    url: `/sidebarqa/api/${method}`,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number): void { this.statusCode = status },
    end(body: string): void { this.body = body },
  }
}

interface HostFaces {
  webStartup?: { trustedHosts?: unknown }
  webRuntime?: { trustedHosts?: unknown }
  loaderEntries?: { options: { id: string; name: string; config?: { trustedHosts?: unknown } } }[]
  host?: string
  protocol?: 'http:' | 'https:'
  settings?: unknown
  config?: SidebarqaLiveConfig
  llm?: unknown
  sessionQuery?: unknown
}

describe('issue #23 config read/write and effective model', () => {
  const headers = { host: '127.0.0.1' }

  it('uses entry config with a hybrid service, saves live values and refuses stale writes', async () => {
    let value = { ...SIDEBARQA_DEFAULTS, answerModel: 'custom', trimWindowMessages: 7 }
    let revision = 0
    const config = Object.fromEntries(Object.keys(value).map(key => [key, {
      get: () => value[key as keyof typeof value],
    }])) as SidebarqaLiveConfig
    const register = vi.fn(() => { throw new Error('legacy namespace must not be opened') })
    const call = mount({ config, settings: {
      register,
      configure: () => () => {},
      describe: () => [{ ns: 'sidebar-qa', value, revision }],
      update: async (id: string, patch: object, expected: number) => {
        expect(id).toBe('sidebar-qa')
        if (expected !== revision) throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })
        value = { ...value, ...patch }
        revision++
      },
    } })
    const read = async (method = 'config') => JSON.parse((await call(headers, method)).body).value
    expect(await read()).toMatchObject({ answerModel: 'custom', trimWindowMessages: 7 })
    expect(await read('config.get')).toMatchObject({ value, revision: 0 })
    const saved = await call(headers, 'config.update', { patch: { trimWindowMessages: 19 }, expectedRevision: 0 })
    expect(saved.statusCode).toBe(200)
    expect(JSON.parse(saved.body).value).toMatchObject({ value: { trimWindowMessages: 19 }, revision: 1 })
    expect(await read()).toMatchObject({ trimWindowMessages: 19 })
    expect((await call(headers, 'config.update', { patch: { trimWindowMessages: 99 }, expectedRevision: 0 })).statusCode).toBe(409)
    expect(await read()).toMatchObject({ trimWindowMessages: 19 })
    expect(register).not.toHaveBeenCalled()
  })

  it.each(['deepseek-v4-flash', 'deepseek-flash'])('uses the served %s id for answer, compression and title', async (id) => {
    const stream = vi.fn(async function* (_options: { model: string }) { yield { type: 'text-delta', index: 0, text: 'topic' } })
    const call = mount({
      llm: { listModels: async () => [{ id }], stream },
      sessionQuery: { readSurface: async () => ({ capturedThroughSeq: 4, events: [
        { type: 'user/message', data: { content: [{ type: 'text', text: 'one' }] } },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'two' }] } },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'three' }] } },
      ] }) },
    })
    expect(JSON.parse((await call(headers)).body).value.answerModel).toBe(id)
    // Stored settings remain exactly as configured; alias resolution is runtime-only.
    expect(JSON.parse((await call(headers, 'config.get')).body).value.value.answerModel).toBe('deepseek-v4-flash')
    await call(headers, 'title', { provider: 'deepseek-official', text: 'question and answer' })
    expect(stream.mock.calls.at(-1)?.[0]).toMatchObject({ model: id })
    stream.mockClear()
    await call(headers, 'context', { mainSessionId: 'parent', provider: 'deepseek-official' })
    expect(stream.mock.calls.at(-1)?.[0]).toMatchObject({ model: id })
  })
})

const SUMMARY_PARENT = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const SUMMARY_SEGMENTS = ['earlier one', 'earlier two', 'earlier three', 'recent question', 'recent answer']

/** Keep configuration live while the route/cache instance stays mounted. No real LLM calls. */
function mountSummary(options: {
  config?: Partial<SidebarqaConfig>
  segments?: readonly string[]
  stream?: (request: SidebarqaLlmRequest) => AsyncIterable<SidebarqaStreamChunk>
} = {}) {
  const config = { ...SIDEBARQA_DEFAULTS, ...options.config }
  const refs = Object.fromEntries(Object.keys(config).map(key => [key, {
    get: () => config[key as keyof SidebarqaConfig],
  }])) as SidebarqaLiveConfig
  const stream = vi.fn(options.stream ?? (async function* (_request: SidebarqaLlmRequest): AsyncIterable<SidebarqaStreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'background summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  const surface = {
    capturedThroughSeq: 4,
    events: (options.segments ?? SUMMARY_SEGMENTS).map((text, seq) => ({
      type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }] },
    })),
  }
  const call = mount({
    config: refs,
    llm: { listModels: async () => [], stream },
    sessionQuery: { readSurface: async () => surface },
  })
  const context = async (payload: Record<string, unknown> = {}): Promise<ContextResult> => {
    const response = await call({ host: '127.0.0.1' }, 'context', {
      mainSessionId: 'parent', parentSelection: SUMMARY_PARENT, ...payload,
    })
    expect(response.statusCode).toBe(200)
    const envelope = JSON.parse(response.body)
    expect(envelope.ok).toBe(true)
    return envelope.value as ContextResult
  }
  return { context, config, stream, surface }
}

function failedSummary(kind: 'throw' | 'error' | 'aborted' | 'empty' | 'whitespace') {
  return async function* (_request: SidebarqaLlmRequest): AsyncIterable<SidebarqaStreamChunk> {
    if (kind === 'throw') throw new Error('summary provider failed')
    if (kind === 'error' || kind === 'aborted') {
      yield { type: 'text-delta', index: 0, text: 'untrusted partial summary' }
      yield { type: 'finish', reason: { kind } }
    } else {
      if (kind === 'whitespace') yield { type: 'text-delta', index: 0, text: '  \n ' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

describe('compressed context route and degradation', () => {
  it('inherits the complete parent selection instead of mixing its provider with configured Flash/off', async () => {
    const { context, stream } = mountSummary()
    const result = await context()
    expect(stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(SUMMARY_PARENT))
    expect(result).toMatchObject({ degraded: false, sourceSeq: 4 })
    expect(result.text).toContain('background summary')
  })

  it('omits inherited effort when the parent leaves the provider default unspecified', async () => {
    const { context, stream } = mountSummary()
    const parentSelection = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
    expect(await context({ parentSelection })).toMatchObject({ degraded: false })
    expect(stream.mock.calls[0]?.[0]).toMatchObject(parentSelection)
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('reasoningEffort')
  })

  it('does not replace an explicit configured summary route or effort with the parent selection', async () => {
    const { context, stream } = mountSummary({ config: {
      summarizeProvider: 'fast-provider', summarizeModel: 'fast-model', summarizeReasoningEffort: 'max',
    } })
    expect(await context()).toMatchObject({ degraded: false })
    expect(stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: 'fast-provider', model: 'fast-model', reasoningEffort: 'max',
    }))
  })

  it('preserves a legacy explicit payload provider/model and the configured effort', async () => {
    const { context, stream } = mountSummary({ config: {
      summarizeProvider: 'configured-provider', summarizeModel: 'configured-model', summarizeReasoningEffort: 'off',
    } })
    await context({ provider: 'legacy-provider', model: 'legacy-model' })
    expect(stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: 'legacy-provider', model: 'legacy-model', reasoningEffort: 'off',
    }))
  })

  it('preserves the legacy provider-only request without guessing a parent model', async () => {
    const { context, stream } = mountSummary({ config: { summarizeModel: 'configured-model' } })
    await context({ provider: 'legacy-provider', parentSelection: undefined })
    expect(stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: 'legacy-provider', model: 'configured-model', reasoningEffort: 'off',
    }))
  })

  it.each([undefined, null, {}, { provider: 'p' }, { model: 'm' }, { provider: 'p', model: 1 }])(
    'reports incomplete inherited selection as degraded instead of guessing a route (%j)', async parentSelection => {
      const { context, stream } = mountSummary()
      const result = await context({ parentSelection })
      expect(result).toMatchObject({ degraded: true, reason: 'summary-unavailable', sourceSeq: 4 })
      expect(result.text).toContain('recent question')
      expect(result.text).toContain('recent answer')
      expect(result.text).not.toContain('earlier one')
      expect(stream).not.toHaveBeenCalled()
    },
  )

  it('does not require a summary route when no earlier content needs compression', async () => {
    const { context, stream } = mountSummary({ segments: ['recent question', 'recent answer'] })
    const result = await context({ parentSelection: undefined })
    expect(result).toMatchObject({ degraded: false })
    expect(result.text).toContain('recent question')
    expect(stream).not.toHaveBeenCalled()
  })

  it('keeps trim deterministic and free even without a summary route', async () => {
    const { context, stream } = mountSummary()
    const result = await context({ strategy: 'trim', parentSelection: undefined })
    expect(result).toMatchObject({ degraded: false })
    expect(result.text).toContain('earlier one')
    expect(result.text).toContain('recent answer')
    expect(stream).not.toHaveBeenCalled()
  })

  it.each(['throw', 'error', 'aborted', 'empty', 'whitespace'] as const)(
    'keeps recent text, reports degradation, and never caches a %s summary', async kind => {
      const { context, stream } = mountSummary({ stream: failedSummary(kind) })
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await context()
        expect(result).toMatchObject({ degraded: true, reason: 'summary-unavailable', sourceSeq: 4 })
        expect(result.text).toContain('recent question')
        expect(result.text).toContain('recent answer')
        expect(result.text).not.toContain('untrusted partial summary')
        expect(stream).toHaveBeenCalledTimes(attempt)
      }
    },
  )

  it('retries a failed summary at the same source sequence and caches only the later success', async () => {
    const { context, stream } = mountSummary()
    stream.mockImplementationOnce(failedSummary('error'))
    expect(await context()).toMatchObject({ degraded: true })
    const recovered = await context()
    expect(recovered).toMatchObject({ degraded: false })
    expect(recovered.text).toContain('background summary')
    expect(await context()).toEqual(recovered)
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it.each(['provider', 'model', 'effort', 'absent-vs-off', 'budget', 'recent-window', 'background-window', 'locale'] as const)(
    'keys successful summaries by %s as well as the source sequence', async axis => {
      const { context, stream, config } = mountSummary()
      let payload: Record<string, unknown> = axis === 'absent-vs-off'
        ? { parentSelection: { provider: SUMMARY_PARENT.provider, model: SUMMARY_PARENT.model } }
        : {}
      const first = await context(payload)
      expect(first.degraded).toBe(false)
      expect(await context(payload)).toEqual(first)
      expect(stream).toHaveBeenCalledOnce()
      switch (axis) {
        case 'provider': payload = { parentSelection: { ...SUMMARY_PARENT, provider: 'other-provider' } }; break
        case 'model': payload = { parentSelection: { ...SUMMARY_PARENT, model: 'other-model' } }; break
        case 'effort': payload = { parentSelection: { ...SUMMARY_PARENT, reasoningEffort: 'max' } }; break
        case 'absent-vs-off': payload = { parentSelection: { provider: SUMMARY_PARENT.provider, model: SUMMARY_PARENT.model, reasoningEffort: 'off' } }; break
        case 'budget': payload = { budgetTokens: 321 }; break
        case 'recent-window': config.recentWindowMessages = 1; break
        case 'background-window': config.backgroundWindowMessages = 1; break
        case 'locale': payload = { locale: 'en' }; break
      }
      const changed = await context(payload)
      expect(changed.degraded).toBe(false)
      expect(stream).toHaveBeenCalledTimes(2)
      expect(await context(payload)).toEqual(changed)
      expect(stream).toHaveBeenCalledTimes(2)
    },
  )

  it('invalidates a successful summary when the session surface advances', async () => {
    const { context, stream, surface } = mountSummary()
    await context()
    surface.capturedThroughSeq++
    expect(await context()).toMatchObject({ degraded: false, sourceSeq: 5 })
    expect(stream).toHaveBeenCalledTimes(2)
  })
})

/** Build the minimal host context `apply` needs, and capture its one route. */
function mount(faces: HostFaces): (headers: Record<string, string>, method?: string, payload?: object) => Promise<FakeResponse> {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined
  const ctx = {
    get: (name: string) => {
      if (name === 'webStartup') return faces.webStartup
      if (name === 'webRuntime') return faces.webRuntime
      return undefined
    },
    loader: { entries: () => faces.loaderEntries ?? [] },
    webServer: {
      register: (route: { handler: (req: never, res: never) => Promise<void> }) => {
        handler = route.handler as unknown as (req: unknown, res: unknown) => Promise<void>
        return () => {}
      },
      host: faces.host,
      protocol: faces.protocol,
    },
    inject: (_names: string[], callback: (ctx: unknown) => void) => {
      if (faces.settings !== undefined) callback(ctx)
    },
    settings: faces.settings,
    effect: (fn: () => () => void) => fn(),
    llm: faces.llm ?? {},
    sessionQuery: faces.sessionQuery ?? {},
    fiber: { entry: { options: { id: 'sidebar-qa' } } },
  } as unknown as Context

  apply(ctx, faces.config)
  return async (headers, method, payload) => {
    if (handler === undefined) throw new Error('the plugin mounted no /sidebarqa/api route')
    const response = fakeResponse()
    await handler(fakeRequest(headers, method, payload), response)
    return response
  }
}

describe('/sidebarqa/api trust fence wiring (DSH >= 0.2.1)', () => {
  it('accepts a trusted authority read from webStartup', async () => {
    const call = mount({ webStartup: { trustedHosts: ['app.example'] }, host: '127.0.0.1' })
    const response = await call({ host: 'app.example:3080' })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ ok: true })
  })

  it('accepts the listener bind address without any trusted authority', async () => {
    // `dsh web --host 10.0.0.7`: the LAN browser's Host is that literal.
    const call = mount({ webStartup: { trustedHosts: [] }, host: '10.0.0.7' })
    expect((await call({ host: '10.0.0.7:3080' })).statusCode).toBe(200)
  })

  it('refuses an untrusted authority', async () => {
    const call = mount({ webStartup: { trustedHosts: ['app.example'] }, host: '127.0.0.1' })
    const response = await call({ host: 'evil.example:3080' })
    expect(response.statusCode).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses a cross-site request even from a loopback Host', async () => {
    const call = mount({ webStartup: { trustedHosts: [] } })
    expect((await call({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403)
  })

  it('accepts a loopback Host as before', async () => {
    const call = mount({ webStartup: { trustedHosts: [] } })
    expect((await call({ host: '127.0.0.1:64396' })).statusCode).toBe(200)
  })
})

describe('/sidebarqa/api trust fence wiring (fallbacks)', () => {
  it('prefers webStartup over a legacy webRuntime face', async () => {
    // Presence decides: an authoritative empty list means loopback-only, and a
    // stale webRuntime must not widen it.
    const call = mount({
      webStartup: { trustedHosts: [] },
      webRuntime: { trustedHosts: ['legacy.example'] },
    })
    expect((await call({ host: 'legacy.example:3080' })).statusCode).toBe(403)
  })

  it('falls back to the legacy webRuntime face', async () => {
    const call = mount({ webRuntime: { trustedHosts: ['legacy.example'] } })
    expect((await call({ host: 'legacy.example:3080' })).statusCode).toBe(200)
  })

  it('falls back to the loader connection row literal', async () => {
    const call = mount({
      loaderEntries: [
        { options: { id: 'other', name: 'x' } },
        { options: { id: 'connection', name: '@deepseek-ai/dsh-client-connection', config: { trustedHosts: ['row.example'] } } },
      ],
    })
    expect((await call({ host: 'row.example:3080' })).statusCode).toBe(200)
  })

  it('does not throw on a malformed startup value (refuses instead)', async () => {
    const call = mount({ webStartup: { trustedHosts: { __jsExpr: 'ctx.webStartup.trustedHosts' } } })
    expect((await call({ host: 'app.example:3080' })).statusCode).toBe(403)
    // A loopback request still passes: an unreadable list degrades to empty.
    expect((await call({ host: '127.0.0.1:3080' })).statusCode).toBe(200)
  })
})
