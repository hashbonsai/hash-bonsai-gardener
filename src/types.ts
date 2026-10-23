/**
 * The shapes everything else agrees on. Amounts are whole-unit numbers (SUI,
 * BONEXP and PRUNE all have 9 decimals; the conversion happens once, where
 * raw chain values are read), so a fact can be compared, tabulated and fed to
 * the number check without carrying a unit around.
 *
 * Any field the chain could not answer is `null` — never a guess — and the
 * prose is not allowed to touch it.
 */

export const FACTS_SCHEMA = 1

export type Facts = {
  schema: typeof FACTS_SCHEMA
  epoch: number
  startedAtMs: number | null
  endedAtMs: number | null
  players: number | null
  burns: number | null
  bonexpBurned: number | null
  /** Top 3 by score, addresses already shortened for display. */
  top: { address: string; score: number }[] | null
  prize: {
    extracted: number
    awarded: number
    /** Crown Seeds minted, index = tier. */
    seedsByTier: number[]
    settlerReward: number
  } | null
  treasury: { value: number; asOf: 'after-settle' | 'now' } | null
  mints: { cumulative: number; delta: number } | null
  prune: {
    standingEmission: number
    holderEmission: number
    holderCount: number
    perBonsai: number
    /** The tap's divisor, 1 = full rate. */
    tapDivisor: number
    mintsToNextStage: number | null
    standingRemaining: number
    holderRemaining: number
    circulating: number
  } | null
  ballot: {
    nextBallotEpoch: number
    open: { epoch: number; deposited: number; needed: number } | null
    /** The most recent executed ballot, if any. */
    executed: {
      epoch: number
      quorumMet: boolean
      applied: boolean[]
    } | null
  } | null
  arena: { trees: number; seeded: number } | null
  drains: number | null
  config: {
    entryFee: number
    epochLengthHours: number
    prizeShape: number
    withdrawCap: number
  } | null
  tx: { settle: string | null; advance: string | null; execute: string | null }
  gardener: { sui: number; wal: number; spentThisEpoch: number } | null
}

/** The metrics an observation may be about: fields of `Facts`, and only these. */
export const OBSERVATION_METRICS = [
  'players',
  'burns',
  'bonexpBurned',
  'prizeOut',
  'mints',
  'arenaTrees',
  'seededTrees',
  'drains',
] as const
export type ObservationMetric = (typeof OBSERVATION_METRICS)[number]

export type Direction = 'up' | 'down' | 'flat'

/** What the model proposes; the code fills in the rest. */
export type RawObservation = {
  metric: string
  direction: string
  statement: string
}

export type Observation = {
  id: string
  epoch: number
  metric: ObservationMetric
  direction: Direction
  /** Always read back from the facts, never from the model's own number. */
  baseline: number
  statement: string
}

export type Verdict = 'continued' | 'reversed' | 'flat'

export type Followup = {
  observationId: string
  fromEpoch: number
  toEpoch: number
  metric: ObservationMetric
  before: number
  after: number
  verdict: Verdict
}

export type EditorNote = { epoch: number; note: string }

/** What the model returns. */
export type LlmReport = {
  en: string
  ja: string
  cast: string
  observations: RawObservation[]
}

export type Lang = 'en' | 'ja'
