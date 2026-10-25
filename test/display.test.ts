import { describe, expect, it } from 'vitest'
import { acceptObservations, checkReport } from '../src/check'
import { displayFacts, displayFollowup, DIGITS, metricDigits, round } from '../src/display'
import { factsTable, fallbackReport, notebookLines } from '../src/templates'
import type { Followup } from '../src/types'
import { buildUser } from '../src/write'
import { CLEAN_REPORT, sampleFacts } from './fixtures'

/** Epoch 3 of the live game, as the collector produced it: every digit the chain gave. */
const epoch3 = () =>
  sampleFacts({
    epoch: 3,
    players: 4,
    burns: 7,
    bonexpBurned: 39284.812586853,
    top: [
      { address: '0x8cd1…d42c', score: 18301.154176 },
      { address: '0x5538…f3fe', score: 14986.5 },
      { address: '0x76f6…c1d9', score: 4540.964136494 },
    ],
    prize: { extracted: 7.17848, awarded: 7.178479998, seedsByTier: [1, 2, 1], settlerReward: 0.2 },
    treasury: { value: 64.40632, asOf: 'after-settle' },
    prune: null,
    mints: null,
    config: null,
    arena: null,
    ballot: null,
  })

const report = (over: Partial<typeof CLEAN_REPORT> = {}) => ({
  en: 'Epoch 3 closed with 4 players. The prize pool paid out 7.178 SUI.',
  ja: 'シーズン 3 は参加者 4 人で、Crown Seed に封入した賞金は 7.178 SUI でした。',
  cast: 'Epoch 3 closed with 4 players.',
  observations: [{ metric: 'players', direction: 'up', statement: 'Players should rise.' }],
  ...over,
})
const ok = (r: ReturnType<typeof report>) => checkReport(r, { facts: epoch3(), castBudgetBytes: 200 })
const reasons = (r: ReturnType<typeof report>) => {
  const c = ok(r)
  return c.ok ? [] : c.reasons
}

describe('round', () => {
  it.each([
    [7.178479998, 3, 7.178],
    [39284.812586853, 2, 39284.81],
    [18301.154176, 2, 18301.15],
    [4540.964136494, 2, 4540.96],
    [8500.5, 2, 8500.5],
    [0.2, 3, 0.2],
    [2.5, 0, 3],
    [0.0006, 3, 0.001],
    [0.0004, 3, 0],
    [12, 0, 12],
  ])('rounds %f to %i decimals as %f, the way the screens do', (n, digits, want) => {
    expect(round(n, digits)).toBe(want)
  })

  it('agrees with toLocaleString, which is what the game’s screens call', () => {
    for (const n of [0.1 + 0.2, 1.005, 2.675, 1234.5678, 99999.9999, 0.0005]) {
      for (const d of [0, 2, 3]) expect(round(n, d)).toBe(Number(n.toLocaleString('en-US', { maximumFractionDigits: d, useGrouping: false })))
    }
  })
})

describe('displayFacts', () => {
  const shown = displayFacts(epoch3())

  it('rounds SUI to three decimals, BONEXP, PRUNE and scores to two, and leaves counts alone', () => {
    expect(shown.prize).toEqual({ extracted: 7.178, awarded: 7.178, seedsByTier: [1, 2, 1], settlerReward: 0.2 })
    expect(shown.treasury).toEqual({ value: 64.406, asOf: 'after-settle' })
    expect(shown.bonexpBurned).toBe(39284.81)
    expect(shown.top!.map((t) => t.score)).toEqual([18301.15, 14986.5, 4540.96])
    expect([shown.players, shown.burns, shown.epoch]).toEqual([4, 7, 3])
  })

  it('rounds the PRUNE figures, the open ballot and the gardener’s balances', () => {
    const f = displayFacts(
      sampleFacts({
        prune: {
          standingEmission: 5500.123456,
          holderEmission: 600.987654,
          holderCount: 1300,
          perBonsai: 0.462298,
          tapDivisor: 2,
          mintsToNextStage: 51,
          standingRemaining: 49500.555555,
          holderRemaining: null,
          circulating: 6_500_000.004,
        },
        ballot: { nextBallotEpoch: 9, open: { epoch: 9, deposited: 12.3456, needed: 1_000_000.001 }, executed: null },
        config: { entryFee: 0.5005, epochLengthHours: 168, prizeShape: 1, prizeCeilingPercent: 8 },
        gardener: { sui: 0.997782754, wal: 9.989828272, spentThisEpoch: 0.01234 },
      }),
    )
    expect(f.prune).toMatchObject({ standingEmission: 5500.12, holderEmission: 600.99, perBonsai: 0.46, standingRemaining: 49500.56, holderRemaining: null, circulating: 6_500_000 })
    expect(f.ballot!.open).toEqual({ epoch: 9, deposited: 12.35, needed: 1_000_000 })
    expect(f.config).toMatchObject({ entryFee: 0.501, epochLengthHours: 168, prizeCeilingPercent: 8 })
    expect(f.gardener).toEqual({ sui: 0.998, wal: 9.99, spentThisEpoch: 0.012 })
  })

  it('keeps null as null and does not touch the facts it was given', () => {
    const facts = epoch3()
    const before = JSON.stringify(facts)
    const f = displayFacts({ ...facts, bonexpBurned: null, prize: null, treasury: null, top: null })
    expect([f.bonexpBurned, f.prize, f.treasury, f.top]).toEqual([null, null, null, null])
    expect(JSON.stringify(facts)).toBe(before)
    expect(facts.prize!.awarded).toBe(7.178479998)
  })
})

describe('followups', () => {
  const f = (metric: Followup['metric'], before: number, after: number): Followup => ({ observationId: 'o', fromEpoch: 2, toEpoch: 3, metric, before, after, verdict: 'continued' })
  it('rounds by what the metric counts', () => {
    expect(displayFollowup(f('prizeOut', 7.178479998, 8.123456))).toMatchObject({ before: 7.178, after: 8.123 })
    expect(displayFollowup(f('bonexpBurned', 35392.6849, 39284.812586853))).toMatchObject({ before: 35392.68, after: 39284.81 })
    expect(displayFollowup(f('players', 4, 5))).toMatchObject({ before: 4, after: 5 })
  })
  it('has digits for every metric', () => {
    expect([metricDigits('players'), metricDigits('prizeOut'), metricDigits('bonexpBurned'), metricDigits('drains')]).toEqual([0, DIGITS.sui, DIGITS.token, 0])
  })
})

describe('what the model is shown', () => {
  const input = (facts = epoch3()) => ({
    facts,
    followups: [{ observationId: 'o', fromEpoch: 2, toEpoch: 3, metric: 'prizeOut' as const, before: 7.178479998, after: 8.123456, verdict: 'continued' as const }],
    observations: [],
    notes: [],
    previousReports: [],
    systemPrompt: 'S',
    reportUrl: 'https://aggregator.example/v1/blobs/abc',
  })

  it('is the rounded facts and follow-ups, never the long figures', () => {
    const text = buildUser(input())
    expect(text).toContain('7.178')
    expect(text).toContain('39284.81')
    expect(text).not.toContain('7.178479998')
    expect(text).not.toContain('39284.812586853')
    expect(text).not.toContain('8.123456')
    const user = JSON.parse(text)
    expect(user.followups[0]).toMatchObject({ before: 7.178, after: 8.123 })
  })

  it('leaves the facts it was handed (the ones stored on Walrus) with every digit', () => {
    const i = input()
    buildUser(i)
    expect(i.facts.prize!.awarded).toBe(7.178479998)
    expect(i.facts.bonexpBurned).toBe(39284.812586853)
  })
})

describe('the check against the rounded figures', () => {
  it('passes a figure as the screens show it, with or without the thousands comma', () => {
    expect(reasons(report({ en: 'Epoch 3 burned 39,284.81 BONEXP.' }))).toEqual([])
    expect(reasons(report({ en: 'Epoch 3 burned 39284.81 BONEXP.' }))).toEqual([])
    expect(reasons(report({ en: 'The top score was 18,301.15.' }))).toEqual([])
    expect(reasons(report({ en: 'The top score was 18301.15.' }))).toEqual([])
    expect(reasons(report({ en: 'The Treasury stood at 64.406 SUI.' }))).toEqual([])
  })

  it('passes a figure rounded a little further, within the precision it states', () => {
    expect(reasons(report({ en: 'About 39,285 BONEXP and 7.18 SUI.' }))).toEqual([])
  })

  it('refuses the long figures the model never saw, whether it copied or computed them', () => {
    expect(reasons(report({ en: 'The pool paid out 7.178479998 SUI.' })).join()).toMatch(/number "7.178479998"/)
    expect(reasons(report({ en: 'Epoch 3 burned 39,284.812586853 BONEXP.' })).join()).toMatch(/number "39,284.812586853"/)
  })

  it('refuses a figure that is not near any shown value', () => {
    expect(reasons(report({ en: 'Epoch 3 burned 39,300 BONEXP.' })).join()).toMatch(/number "39,300"/)
    expect(reasons(report({ en: 'The pool paid out 7.5 SUI.' })).join()).toMatch(/number "7.5"/)
  })

  it('applies to observations as well', () => {
    const o = (statement: string) => ({ metric: 'bonexpBurned', direction: 'up', statement })
    const got = acceptObservations([o('Burning may stay above 39,284.81 BONEXP.'), o('Burning may reach 41,000 BONEXP.')], epoch3())
    expect(got.map((x) => x.statement)).toEqual(['Burning may stay above 39,284.81 BONEXP.'])
  })

  it('still takes an observation’s baseline from the long figure, not the rounded one', () => {
    const [obs] = acceptObservations([{ metric: 'bonexpBurned', direction: 'up', statement: 'It may rise.' }], epoch3())
    expect(obs.baseline).toBe(39284.812586853)
  })
})

describe('the fixed text', () => {
  it('shows SUI to three decimals and BONEXP, PRUNE and scores to two, with thousands commas', () => {
    const t = factsTable(epoch3(), 'en').join('\n')
    expect(t).toContain('Prize pool extracted (SUI): 7.178')
    expect(t).toContain('Prize awarded (SUI): 7.178')
    expect(t).toContain('Treasury after settlement (SUI): 64.406')
    expect(t).toContain('BONEXP burned: 39,284.81')
    expect(t).toContain('0x8cd1…d42c 18,301.15')
    expect(t).toContain('0x76f6…c1d9 4,540.96')
    expect(t).not.toContain('7.178479998')
  })

  it('shows PRUNE to two decimals', () => {
    const t = factsTable(
      sampleFacts({ prune: { standingEmission: 5500.123456, holderEmission: 600.987654, holderCount: 1, perBonsai: 1, tapDivisor: 8, mintsToNextStage: 1, standingRemaining: null, holderRemaining: null, circulating: null } }),
      'en',
    ).join('\n')
    expect(t).toContain('PRUNE to the Standing: 5,500.12')
    expect(t).toContain('PRUNE to holders: 600.99')
  })

  it('shows the notebook’s figures the way the metric is shown', () => {
    const f = (metric: Followup['metric'], before: number, after: number): Followup => ({ observationId: 'o', fromEpoch: 2, toEpoch: 3, metric, before, after, verdict: 'continued' })
    expect(notebookLines([f('prizeOut', 7.178479998, 8.5)], 'en')[0]).toContain('7.178 → epoch 3: 8.5')
    expect(notebookLines([f('bonexpBurned', 35392.6849, 39284.812586853)], 'ja')[0]).toContain('35,392.68 → シーズン 3: 39,284.81')
    expect(notebookLines([f('players', 1234, 1500)], 'en')[0]).toContain('1,234 → epoch 3: 1,500')
  })

  it('carries the same figures into the report with no commentary', () => {
    const text = fallbackReport(epoch3(), [], 'ja')
    expect(text).toContain('スコアに変換した BONEXP: 39,284.81')
    expect(text).toContain('Crown Seed に封入した賞金 (SUI): 7.178')
  })
})
