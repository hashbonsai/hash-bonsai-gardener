#!/usr/bin/env -S npx tsx
// Writes one finished epoch twice, with and without what the gardener remembers, and
// prints the two side by side: the demonstration of what Walrus Memory changes.
// Stores, remembers and posts nothing. Makes two to four calls to the language model
// (a few cents).
//
// Run this yourself — it needs the Tatum, Anthropic and MemWal keys. Usage:
//   npx tsx scripts/compare-memory.ts --config ~/.config/the-gardener/config.json --epoch 6
//
// It is only worth showing once the memory holds an observation from an earlier epoch;
// the output says how many it recalled and how many were graded against this epoch.
import { MemWal } from '@mysten-incubation/memwal'
import { anthropicClient, anthropicProvider } from '../src/anthropic'
import { compareWithAndWithoutMemory, type Side } from '../src/compare'
import { loadConfig, readSecret } from '../src/config'
import { httpGraphQl } from '../src/gql'
import { memwalStore } from '../src/memory'
import { redact } from '../src/redact'
import { liveSources } from '../src/sources'
import { createTatumClient } from '../src/tatum'
import { TATUM_THROTTLE } from '../src/throttle'
import { readFileSync } from 'node:fs'

function option(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

function show(title: string, side: Side) {
  console.log(`\n=== ${title} ===`)
  console.log(side.fallback ? '(figures only: the text did not pass its checks or could not be written)' : `(${side.attempts} attempt(s))`)
  console.log(`\n[English]\n${side.text.en}`)
  console.log(`\n[日本語]\n${side.text.ja}`)
  console.log(`\n[Notebook]\n${side.notebook.en.length === 0 ? '(none)' : side.notebook.en.join('\n')}`)
  console.log(`\n[Observations for next epoch]\n${side.observations.length === 0 ? '(none)' : side.observations.map((o) => `- ${o.metric} ${o.direction}: ${o.statement}`).join('\n')}`)
}

async function main(): Promise<number> {
  const config = loadConfig(option('config') ?? process.env.GARDENER_CONFIG ?? 'config.json')
  const epoch = Number(option('epoch'))
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('--epoch must be a positive integer')

  const secrets = [readSecret(config.tatumKeyFile), readSecret(config.anthropicKeyFile), readSecret(config.memwal.keyFile)]
  const [tatumKey, anthropicKey, memwalKey] = secrets
  const tatum = createTatumClient(config.network, tatumKey, {
    ...TATUM_THROTTLE,
    onRetry: ({ attempt, waitMs }) => console.error(`Tatum answered 429; waiting ${waitMs} ms (retry ${attempt})`),
  })
  const memwal = MemWal.create({ key: memwalKey, accountId: config.memwal.accountId, serverUrl: config.memwal.serverUrl, namespace: config.memwal.namespace })
  try {
    const result = await compareWithAndWithoutMemory(
      {
        src: liveSources(tatum.client, httpGraphQl(config.graphqlUrl), config.chain, config.address),
        memory: memwalStore(memwal, config.memwal.namespace),
        llm: anthropicProvider(anthropicClient(anthropicKey), config.model ? { model: config.model } : {}),
        systemPrompt: readFileSync(config.promptFile, 'utf8'),
        reportUrl: 'https://aggregator.example/v1/blobs/' + '0'.repeat(43),
      },
      epoch,
    )
    console.log(`epoch ${epoch}, memory namespace "${config.memwal.namespace}"`)
    console.log(`recalled: ${result.recalled.observations} earlier observation(s), ${result.recalled.graded} graded against this epoch, ${result.recalled.notes} note(s)`)
    if (result.recalled.observations === 0 && result.recalled.notes === 0) console.log('(nothing recalled: the two will differ only by chance)')
    show('WITH what it remembers', result.withMemory)
    show('WITHOUT any memory', result.withoutMemory)
    return 0
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
