import { FACTS_SCHEMA, type Facts } from '../src/types'

/** A complete, plausible epoch. Tests override only what they are about. */
export function sampleFacts(over: Partial<Facts> = {}): Facts {
  return {
    schema: FACTS_SCHEMA,
    epoch: 5,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_604_800_000,
    players: 12,
    burns: 40,
    bonexpBurned: 8_500.5,
    top: [
      { address: '0xabc123…cdef', score: 4_200 },
      { address: '0x111111…2222', score: 3_100.25 },
      { address: '0x333333…4444', score: 900 },
    ],
    prize: { extracted: 25.5, awarded: 25.4, seedsByTier: [1, 2, 4], settlerReward: 0.1 },
    treasury: { value: 310.75, asOf: 'after-settle' },
    mints: { cumulative: 1_234, delta: 56 },
    prune: {
      standingEmission: 100_000,
      holderEmission: 50_000,
      holderCount: 400,
      perBonsai: 125,
      tapDivisor: 8,
      mintsToNextStage: 300,
      standingRemaining: 9_000_000,
      holderRemaining: 4_500_000,
      circulating: 1_500_000,
    },
    ballot: { nextBallotEpoch: 9, open: null, executed: null },
    arena: { trees: 70, seeded: 18 },
    drains: 22,
    config: { entryFee: 0.5, epochLengthHours: 168, prizeShape: 1, withdrawCap: 10 },
    tx: { settle: '0xsettle', advance: null, execute: null },
    gardener: { sui: 0.8, wal: 5, spentThisEpoch: 0.01 },
    ...over,
  }
}

export const CLEAN_REPORT = {
  en: 'Epoch 5 closed with 12 players and 40 burns. The prize pool paid out 25.4 SUI.',
  ja: 'シーズン 5 は参加者 12 人、焼却 40 回で終わり、賞金は 25.4 SUI でした。',
  cast: 'Epoch 5 closed with 12 players.',
  observations: [{ metric: 'players', direction: 'up', statement: 'Player count should keep growing.' }],
}
