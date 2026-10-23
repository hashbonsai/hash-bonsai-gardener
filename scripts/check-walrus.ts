#!/usr/bin/env -S npx tsx
// Day-one connectivity check: confirm the gardener's
// own Sui key can store a blob on Walrus with `deletable: false` (an
// undeletable blob, the same shape every real report will use).
//
// *** This spends real WAL and SUI and cannot be undone. *** The blob this
// writes stays on Walrus for the epochs you pay for and can never be
// deleted, by anyone, for any reason — that is the point, not a bug.
// Run this yourself, once, with a small `--epochs`, after the gardener
// address already holds some WAL and SUI. Requires `--confirm-permanent`,
// so it cannot be run by accident.
//
// Usage:
//   npx tsx scripts/check-walrus.ts --network mainnet \
//     --key-file ~/.config/the-gardener/sui-key \
//     --tatum-key-file ~/.config/the-gardener/tatum-api-key \
//     --epochs 3 --confirm-permanent
//
// Prints the blob id and the transaction digest — both public once sent —
// never either key.
import { readFileSync } from 'node:fs'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { WalrusClient } from '@mysten/walrus'
import { createTatumClient } from '../src/tatum'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

async function main() {
  if (!process.argv.includes('--confirm-permanent')) {
    throw new Error('this writes an undeletable blob and spends real WAL/SUI — pass --confirm-permanent to proceed')
  }
  const network = arg('network')
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('--network must be mainnet or testnet')
  const epochs = Number(arg('epochs'))
  if (!Number.isInteger(epochs) || epochs < 1) throw new Error('--epochs must be a positive integer')

  const secret = readFileSync(arg('key-file'), 'utf8').trim()
  const tatumKey = readFileSync(arg('tatum-key-file'), 'utf8').trim()
  const keypair = Ed25519Keypair.fromSecretKey(secret)
  const address = normalizeSuiAddress(keypair.toSuiAddress())

  const tatum = createTatumClient(network, tatumKey)
  const walrus = new WalrusClient({ network, suiClient: tatum.client })

  const text = `gardener Walrus check, ${new Date().toISOString()}, safe to ignore — this blob cannot be deleted.`
  console.log(`writing a permanent blob from ${address} on ${network}, ${epochs} epoch(s), reads via ${tatum.host}...`)
  try {
    const { blobId, blobObject } = await walrus.writeBlob({
      blob: new TextEncoder().encode(text),
      deletable: false,
      epochs,
      signer: keypair,
    })

    console.log(`ok — blob ${blobId}`)
    console.log(`blob object id: ${blobObject.id}`)
    console.log(`deletable: ${blobObject.deletable} (must be false), stored through epoch ${blobObject.storage.end_epoch}`)
  } finally {
    tatum.close()
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
