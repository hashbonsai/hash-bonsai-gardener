#!/usr/bin/env -S npx tsx
// Day-one connectivity check: confirm the Tatum gRPC
// endpoint accepts `x-api-key` the way `@mysten/sui`'s SuiGrpcClient can send
// it, before anything else in this repo is built on top of it.
//
// Run this yourself — it needs the real Tatum API key, which this session
// never reads. Usage:
//   npx tsx scripts/check-tatum.ts --network mainnet --key-file ~/.config/the-gardener/tatum-api-key --address 0x...
//
// Prints only the gRPC host and the balance read back — never the key.
import { readFileSync } from 'node:fs'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const TATUM_URL: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'https://sui-mainnet-grpc.gateway.tatum.io',
  testnet: 'https://sui-testnet-grpc.gateway.tatum.io',
}

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
  const baseUrl = TATUM_URL[network]

  // `SuiGrpcClientOptions` accepts the same fields as `GrpcWebOptions`
  // (`@protobuf-ts/grpcweb-transport`) alongside `network`, including `meta`
  // — default RPC metadata sent with every call, which the transport turns
  // into HTTP headers. Confirmed against the installed SDK's own .d.mts
  // (node_modules/@mysten/sui/dist/grpc/client.d.mts), not assumed.
  const client = new SuiGrpcClient({
    network,
    baseUrl,
    meta: { 'x-api-key': apiKey },
  })

  console.log(`checking Tatum gRPC: ${baseUrl}`)
  const { balance } = await client.core.getBalance({ owner: address })
  console.log(`ok — ${address} holds ${balance.balance} MIST SUI via Tatum`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
