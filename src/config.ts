import { readFileSync } from 'node:fs'
import type { LlmLimits } from './budget'
import { MAINNET, MAINNET_GRAPHQL, type ChainConfig } from './sources'

/**
 * The deployment's configuration: a JSON file of settings and of the places
 * the secrets live. A value that is a secret is never written here — only the
 * path of the file that holds it — and nothing in this module reads those files.
 */

export type GardenerConfig = {
  network: 'mainnet' | 'testnet'
  /** The gardener's own Sui address; the key file must belong to it. */
  address: string
  keyFile: string
  tatumKeyFile: string
  anthropicKeyFile: string
  memwal: { keyFile: string; accountId: string; serverUrl: string; namespace: string }
  /** Discord webhook. Without one, notices are printed to the log. */
  webhookFile: string | null
  stateFile: string
  promptFile: string
  /** Where the Walrus packages' functions may be called from; the current published-at ids. */
  walrusPackageIds: string[]
  /** A public Walrus aggregator, to read earlier reports back and to link to. */
  aggregatorUrl: string
  /** The first epoch to write about when there is no state yet. */
  firstEpoch: number
  /** Hold every report for `npm run approve`; a person turns this off by editing the file. */
  requireApproval: boolean
  model: string | null
  /** Raised model-call limits for a testnet rehearsal, whose epochs last minutes. Never set on mainnet. */
  llmLimits: LlmLimits | null
  chain: ChainConfig
  graphqlUrl: string
}

const MEMWAL_RELAYER = 'https://relayer.memory.walrus.xyz'

type Raw = Record<string, unknown>

function field(raw: Raw, name: string, where = 'config'): unknown {
  if (!(name in raw)) throw new Error(`${where}: "${name}" is missing`)
  return raw[name]
}

function text(raw: Raw, name: string, where?: string): string {
  const v = field(raw, name, where)
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where ?? 'config'}: "${name}" must be a non-empty string`)
  return v
}

function optionalText(raw: Raw, name: string): string | null {
  const v = raw[name]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`config: "${name}" must be a non-empty string or left out`)
  return v
}

const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseConfig(value: unknown): GardenerConfig {
  if (!isRecord(value)) throw new Error('config: not a JSON object')
  const network = text(value, 'network')
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('config: "network" must be "mainnet" or "testnet"')

  const memwal = field(value, 'memwal')
  if (!isRecord(memwal)) throw new Error('config: "memwal" must be an object')

  const ids = field(value, 'walrusPackageIds')
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === 'string' && /^0x[0-9a-fA-F]+$/.test(i))) {
    throw new Error('config: "walrusPackageIds" must be a non-empty list of 0x package ids')
  }
  const firstEpoch = field(value, 'firstEpoch')
  if (!Number.isInteger(firstEpoch) || (firstEpoch as number) < 1) throw new Error('config: "firstEpoch" must be a positive integer')
  const requireApproval = value.requireApproval ?? true
  if (typeof requireApproval !== 'boolean') throw new Error('config: "requireApproval" must be true or false')

  const chain = value.chain === undefined ? MAINNET : (value.chain as ChainConfig)
  if (network === 'testnet' && value.chain === undefined) throw new Error('config: a testnet deployment must give its own "chain" (the game objects and event packages)')

  let llmLimits: LlmLimits | null = null
  if (value.llmLimits !== undefined) {
    // The limits are a brake against a runaway on real money. Only a rehearsal may raise them.
    if (network === 'mainnet') throw new Error('config: "llmLimits" may only be set on a testnet deployment; the mainnet limits are fixed')
    const l = value.llmLimits
    if (!isRecord(l) || !Number.isInteger(l.perDay) || !Number.isInteger(l.perMonth) || (l.perDay as number) < 1 || (l.perMonth as number) < 1) {
      throw new Error('config: "llmLimits" must be { "perDay": n, "perMonth": n } with positive integers')
    }
    llmLimits = { perDay: l.perDay as number, perMonth: l.perMonth as number }
  }

  return {
    network,
    address: text(value, 'address'),
    keyFile: text(value, 'keyFile'),
    tatumKeyFile: text(value, 'tatumKeyFile'),
    anthropicKeyFile: text(value, 'anthropicKeyFile'),
    memwal: {
      keyFile: text(memwal, 'keyFile', 'config.memwal'),
      accountId: text(memwal, 'accountId', 'config.memwal'),
      serverUrl: optionalText(memwal, 'serverUrl') ?? MEMWAL_RELAYER,
      namespace: text(memwal, 'namespace', 'config.memwal'),
    },
    webhookFile: optionalText(value, 'webhookFile'),
    stateFile: text(value, 'stateFile'),
    promptFile: optionalText(value, 'promptFile') ?? 'prompts' + String.fromCharCode(47) + 'system.md',
    walrusPackageIds: ids as string[],
    aggregatorUrl: text(value, 'aggregatorUrl'),
    firstEpoch: firstEpoch as number,
    requireApproval,
    model: optionalText(value, 'model'),
    llmLimits,
    chain,
    graphqlUrl: optionalText(value, 'graphqlUrl') ?? MAINNET_GRAPHQL,
  }
}

export function loadConfig(path: string): GardenerConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`the configuration file ${path} could not be read as JSON: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown error'}`)
  }
  return parseConfig(parsed)
}

/** Reads a secret from its file. Never log what this returns. */
export function readSecret(path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (value === '') throw new Error(`${path} is empty`)
  return value
}
