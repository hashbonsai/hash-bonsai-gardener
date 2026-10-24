import { readFileSync } from 'node:fs'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { WalrusClient } from '@mysten/walrus'
import { MemWal } from '@mysten-incubation/memwal'
import { anthropicClient, anthropicProvider } from './anthropic'
import { GuardedSigner } from './chain'
import { loadConfig, readSecret } from './config'
import { httpGraphQl } from './gql'
import { memwalStore, nullStore } from './memory'
import { consoleNotifier, discordNotifier } from './notify'
import { redact } from './redact'
import { runRound } from './round'
import { liveSources } from './sources'
import { fileStateStore, initialState } from './state'
import { createTatumClient } from './tatum'
import { TATUM_THROTTLE } from './throttle'
import { walrusReportStore } from './walrus'

/**
 * The hourly entry point. `npm run once -- --config <file> [--dry-run] [--no-memory]`.
 *
 *   --dry-run     compose and show the report; store, remember, post and save nothing
 *   --no-memory   read and write no Walrus Memory (to show the difference it makes)
 *
 * Every line printed passes through `redact`, with the secrets themselves as
 * exact matches, so a key that slips into an error message does not reach a log.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flag = (name: string) => argv.includes(`--${name}`)
  const configIndex = argv.indexOf('--config')
  const config = loadConfig(configIndex === -1 ? (process.env.GARDENER_CONFIG ?? 'config.json') : argv[configIndex + 1])

  const secrets = {
    sui: readSecret(config.keyFile),
    tatum: readSecret(config.tatumKeyFile),
    anthropic: readSecret(config.anthropicKeyFile),
    memwal: readSecret(config.memwal.keyFile),
    webhook: config.webhookFile ? readSecret(config.webhookFile) : null,
  }
  const hidden = Object.values(secrets).filter((s): s is string => s !== null)
  const log = (line: string) => console.log(redact(line, hidden))

  // The key must belong to the address the configuration names, or nothing is signed.
  const keypair = Ed25519Keypair.fromSecretKey(secrets.sui)
  if (normalizeSuiAddress(keypair.toSuiAddress()) !== normalizeSuiAddress(config.address)) {
    throw new Error('the key file does not belong to the configured address')
  }
  const signer = new GuardedSigner(keypair, { address: config.address, walrusPackageIds: config.walrusPackageIds })

  const tatum = createTatumClient(config.network, secrets.tatum, {
    ...TATUM_THROTTLE,
    onRetry: ({ attempt, waitMs }) => log(`Tatum answered 429; waiting ${waitMs} ms (retry ${attempt})`),
  })
  log(`reading and sending through Tatum: ${tatum.host}`)

  const useMemory = !flag('no-memory')
  const memwal = useMemory ? MemWal.create({ key: secrets.memwal, accountId: config.memwal.accountId, serverUrl: config.memwal.serverUrl, namespace: config.memwal.namespace }) : null

  try {
    const outcome = await runRound({
      config: { requireApproval: config.requireApproval, useMemory, dryRun: flag('dry-run') },
      nowMs: Date.now,
      state: fileStateStore(config.stateFile, () => initialState(config.firstEpoch - 1)),
      src: liveSources(tatum.client, httpGraphQl(config.graphqlUrl), config.chain, config.address),
      memory: memwal ? memwalStore(memwal, config.memwal.namespace) : nullStore,
      llm: anthropicProvider(anthropicClient(secrets.anthropic), config.model ? { model: config.model } : {}),
      store: walrusReportStore({
        walrus: new WalrusClient({ network: config.network, suiClient: tatum.client }),
        signer,
        aggregatorUrl: config.aggregatorUrl,
      }),
      notifier: secrets.webhook ? discordNotifier(secrets.webhook, { log }) : consoleNotifier(log),
      systemPrompt: readFileSync(config.promptFile, 'utf8'),
      ...(config.llmLimits ? { limits: config.llmLimits } : {}),
      log,
    })
    log(`round: ${outcome.kind}${'epoch' in outcome && outcome.epoch !== null ? ` (epoch ${outcome.epoch})` : ''}${outcome.kind === 'blocked' ? `: ${outcome.reason}` : ''}${outcome.kind === 'failed' ? `: ${outcome.error}` : ''}`)
    // A stop the operator was told about is not a failure of the program; a round that failed is.
    return outcome.kind === 'failed' ? 1 : 0
  } finally {
    tatum.close()
    memwal?.destroy()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    console.error('FAILED:', redact(e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  })
