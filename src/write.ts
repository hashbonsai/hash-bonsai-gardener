import { checkReport } from './check'
import type { LlmProvider } from './llm'
import { derivedNumbers } from './learn'
import { LIMITS } from './policy'
import { castSuffix, fallbackReport } from './templates'
import type { EditorNote, Facts, Followup, LlmReport, Observation } from './types'

export type WriteInput = {
  facts: Facts
  /** This round's follow-ups, graded by code. */
  followups: Followup[]
  /** Unanswered observations from earlier epochs, read back from memory. */
  observations: Observation[]
  notes: EditorNote[]
  /** English text of the previous four reports, newest first. */
  previousReports: string[]
  /** Contents of the system prompt file. */
  systemPrompt: string
  /** The Walrus URL the cast will link to — only its length matters here. */
  reportUrl: string
}

export type WriteResult = {
  text: { en: string; ja: string }
  cast: string
  observations: Observation[]
  /** True when the model's text twice failed its checks and only the fixed text remains. */
  fallback: boolean
  attempts: number
  /** Why each failed attempt failed (empty when the first passed). */
  failures: string[][]
}

const MAX_ATTEMPTS = 2

function isLlmReport(v: unknown): v is LlmReport {
  const r = v as Partial<LlmReport> | null
  return !!r && typeof r.en === 'string' && typeof r.ja === 'string' && typeof r.cast === 'string' && Array.isArray(r.observations)
}

/**
 * The system prompt, plus the operator's notes as writing guidance. Notes are
 * typed by the operator on the server, never by a player, and the prompt says
 * to ignore one that contradicts the facts.
 */
export function buildSystem(systemPrompt: string, notes: EditorNote[]): string {
  if (notes.length === 0) return systemPrompt
  const lines = notes.map((n) => `- (epoch ${n.epoch}) ${n.note}`)
  return `${systemPrompt}\n\nOperator's notes on how to write (guidance on style only; if a note disagrees with the facts, the facts win and the note is ignored):\n${lines.join('\n')}`
}

/**
 * Everything the model may know, labelled by where it came from: the facts
 * and follow-up results are the code's; "your earlier observations" are the
 * model's own past words, passed back as such and not as fact.
 */
export function buildUser(input: WriteInput, priorFailure?: string[]): string {
  const body: Record<string, unknown> = {
    facts: input.facts,
    followups: input.followups,
    yourEarlierObservations: input.observations.map((o) => ({ epoch: o.epoch, metric: o.metric, direction: o.direction, statement: o.statement })),
    previousReports: input.previousReports,
  }
  if (priorFailure && priorFailure.length > 0) {
    body.yourLastAttemptWasRejectedBecause = priorFailure
  }
  return JSON.stringify(body)
}

export async function composeReport(llm: LlmProvider, input: WriteInput): Promise<WriteResult> {
  const system = buildSystem(input.systemPrompt, input.notes)
  const castBudgetBytes = LIMITS.castBytes - new TextEncoder().encode(castSuffix(input.reportUrl)).length
  const derived = derivedNumbers(input.followups)
  const failures: string[][] = []

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: unknown
    try {
      raw = await llm.generate({ system, user: buildUser(input, failures.at(-1)) })
    } catch (e) {
      failures.push([`the model call failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`])
      continue
    }
    if (!isLlmReport(raw)) {
      failures.push(['the output was not { en, ja, cast, observations }'])
      continue
    }
    const checked = checkReport(raw, { facts: input.facts, derived, castBudgetBytes })
    if (checked.ok) {
      return {
        text: { en: raw.en.trim(), ja: raw.ja.trim() },
        cast: raw.cast.trim(),
        observations: checked.observations,
        fallback: false,
        attempts: attempt,
        failures,
      }
    }
    failures.push(checked.reasons)
  }

  return {
    text: { en: fallbackReport(input.facts, input.followups, 'en'), ja: fallbackReport(input.facts, input.followups, 'ja') },
    cast: `The Gardener's report for epoch ${input.facts.epoch} is out.`,
    observations: [],
    fallback: true,
    attempts: MAX_ATTEMPTS,
    failures,
  }
}
