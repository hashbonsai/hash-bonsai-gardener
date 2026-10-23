#!/usr/bin/env -S npx tsx
// Day-one connectivity check: confirm the delegate key
// can write to and read back from MemWal's mainnet relayer, under the
// practice namespace (practice and production share the mainnet relayer and
// account, split only by namespace).
//
// Run this yourself — it needs the real delegate key and account id, which
// this session never reads. Usage:
//   npx tsx scripts/check-memwal.ts \
//     --key-file ~/.config/the-gardener/memwal-delegate-key \
//     --account-id 0x... \
//     --namespace hash-bonsai-gardener-testnet
//
// Writes one short memory, waits for it to land, recalls it back by its own
// text, and confirms the round trip. Prints no key material.
import { readFileSync } from 'node:fs'
import { MemWal } from '@mysten-incubation/memwal'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

async function main() {
  const keyFile = arg('key-file')
  const accountId = arg('account-id')
  const namespace = arg('namespace')

  const key = readFileSync(keyFile, 'utf8').trim()
  const memwal = MemWal.create({ key, accountId, namespace })

  try {
    console.log(`checking MemWal relayer for account ${accountId}, namespace "${namespace}"`)

    const health = await memwal.health()
    console.log('health:', JSON.stringify(health))

    const marker = `gardener-check-${Date.now()}`
    const text = `${marker}: connectivity check from scripts/check-memwal.ts, safe to ignore or delete.`
    console.log('writing a test memory...')
    const written = await memwal.rememberAndWait(text)
    console.log(`wrote memory id=${written.id} blob_id=${written.blob_id}`)

    console.log('recalling it back...')
    const recalled = await memwal.recall({ query: marker, limit: 5, sort: 'recent' })
    const found = recalled.results.some((r) => r.text.includes(marker))
    if (!found) throw new Error('wrote a memory but recall did not find it back')
    console.log(`ok — recall found the memory it just wrote (${recalled.results.length} result(s))`)

    const page = await memwal.listMemories({ namespace, limit: 1 })
    console.log(`listMemories reports at least ${page.memories.length} memor${page.memories.length === 1 ? 'y' : 'ies'} in this namespace (has_more=${page.has_more})`)
  } finally {
    memwal.destroy()
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
