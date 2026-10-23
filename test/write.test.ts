import { describe, expect, it } from 'vitest'
import { LlmCallError, type LlmProvider } from '../src/llm'
import { buildSystem, buildUser, composeReport, operatorNotice, type WriteInput } from '../src/write'
import type { Followup, Observation } from '../src/types'
import { CLEAN_REPORT, sampleFacts } from './fixtures'

const input = (over: Partial<WriteInput> = {}): WriteInput => ({
  facts: sampleFacts(),
  followups: [],
  observations: [],
  notes: [],
  previousReports: [],
  systemPrompt: 'SYSTEM',
  reportUrl: 'https://aggregator.example/v1/blobs/abc',
  ...over,
})

/** Answers each call with the next queued output (or throws it, if it is an Error). */
function script(...outputs: unknown[]): LlmProvider & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = []
  return {
    calls,
    async generate(i) {
      calls.push(i)
      const next = outputs[Math.min(calls.length - 1, outputs.length - 1)]
      if (next instanceof Error) throw next
      return next
    },
  }
}

const withInvented = { ...CLEAN_REPORT, en: 'Epoch 5 closed with 99 players.' }
const withForbidden = { ...CLEAN_REPORT, en: 'The price rose.' }

describe('composeReport', () => {
  it('returns the first attempt when it passes', async () => {
    const llm = script(CLEAN_REPORT)
    const r = await composeReport(llm, input())
    expect(r).toMatchObject({ fallback: false, attempts: 1, failures: [], text: { en: CLEAN_REPORT.en, ja: CLEAN_REPORT.ja } })
    expect(r.observations).toHaveLength(1)
    expect(llm.calls).toHaveLength(1)
  })

  it('retries once after a failed check, and tells the model why', async () => {
    const llm = script(withInvented, CLEAN_REPORT)
    const r = await composeReport(llm, input())
    expect(r.fallback).toBe(false)
    expect(r.attempts).toBe(2)
    expect(r.failures[0].join()).toMatch(/number "99"/)
    const second = JSON.parse(llm.calls[1].user)
    expect(second.yourLastAttemptWasRejectedBecause.join()).toMatch(/number "99"/)
    expect(JSON.parse(llm.calls[0].user).yourLastAttemptWasRejectedBecause).toBeUndefined()
  })

  it('falls back to the fixed text after two failures, with no observations and nothing the model wrote', async () => {
    const llm = script(withInvented, withForbidden)
    const r = await composeReport(llm, input())
    expect(r.fallback).toBe(true)
    expect(r.observations).toEqual([])
    expect(llm.calls).toHaveLength(2)
    expect(r.text.en).not.toContain('The price rose')
    expect(r.text.en).toContain('Players: 12')
    expect(r.text.en).toContain('The Gardener is an AI run by the Hash Bonsai operator.')
    expect(r.text.ja).toContain('庭師は Hash Bonsai の運営が動かす AI です。')
    expect(r.failures).toHaveLength(2)
  })

  it('treats a model call that throws as a failed attempt, not a crash', async () => {
    const r = await composeReport(script(new Error('overloaded'), CLEAN_REPORT), input())
    expect(r.fallback).toBe(false)
    expect(r.failures[0][0]).toMatch(/model call failed: overloaded/)
  })

  it('treats output of the wrong shape as a failed attempt', async () => {
    const r = await composeReport(script({ en: 'only this' }, 'nonsense'), input())
    expect(r.fallback).toBe(true)
    expect(r.failures[0][0]).toMatch(/not \{ en, ja, cast, observations \}/)
  })

  describe('a call that failed is told apart from a text that failed its checks', () => {
    const sleeps: number[] = []
    const opts = { transientDelayMs: 1234, sleep: async (ms: number) => void sleeps.push(ms) }
    const permanent = () => new LlmCallError('401 {"error":{"message":"Invalid bearer token"}}', 'permanent')
    const transient = () => new LlmCallError('429 rate limited', 'transient')

    it('does not retry a failure that retrying cannot fix', async () => {
      const llm = script(permanent(), CLEAN_REPORT)
      const r = await composeReport(llm, input(), opts)
      expect(llm.calls).toHaveLength(1)
      expect(r).toMatchObject({ fallback: true, fallbackReason: 'unavailable', attempts: 1 })
      expect(r.failures).toEqual([[expect.stringMatching(/will not be retried: 401/)]])
    })

    it('says "could not be written" in the fixed text, not "did not pass its checks"', async () => {
      const r = await composeReport(script(permanent()), input(), opts)
      expect(r.text.en).toContain('could not be written')
      expect(r.text.en).not.toContain('did not pass its checks')
      expect(r.text.ja).toContain('作れなかった')
      expect(r.text.ja).not.toContain('検査に通らなかった')
    })

    it('retries a rate limit after a pause and uses the answer', async () => {
      sleeps.length = 0
      const r = await composeReport(script(transient(), CLEAN_REPORT), input(), opts)
      expect(r).toMatchObject({ fallback: false, fallbackReason: null, attempts: 2 })
      expect(sleeps).toEqual([1234])
    })

    it('gives up after two rate-limited tries, and does not pause after the last one', async () => {
      sleeps.length = 0
      const llm = script(transient(), transient())
      const r = await composeReport(llm, input(), opts)
      expect(llm.calls).toHaveLength(2)
      expect(r).toMatchObject({ fallback: true, fallbackReason: 'unavailable', attempts: 2 })
      expect(sleeps).toEqual([1234])
    })

    it('retries an unusable answer at once, with no pause', async () => {
      sleeps.length = 0
      const r = await composeReport(script(new Error('the model returned no text'), CLEAN_REPORT), input(), opts)
      expect(r.fallback).toBe(false)
      expect(sleeps).toEqual([])
    })

    it('says "did not pass its checks" only when the checks were what failed', async () => {
      const r = await composeReport(script(withInvented, withForbidden), input(), opts)
      expect(r).toMatchObject({ fallback: true, fallbackReason: 'checks' })
      expect(r.text.en).toContain('did not pass its checks')
      expect(r.text.ja).toContain('検査に通らなかった')
    })

    it('goes by the last attempt when the two end differently', async () => {
      expect((await composeReport(script(withInvented, transient()), input(), opts)).fallbackReason).toBe('unavailable')
      expect((await composeReport(script(transient(), withInvented), input(), opts)).fallbackReason).toBe('checks')
    })

    it('keeps a key out of the failure that is reported', async () => {
      // Built at run time so that no key-shaped text sits in the repository.
      const fakeKey = ['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-')
      const r = await composeReport(script(new LlmCallError(`bad key ${fakeKey}`, 'permanent')), input(), opts)
      expect(r.failures.join()).not.toContain(fakeKey)
      expect(r.failures.join()).toContain('[redacted key]')
    })
  })

  describe('operatorNotice', () => {
    const opts = { transientDelayMs: 0, sleep: async () => {} }
    it('is null when the report passed', async () => {
      expect(operatorNotice(await composeReport(script(CLEAN_REPORT), input(), opts), 5)).toBeNull()
    })
    it('names the call failure and its reason when the model could not be reached', async () => {
      const n = operatorNotice(await composeReport(script(new LlmCallError('401 Invalid bearer token', 'permanent')), input(), opts), 5)
      expect(n).toMatch(/Epoch 5: the commentary could not be written/)
      expect(n).toMatch(/401 Invalid bearer token/)
    })
    it('names the failed checks when the text was the problem', async () => {
      const n = operatorNotice(await composeReport(script(withInvented, withForbidden), input(), opts), 5)
      expect(n).toMatch(/Epoch 5: the commentary failed its checks/)
      expect(n).toMatch(/forbidden word/)
    })
  })

  it('lets a follow-up result license numbers the facts do not hold', async () => {
    const followup: Followup = { observationId: 'obs-4-1', fromEpoch: 4, toEpoch: 5, metric: 'players', before: 7, after: 12, verdict: 'continued' }
    const llm = script({ ...CLEAN_REPORT, en: 'Players went from 7 to 12 in epoch 5.' })
    const r = await composeReport(llm, input({ followups: [followup] }))
    expect(r.fallback).toBe(false)
  })

  it('keeps the cast inside the room left by the fixed link and sentence', async () => {
    const long = { ...CLEAN_REPORT, cast: 'x'.repeat(300) }
    const r = await composeReport(script(long, long), input())
    expect(r.fallback).toBe(true)
    expect(r.failures[0].join()).toMatch(/cast: 300 bytes exceeds/)
  })
})

describe('what the model is shown', () => {
  it('appends the operator notes to the system prompt as style guidance only', () => {
    const system = buildSystem('SYSTEM', [{ epoch: 4, note: 'be briefer' }])
    expect(system.startsWith('SYSTEM')).toBe(true)
    expect(system).toMatch(/\(epoch 4\) be briefer/)
    expect(system).toMatch(/the facts win/)
    expect(buildSystem('SYSTEM', [])).toBe('SYSTEM')
  })

  it('labels earlier observations as the model’s own words, apart from the facts', () => {
    const earlier: Observation = { id: 'obs-4-1', epoch: 4, metric: 'players', direction: 'up', baseline: 7, statement: 'Players may rise.' }
    const user = JSON.parse(buildUser(input({ observations: [earlier], previousReports: ['old text'] })))
    expect(user.yourEarlierObservations).toEqual([{ epoch: 4, metric: 'players', direction: 'up', statement: 'Players may rise.' }])
    expect(user.facts.epoch).toBe(5)
    expect(user.previousReports).toEqual(['old text'])
    expect(user.facts).not.toHaveProperty('yourEarlierObservations')
  })

  it('does not send the model anything that could hold a secret: only facts, results and its own past words', () => {
    const user = buildUser(input())
    expect(Object.keys(JSON.parse(user)).sort()).toEqual(['facts', 'followups', 'previousReports', 'yourEarlierObservations'])
  })
})
