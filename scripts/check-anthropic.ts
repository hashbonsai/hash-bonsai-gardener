#!/usr/bin/env -S npx tsx
// Day-one check: run the real writing step once, the way a round runs it —
// the real system prompt, a realistic facts JSON, the real model, then every
// mechanical check — and show what each attempt produced, whether it passed,
// why it failed, and whether the round ended on the fixed text.
//
// Run this yourself — it needs the real Anthropic API key, which this session
// never reads. It makes one call, or two when the first attempt fails its
// checks (a few cents at most). Usage:
//   npx tsx scripts/check-anthropic.ts --key-file ~/.config/the-gardener/anthropic-api-key
//
// Prints the model that answered, each attempt's raw output, the checks'
// verdict and the final text — never the key.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { anthropicClient, anthropicProvider } from '../src/anthropic'
import type { LlmProvider } from '../src/llm'
import { redact } from '../src/redact'
import type { Followup, Observation } from '../src/types'
import { composeReport } from '../src/write'
import { sampleFacts } from '../test/fixtures'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}

async function main() {
  const apiKey = readFileSync(arg('key-file'), 'utf8').trim()
  const systemPrompt = readFileSync(fileURLToPath(new URL('../prompts/system.md', import.meta.url)), 'utf8')

  const real = anthropicProvider(anthropicClient(apiKey))
  let attempt = 0
  const shown: LlmProvider = {
    servedModel: () => real.servedModel?.() ?? null,
    async generate(input) {
      attempt += 1
      try {
        const raw = await real.generate(input)
        console.log(`\n--- attempt ${attempt}: the model returned ---\n${JSON.stringify(raw, null, 2)}`)
        return raw
      } catch (e) {
        console.log(`\n--- attempt ${attempt}: the call failed: ${redact(e instanceof Error ? e.message : String(e))}`)
        throw e
      }
    },
  }

  // A plausible epoch 5 with one earlier observation already graded.
  const facts = sampleFacts()
  const followups: Followup[] = [{ observationId: 'obs-4-1', fromEpoch: 4, toEpoch: 5, metric: 'players', before: 9, after: 12, verdict: 'continued' }]
  const observations: Observation[] = [
    { id: 'obs-4-1', epoch: 4, metric: 'players', direction: 'up', baseline: 9, statement: 'The Standing may keep filling.' },
  ]

  const result = await composeReport(shown, {
    facts,
    followups,
    observations,
    notes: [],
    previousReports: ['Epoch 4 was quiet: 9 players tended their trees and the Treasury grew steadily.'],
    systemPrompt,
    reportUrl: 'https://aggregator.example/v1/blobs/sample',
  })

  console.log('\n=== result ===')
  console.log(`model that answered: ${real.servedModel?.() ?? '(none)'}`)
  console.log(`attempts: ${result.attempts}`)
  result.failures.forEach((reasons, i) => {
    console.log(`attempt ${i + 1} failed its checks:`)
    for (const r of reasons) console.log(`  - ${r}`)
  })
  console.log(result.fallback ? 'FALLBACK: both attempts failed, so the report is the fixed text only' : `passed all checks on attempt ${result.attempts}`)
  console.log(`\nen: ${result.text.en}\n\nja: ${result.text.ja}\n\ncast: ${result.cast}`)
  console.log(`\nobservations kept: ${JSON.stringify(result.observations, null, 2)}`)
}

main().catch((e) => {
  const status = (e as { status?: number }).status
  console.error('FAILED:', redact(e instanceof Error ? e.message : String(e)), status ? `(HTTP ${status})` : '')
  process.exitCode = 1
})
