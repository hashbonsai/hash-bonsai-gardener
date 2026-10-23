import type {
  BallotExecutedEvent,
  BurnEvent,
  DrainEvent,
  EmissionEvent,
  HolderEmissionEvent,
  SettleEvent,
  TransactionChanges,
} from './events'
import type { RawEpoch } from './facts'
import { big, child, list, num, record, str } from './json'
import { redact } from './redact'
import type { BallotState, DistributorState, GovernanceState } from './read'

/**
 * Assembles one epoch's `RawEpoch` from the chain's two readers. Every section
 * is built on its own: one that cannot be read becomes `null` with a line in
 * `problems`, and the prose is not allowed to touch it. Nothing is guessed
 * and nothing is filled in with a default that looks like a measurement.
 *
 * Where each figure comes from is stated at its section, because "as of when"
 * is part of what a figure means: the settlement transaction's own effects
 * hold the state at the end of the epoch; the objects hold only now.
 */

/** Everything the collector reads. The live implementation is in `liveSources`; a test supplies its own. */
export type Sources = {
  board(): Promise<{ epoch: number; endsAtMs: number }>
  gameBank(): Promise<{ treasury: bigint; totalMinted: number }>
  epochMinted(epoch: number): Promise<number | null>
  arena(): Promise<{ stationed: number; seeded: number }>
  distributor(): Promise<DistributorState>
  governance(): Promise<GovernanceState>
  ballot(ballotsTableId: string, epoch: number): Promise<BallotState | null>
  operatorLock(): Promise<{ balance: bigint }>
  balances(): Promise<{ sui: bigint; wal: bigint }>
  burns(): Promise<BurnEvent[]>
  settles(): Promise<SettleEvent[]>
  drains(): Promise<DrainEvent[]>
  emissions(): Promise<EmissionEvent[]>
  holderEmissions(): Promise<HolderEmissionEvent[]>
  ballotsExecuted(): Promise<BallotExecutedEvent[]>
  transaction(digest: string): Promise<TransactionChanges>
}

export type Collected = { raw: RawEpoch; problems: string[] }

/** Thrown when the epoch is not finished yet, or its distribution is not confirmed: nothing to report. */
export class NotFinalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFinalError'
  }
}

// ── Constants of the game that the facts need (from the Move sources) ───────

const MIST = 1_000_000_000n
/** `prune::TOTAL_SUPPLY`, 100,000,000 PRUNE. */
const PRUNE_TOTAL_SUPPLY = 100_000_000n * MIST
/** `governance::MIN_QUORUM`, 1,000,000 PRUNE. */
const MIN_QUORUM = 1_000_000n * MIST
/** `governance::QUORUM_BPS` over `BPS_DENOM`: a tenth of the circulating supply. */
const QUORUM_DIVISOR = 10n
/** `governance::BALLOT_INTERVAL`. */
const BALLOT_INTERVAL = 4
/** `distributor::TAP_*_UP_TO`: the holder share is divided by 8, 4, 2, then 1 as the mint count passes these. */
const TAP_STAGES = [350, 850, 1_350] as const

export function tapDivisor(mintCount: number): number {
  if (mintCount <= TAP_STAGES[0]) return 8
  if (mintCount <= TAP_STAGES[1]) return 4
  if (mintCount <= TAP_STAGES[2]) return 2
  return 1
}

/** Mints until the tap stage changes, counted from `mintCount`; null once it is fully open. */
export function mintsToNextStage(mintCount: number): number | null {
  const edge = TAP_STAGES.find((t) => mintCount <= t)
  return edge === undefined ? null : edge + 1 - mintCount
}

/** `economy::gov_set_prize_shape`: the tier table each of the three shapes writes, in whole SUI. */
const PRIZE_SHAPES: [number, number][][] = [
  [[1, 100], [3, 35], [10, 10], [20, 4]],
  [[1, 60], [3, 30], [10, 12], [20, 6]],
  [[1, 40], [3, 25], [10, 12], [20, 8]],
]

export function prizeShapeOf(tiers: { maxRank: number; amountPerSlot: bigint }[]): number | null {
  const index = PRIZE_SHAPES.findIndex(
    (shape) => shape.length === tiers.length && shape.every(([rank, sui], i) => tiers[i].maxRank === rank && tiers[i].amountPerSlot === BigInt(sui) * MIST),
  )
  return index === -1 ? null : index
}

const SUI_COIN = /^0x0*2::coin::Coin<0x0*2::sui::SUI>$/

// ── The collector ───────────────────────────────────────────────────────────

export type CollectOptions = {
  /** What the gardener spent this epoch, kept in its own state. */
  spentThisEpoch: bigint
}

export async function collectRawEpoch(src: Sources, epoch: number, options: CollectOptions): Promise<Collected> {
  const problems: string[] = []
  const attempt = async <T>(what: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f()
    } catch (e) {
      problems.push(`${what}: ${redact(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
      return null
    }
  }

  // The two reads that decide whether there is anything to report at all.
  const board = await src.board()
  if (board.epoch <= epoch) throw new NotFinalError(`epoch ${epoch} is still running (the board is on ${board.epoch})`)
  const distributor = await src.distributor()
  const distributes = distributor.bootstrapped && epoch >= distributor.startEpoch
  if (distributes && distributor.nextEpoch <= epoch) {
    throw new NotFinalError(`epoch ${epoch}'s distribution is not confirmed yet (confirmed through ${distributor.nextEpoch - 1})`)
  }

  const [burns, settles, drains, emissions, holderEmissions, ballotsExecuted, governance, lock, arena, bank, balances, minted, previousMinted] =
    await Promise.all([
      attempt('burn events', () => src.burns()),
      attempt('settle events', () => src.settles()),
      attempt('drain events', () => src.drains()),
      attempt('emission events', () => src.emissions()),
      attempt('holder emission events', () => src.holderEmissions()),
      attempt('ballot events', () => src.ballotsExecuted()),
      attempt('governance', () => src.governance()),
      attempt('operator lock', () => src.operatorLock()),
      attempt('arena', () => src.arena()),
      attempt('game bank', () => src.gameBank()),
      attempt('gardener balances', () => src.balances()),
      attempt(`mint count at the end of epoch ${epoch}`, () => src.epochMinted(epoch)),
      attempt(`mint count at the end of epoch ${epoch - 1}`, () => src.epochMinted(epoch - 1)),
    ])

  const settle = settles?.find((e) => e.epoch === epoch) ?? null
  const settlePrevious = settles?.find((e) => e.epoch === epoch - 1) ?? null
  if (settles && !settle) problems.push(`no settle event for epoch ${epoch}`)

  // What the settling transaction did to the objects holds the state at the end of the epoch.
  const tx = settle ? await attempt('settle transaction', () => src.transaction(settle.digest)) : null
  const changeOfType = (suffix: string) => tx?.changes.find((c) => c.type?.endsWith(suffix)) ?? null

  // ── Players, burns and BONEXP: the epoch's burn events ──
  const epochBurns = burns?.filter((b) => b.epoch === epoch) ?? null
  const burnStats = epochBurns
    ? {
        players: new Set(epochBurns.map((b) => b.player)).size,
        count: epochBurns.length,
        bonexp: epochBurns.reduce((sum, b) => sum + b.burned, 0n),
      }
    : null

  // ── Top scores: the board as the settling transaction found it, else the last score each player reached ──
  const scores = await (async () => {
    const boardBefore = changeOfType('::economy::EpochBoard')?.before
    const fromBoard = boardBefore
      ? await attempt('top scores from the settle transaction', async () => {
          if (num(boardBefore, 'epoch') !== epoch) throw new Error(`the board in the settle transaction was on epoch ${num(boardBefore, 'epoch')}`)
          return list(boardBefore, 'top').map((s) => {
            const standing = record(s, 'standing')
            return { address: str(standing, 'player'), score: big(standing, 'score') }
          })
        })
      : null
    if (fromBoard) return fromBoard
    if (!epochBurns) return null
    const best = new Map<string, bigint>()
    for (const b of epochBurns) if (b.newScore > (best.get(b.player) ?? 0n)) best.set(b.player, b.newScore)
    return [...best].map(([address, score]) => ({ address, score }))
  })()

  // ── Prize: the settle event, the prize object it created, the reward coin it paid ──
  const prize = await (async () => {
    if (!settle) return null
    const awarded = changeOfType('::economy::EpochPrize')
    const seedsByTier = awarded?.created
      ? await attempt('seeds by tier', async () => {
          const counts: number[] = []
          for (const a of list(awarded.after ?? {}, 'awards')) {
            const tier = num(record(a, 'award'), 'tier')
            counts[tier] = (counts[tier] ?? 0) + 1
          }
          return Array.from(counts, (n) => n ?? 0)
        })
      : null
    if (!awarded?.created && tx) problems.push('seeds by tier: no EpochPrize was created in the settle transaction')
    let settlerReward: bigint | null = null
    if (tx) {
      const coins = tx.changes.filter((c) => c.created && c.type !== null && SUI_COIN.test(c.type))
      if (coins.length === 0) settlerReward = 0n
      else if (coins.length === 1) settlerReward = await attempt('settler reward', async () => big(coins[0].after ?? {}, 'balance'))
      else problems.push('settler reward: the settle transaction created more than one SUI coin')
    }
    return { extracted: settle.extracted, awarded: settle.awarded, seedsByTier, settlerReward }
  })()

  // ── Treasury: after the settlement, else now ──
  const treasury = await (async () => {
    const after = changeOfType('::economy::GameBank')?.after
    if (after) {
      const value = await attempt('treasury after settlement', async () => big(after, 'treasury'))
      if (value !== null) return { value, asOf: 'after-settle' as const }
    }
    return bank ? { value: bank.treasury, asOf: 'now' as const } : null
  })()

  // ── Mints: the count kept at the end of each epoch ──
  const mints = minted !== null ? { cumulative: minted, previousCumulative: previousMinted } : null

  // ── PRUNE: the emissions the distributor confirmed for this epoch ──
  const prune = (() => {
    if (!distributes) return null
    if (!emissions || !holderEmissions) return null
    const standing = emissions.find((e) => e.epoch === epoch)
    const holder = holderEmissions.find((e) => e.epoch === epoch)
    const count = holder?.count ?? 0
    // The remaining and circulating figures are read now; they describe this epoch only
    // while the distributor has not confirmed a later one.
    const current = distributor.nextEpoch === epoch + 1
    return {
      standingEmission: standing?.amount ?? 0n,
      holderEmission: holder?.amount ?? 0n,
      holderCount: count,
      tapDivisor: tapDivisor(count),
      mintsToNextStage: mintsToNextStage(count),
      standingRemaining: current ? distributor.unallocated : null,
      holderRemaining: current ? distributor.holderUnallocated : null,
      circulating: current && lock ? PRUNE_TOTAL_SUPPLY - distributor.pool - lock.balance : null,
    }
  })()

  // ── Ballot: where the next vote is, how the open one stands, what the last one decided ──
  const ballot = await (async () => {
    if (!governance || !governance.bootstrapped) return null
    const first = governance.firstBallotEpoch
    const now = board.epoch
    const nextBallotEpoch = now <= first ? first : first + Math.ceil((now - first) / BALLOT_INTERVAL) * BALLOT_INTERVAL
    let open: { epoch: number; deposited: bigint; needed: bigint } | null = null
    if (now >= first && (now - first) % BALLOT_INTERVAL === 0) {
      open = await attempt('open ballot', async () => {
        const row = await src.ballot(governance.ballotsTableId, now)
        const circulating = row?.circulating ?? (lock ? PRUNE_TOTAL_SUPPLY - distributor.pool - lock.balance : null)
        if (circulating === null) throw new Error('the circulating supply could not be read')
        const tenth = (circulating + QUORUM_DIVISOR - 1n) / QUORUM_DIVISOR
        return { epoch: now, deposited: row?.total ?? 0n, needed: tenth > MIN_QUORUM ? tenth : MIN_QUORUM }
      })
    }
    const last = ballotsExecuted?.reduce<BallotExecutedEvent | null>((a, e) => (a === null || e.ballotEpoch > a.ballotEpoch ? e : a), null) ?? null
    return {
      nextBallotEpoch,
      open,
      executed: last ? { epoch: last.ballotEpoch, quorumMet: last.quorumMet, applied: last.applied } : null,
    }
  })()

  // ── Drains between this epoch's start and end, both marked by a settlement ──
  const drainCount =
    drains && settle && settlePrevious ? drains.filter((d) => d.timestampMs >= settlePrevious.timestampMs && d.timestampMs < settle.timestampMs).length : null

  // ── Rules in force: the board's rules field as the settling transaction found it ──
  const config = await (async () => {
    const rules = tx?.changes.find((c) => c.type !== null && c.type.includes('::economy::EpochRulesKey') && c.before)?.before
    if (!rules) return null
    return attempt('rules in force', async () => {
      const v = child(rules, 'value')
      const tiers = list(v, 'tiers').map((t) => {
        const tier = record(t, 'tier')
        return { maxRank: num(tier, 'max_rank'), amountPerSlot: big(tier, 'amount_per_slot') }
      })
      return {
        entryFee: big(v, 'standing_fee_sui'),
        epochLengthMs: num(v, 'span_ms'),
        prizeShape: prizeShapeOf(tiers),
        prizeCeilingPercent: Number(big(v, 'buyback_bps')) / 100,
      }
    })
  })()

  const raw: RawEpoch = {
    epoch,
    startedAtMs: settlePrevious?.timestampMs ?? null,
    endedAtMs: settle?.timestampMs ?? null,
    burns: burnStats,
    scores,
    prize,
    treasury,
    mints,
    prune,
    ballot,
    arena: arena ? { trees: arena.stationed, seeded: arena.seeded } : null,
    drains: drainCount,
    config,
    tx: {
      settle: settle?.digest ?? null,
      advance: (emissions?.find((e) => e.epoch === epoch) ?? holderEmissions?.find((e) => e.epoch === epoch))?.digest ?? null,
      execute: ballotsExecuted && ballotsExecuted.length > 0 ? ballotsExecuted[ballotsExecuted.length - 1].digest : null,
    },
    gardener: balances ? { sui: balances.sui, wal: balances.wal, spentThisEpoch: options.spentThisEpoch } : null,
  }
  return { raw, problems }
}
