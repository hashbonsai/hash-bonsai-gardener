import { bool, big, child, field, isRecord, list, num, record, str, type Json } from './json'
import type { GraphQl } from './gql'

/**
 * The events and transactions that gRPC cannot search, read from Sui's public
 * GraphQL. Every list is read to its last page: a count that stopped early
 * would be a wrong number that looks right.
 */

export type ChainEvent = { timestampMs: number; digest: string; json: Json }

const EVENTS_QUERY = `query($t: String!, $after: String) {
  events(filter: { type: $t }, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { timestamp transaction { digest } contents { json } }
  }
}`

/** More pages than any real event type will ever have; reaching it means the cursor is not advancing. */
const MAX_PAGES = 5000

export async function fetchEvents(gql: GraphQl, type: string): Promise<ChainEvent[]> {
  const out: ChainEvent[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = record(await gql(EVENTS_QUERY, { t: type, after }), 'events response')
    const events = child(data, 'events')
    for (const node of list(events, 'nodes')) {
      const n = record(node, 'event')
      const timestamp = Date.parse(str(n, 'timestamp'))
      if (Number.isNaN(timestamp)) throw new Error('event: unreadable timestamp')
      out.push({
        timestampMs: timestamp,
        digest: str(child(n, 'transaction'), 'digest'),
        json: child(child(n, 'contents'), 'json'),
      })
    }
    const info = child(events, 'pageInfo')
    if (!bool(info, 'hasNextPage')) return out
    const cursor = field(info, 'endCursor')
    if (typeof cursor !== 'string' || cursor === after) throw new Error('events: the page cursor did not advance')
    after = cursor
  }
  throw new Error(`events: more than ${MAX_PAGES} pages of ${type}`)
}

// ── Typed events ───────────────────────────────────────────────────────────

export type BurnEvent = { digest: string; timestampMs: number; player: string; epoch: number; burned: bigint; gained: bigint; newScore: bigint }
export type SettleEvent = { digest: string; timestampMs: number; epoch: number; extracted: bigint; awarded: bigint }
export type DrainEvent = { digest: string; timestampMs: number }
export type EmissionEvent = { digest: string; epoch: number; amount: bigint }
export type HolderEmissionEvent = { digest: string; epoch: number; amount: bigint; count: number }
export type BallotExecutedEvent = { digest: string; timestampMs: number; ballotEpoch: number; quorumMet: boolean; applied: boolean[] }

export const parseBurn = (e: ChainEvent): BurnEvent => ({
  digest: e.digest,
  timestampMs: e.timestampMs,
  player: str(e.json, 'player'),
  epoch: num(e.json, 'epoch'),
  burned: big(e.json, 'burned'),
  gained: big(e.json, 'gained'),
  newScore: big(e.json, 'new_score'),
})

export const parseSettle = (e: ChainEvent): SettleEvent => ({
  digest: e.digest,
  timestampMs: e.timestampMs,
  epoch: num(e.json, 'epoch'),
  extracted: big(e.json, 'extracted'),
  awarded: big(e.json, 'awarded'),
})

/** A drain is dated by the game's own clock in the event, not by the indexer's timestamp. */
export const parseDrain = (e: ChainEvent): DrainEvent => ({ digest: e.digest, timestampMs: num(e.json, 'timestamp_ms') })

export const parseEmission = (e: ChainEvent): EmissionEvent => ({ digest: e.digest, epoch: num(e.json, 'epoch'), amount: big(e.json, 'amount') })

export const parseHolderEmission = (e: ChainEvent): HolderEmissionEvent => ({
  digest: e.digest,
  epoch: num(e.json, 'epoch'),
  amount: big(e.json, 'amount'),
  count: num(e.json, 'count'),
})

export const parseBallotExecuted = (e: ChainEvent): BallotExecutedEvent => ({
  digest: e.digest,
  timestampMs: e.timestampMs,
  ballotEpoch: num(e.json, 'ballot_epoch'),
  quorumMet: bool(e.json, 'quorum_met'),
  applied: list(e.json, 'applied').map((a, i) => {
    if (typeof a !== 'boolean') throw new Error(`applied[${i}]: not a boolean`)
    return a
  }),
})

/** Where the event types live: the package that first declared each, which never changes. */
export type EventTypePackages = {
  /** First declared `economy` and `bonsai` (the original game package). */
  game: string
  /** First declared the governance package's types. */
  gov: string
}

export function eventTypes(p: EventTypePackages) {
  return {
    burn: `${p.game}::economy::BurnForScoreEvent`,
    settle: `${p.game}::economy::SettleEpochEvent`,
    drain: `${p.game}::bonsai::DrainEvent`,
    emission: `${p.gov}::distributor::EmissionEvent`,
    holderEmission: `${p.gov}::distributor::HolderEmissionEvent`,
    ballotExecuted: `${p.gov}::governance::BallotExecutedEvent`,
  } as const
}

// ── One transaction's object changes ───────────────────────────────────────

const TX_QUERY = `query($d: String!) {
  transaction(digest: $d) {
    digest
    sender { address }
    effects {
      timestamp
      objectChanges {
        pageInfo { hasNextPage }
        nodes {
          idCreated idDeleted address
          inputState { asMoveObject { contents { type { repr } json } } }
          outputState { asMoveObject { contents { type { repr } json } } }
        }
      }
    }
  }
}`

export type ObjectChange = {
  address: string
  created: boolean
  deleted: boolean
  /** The object's type, from whichever side of the transaction has it. */
  type: string | null
  before: Json | null
  after: Json | null
}

export type TransactionChanges = { digest: string; sender: string | null; changes: ObjectChange[] }

function side(state: unknown): { type: string; json: Json } | null {
  if (state === null || state === undefined) return null
  const contents = child(child(record(state, 'object state'), 'asMoveObject'), 'contents')
  const json = field(contents, 'json')
  return { type: str(child(contents, 'type'), 'repr'), json: isRecord(json) ? json : {} }
}

/**
 * What a transaction did to the objects it touched, with each object's JSON
 * as it stood before and after. This is how the state at a past settlement is
 * read: the chain keeps no history that gRPC can ask for, but a transaction's
 * own effects hold both sides.
 */
export async function fetchTransactionChanges(gql: GraphQl, digest: string): Promise<TransactionChanges> {
  const data = record(await gql(TX_QUERY, { d: digest }), 'transaction response')
  const tx = data.transaction
  if (!isRecord(tx)) throw new Error(`transaction ${digest}: not found`)
  const objectChanges = child(child(tx, 'effects'), 'objectChanges')
  // A settlement touches a handful of objects. If the list ever spans pages, a change
  // could be missing from this one, and a missing change reads as "nothing happened".
  if (bool(child(objectChanges, 'pageInfo'), 'hasNextPage')) throw new Error(`transaction ${digest}: more object changes than one page`)
  const nodes = list(objectChanges, 'nodes')
  const sender = isRecord(tx.sender) ? str(tx.sender, 'address') : null
  return {
    digest: str(tx, 'digest'),
    sender,
    changes: nodes.map((node) => {
      const n = record(node, 'object change')
      const before = side(n.inputState)
      const after = side(n.outputState)
      return {
        address: str(n, 'address'),
        created: bool(n, 'idCreated'),
        deleted: bool(n, 'idDeleted'),
        type: after?.type ?? before?.type ?? null,
        before: before?.json ?? null,
        after: after?.json ?? null,
      }
    }),
  }
}
