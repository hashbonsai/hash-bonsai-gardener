import { describe, expect, it } from 'vitest'
import type { LlmProvider } from '../src/llm'
import { buildSystem, buildUser, composeReport, type WriteInput } from '../src/write'
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
