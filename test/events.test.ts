import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  eventTypes,
  fetchEvents,
  fetchTransactionChanges,
  parseBallotExecuted,
  parseBurn,
  parseDrain,
  parseEmission,
  parseHolderEmission,
  parseSettle,
  type ChainEvent,
} from '../src/events'
import type { GraphQl } from '../src/gql'

/** Real mainnet responses, with player addresses replaced; see the capture notes in the commit that added them. */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), 'utf8')) as any

type RawNode = { timestamp: string; transaction: { digest: string }; contents: { json: Record<string, unknown> } }

/** Serves `nodes` the way the endpoint does: `pageSize` at a time, with a cursor. */
function pagedEvents(nodes: RawNode[], pageSize: number): GraphQl & { calls: number } {
  const fn = (async (_query: string, variables: Record<string, unknown> = {}) => {
    fn.calls += 1
    const start = typeof variables.after === 'string' ? Number(variables.after) : 0
    const slice = nodes.slice(start, start + pageSize)
    const end = start + pageSize
    return { events: { pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) }, nodes: slice } }
  }) as GraphQl & { calls: number }
  fn.calls = 0
  return fn
}

describe('fetchEvents', () => {
  const burns: RawNode[] = fixture('events-burn')

  it('reads every page to the last, so the count is the whole count', async () => {
    const gql = pagedEvents(burns, 10)
    const got = await fetchEvents(gql, 'any')
    expect(got).toHaveLength(burns.length)
    expect(gql.calls).toBe(Math.ceil(burns.length / 10))
  })

  it('keeps the order, the transaction digest and the parsed time', async () => {
    const got = await fetchEvents(pagedEvents(burns, 50), 'any')
    expect(got[0].digest).toBe(burns[0].transaction.digest)
    expect(got[0].timestampMs).toBe(Date.parse(burns[0].timestamp))
    const times = got.map((e) => e.timestampMs)
    expect(times).toEqual(times.slice().sort((a, b) => a - b))
  })

  it('answers an empty list for a type with no events', async () => {
    expect(await fetchEvents(pagedEvents([], 50), 'any')).toEqual([])
  })

  it('stops with an error when the cursor does not advance, rather than loop', async () => {
    const stuck: GraphQl = async () => ({ events: { pageInfo: { hasNextPage: true, endCursor: 'same' }, nodes: [] } })
    await expect(fetchEvents(stuck, 'any')).rejects.toThrow(/cursor did not advance/)
  })

  it('refuses a node it cannot read instead of skipping it', async () => {
    const bad = [{ ...burns[0], timestamp: 'not a time' }]
    await expect(fetchEvents(pagedEvents(bad, 50), 'any')).rejects.toThrow(/timestamp/)
    const noDigest = [{ timestamp: burns[0].timestamp, transaction: {}, contents: burns[0].contents }] as unknown as RawNode[]
    await expect(fetchEvents(pagedEvents(noDigest, 50), 'any')).rejects.toThrow(/digest/)
  })
})

describe('the typed events, parsed from real responses', () => {
  const read = async (name: string): Promise<ChainEvent[]> => fetchEvents(pagedEvents(fixture(name), 50), 'any')

  it('BurnForScoreEvent', async () => {
    const events = (await read('events-burn')).map(parseBurn)
    expect(events[0]).toMatchObject({ epoch: 1, burned: 113_000_000_000n, gained: 113_000_000_000n, newScore: 113_000_000_000n })
    expect(events.every((e) => /^0x[0-9a-f]{64}$/.test(e.player))).toBe(true)
    expect(events.map((e) => e.epoch)).toContain(3)
  })

  it('SettleEpochEvent', async () => {
    const events = (await read('events-settle')).map(parseSettle)
    expect(events.map((e) => e.epoch)).toEqual([1, 2, 3])
    expect(events[0]).toMatchObject({ extracted: 8_368_000_000n, awarded: 8_367_999_999n })
  })

  it('DrainEvent is dated by the game clock in the event', async () => {
    const [first] = (await read('events-drain-sample')).map(parseDrain)
    expect(first.timestampMs).toBe(1_790_438_807_298)
  })

  // These three have no live example yet (distribution starts with epoch 5), so their shape is the Move
  // struct's own field list: `EmissionEvent { epoch, amount }`, `HolderEmissionEvent { epoch, amount, count }`,
  // `BallotExecutedEvent { ballot_epoch, quorum_met, applied }`, with u64 as a string like every other event.
  it('EmissionEvent, HolderEmissionEvent and BallotExecutedEvent', () => {
    const at = (json: Record<string, unknown>): ChainEvent => ({ digest: 'D', timestampMs: 5, json })
    expect(parseEmission(at({ epoch: '5', amount: '55000000000' }))).toEqual({ digest: 'D', epoch: 5, amount: 55_000_000_000n })
    expect(parseHolderEmission(at({ epoch: '5', amount: '9', count: '120' }))).toEqual({ digest: 'D', epoch: 5, amount: 9n, count: 120 })
    expect(parseBallotExecuted(at({ ballot_epoch: '9', quorum_met: true, applied: [true, false, true, false] }))).toEqual({
      digest: 'D',
      timestampMs: 5,
      ballotEpoch: 9,
      quorumMet: true,
      applied: [true, false, true, false],
    })
  })

  it('refuses a field that is not what the struct says', () => {
    const at = (json: Record<string, unknown>): ChainEvent => ({ digest: 'D', timestampMs: 5, json })
    expect(() => parseEmission(at({ epoch: 'five', amount: '1' }))).toThrow(/epoch/)
    expect(() => parseEmission(at({ epoch: '5' }))).toThrow(/amount/)
    expect(() => parseBallotExecuted(at({ ballot_epoch: '9', quorum_met: 'yes', applied: [] }))).toThrow(/quorum_met/)
    expect(() => parseBallotExecuted(at({ ballot_epoch: '9', quorum_met: true, applied: [1] }))).toThrow(/applied/)
  })
})

describe('eventTypes', () => {
  it('prefixes each type with the package that declared it', () => {
    const t = eventTypes({ game: '0xG', gov: '0xV' })
    expect(t.settle).toBe('0xG::economy::SettleEpochEvent')
    expect(t.burn).toBe('0xG::economy::BurnForScoreEvent')
    expect(t.drain).toBe('0xG::bonsai::DrainEvent')
    expect(t.emission).toBe('0xV::distributor::EmissionEvent')
    expect(t.holderEmission).toBe('0xV::distributor::HolderEmissionEvent')
    expect(t.ballotExecuted).toBe('0xV::governance::BallotExecutedEvent')
  })
})

describe('fetchTransactionChanges', () => {
  const captured = fixture('settle-transaction')
  const withPage = (hasNextPage: boolean) => ({
    ...captured,
    effects: { ...captured.effects, objectChanges: { ...captured.effects.objectChanges, pageInfo: { hasNextPage } } },
  })
  const tx = withPage(false)
  const gql: GraphQl = async () => ({ transaction: tx })

  it('refuses a transaction whose changes span more than one page', async () => {
    await expect(fetchTransactionChanges(async () => ({ transaction: withPage(true) }), 'X')).rejects.toThrow(/more object changes than one page/)
  })

  it('gives both sides of every object the transaction touched', async () => {
    const got = await fetchTransactionChanges(gql, tx.digest)
    expect(got.sender).toBe(tx.sender.address)
    expect(got.changes).toHaveLength(4)
    const board = got.changes.find((c) => c.type?.endsWith('::economy::EpochBoard'))!
    expect(board.before).toMatchObject({ epoch: '1' })
    expect(board.after).toMatchObject({ epoch: '2', top: [] })
    const prize = got.changes.find((c) => c.type?.endsWith('::economy::EpochPrize'))!
    expect(prize).toMatchObject({ created: true, before: null })
    expect(prize.after).toMatchObject({ epoch: '1' })
    const coin = got.changes.find((c) => c.type?.includes('::coin::Coin<'))!
    expect(coin).toMatchObject({ created: true, after: { balance: '200000000' } })
  })

  it('says so when the transaction is not found', async () => {
    await expect(fetchTransactionChanges(async () => ({ transaction: null }), 'X')).rejects.toThrow(/not found/)
  })
})
