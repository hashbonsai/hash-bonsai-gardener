#!/usr/bin/env -S npx tsx
// Gives the gardener a memory of the epochs before it began: one record for
// each final epoch before `firstEpoch`, written once. Reads the chain through
// Tatum and writes to Walrus Memory; it signs nothing and calls no language model.
//
// Run this yourself — it needs the Tatum key and the MemWal delegate key.
// Try it on the practice namespace first, then on the real one:
//
//   npx tsx scripts/backfill.ts --config ~/.config/the-gardener/config.json \
//     --namespace hash-bonsai-gardener-testnet --dry-run     # shows what it would write
//   npx tsx scripts/backfill.ts --config ... --namespace hash-bonsai-gardener-testnet
//   npx tsx scripts/backfill.ts --config ...                  # the namespace in the config
//
// Run it before the next epoch ends: the Arena is only readable as it stands now,
// so only the latest final epoch keeps it. Prints the namespace, each epoch's
// outcome and the memory count — never a key.
import { MemWal } from '@mysten-incubation/memwal'
import { runBackfill } from '../src/backfill'
import { loadConfig, readSecret } from '../src/config'
import { httpGraphQl } from '../src/gql'
import { memwalStore } from '../src/memory'
import { redact } from '../src/redact'
import { liveSources } from '../src/sources'
import { createTatumClient } from '../src/tatum'
import { TATUM_THROTTLE } from '../src/throttle'

function option(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main(): Promise<number> {
  const config = loadConfig(option('config') ?? process.env.GARDENER_CONFIG ?? 'config.json')
  const namespace = option('namespace') ?? config.memwal.namespace
  const dryRun = process.argv.includes('--dry-run')

  const tatumKey = readSecret(config.tatumKeyFile)
  const memwalKey = readSecret(config.memwal.keyFile)
  const log = (line: string) => console.log(redact(line, [tatumKey, memwalKey]))

  const tatum = createTatumClient(config.network, tatumKey, {
    ...TATUM_THROTTLE,
    onRetry: ({ attempt, waitMs }) => log(`Tatum answered 429; waiting ${waitMs} ms (retry ${attempt})`),
  })
  const memwal = MemWal.create({ key: memwalKey, accountId: config.memwal.accountId, serverUrl: config.memwal.serverUrl, namespace })
  try {
    log(`backfill${dryRun ? ' (dry run)' : ''}: epochs before ${config.firstEpoch}, memory namespace "${namespace}"`)
    const result = await runBackfill({
      src: liveSources(tatum.client, httpGraphQl(config.graphqlUrl), config.chain, config.address),
      memory: memwalStore(memwal, namespace),
      firstEpoch: config.firstEpoch,
      dryRun,
      log,
    })
    log(
      `${dryRun ? 'would write' : 'written'}: [${result.written.join(', ')}]; already there: [${result.already.join(', ')}]; ` +
        `not over yet: [${result.notFinal.join(', ')}]; failed: ${result.failed.length}; memories in the namespace: ${result.memories ?? 'unknown'}`,
    )
    return result.failed.length > 0 ? 1 : 0
  } finally {
    tatum.close()
    memwal.destroy()
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
