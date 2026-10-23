import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { anthropicProvider, DEFAULT_MODEL, REPORT_SCHEMA, type MessagesApi } from '../src/anthropic'
import { LlmCallError } from '../src/llm'
import { OBSERVATION_METRICS } from '../src/types'

type Reply = Partial<Awaited<ReturnType<MessagesApi['create']>>>

function fake(reply: Reply | (() => Reply)) {
  const calls: Parameters<MessagesApi['create']>[0][] = []
  const api: MessagesApi = {
    async create(params) {
      calls.push(params)
      const r = typeof reply === 'function' ? reply() : reply
      return { model: DEFAULT_MODEL, stop_reason: 'end_turn', stop_details: null, content: [], ...r } as Awaited<ReturnType<MessagesApi['create']>>
    },
  }
  return { api, calls }
}

const report = { en: 'English.', ja: '日本語。', cast: 'A cast.', observations: [{ metric: 'players', direction: 'up', statement: 'More players.' }] }
const textReply = (text: string): Reply => ({ content: [{ type: 'text', text, citations: null }] as never })

describe('anthropicProvider', () => {
  it('uses Sonnet 5.5 unless told otherwise, for practice and for production alike', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5')
  })

  it('returns the model\'s JSON, parsed', async () => {
    const { api } = fake(textReply(JSON.stringify(report)))
    expect(await anthropicProvider(api).generate({ system: 's', user: 'u' })).toEqual(report)
  })

  it('asks for the configured model, with the system and user text, a JSON schema, and the refusal fallback', async () => {
    const { api, calls } = fake(textReply(JSON.stringify(report)))
    await anthropicProvider(api).generate({ system: 'the system', user: 'the user' })
    const p = calls[0]
    expect(p.model).toBe('claude-sonnet-5-5')
    expect(p.system).toBe('the system')
    expect(p.messages).toEqual([{ role: 'user', content: 'the user' }])
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.fallbacks).toBe('default')
    expect(p.thinking).toEqual({ type: 'adaptive' })
    expect(p.output_config?.format).toEqual({ type: 'json_schema', schema: REPORT_SCHEMA })
  })

  it('sets no sampling parameters, which this model rejects', async () => {
    const { api, calls } = fake(textReply(JSON.stringify(report)))
    await anthropicProvider(api).generate({ system: 's', user: 'u' })
    const p = calls[0] as unknown as Record<string, unknown>
    expect(p.temperature).toBeUndefined()
    expect(p.top_p).toBeUndefined()
    expect(p.top_k).toBeUndefined()
    expect(p.tool_choice).toBeUndefined()
  })

  it('lets the schema offer only the metrics the code can grade', () => {
    expect(REPORT_SCHEMA.properties.observations.items.properties.metric.enum).toEqual([...OBSERVATION_METRICS])
  })

  it('records the model that actually answered, which differs after a fallback', async () => {
    const provider = anthropicProvider(fake({ ...textReply(JSON.stringify(report)), model: 'claude-some-substitute' }).api)
    expect(provider.servedModel?.()).toBeNull()
    await provider.generate({ system: 's', user: 'u' })
    expect(provider.servedModel?.()).toBe('claude-some-substitute')
  })

  it('throws when the model declines, naming the category', async () => {
    const { api } = fake({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } as never })
    await expect(anthropicProvider(api).generate({ system: 's', user: 'u' })).rejects.toThrow(/declined.*general_harms/)
  })

  it('throws when the output was cut off', async () => {
    const { api } = fake({ ...textReply('{"en":'), stop_reason: 'max_tokens' })
    await expect(anthropicProvider(api).generate({ system: 's', user: 'u' })).rejects.toThrow(/ran out of tokens/)
  })

  it('throws on text that is not JSON, and on no text at all', async () => {
    await expect(anthropicProvider(fake(textReply('Sure! Here is the report')).api).generate({ system: 's', user: 'u' })).rejects.toThrow(/not valid JSON/)
    await expect(anthropicProvider(fake({ content: [] }).api).generate({ system: 's', user: 'u' })).rejects.toThrow(/no text/)
  })

  it('skips thinking blocks and reads the text block', async () => {
    const reply: Reply = { content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(report), citations: null }] as never }
    expect(await anthropicProvider(fake(reply).api).generate({ system: 's', user: 'u' })).toEqual(report)
  })

  describe('a failed call is sorted by whether trying again can help', () => {
    const failing = (error: unknown): MessagesApi => ({
      create: () => Promise.reject(error),
    })
    const apiError = (status: number, message = 'x') => Object.assign(new Error(message), { status })
    const attempt = (error: unknown) => anthropicProvider(failing(error)).generate({ system: 's', user: 'u' }).catch((e: unknown) => e)

    it.each([400, 401, 403, 404, 413, 422])('does not retry HTTP %i', async (status) => {
      const e = await attempt(apiError(status, `${status} {"error":{"message":"nope"}}`))
      expect(e).toBeInstanceOf(LlmCallError)
      expect((e as LlmCallError).kind).toBe('permanent')
      expect((e as LlmCallError).message).toContain(String(status))
    })

    it.each([408, 429, 500, 502, 503, 529])('retries HTTP %i', async (status) => {
      expect(((await attempt(apiError(status))) as LlmCallError).kind).toBe('transient')
    })

    it('retries a dropped connection and a timeout', async () => {
      expect(((await attempt(new Anthropic.APIConnectionError({ message: 'socket closed' }))) as LlmCallError).kind).toBe('transient')
      expect(((await attempt(new Anthropic.APIConnectionTimeoutError())) as LlmCallError).kind).toBe('transient')
    })

    it('treats an error that is not from the API as permanent, since repeating a bug does not fix it', async () => {
      expect(((await attempt(new TypeError('x is undefined'))) as LlmCallError).kind).toBe('permanent')
    })

    it('leaves an unusable answer as a plain error, so it is retried once without a pause', async () => {
      const e = await anthropicProvider(fake({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } as never }).api).generate({ system: 's', user: 'u' }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(LlmCallError)
    })
  })

  it('passes a chosen effort and model through', async () => {
    const { api, calls } = fake(textReply(JSON.stringify(report)))
    await anthropicProvider(api, { model: 'claude-other', effort: 'low' }).generate({ system: 's', user: 'u' })
    expect(calls[0].model).toBe('claude-other')
    expect(calls[0].output_config?.effort).toBe('low')
  })
})
