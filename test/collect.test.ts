import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectRawEpoch, mintsToNextStage, NotFinalError, prizeShapeOf, tapDivisor, type Sources } from '../src/collect'
import type { ChainEvent, TransactionChanges } from '../src/events'
import { fetchEvents, fetchTransactionChanges, parseBurn, parseDrain, parseSettle } from '../src/events'
import { buildFacts } from '../src/facts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), 'utf8')) as any
const objects = fixture('objects') as Record<string, { json: Record<string, any> }>
const U = 1_000_000_000n
const NO_SPEND = { spentThisEpoch: 0n }

async function realEvents(name: string): Promise<ChainEvent[]> {
  const nodes = fixture(name)
  return fetchEvents(async () => ({ events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }), 'any')
}

/** Sources backed by the captured mainnet responses: the chain as it stood with the board on epoch 4. */
async function mainnetSources(): Promise<Sources> {
  const captured = fixture('settle-transaction')
  const tx = await fetchTransactionChanges(
    async () => ({ transaction: { ...captured, effects: { ...captured.effects, objectChanges: { ...captured.effects.objectChanges, pageInfo: { hasNextPage: false } } } } }),
    captured.digest,
  )
  const burns = (await realEvents('events-burn')).map(parseBurn)
  const settles = (await realEvents('events-settle')).map(parseSettle)
  const drains = (await realEvents('events-drain-sample')).map(parseDrain)
  return {
    board: async () => ({ epoch: 4, endsAtMs: 1_792_847_579_247 }),
    gameBank: async () => ({ treasury: 65_366_320_000n, totalMinted: 108 }),
    epochMinted: async () => null,
    arena: async () => ({ stationed: 10, seeded: 7 }),
    distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 5, unallocated: 55_000n * U, holderUnallocated: 30_000n * U, pool: 85_000n * U }),
    governance: async () => ({ bootstrapped: true, firstBallotEpoch: 9, ballotsTableId: '0xtable' }),
    ballot: async () => null,
    operatorLock: async () => ({ balance: 15_000_000n * U }),
    balances: async () => ({ sui: 2n * U, wal: 9_989_828_272n }),
    burns: async () => burns,
    settles: async () => settles,
    drains: async () => drains,
    emissions: async () => [],
    holderEmissions: async () => [],
    ballotsExecuted: async () => [],
    transaction: async () => tx,
  }
}

describe('an epoch settled before distribution began (real mainnet data, epoch 1)', () => {
  it('assembles the figures the chain holds and leaves the rest null', async () => {
    const { raw, problems } = await collectRawEpoch(await mainnetSources(), 1, NO_SPEND)
    expect(problems).toEqual([])

    // From the epoch's burn events.
    const burns = (await realEvents('events-burn')).map(parseBurn).filter((b) => b.epoch === 1)
    expect(raw.burns).toEqual({
      players: new Set(burns.map((b) => b.player)).size,
      count: burns.length,
      bonexp: burns.reduce((s, b) => s + b.burned, 0n),
    })
    expect(raw.burns!.count).toBeGreaterThan(0)

    // From the board as the settling transaction found it: three players, best first.
    expect(raw.scores!.map((s) => s.score)).toEqual([7_232_400_000_000n, 6_868_680_200_000n, 3_975_164_100_000n])

    // From the settle event, the prize object it created, and the reward coin it paid.
    expect(raw.prize).toEqual({ extracted: 8_368_000_000n, awarded: 8_367_999_999n, seedsByTier: [1, 2], settlerReward: 200_000_000n })

    // From the GameBank as the transaction left it.
    expect(raw.treasury).toEqual({ value: 75_112_000_000n, asOf: 'after-settle' })

    expect(raw.tx.settle).toBe(fixture('events-settle')[0].transaction.digest)
    expect(raw.endedAtMs).toBe(Date.parse(fixture('events-settle')[0].timestamp))

    // Not kept by the game yet, so not known.
    expect(raw.mints).toBeNull()
    expect(raw.startedAtMs).toBeNull()
    expect(raw.drains).toBeNull()
    expect(raw.config).toBeNull()
    // Distribution starts at epoch 5.
    expect(raw.prune).toBeNull()
  })

  it('reports the Arena and the next ballot as of now only when the board is on the epoch after this one', async () => {
    const src = { ...(await mainnetSources()), board: async () => ({ epoch: 2, endsAtMs: 0 }) }
    const { raw } = await collectRawEpoch(src, 1, { spentThisEpoch: 12_000_000n })
    expect(raw.arena).toEqual({ trees: 10, seeded: 7 })
    expect(raw.ballot).toEqual({ nextBallotEpoch: 9, open: null, executed: null })
    expect(raw.gardener).toEqual({ sui: 2n * U, wal: 9_989_828_272n, spentThisEpoch: 12_000_000n })
  })

  it('leaves the Arena and the ballot’s now-figures null for an older epoch (epoch 2, with the board on 4)', async () => {
    const { raw, problems } = await collectRawEpoch(await mainnetSources(), 2, NO_SPEND)
    expect(raw.arena).toBeNull()
    expect(raw.ballot).toEqual({ nextBallotEpoch: null, open: null, executed: null })
    // Not a failure to read: the figures are simply not this epoch's.
    expect(problems.filter((p) => /arena|ballot/i.test(p))).toEqual([])
  })

  it('still reports the last executed ballot for an older epoch', async () => {
    const src = {
      ...(await mainnetSources()),
      ballotsExecuted: async () => [{ digest: 'EX', timestampMs: 1, ballotEpoch: 9, quorumMet: true, applied: [true, true, true, true] }],
    }
    const { raw } = await collectRawEpoch(src, 2, NO_SPEND)
    expect(raw.ballot).toEqual({ nextBallotEpoch: null, open: null, executed: { epoch: 9, quorumMet: true, applied: [true, true, true, true] } })
  })

  it('turns into facts in whole units', async () => {
    const facts = buildFacts((await collectRawEpoch(await mainnetSources(), 1, NO_SPEND)).raw)
    expect(facts).toMatchObject({
      epoch: 1,
      prize: { extracted: 8.368, awarded: 8.367999999, seedsByTier: [1, 2], settlerReward: 0.2 },
      treasury: { value: 75.112, asOf: 'after-settle' },
      top: [{ score: 7232.4 }, { score: 6868.6802 }, { score: 3975.1641 }],
      mints: null,
      prune: null,
    })
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts)
  })
})

describe('an epoch that is not final', () => {
  it('refuses the epoch the board is still on, and any later one', async () => {
    const src = await mainnetSources()
    await expect(collectRawEpoch(src, 4, NO_SPEND)).rejects.toBeInstanceOf(NotFinalError)
    await expect(collectRawEpoch(src, 5, NO_SPEND)).rejects.toThrow(/still running/)
  })

  it('refuses an epoch whose distribution the distributor has not confirmed', async () => {
    const src = { ...(await mainnetSources()), board: async () => ({ epoch: 7, endsAtMs: 0 }) }
    await expect(collectRawEpoch(src, 5, NO_SPEND)).rejects.toThrow(/distribution is not confirmed/)
  })

  it('does not ask for confirmation of an epoch before distribution began', async () => {
    await expect(collectRawEpoch(await mainnetSources(), 3, NO_SPEND)).resolves.toBeDefined()
  })
})

// ── A distributing epoch, built to the Move structs' own shapes ────────────

const player = (n: number) => '0x' + String(n).padStart(64, '0')
const DAY = 86_400_000
const T4 = Date.UTC(2026, 10, 1)
const T5 = T4 + 7 * DAY

function change(type: string, over: Partial<TransactionChanges['changes'][number]>): TransactionChanges['changes'][number] {
  return { address: '0x' + 'e'.repeat(64), created: false, deleted: false, type, before: null, after: null, ...over }
}

const SUI_COIN_TYPE = `0x${'0'.repeat(63)}2::coin::Coin<0x${'0'.repeat(63)}2::sui::SUI>`
const GAME = '0xgame'

function settleTx(extra: TransactionChanges['changes'] = []): TransactionChanges {
  return {
    digest: 'SETTLE5',
    sender: player(99),
    changes: [
      change(`${GAME}::economy::EpochBoard`, {
        before: { epoch: '5', top: [{ player: player(1), score: '900' }, { player: player(2), score: '700' }, { player: player(3), score: '100' }] },
        after: { epoch: '6', top: [] },
      }),
      change(`${GAME}::economy::GameBank`, { before: { treasury: '400000000000' }, after: { treasury: '360000000000' } }),
      change(`${GAME}::economy::EpochPrize`, {
        created: true,
        after: { epoch: '5', awards: [{ tier: 0 }, { tier: 1 }, { tier: 1 }, { tier: 3 }], pot: '1' },
      }),
      change(SUI_COIN_TYPE, { created: true, after: { balance: '500000000' } }),
      change(`0x2::dynamic_field::Field<${GAME}::economy::EpochRulesKey,${GAME}::economy::EpochRules>`, {
        before: {
          value: {
            tiers: [
              { max_rank: '1', amount_per_slot: String(60n * U) },
              { max_rank: '3', amount_per_slot: String(30n * U) },
              { max_rank: '10', amount_per_slot: String(12n * U) },
              { max_rank: '20', amount_per_slot: String(6n * U) },
            ],
            buyback_bps: '800',
            span_ms: '604800000',
            standing_fee_sui: '500000000',
          },
        },
        after: { value: {} },
      }),
      ...extra,
    ],
  }
}

async function distributingSources(over: Partial<Sources> = {}): Promise<Sources> {
  const base = await mainnetSources()
  const at = (timestampMs: number) => ({ timestampMs })
  return {
    ...base,
    board: async () => ({ epoch: 6, endsAtMs: T5 + 7 * DAY }),
    distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 6, unallocated: 49_500n * U, holderUnallocated: 29_000n * U, pool: 78_500n * U }),
    epochMinted: async (e) => (e === 5 ? 1_300 : e === 4 ? 1_200 : null),
    settles: async () => [
      { digest: 'SETTLE4', ...at(T4), epoch: 4, extracted: 0n, awarded: 0n },
      { digest: 'SETTLE5', ...at(T5), epoch: 5, extracted: 40n * U, awarded: 40n * U - 1n },
    ],
    burns: async () => [
      { digest: 'b1', timestampMs: T4 + 1, player: player(1), epoch: 5, burned: 100n * U, gained: 100n * U, newScore: 100n * U },
      { digest: 'b2', timestampMs: T4 + 2, player: player(1), epoch: 5, burned: 50n * U, gained: 40n * U, newScore: 140n * U },
      { digest: 'b3', timestampMs: T4 + 3, player: player(2), epoch: 5, burned: 70n * U, gained: 70n * U, newScore: 70n * U },
      { digest: 'b4', timestampMs: T4 + 4, player: player(3), epoch: 4, burned: 9n * U, gained: 9n * U, newScore: 9n * U },
    ],
    drains: async () => [T4 - 1, T4, T4 + DAY, T5 - 1, T5, T5 + 1].map((t) => ({ digest: 'd', timestampMs: t })),
    emissions: async () => [{ digest: 'ADV5', epoch: 5, amount: 5_500n * U }],
    holderEmissions: async () => [{ digest: 'ADV5', epoch: 5, amount: 600n * U, count: 1_300 }],
    ballotsExecuted: async () => [
      { digest: 'EX1', timestampMs: 1, ballotEpoch: 1, quorumMet: false, applied: [false, false, false, false] },
      { digest: 'EX2', timestampMs: 2, ballotEpoch: 9, quorumMet: true, applied: [true, false, true, false] },
    ],
    transaction: async () => settleTx(),
    ...over,
  }
}

describe('a distributing epoch (epoch 5, the board on 6)', () => {
  it('counts the epoch’s own burns: players once each, every burn, all the BONEXP', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.burns).toEqual({ players: 2, count: 3, bonexp: 220n * U })
  })

  it('takes the scores from the settle transaction’s board, not from the burn events', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.scores).toEqual([
      { address: player(1), score: 900n },
      { address: player(2), score: 700n },
      { address: player(3), score: 100n },
    ])
  })

  it('counts the seeds of each tier from the prize object, and reads the reward from the one SUI coin created', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.prize).toEqual({ extracted: 40n * U, awarded: 40n * U - 1n, seedsByTier: [1, 2, 0, 1], settlerReward: 500_000_000n })
  })

  it('reads the rules in force from the board’s rules field as it stood before the settlement', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.config).toEqual({ entryFee: 500_000_000n, epochLengthMs: 604_800_000, prizeShape: 1, prizeCeilingPercent: 8 })
  })

  it('counts the mints kept at the end of this epoch and of the one before', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.mints).toEqual({ cumulative: 1_300, previousCumulative: 1_200 })
  })

  it('counts drains between the two settlements: from the first, up to but not including the second', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.startedAtMs).toBe(T4)
    expect(raw.endedAtMs).toBe(T5)
    expect(raw.drains).toBe(3) // T4, T4 + DAY, T5 - 1
  })

  it('takes the emissions from the events and the stage of the tap from the mint count they carry', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.prune).toEqual({
      standingEmission: 5_500n * U,
      holderEmission: 600n * U,
      holderCount: 1_300,
      tapDivisor: 2,
      mintsToNextStage: 51,
      standingRemaining: 49_500n * U,
      holderRemaining: 29_000n * U,
      circulating: 100_000_000n * U - 78_500n * U - 15_000_000n * U,
    })
  })

  it('leaves the remaining and circulating figures null once a later epoch has been confirmed', async () => {
    const src = await distributingSources({
      distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 7, unallocated: 1n, holderUnallocated: 1n, pool: 1n }),
      board: async () => ({ epoch: 8, endsAtMs: 0 }),
    })
    const { raw } = await collectRawEpoch(src, 5, NO_SPEND)
    expect(raw.prune).toMatchObject({ standingEmission: 5_500n * U, standingRemaining: null, holderRemaining: null, circulating: null })
  })

  it('reads an epoch nobody scored in as no emission, not as unreadable', async () => {
    const { raw } = await collectRawEpoch(await distributingSources({ emissions: async () => [], holderEmissions: async () => [] }), 5, NO_SPEND)
    expect(raw.prune).toMatchObject({ standingEmission: 0n, holderEmission: 0n, holderCount: 0, tapDivisor: 8 })
  })

  it('names the settle and the advance, and no ballot execution when this epoch ran no vote', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.tx).toEqual({ settle: 'SETTLE5', advance: 'ADV5', execute: null })
  })

  it('names the transaction that applied the ballot this epoch ran, and only that one', async () => {
    const executed = (ballotEpoch: number, digest: string) => ({ digest, timestampMs: 1, ballotEpoch, quorumMet: true, applied: [true, false, true, false] })
    const src = await distributingSources({ ballotsExecuted: async () => [executed(1, 'EX1'), executed(5, 'EX5'), executed(9, 'EX9')] })
    expect((await collectRawEpoch(src, 5, NO_SPEND)).raw.tx.execute).toBe('EX5')
  })

  it('reports the latest executed ballot with its per-item results', async () => {
    const { raw } = await collectRawEpoch(await distributingSources(), 5, NO_SPEND)
    expect(raw.ballot!.executed).toEqual({ epoch: 9, quorumMet: true, applied: [true, false, true, false] })
  })
})

describe('what happens when a part cannot be read', () => {
  it('turns that part into null with a reason and keeps the rest', async () => {
    const src = await distributingSources({ burns: async () => Promise.reject(new Error('GraphQL answered HTTP 503')) })
    const { raw, problems } = await collectRawEpoch(src, 5, NO_SPEND)
    expect(raw.burns).toBeNull()
    expect(problems).toEqual([expect.stringMatching(/burn events: GraphQL answered HTTP 503/)])
    expect(raw.prize).not.toBeNull()
    expect(buildFacts(raw).players).toBeNull()
  })

  it('falls back to the best score each player reached when the settle transaction cannot be read', async () => {
    const { raw, problems } = await collectRawEpoch(await distributingSources({ transaction: async () => Promise.reject(new Error('not found')) }), 5, NO_SPEND)
    expect(raw.scores).toEqual([
      { address: player(1), score: 140n * U },
      { address: player(2), score: 70n * U },
    ])
    expect(problems.join()).toMatch(/settle transaction: not found/)
    // What only the transaction knows becomes unknown, not a guess.
    expect(raw.prize).toMatchObject({ extracted: 40n * U, seedsByTier: null, settlerReward: null })
    expect(raw.config).toBeNull()
    // The Treasury falls back to the current figure and says so.
    expect(raw.treasury).toEqual({ value: 65_366_320_000n, asOf: 'now' })
  })

  it('says it does not know the reward when the transaction created more than one SUI coin', async () => {
    const src = await distributingSources({
      transaction: async () => settleTx([change(SUI_COIN_TYPE, { created: true, after: { balance: '7' } })]),
    })
    const { raw, problems } = await collectRawEpoch(src, 5, NO_SPEND)
    expect(raw.prize!.settlerReward).toBeNull()
    expect(problems.join()).toMatch(/more than one SUI coin/)
  })

  it('reads a settlement that paid no reward as zero', async () => {
    const tx = settleTx()
    const src = await distributingSources({ transaction: async () => ({ ...tx, changes: tx.changes.filter((c) => c.type !== SUI_COIN_TYPE) }) })
    expect((await collectRawEpoch(src, 5, NO_SPEND)).raw.prize!.settlerReward).toBe(0n)
  })

  it('does not trust a board in the transaction that is on another epoch', async () => {
    const tx = settleTx()
    tx.changes[0] = change(`${GAME}::economy::EpochBoard`, { before: { epoch: '4', top: [] }, after: { epoch: '5', top: [] } })
    const { raw, problems } = await collectRawEpoch(await distributingSources({ transaction: async () => tx }), 5, NO_SPEND)
    expect(problems.join()).toMatch(/the board in the settle transaction was on epoch 4/)
    expect(raw.scores!.map((s) => s.address)).toEqual([player(1), player(2)])
  })

  it('knows nothing of drains without both settlements', async () => {
    const { raw } = await collectRawEpoch(await distributingSources({ settles: async () => [{ digest: 'SETTLE5', timestampMs: T5, epoch: 5, extracted: 1n, awarded: 1n }] }), 5, NO_SPEND)
    expect(raw.drains).toBeNull()
    expect(raw.startedAtMs).toBeNull()
  })

  it('leaves the open ballot unread, with the reason, when the circulating supply cannot be had', async () => {
    // The board is on 9, a ballot epoch, nobody has voted yet (no row), and the lock cannot be read.
    // Epoch 8 has just ended and its distribution is confirmed.
    const src = await distributingSources({
      board: async () => ({ epoch: 9, endsAtMs: 0 }),
      distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 9, unallocated: 1n, holderUnallocated: 1n, pool: 78_500n * U }),
      ballot: async () => null,
      operatorLock: async () => Promise.reject(new Error('lock unreadable')),
    })
    const { raw, problems } = await collectRawEpoch(src, 8, NO_SPEND)
    expect(raw.ballot).toMatchObject({ nextBallotEpoch: 9, open: null })
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/operator lock: lock unreadable/), expect.stringMatching(/open ballot: the circulating supply could not be read/)]))
    // The same failure leaves the circulating figure unknown, and everything else stands.
    expect(raw.prune).toMatchObject({ standingEmission: 0n, standingRemaining: 1n, circulating: null })
  })
})

describe('the ballot', () => {
  /** A board on `now`, collected for the epoch just before it: the case in which the board's own figures apply. */
  const governed = (now: number, over: Partial<Sources> = {}) =>
    distributingSources({
      board: async () => ({ epoch: now, endsAtMs: 0 }),
      distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: now, unallocated: 1n, holderUnallocated: 1n, pool: 78_500n * U }),
      ...over,
    })

  it.each([
    [6, 9], // before the first ballot
    [9, 9], // the first ballot's own epoch
    [10, 13],
    [12, 13],
    [13, 13],
    [14, 17],
  ])('puts the next ballot epoch for a board on epoch %i at %i', async (now, next) => {
    const { raw } = await collectRawEpoch(await governed(now), now - 1, NO_SPEND)
    expect(raw.ballot!.nextBallotEpoch).toBe(next)
  })

  it('does not work out a next ballot for an epoch that ended long before the board’s epoch', async () => {
    const { raw } = await collectRawEpoch(await governed(14), 5, NO_SPEND)
    expect(raw.ballot).toMatchObject({ nextBallotEpoch: null, open: null })
  })

  it('is open only in a ballot epoch, with the deposit and the quorum it needs', async () => {
    const row = { total: 2_000_000n * U, circulating: 20_000_000n * U, executed: false }
    const { raw } = await collectRawEpoch(await governed(9, { ballot: async () => row }), 8, NO_SPEND)
    // A tenth of 20,000,000 is 2,000,000, above the 1,000,000 floor.
    expect(raw.ballot!.open).toEqual({ epoch: 9, deposited: 2_000_000n * U, needed: 2_000_000n * U })
    expect((await collectRawEpoch(await governed(10), 9, NO_SPEND)).raw.ballot!.open).toBeNull()
  })

  it('needs at least the floor of 1,000,000 when a tenth of the supply is less', async () => {
    const row = { total: 5n * U, circulating: 4_000_000n * U, executed: false }
    expect((await collectRawEpoch(await governed(9, { ballot: async () => row }), 8, NO_SPEND)).raw.ballot!.open).toEqual({
      epoch: 9,
      deposited: 5n * U,
      needed: 1_000_000n * U,
    })
  })

  it('rounds a tenth up, as the quorum is "at least", and counts nothing deposited before a first vote', async () => {
    const { raw } = await collectRawEpoch(await governed(9, { ballot: async () => null, operatorLock: async () => ({ balance: 0n }) }), 8, NO_SPEND)
    // No row: the circulating supply is read now: 100,000,000 − 78,500 pool − 0 locked.
    const circulating = 100_000_000n * U - 78_500n * U
    expect(raw.ballot!.open).toEqual({ epoch: 9, deposited: 0n, needed: (circulating + 9n) / 10n })
  })

  it('is absent while the governance is not bootstrapped', async () => {
    const src = await governed(9, { governance: async () => ({ bootstrapped: false, firstBallotEpoch: 0, ballotsTableId: '0x' }) })
    expect((await collectRawEpoch(src, 8, NO_SPEND)).raw.ballot).toBeNull()
  })
})

describe('the game’s fixed tables', () => {
  it.each([
    [0, 8],
    [350, 8],
    [351, 4],
    [850, 4],
    [851, 2],
    [1_350, 2],
    [1_351, 1],
    [5_000, 1],
  ])('divides the holder share by the right number for %i mints (%i)', (mints, divisor) => {
    expect(tapDivisor(mints)).toBe(divisor)
  })

  it.each([
    [1_300, 51],
    [1_350, 1],
    [851, 500],
    [350, 1],
    [0, 351],
    [1_351, null],
  ])('counts the mints from %i to the next stage (%s)', (mints, left) => {
    expect(mintsToNextStage(mints)).toBe(left)
  })

  it('recognises the three prize shapes by their tier tables, and nothing else', () => {
    const shape = (rows: [number, number][]) => rows.map(([maxRank, sui]) => ({ maxRank, amountPerSlot: BigInt(sui) * U }))
    expect(prizeShapeOf(shape([[1, 100], [3, 35], [10, 10], [20, 4]]))).toBe(0)
    expect(prizeShapeOf(shape([[1, 60], [3, 30], [10, 12], [20, 6]]))).toBe(1)
    expect(prizeShapeOf(shape([[1, 40], [3, 25], [10, 12], [20, 8]]))).toBe(2)
    expect(prizeShapeOf(shape([[1, 60], [3, 30], [10, 12], [20, 7]]))).toBeNull()
    expect(prizeShapeOf(shape([[1, 60], [3, 30]]))).toBeNull()
  })

  it('agrees with the captured Distributor about when distribution starts', () => {
    expect(Number(objects.Distributor.json.start_epoch)).toBe(5)
  })
})
