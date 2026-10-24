import { bcs, TypeTagSerializer } from '@mysten/sui/bcs'
import { deriveDynamicFieldID } from '@mysten/sui/utils'
import { big, bool, child, field, isRecord, list, num, optional, str, type Json } from './json'

/**
 * Reads the game's objects over gRPC (Tatum), as JSON, and picks out the
 * fields the facts need. The field names are the Move structs' own field
 * names, which the JSON keeps; every value is checked on the way out, so a
 * struct that changed shape stops the section it feeds instead of turning into
 * a number. Nothing here decodes BCS.
 */

/** The three calls this module makes, so a test can stand in for the client. */
export interface GrpcReader {
  core: {
    getObjects(options: { objectIds: string[]; include: { json: true } }): Promise<{
      objects: (Error | { type: string; json: Json | null })[]
    }>
    listDynamicFields(options: { parentId: string; limit?: number; cursor?: string | null }): Promise<{
      hasNextPage: boolean
      cursor: string | null
      dynamicFields: { name: { type: string } }[]
    }>
    getBalance(options: { owner: string; coinType?: string }): Promise<{ balance: { balance: string } }>
  }
}

/** Where the game lives. All of it is public chain data, and it goes in the deploy configuration. */
export type GameIds = {
  epochBoard: string
  gameBank: string
  arena: string
  distributor: string
  governance: string
  operatorLock: string
  /** The package that first declared the types added in v4 (`EpochMintedKey`); upgrades do not change it. */
  epochKeyPackageId: string
  /** The package that first declared `EpochRulesKey` (v2, not the one above); upgrades do not change it. */
  epochRulesKeyPackageId: string
  /** The coin type of WAL on this network. */
  walType: string
}

async function json(client: GrpcReader, id: string, what: string): Promise<Json> {
  const { objects } = await client.core.getObjects({ objectIds: [id], include: { json: true } })
  const o = objects[0]
  if (!o || o instanceof Error) throw new Error(`${what} (${id}): not readable${o instanceof Error ? ` — ${o.message}` : ''}`)
  if (!isRecord(o.json)) throw new Error(`${what} (${id}): no JSON content`)
  return o.json
}

/** A row of a dynamic field or table, or null when the row does not exist. */
async function row(client: GrpcReader, parentId: string, keyType: string, keyBcs: Uint8Array, what: string): Promise<Json | null> {
  const id = deriveDynamicFieldID(parentId, TypeTagSerializer.parseFromStr(keyType, true), keyBcs)
  const { objects } = await client.core.getObjects({ objectIds: [id], include: { json: true } })
  const o = objects[0]
  if (!o || o instanceof Error) return null
  if (!isRecord(o.json)) throw new Error(`${what}: the row has no JSON content`)
  return o.json
}

const u64Key = (n: number) => bcs.u64().serialize(BigInt(n)).toBytes()

export async function readBoard(client: GrpcReader, ids: GameIds): Promise<{ epoch: number; endsAtMs: number }> {
  const j = await json(client, ids.epochBoard, 'EpochBoard')
  return { epoch: num(j, 'epoch'), endsAtMs: num(j, 'ends_at_ms') }
}

export async function readGameBank(client: GrpcReader, ids: GameIds): Promise<{ treasury: bigint; totalMinted: number }> {
  const j = await json(client, ids.gameBank, 'GameBank')
  return { treasury: big(j, 'treasury'), totalMinted: num(j, 'total_minted') }
}

/** Trees stationed, and how many of them hold a Crown Seed (one `EquippedSeedKey` field each). */
export async function readArena(client: GrpcReader, ids: GameIds): Promise<{ stationed: number; seeded: number }> {
  const j = await json(client, ids.arena, 'Arena')
  let seeded = 0
  let cursor: string | null = null
  for (let page = 0; page < 1000; page++) {
    const r = await client.core.listDynamicFields({ parentId: ids.arena, limit: 50, cursor })
    seeded += r.dynamicFields.filter((f) => f.name.type.endsWith('::bonsai::EquippedSeedKey')).length
    if (!r.hasNextPage) return { stationed: num(j, 'stationed'), seeded }
    if (r.cursor === null || r.cursor === cursor) throw new Error('Arena fields: the page cursor did not advance')
    cursor = r.cursor
  }
  throw new Error('Arena fields: too many pages')
}

export type DistributorState = {
  bootstrapped: boolean
  /** The first epoch that distributes. */
  startEpoch: number
  /** The first epoch not yet confirmed. */
  nextEpoch: number
  unallocated: bigint
  holderUnallocated: bigint
  /** Everything not yet claimed, both shares together. */
  pool: bigint
}

export async function readDistributor(client: GrpcReader, ids: GameIds): Promise<DistributorState> {
  const j = await json(client, ids.distributor, 'Distributor')
  return {
    bootstrapped: optional(j, 'board_id') !== null,
    startEpoch: num(j, 'start_epoch'),
    nextEpoch: num(j, 'next_epoch'),
    unallocated: big(j, 'unallocated'),
    holderUnallocated: big(j, 'holder_unallocated'),
    pool: big(j, 'pool'),
  }
}

export type GovernanceState = {
  bootstrapped: boolean
  firstBallotEpoch: number
  /** Table of ballots, keyed by the epoch each ran in. */
  ballotsTableId: string
}

export async function readGovernance(client: GrpcReader, ids: GameIds): Promise<GovernanceState> {
  const j = await json(client, ids.governance, 'Governance')
  return {
    bootstrapped: optional(j, 'board_id') !== null,
    firstBallotEpoch: num(j, 'first_ballot_epoch'),
    ballotsTableId: str(child(j, 'ballots'), 'id'),
  }
}

export type BallotState = { total: bigint; circulating: bigint; executed: boolean }

/** The ballot that ran in `epoch`, or null if none was ever opened. */
export async function readBallot(client: GrpcReader, ballotsTableId: string, epoch: number): Promise<BallotState | null> {
  const r = await row(client, ballotsTableId, 'u64', u64Key(epoch), `ballot ${epoch}`)
  if (!r) return null
  const v = child(r, 'value')
  list(v, 'counts')
  return { total: big(v, 'total'), circulating: big(v, 'circulating'), executed: bool(v, 'executed') }
}

export async function readOperatorLock(client: GrpcReader, ids: GameIds): Promise<{ balance: bigint }> {
  const j = await json(client, ids.operatorLock, 'OperatorLock')
  return { balance: big(j, 'balance') }
}

/**
 * `GameBank.total_minted` as it stood when `epoch` ended, kept by the game in
 * a field on the board. Null for an epoch that ended before v4 began keeping it.
 */
export async function readEpochMinted(client: GrpcReader, ids: GameIds, epoch: number): Promise<number | null> {
  const r = await row(client, ids.epochBoard, `${ids.epochKeyPackageId}::economy::EpochMintedKey`, u64Key(epoch), `minted at the end of epoch ${epoch}`)
  if (!r) return null
  const v = field(r, 'value')
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`minted at the end of epoch ${epoch}: not an unsigned integer`)
  return Number(v)
}

/**
 * The rules field on the board as it stands now: the `Field` object, whose `value` is the rules.
 * The game writes it only when an epoch is rolled (and once, for an epoch rolled before v2, when
 * someone seals it). Null if the board has none. `EpochRulesKey` is an empty struct, which BCS
 * writes as the single byte of its placeholder field.
 */
export async function readCurrentRules(client: GrpcReader, ids: GameIds): Promise<Json | null> {
  return row(client, ids.epochBoard, `${ids.epochRulesKeyPackageId}::economy::EpochRulesKey`, new Uint8Array([0]), 'the board’s rules field')
}

export async function readBalances(client: GrpcReader, ids: GameIds, owner: string): Promise<{ sui: bigint; wal: bigint }> {
  const [sui, wal] = await Promise.all([
    client.core.getBalance({ owner }),
    client.core.getBalance({ owner, coinType: ids.walType }),
  ])
  return { sui: BigInt(sui.balance.balance), wal: BigInt(wal.balance.balance) }
}
