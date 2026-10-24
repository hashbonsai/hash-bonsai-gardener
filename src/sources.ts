import type { Sources } from './collect'
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
  type EventTypePackages,
} from './events'
import type { GraphQl } from './gql'
import {
  readArena,
  readBalances,
  readBallot,
  readBoard,
  readCurrentRules,
  readDistributor,
  readEpochMinted,
  readGameBank,
  readGovernance,
  readOperatorLock,
  type GameIds,
  type GrpcReader,
} from './read'

export type ChainConfig = {
  ids: GameIds
  eventPackages: EventTypePackages
}

/**
 * Where the game lives on mainnet. All public chain data. The ids are the
 * shared objects; `epochKeyPackageId` is the package that first declared the
 * v4 key types (read off the board's own fields), and `eventPackages` are the
 * packages that first declared the event types, which no upgrade changes.
 */
export const MAINNET: ChainConfig = {
  ids: {
    epochBoard: '0x7f02d59b8b4b9d0a34a16ea2668c9aebb132fae0b1cf6a1ef06a575a87b7a389',
    gameBank: '0x84a01088ca67ec3dfb152615dbfe3447149097fb406f053265eabdc2c6112f12',
    arena: '0x928e28c83ea2fb44b694ab2209b0fe4d239031c52ddfd910d57e8b37fc83d4fe',
    distributor: '0x0f1cc71f7e03381d196f16d621a373701403f50e8a44d31f2593fbacfb0a9c00',
    governance: '0x6f8cee2fa6a89bd6ed87ebdacbedab93ca71e571e863169e0e20fee32f887804',
    operatorLock: '0x1de431e1cf9c3f537fa42b8e401652496bb9d0557b2a308f3ecd02573a1bd163',
    epochKeyPackageId: '0x75e8ed78c6dfcacd862b0dd616d6bc5b6dde171279280cb7e9d2f0dbbeb8e4e1',
    epochRulesKeyPackageId: '0x52834277f505d2bf0bfd609f91a0df5bc619a1897c02a72f1899a33105e5b90a',
    walType: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
  },
  eventPackages: {
    game: '0x0c8921698a36dac5e48048d782608e62e00f3ed0f2e21f2e0c17b898457d4825',
    gov: '0x2b56cac54d40b764383602c155833cc13d645f61a4cb29f06d1d97419fc4c19e',
  },
}

export const MAINNET_GRAPHQL = 'https://graphql.mainnet.sui.io' + String.fromCharCode(47) + 'graphql'

/** The collector's sources, wired to the real readers. */
export function liveSources(grpc: GrpcReader, gql: GraphQl, config: ChainConfig, gardenerAddress: string): Sources {
  const types = eventTypes(config.eventPackages)
  const events = async <T>(type: string, parse: (e: ChainEvent) => T): Promise<T[]> => (await fetchEvents(gql, type)).map(parse)
  const { ids } = config
  return {
    board: () => readBoard(grpc, ids),
    gameBank: () => readGameBank(grpc, ids),
    epochMinted: (epoch) => readEpochMinted(grpc, ids, epoch),
    currentRules: () => readCurrentRules(grpc, ids),
    arena: () => readArena(grpc, ids),
    distributor: () => readDistributor(grpc, ids),
    governance: () => readGovernance(grpc, ids),
    ballot: (table, epoch) => readBallot(grpc, table, epoch),
    operatorLock: () => readOperatorLock(grpc, ids),
    balances: () => readBalances(grpc, ids, gardenerAddress),
    burns: () => events(types.burn, parseBurn),
    settles: () => events(types.settle, parseSettle),
    drains: () => events(types.drain, parseDrain),
    emissions: () => events(types.emission, parseEmission),
    holderEmissions: () => events(types.holderEmission, parseHolderEmission),
    ballotsExecuted: () => events(types.ballotExecuted, parseBallotExecuted),
    transaction: (digest) => fetchTransactionChanges(gql, digest),
  }
}
