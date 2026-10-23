#!/usr/bin/env -S npx tsx
// Day-one check: read one finished epoch of the live game the way a round does,
// over gRPC and the public GraphQL, and print the facts it produced and every
// section that could not be read. Read-only: nothing is signed or written.
//
// With --tatum-key-file the objects come through Tatum (the real path, native
// gRPC with the key as metadata). Without it they come from Sui's public
// fullnode, which needs no key. Usage:
//   npx tsx scripts/check-chain.ts --epoch 3 --tatum-key-file ~/.config/the-gardener/tatum-api-key
//
// Prints the facts JSON and the problems — never a key.
import { readFileSync } from 'node:fs'
import { ChannelCredentials } from '@grpc/grpc-js'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { GrpcTransport } from '@protobuf-ts/grpc-transport'
import { collectRawEpoch } from '../src/collect'
import { buildFacts } from '../src/facts'
import { httpGraphQl } from '../src/gql'
import { redact } from '../src/redact'
import { liveSources, MAINNET, MAINNET_GRAPHQL } from '../src/sources'
import { createTatumClient } from '../src/tatum'
import { TATUM_THROTTLE } from '../src/throttle'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main() {
  const epoch = Number(arg('epoch'))
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('--epoch must be a positive integer')
  const keyFile = arg('tatum-key-file')
  const gardener = arg('address') ?? '0x7ea44266a7310276cdcd916d1c2f46f5609c2a4c78e5c441840c09612f127826'

  let grpc: SuiGrpcClient
  let close: () => void
  if (keyFile) {
    const tatum = createTatumClient('mainnet', readFileSync(keyFile, 'utf8').trim(), {
      ...TATUM_THROTTLE,
      onRetry: ({ attempt, waitMs }) => console.error(`  Tatum answered 429; waiting ${waitMs} ms (retry ${attempt})`),
    })
    grpc = tatum.client
    close = tatum.close
    console.error(`reading objects through Tatum: ${tatum.host}`)
  } else {
    const transport = new GrpcTransport({ host: 'fullnode.mainnet.sui.io:443', channelCredentials: ChannelCredentials.createSsl() })
    grpc = new SuiGrpcClient({ network: 'mainnet', transport })
    close = () => transport.close()
    console.error('reading objects through the public fullnode (no key)')
  }

  try {
    const sources = liveSources(grpc, httpGraphQl(MAINNET_GRAPHQL), MAINNET, gardener)
    const { raw, problems } = await collectRawEpoch(sources, epoch, { spentThisEpoch: 0n })
    const facts = buildFacts(raw)
    console.log(JSON.stringify(facts, null, 2))
    console.error(problems.length === 0 ? '\nproblems: none' : `\nproblems (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  } finally {
    close()
  }
}

main().catch((e) => {
  console.error('FAILED:', redact(e instanceof Error ? e.message : String(e)))
  process.exitCode = 1
})
