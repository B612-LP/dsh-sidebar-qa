import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, SidebarqaModelSelection, SidebarqaRemoteResult } from '../src/context-types.ts'
import { SIDEBARQA_DEFAULTS } from '../src/config.ts'
import { askFollowUp } from '../src/client/orchestrate.ts'
import { sidebarqaApi, type ContextResult } from '../src/client/api.ts'
import { currentModelOf } from '../src/client/session-wire.ts'
import type { SidebarqaStore } from '../src/client/store.ts'

vi.mock('../src/client/api.ts', () => ({ sidebarqaApi: { config: vi.fn(), context: vi.fn() } }))
vi.mock('../src/client/session-wire.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/session-wire.ts')>(),
  currentModelOf: vi.fn(),
}))

const parentModel = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const failure = (code = 'session/model-unavailable'): SidebarqaRemoteResult<never> => ({
  ok: false, error: { code, message: 'unavailable' },
})
const success = { ok: true as const, value: { selected: parentModel } }

function mount() {
  const session = {
    create: vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'child' } }),
    fork: vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'forked' } }),
    rename: vi.fn().mockResolvedValue({ ok: true, value: { title: 'topic', seq: 1 } }),
    selectModel: vi.fn().mockResolvedValue(success),
    prompt: vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
  }
  const ctx = {
    remote: { session },
    sessions: { list: { getSnapshot: () => ({ byId: { parent: { cwd: '/workspace' } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  } as unknown as Context
  const addChild = vi.fn()
  const store = { addChild } as unknown as SidebarqaStore
  const ask = (strategy: 'trim' | 'compressed' | 'inherit' = 'trim', modelOverride?: SidebarqaModelSelection) =>
    askFollowUp(ctx, store, { parentSessionId: 'parent', quote: { text: 'selected text' }, question: 'why?', strategy, modelOverride })
  return { session, addChild, ask }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(sidebarqaApi.config).mockResolvedValue({ ...SIDEBARQA_DEFAULTS })
  vi.mocked(sidebarqaApi.context).mockResolvedValue({ degraded: false, text: 'context', sourceSeq: 1 })
  vi.mocked(currentModelOf).mockReturnValue(parentModel)
})

describe('summary selection payload and degradation', () => {
  it('sends the complete parent selection rather than a provider-only hybrid for default compression', async () => {
    const { ask } = mount()
    await ask('compressed')
    expect(sidebarqaApi.context).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      mainSessionId: 'parent', strategy: 'compressed', parentSelection: parentModel,
    }))
    const payload = vi.mocked(sidebarqaApi.context).mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('provider')
    expect(payload).not.toHaveProperty('model')
    expect(payload).not.toHaveProperty('reasoningEffort')
  })

  it('leaves explicit summary model and effort to Host configuration instead of passing the parent', async () => {
    const { ask } = mount()
    vi.mocked(sidebarqaApi.config).mockResolvedValue({
      ...SIDEBARQA_DEFAULTS, summarizeProvider: 'summary-route', summarizeModel: 'summary-model', summarizeReasoningEffort: 'max',
    })
    await ask('compressed')
    expect(sidebarqaApi.context).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'summary-route' }))
    const payload = vi.mocked(sidebarqaApi.context).mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('parentSelection')
    expect(payload).not.toHaveProperty('model')
    expect(payload).not.toHaveProperty('reasoningEffort')
  })

  it('omits inherited selection when the parent has no model projection, without guessing a provider', async () => {
    const { ask } = mount()
    vi.mocked(currentModelOf).mockReturnValue(undefined)
    await ask('compressed')
    const payload = vi.mocked(sidebarqaApi.context).mock.calls[0]?.[0]
    expect(payload).not.toHaveProperty('parentSelection')
    expect(payload).not.toHaveProperty('provider')
  })

  it('propagates summary degradation and still prompts only the child with preserved recent context', async () => {
    const { ask, session } = mount()
    vi.mocked(sidebarqaApi.context).mockResolvedValue({
      degraded: true, text: 'preserved recent context', sourceSeq: 4, reason: 'summary-unavailable',
    })
    expect(await ask('compressed')).toMatchObject({ degraded: true, sideSessionId: 'child', strategy: 'compressed' })
    expect(session.prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: 'child', content: [{ type: 'text', text: expect.stringContaining('preserved recent context') }],
    }))
  })

  it('propagates a context request failure without claiming recent text was available', async () => {
    const { ask, session } = mount()
    vi.mocked(sidebarqaApi.context).mockRejectedValue(new Error('context route offline'))
    expect(await ask('compressed')).toMatchObject({ degraded: true, sideSessionId: 'child' })
    expect(session.prompt).toHaveBeenCalledOnce()
    expect(session.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'child' })
    expect(session.prompt.mock.calls[0]?.[0].content[0].text).not.toContain('undefined')
  })

  it('waits for context assembly before selecting the answer model or prompting', async () => {
    const { ask, session } = mount()
    let finishContext!: (result: ContextResult) => void
    vi.mocked(sidebarqaApi.context).mockReturnValue(new Promise(resolve => { finishContext = resolve }))
    const pending = ask('compressed')
    await vi.waitFor(() => expect(session.create).toHaveBeenCalledOnce())
    expect(session.selectModel).not.toHaveBeenCalled()
    expect(session.prompt).not.toHaveBeenCalled()
    finishContext({ degraded: true, text: 'recent context', sourceSeq: 4, reason: 'summary-unavailable' })
    await pending
    expect(session.selectModel).toHaveBeenCalledOnce()
    expect(session.prompt).toHaveBeenCalledOnce()
  })
})

describe('model-safe independent follow-up orchestration', () => {
  it.each(['trim', 'compressed'] as const)('pins the configured model before a %s prompt, touching only the child', async strategy => {
    const { session, ask, addChild } = mount()
    const result = await ask(strategy)
    expect(result.modelFallback).toBe(false)
    expect(session.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'child', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' })
    expect(session.prompt).toHaveBeenCalledOnce()
    expect(session.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'child', mode: 'queue' })
    expect(session.selectModel.mock.invocationCallOrder[0]).toBeLessThan(session.prompt.mock.invocationCallOrder[0]!)
    expect(addChild).toHaveBeenCalledWith('parent', 'child')
    expect(session.fork).not.toHaveBeenCalled()
  })

  it('falls back only from the unavailable configured model, preserving the parent effort', async () => {
    const { session, ask } = mount()
    session.selectModel.mockResolvedValueOnce(failure()).mockResolvedValueOnce(success)
    expect(await ask()).toMatchObject({ modelFallback: true, acceptedSelection: parentModel })
    expect(session.selectModel).toHaveBeenNthCalledWith(2, { sessionId: 'child', ...parentModel })
    expect(session.prompt).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'max'])('does not top up a deliberate panel pick effort (%s) with configured off', async effort => {
    const { session, ask } = mount()
    const selection = { provider: 'chosen', model: 'chosen-model', ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    await ask('trim', selection)
    expect(session.selectModel).toHaveBeenCalledExactlyOnceWith({ sessionId: 'child', ...selection })
  })

  it('reports the Host accepted selection, not the requested model or catalog default', async () => {
    const { session, ask } = mount()
    const accepted = { provider: 'actual-route', model: 'actual-model' }
    session.selectModel.mockResolvedValueOnce(failure()).mockResolvedValueOnce({ ok: true, value: { selected: accepted } })
    expect(await ask()).toMatchObject({ modelFallback: true, acceptedSelection: accepted })
    expect(session.prompt).toHaveBeenCalledOnce()
  })

  it('does not invent an effort when the parent omits it', async () => {
    const { session, ask } = mount()
    vi.mocked(currentModelOf).mockReturnValue({ provider: 'parent-route', model: 'parent-model' })
    session.selectModel.mockResolvedValueOnce(failure()).mockResolvedValueOnce(success)
    await ask()
    expect(session.selectModel).toHaveBeenNthCalledWith(2, { sessionId: 'child', provider: 'parent-route', model: 'parent-model' })
  })

  it.each(['explicit', 'no-parent', 'fallback-failed', 'transport', 'thrown'] as const)('never prompts after model selection failure: %s', async scenario => {
    const { session, ask, addChild } = mount()
    session.selectModel.mockResolvedValue(failure())
    if (scenario === 'no-parent') vi.mocked(currentModelOf).mockReturnValue(undefined)
    if (scenario === 'transport') session.selectModel.mockResolvedValue(failure('gateway/internal'))
    if (scenario === 'thrown') session.selectModel.mockRejectedValue(new Error('transport broke'))
    await expect(ask('trim', scenario === 'explicit' ? parentModel : undefined)).rejects.toThrow()
    expect(session.prompt).not.toHaveBeenCalled()
    expect(addChild).not.toHaveBeenCalled()
    expect(session.selectModel).toHaveBeenCalledTimes(scenario === 'fallback-failed' ? 2 : 1)
  })

  it('inherit keeps the fork model and never selects another model', async () => {
    const { session, ask } = mount()
    const result = await ask('inherit')
    expect(result).toMatchObject({ strategy: 'inherit', sideSessionId: 'forked' })
    expect(session.selectModel).not.toHaveBeenCalled()
    expect(session.create).not.toHaveBeenCalled()
    expect(session.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'forked' })
  })

  it('a failed fork degrades to compressed and still pins the fallback model before prompting', async () => {
    const { session, ask } = mount()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      session.fork.mockResolvedValue(failure('session/fork-unavailable'))
      session.selectModel.mockResolvedValueOnce(failure()).mockResolvedValueOnce(success)
      expect(await ask('inherit')).toMatchObject({ strategy: 'compressed', modelFallback: true })
      expect(session.create).toHaveBeenCalledOnce()
      expect(session.prompt).toHaveBeenCalledOnce()
      expect(session.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'child' })
    } finally {
      warning.mockRestore()
    }
  })
})
