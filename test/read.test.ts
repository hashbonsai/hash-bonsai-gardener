import { readFileSync } from 'node:fs'
import { bcs, TypeTagSerializer } from '@mysten/sui/bcs'
import { deriveDynamicFieldID } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'
import {
  readArena,
  readBalances,
  readBallot,
  readBoard,
  readDistributor,
  readEpochMinted,
  readGameBank,
  readGovernance,
  readOperatorLock,
  type GameIds,
  type GrpcReader,
} from '../src/read'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), 'utf8')) as any

const objects: Record<string, { type: string; json: Record<string, unknown> }> = fixture('objects')
const V4 = '0x' + 'b'.repeat(64)
const IDS = {
  epochBoard: objects.EpochBoard.json.id as string,
  gameBank: objects.GameBank.json.id as string,
  arena: objects.Arena.json.id as string,
  distributor: objects.Distributor.json.id as string,
  governance: objects.Governance.json.id as string,
  operatorLock: objects.OperatorLock.json.id as string,
  epochKeyPackageId: V4,
  walType: '0xwal::wal::WAL',
}
const ids: GameIds = IDS

type Row = Record<string, unknown>

/** A stand-in for the gRPC client, serving the captured objects and any extra rows by id. */
function fake(extra: Record<string, Row> = {}, fieldPages?: { name: { type: string } }[][]) {
  const byId = new Map<string, { type: string; json: Row }>(Object.values(objects).map((o) => [o.json.id as string, o]))
  for (const [id, json] of Object.entries(extra)) byId.set(id, { type: 'row', json })
  const calls = { getObjects: [] as string[][], listDynamicFields: 0 }
  const arenaFields = fixture('arena-dynamic-fields').fields as { nameType: string }[]
  const pages = fieldPages ?? [arenaFields.map((f) => ({ name: { type: f.nameType } }))]
  const client: GrpcReader = {
    core: {
      async getObjects({ objectIds }) {
        calls.getObjects.push(objectIds)
        return { objects: objectIds.map((id) => byId.get(id) ?? new Error(`Object ${id} not found`)) }
      },
      async listDynamicFields({ cursor }) {
        calls.listDynamicFields += 1
        const i = cursor ? Number(cursor) : 0
        return { hasNextPage: i + 1 < pages.length, cursor: i + 1 < pages.length ? String(i + 1) : null, dynamicFields: pages[i] }
      },
      async getBalance({ coinType }) {
        return { balance: { balance: coinType ? '9989828272' : '1500000000' } }
      },
    },
  }
  return { client, calls }
}

const rowId = (parent: string, type: string, key: Uint8Array) => deriveDynamicFieldID(parent, TypeTagSerializer.parseFromStr(type, true), key)
const u64 = (n: number) => bcs.u64().serialize(BigInt(n)).toBytes()

describe('the game objects, read as JSON', () => {
  it('EpochBoard: the running epoch and when it ends', async () => {
    expect(await readBoard(fake().client, ids)).toEqual({ epoch: 4, endsAtMs: 1_792_847_579_247 })
  })
  it('GameBank: the Treasury in MIST and the mint count', async () => {
    expect(await readGameBank(fake().client, ids)).toEqual({ treasury: 65_366_320_000n, totalMinted: 108 })
  })
  it('Distributor: confirmed through, the unallocated shares and the pool', async () => {
    expect(await readDistributor(fake().client, ids)).toEqual({
      bootstrapped: true,
      startEpoch: 5,
      nextEpoch: 5,
      unallocated: BigInt(objects.Distributor.json.unallocated as string),
      holderUnallocated: BigInt(objects.Distributor.json.holder_unallocated as string),
      pool: BigInt(objects.Distributor.json.pool as string),
    })
  })
  it('Governance: bootstrapped, the first ballot, the ballots table', async () => {
    const g = await readGovernance(fake().client, ids)
    expect(g).toMatchObject({ bootstrapped: true, firstBallotEpoch: 9 })
    expect(g.ballotsTableId).toMatch(/^0x[0-9a-f]{64}$/)
  })
  it('OperatorLock: what is locked', async () => {
    expect(await readOperatorLock(fake().client, ids)).toEqual({ balance: BigInt(objects.OperatorLock.json.balance as string) })
  })
  it('Distributor and Governance report not bootstrapped while board_id is none', async () => {
    const d = structuredClone(objects.Distributor)
    d.json.board_id = null
    const g = structuredClone(objects.Governance)
    g.json.board_id = null
    const client = fake({ [d.json.id as string]: d.json, [g.json.id as string]: g.json }).client
    expect((await readDistributor(client, ids)).bootstrapped).toBe(false)
    expect((await readGovernance(client, ids)).bootstrapped).toBe(false)
  })
})

describe('Arena', () => {
  it('counts the stationed trees and, among the Arena’s own fields, the equipped Crown Seeds', async () => {
    expect(await readArena(fake().client, ids)).toEqual({ stationed: 10, seeded: 7 })
  })
  it('counts across pages, to the last', async () => {
    const seed = { name: { type: '0xabc::bonsai::EquippedSeedKey' } }
    const other = { name: { type: '0x2::object::ID' } }
    const f = fake({}, [[seed, other], [seed, seed], [other, seed]])
    expect(await readArena(f.client, ids)).toEqual({ stationed: 10, seeded: 4 })
    expect(f.calls.listDynamicFields).toBe(3)
  })
  it('does not count a field whose key merely mentions the seed', async () => {
    const f = fake({}, [[{ name: { type: '0xabc::bonsai::EquippedSeedKeyOld' } }, { name: { type: '0xabc::other::EquippedSeedKey' } }]])
    expect((await readArena(f.client, ids)).seeded).toBe(0)
  })
})

describe('rows of a table or dynamic field', () => {
  it('reads a ballot at the row id derived from the table and the epoch', async () => {
    const table = '0x' + 'a'.repeat(64)
    const id = rowId(table, 'u64', u64(9))
    const f = fake({ [id]: { id, name: '9', value: { total: '1500', counts: [['1', '2', '3']], circulating: '99', executed: false } } })
    expect(await readBallot(f.client, table, 9)).toEqual({ total: 1500n, circulating: 99n, executed: false })
    expect(f.calls.getObjects.at(-1)).toEqual([id])
  })
  it('answers null for a ballot that was never opened', async () => {
    expect(await readBallot(fake().client, '0x' + 'a'.repeat(64), 9)).toBeNull()
  })
  it('refuses a ballot row that has lost a field', async () => {
    const table = '0x' + 'a'.repeat(64)
    const id = rowId(table, 'u64', u64(9))
    const f = fake({ [id]: { id, name: '9', value: { total: '1', counts: [], executed: false } } })
    await expect(readBallot(f.client, table, 9)).rejects.toThrow(/circulating/)
  })

  it('reads the mint count kept for an epoch, from the board, under the v4 key type', async () => {
    const id = rowId(IDS.epochBoard, `${V4}::economy::EpochMintedKey`, u64(5))
    const f = fake({ [id]: { id, name: { epoch: '5' }, value: '123' } })
    expect(await readEpochMinted(f.client, ids, 5)).toBe(123)
    expect(f.calls.getObjects.at(-1)).toEqual([id])
  })
  it('answers null for an epoch that ended before the game kept the count', async () => {
    expect(await readEpochMinted(fake().client, ids, 2)).toBeNull()
  })
  it('refuses a count that is not an unsigned integer', async () => {
    const id = rowId(IDS.epochBoard, `${V4}::economy::EpochMintedKey`, u64(5))
    await expect(readEpochMinted(fake({ [id]: { id, value: 'many' } }).client, ids, 5)).rejects.toThrow(/unsigned integer/)
  })
})

describe('failures', () => {
  it('names the object that could not be read', async () => {
    const client: GrpcReader = { core: { ...fake().client.core, getObjects: async () => ({ objects: [new Error('Object x not found')] }) } } as GrpcReader
    await expect(readBoard(client, ids)).rejects.toThrow(/EpochBoard .* not readable/)
  })
  it('refuses a struct whose field changed shape instead of reading a number out of it', async () => {
    const board = structuredClone(objects.EpochBoard)
    board.json.epoch = 'four'
    await expect(readBoard(fake({ [board.json.id as string]: board.json }).client, ids)).rejects.toThrow(/epoch/)
  })
})

describe('balances', () => {
  it('reads SUI and WAL in their smallest units, from the totals', async () => {
    expect(await readBalances(fake().client, ids, '0xme')).toEqual({ sui: 1_500_000_000n, wal: 9_989_828_272n })
  })
})
