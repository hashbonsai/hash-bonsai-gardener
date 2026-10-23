import type { Facts, Followup, ObservationMetric } from './types'

/**
 * How many decimals each figure is shown with, the same as the game's own
 * screens: SUI to three, BONEXP, PRUNE and scores to two, counts whole. The
 * rounding is the screens' too — to the nearest, a half rounding away from
 * zero, which is what `toLocaleString`'s `maximumFractionDigits` does.
 *
 * The facts that are stored on Walrus keep every digit the chain gave. What the
 * model is shown, the table, and the numbers the check allows are these
 * rounded values, so the report cannot quote a figure the reader's screen
 * would never show.
 */
export const DIGITS = { sui: 3, token: 2, count: 0 } as const

export function round(n: number, digits: number): number {
  return Number(n.toLocaleString('en-US', { maximumFractionDigits: digits, useGrouping: false }))
}

const sui = (n: number) => round(n, DIGITS.sui)
const token = (n: number) => round(n, DIGITS.token)
const orNull = (n: number | null, f: (n: number) => number) => (n === null ? null : f(n))

/** The digits a metric is shown with: what the unit of the figure it reads is. */
export function metricDigits(metric: ObservationMetric): number {
  switch (metric) {
    case 'bonexpBurned':
      return DIGITS.token
    case 'prizeOut':
      return DIGITS.sui
    case 'players':
    case 'burns':
    case 'mints':
    case 'arenaTrees':
    case 'seededTrees':
    case 'drains':
      return DIGITS.count
  }
}

export function displayFollowup(f: Followup): Followup {
  const digits = metricDigits(f.metric)
  return { ...f, before: round(f.before, digits), after: round(f.after, digits) }
}

/** The facts as the screens would show them. Same shape; only the figures with decimals are rounded. */
export function displayFacts(f: Facts): Facts {
  return {
    ...f,
    bonexpBurned: orNull(f.bonexpBurned, token),
    top: f.top ? f.top.map((t) => ({ ...t, score: token(t.score) })) : null,
    prize: f.prize
      ? { ...f.prize, extracted: sui(f.prize.extracted), awarded: sui(f.prize.awarded), settlerReward: orNull(f.prize.settlerReward, sui) }
      : null,
    treasury: f.treasury ? { ...f.treasury, value: sui(f.treasury.value) } : null,
    prune: f.prune
      ? {
          ...f.prune,
          standingEmission: token(f.prune.standingEmission),
          holderEmission: token(f.prune.holderEmission),
          perBonsai: token(f.prune.perBonsai),
          standingRemaining: orNull(f.prune.standingRemaining, token),
          holderRemaining: orNull(f.prune.holderRemaining, token),
          circulating: orNull(f.prune.circulating, token),
        }
      : null,
    ballot: f.ballot
      ? { ...f.ballot, open: f.ballot.open ? { ...f.ballot.open, deposited: token(f.ballot.open.deposited), needed: token(f.ballot.open.needed) } : null }
      : null,
    config: f.config ? { ...f.config, entryFee: sui(f.config.entryFee) } : null,
    gardener: f.gardener ? { sui: sui(f.gardener.sui), wal: sui(f.gardener.wal), spentThisEpoch: sui(f.gardener.spentThisEpoch) } : null,
  }
}
