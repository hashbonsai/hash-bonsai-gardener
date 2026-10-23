#!/usr/bin/env -S npx tsx
// Day-one connectivity check: confirm the Tatum gRPC
// endpoint accepts `x-api-key` sent as gRPC metadata over native gRPC (HTTP/2),
// the same client the gardener itself uses (src/tatum.ts).
//
// Run this yourself — it needs the real Tatum API key, which this session
// never reads. Usage:
//   npx tsx scripts/check-tatum.ts --network mainnet --key-file ~/.config/the-gardener/tatum-api-key --address 0x...
//
// Prints only the gRPC host and the balance read back — never the key.
import { readFileSync } from 'node:fs'
import { createTatumClient } from '../src/tatum'
import { TATUM_THROTTLE } from '../src/throttle'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

async function main() {
  const network = arg('network')
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('--network must be mainnet or testnet')
  const keyFile = arg('key-file')
  const address = arg('address')

  const apiKey = readFileSync(keyFile, 'utf8').trim()
  const tatum = createTatumClient(network, apiKey, {
    ...TATUM_THROTTLE,
    onRetry: ({ attempt, waitMs }) => console.log(`  Tatum answered 429; waiting ${waitMs} ms (retry ${attempt})`),
  })

  console.log(`checking Tatum gRPC: ${tatum.host}`)
  try {
    const { balance } = await tatum.client.core.getBalance({ owner: address })
    console.log(`ok — ${address} holds ${balance.balance} MIST SUI via Tatum`)
  } finally {
    tatum.close()
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
