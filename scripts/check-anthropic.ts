#!/usr/bin/env -S npx tsx
// Day-one check: confirm the Anthropic API accepts the exact request the
// gardener will send (model, adaptive thinking, JSON-schema output, refusal
// fallback) and that its answer parses into { en, ja, cast, observations }.
//
// Run this yourself — it needs the real Anthropic API key, which this session
// never reads. It makes one short call (a few cents at most). Usage:
//   npx tsx scripts/check-anthropic.ts --key-file ~/.config/the-gardener/anthropic-api-key
//
// Prints the model that answered, the shape of the reply and the text of the
// sample report — never the key.
import { readFileSync } from 'node:fs'
import { anthropicClient, anthropicProvider } from '../src/anthropic'
import { redact } from '../src/redact'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

async function main() {
  const apiKey = readFileSync(arg('key-file'), 'utf8').trim()
  const provider = anthropicProvider(anthropicClient(apiKey))

  const out = (await provider.generate({
    system:
      'You write short reports for a bonsai game. Reply with one sentence in English, the same sentence in Japanese, a cast of at most 200 characters, and one observation about the metric "players" with direction "up".',
    user: JSON.stringify({ facts: { epoch: 0, players: 3 } }),
  })) as { en?: unknown; ja?: unknown; cast?: unknown; observations?: unknown }

  console.log(`ok — answered by ${provider.servedModel?.() ?? '(unknown)'}`)
  console.log(`fields: en ${typeof out.en}, ja ${typeof out.ja}, cast ${typeof out.cast}, observations ${Array.isArray(out.observations) ? `array of ${out.observations.length}` : typeof out.observations}`)
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  const status = (e as { status?: number }).status
  console.error('FAILED:', redact(e instanceof Error ? e.message : String(e)), status ? `(HTTP ${status})` : '')
  process.exitCode = 1
})
