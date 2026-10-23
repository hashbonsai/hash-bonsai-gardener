import { describe, expect, it } from 'vitest'
import { buildFacts, units, type RawEpoch } from '../src/facts'

const U = 1_000_000_000n

/** What the chain readers might return for one epoch, as recorded. */
function raw(over: Partial<RawEpoch> = {}): RawEpoch {
  return {
    epoch: 5,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_604_800_000,
    burns: { players: 12, count: 40, bonexp: 8_500n * U + U / 2n },
    scores: [
      { address: '0x' + '3'.repeat(64), score: 900n * U },
      { address: '0x' + 'a'.repeat(64), score: 4_200n * U },
      { address: '0x' + '1'.repeat(64), score: 3_100n * U },
      { address: '0x' + '2'.repeat(64), score: 50n * U },
    ],
    prize: { extracted: 25n * U + U / 2n, awarded: 25n * U, seedsByTier: [1, 2, 4], settlerReward: U / 10n },
    treasury: { value: 310n * U, asOf: 'after-settle' },
    mints: { cumulative: 1_234, previousCumulative: 1_178 },
    prune: {
      standingEmission: 100_000n * U,
      holderEmission: 50_000n * U,
      holderCount: 400,
      tapDivisor: 8,
      mintsToNextStage: 300,
      standingRemaining: 9_000_000n * U,
      holderRemaining: 4_500_000n * U,
      circulating: 1_500_000n * U,
    },
    ballot: { nextBallotEpoch: 9, open: null, executed: null },
    arena: { trees: 70, seeded: 18 },
    drains: 22,
    config: { entryFee: U / 2n, epochLengthMs: 604_800_000, prizeShape: 1, withdrawCap: 10n * U },
    tx: { settle: '0xsettle', advance: '0xadvance', execute: null },
    gardener: { sui: 800_000_000n, wal: 5n * U, spentThisEpoch: 10_000_000n },
    ...over,
  }
}

describe('units', () => {
  it('turns 9-decimal raw amounts into whole units, keeping the fraction', () => {
    expect(units(0n)).toBe(0)
    expect(units(U)).toBe(1)
    expect(units(25n * U + U / 2n)).toBe(25.5)
    expect(units(123_456_789n)).toBeCloseTo(0.123456789, 9)
  })
})

describe('buildFacts', () => {
  const f = buildFacts(raw())

  it('stamps the schema and keeps the epoch', () => {
    expect(f.schema).toBe(1)
    expect(f.epoch).toBe(5)
  })
  it('counts players, burns and BONEXP burned for the epoch', () => {
    expect([f.players, f.burns, f.bonexpBurned]).toEqual([12, 40, 8_500.5])
  })
  it('keeps the top three by score, highest first, with shortened addresses', () => {
    expect(f.top).toEqual([
      { address: '0xaaaa…aaaa', score: 4_200 },
      { address: '0x1111…1111', score: 3_100 },
      { address: '0x3333…3333', score: 900 },
    ])
    expect(JSON.stringify(f)).not.toContain('a'.repeat(64))
  })
  it('converts the prize, and counts the seeds by tier', () => {
    expect(f.prize).toEqual({ extracted: 25.5, awarded: 25, seedsByTier: [1, 2, 4], settlerReward: 0.1 })
  })
  it('works out the mints added this epoch', () => {
    expect(f.mints).toEqual({ cumulative: 1_234, delta: 56 })
  })
  it('works out PRUNE per Bonsai from the holder share and head count', () => {
    expect(f.prune?.perBonsai).toBe(125)
    expect(f.prune?.standingEmission).toBe(100_000)
  })
  it('converts the config, and the epoch length to hours', () => {
    expect(f.config).toEqual({ entryFee: 0.5, epochLengthHours: 168, prizeShape: 1, withdrawCap: 10 })
  })
  it('records the transactions it knows and leaves the rest null', () => {
    expect(f.tx).toEqual({ settle: '0xsettle', advance: '0xadvance', execute: null })
  })
  it('converts the gardener’s own balances', () => {
    expect(f.gardener).toEqual({ sui: 0.8, wal: 5, spentThisEpoch: 0.01 })
  })

  it('leaves every unreadable section null, never guessing', () => {
    const empty = buildFacts(
      raw({ burns: null, scores: null, prize: null, treasury: null, mints: null, prune: null, ballot: null, arena: null, drains: null, config: null, gardener: null }),
    )
    expect(empty).toMatchObject({
      players: null, burns: null, bonexpBurned: null, top: null, prize: null, treasury: null, mints: null,
      prune: null, ballot: null, arena: null, drains: null, config: null, gardener: null,
    })
  })
  it('leaves mints null when the previous total is unknown, rather than treating it as zero', () => {
    expect(buildFacts(raw({ mints: { cumulative: 1_234, previousCumulative: null } })).mints).toBeNull()
  })
  it('does not divide by zero holders', () => {
    const p = raw().prune!
    expect(buildFacts(raw({ prune: { ...p, holderCount: 0 } })).prune?.perBonsai).toBe(0)
  })
  it('keeps the treasury label that says whether it is a settlement reading or the present one', () => {
    expect(buildFacts(raw({ treasury: { value: U, asOf: 'now' } })).treasury).toEqual({ value: 1, asOf: 'now' })
  })
  it('carries an executed ballot through with its per-item results', () => {
    const b = buildFacts(raw({ ballot: { nextBallotEpoch: 13, open: null, executed: { epoch: 9, quorumMet: true, applied: [true, false, true, false] } } })).ballot
    expect(b?.executed).toEqual({ epoch: 9, quorumMet: true, applied: [true, false, true, false] })
  })
  it('converts an open ballot’s deposits and quorum target', () => {
    const b = buildFacts(raw({ ballot: { nextBallotEpoch: 13, open: { epoch: 9, deposited: 2n * U, needed: 3n * U }, executed: null } })).ballot
    expect(b?.open).toEqual({ epoch: 9, deposited: 2, needed: 3 })
  })
})
