import { shortAddress } from './check'
import { FACTS_SCHEMA, type Facts } from './types'

/**
 * Turns what the chain readers returned into the facts. Raw 9-decimal
 * amounts become whole-unit numbers here and nowhere else; every field the
 * readers could not answer stays `null`, and the prose may not touch it.
 * Nothing here reads the chain — the readers do, this only assembles.
 */

const UNIT = 1_000_000_000n

/** A raw 9-decimal amount as whole units, keeping the fractional part. */
export function units(raw: bigint): number {
  const whole = raw / UNIT
  const frac = raw % UNIT
  return Number(whole) + Number(frac) / Number(UNIT)
}

export type RawEpoch = {
  epoch: number
  startedAtMs: number | null
  endedAtMs: number | null
  burns: { players: number; count: number; bonexp: bigint } | null
  /** Any order, full addresses; the three best are kept. */
  scores: { address: string; score: bigint }[] | null
  prize: { extracted: bigint; awarded: bigint; seedsByTier: number[] | null; settlerReward: bigint | null } | null
  treasury: { value: bigint; asOf: 'after-settle' | 'now' } | null
  mints: { cumulative: number; previousCumulative: number | null } | null
  prune: {
    standingEmission: bigint
    holderEmission: bigint
    holderCount: number
    tapDivisor: number
    mintsToNextStage: number | null
    standingRemaining: bigint | null
    holderRemaining: bigint | null
    circulating: bigint | null
  } | null
  ballot: {
    nextBallotEpoch: number
    open: { epoch: number; deposited: bigint; needed: bigint } | null
    executed: { epoch: number; quorumMet: boolean; applied: boolean[] } | null
  } | null
  arena: { trees: number; seeded: number } | null
  drains: number | null
  config: { entryFee: bigint; epochLengthMs: number; prizeShape: number | null; prizeCeilingPercent: number } | null
  tx: { settle: string | null; advance: string | null; execute: string | null }
  gardener: { sui: bigint; wal: bigint; spentThisEpoch: bigint } | null
}

export function buildFacts(raw: RawEpoch): Facts {
  const top = raw.scores
    ? [...raw.scores]
        .sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? 1 : -1))
        .slice(0, 3)
        .map((s) => ({ address: shortAddress(s.address), score: units(s.score) }))
    : null

  const mints =
    raw.mints && raw.mints.previousCumulative !== null
      ? { cumulative: raw.mints.cumulative, delta: raw.mints.cumulative - raw.mints.previousCumulative }
      : null

  return {
    schema: FACTS_SCHEMA,
    epoch: raw.epoch,
    startedAtMs: raw.startedAtMs,
    endedAtMs: raw.endedAtMs,
    players: raw.burns?.players ?? null,
    burns: raw.burns?.count ?? null,
    bonexpBurned: raw.burns ? units(raw.burns.bonexp) : null,
    top,
    prize: raw.prize
      ? {
          extracted: units(raw.prize.extracted),
          awarded: units(raw.prize.awarded),
          seedsByTier: raw.prize.seedsByTier,
          settlerReward: raw.prize.settlerReward === null ? null : units(raw.prize.settlerReward),
        }
      : null,
    treasury: raw.treasury ? { value: units(raw.treasury.value), asOf: raw.treasury.asOf } : null,
    mints,
    prune: raw.prune
      ? {
          standingEmission: units(raw.prune.standingEmission),
          holderEmission: units(raw.prune.holderEmission),
          holderCount: raw.prune.holderCount,
          perBonsai: raw.prune.holderCount > 0 ? units(raw.prune.holderEmission) / raw.prune.holderCount : 0,
          tapDivisor: raw.prune.tapDivisor,
          mintsToNextStage: raw.prune.mintsToNextStage,
          standingRemaining: raw.prune.standingRemaining === null ? null : units(raw.prune.standingRemaining),
          holderRemaining: raw.prune.holderRemaining === null ? null : units(raw.prune.holderRemaining),
          circulating: raw.prune.circulating === null ? null : units(raw.prune.circulating),
        }
      : null,
    ballot: raw.ballot
      ? {
          nextBallotEpoch: raw.ballot.nextBallotEpoch,
          open: raw.ballot.open
            ? { epoch: raw.ballot.open.epoch, deposited: units(raw.ballot.open.deposited), needed: units(raw.ballot.open.needed) }
            : null,
          executed: raw.ballot.executed,
        }
      : null,
    arena: raw.arena,
    drains: raw.drains,
    config: raw.config
      ? {
          entryFee: units(raw.config.entryFee),
          epochLengthHours: raw.config.epochLengthMs / 3_600_000,
          prizeShape: raw.config.prizeShape,
          prizeCeilingPercent: raw.config.prizeCeilingPercent,
        }
      : null,
    tx: raw.tx,
    gardener: raw.gardener
      ? { sui: units(raw.gardener.sui), wal: units(raw.gardener.wal), spentThisEpoch: units(raw.gardener.spentThisEpoch) }
      : null,
  }
}
