import { checkReport } from './check'
import { displayFacts, displayFollowup } from './display'
import { LlmCallError, type LlmProvider } from './llm'
import { derivedNumbers } from './learn'
import { LIMITS } from './policy'
import { redact } from './redact'
import { castSuffix, fallbackReport, type FallbackReason } from './templates'
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
  /** True when no commentary was kept and only the fixed text remains. */
  fallback: boolean
  /**
   * Why there is no commentary, by what the last attempt ended on: the text
   * failed its checks, or no usable text could be had from the model (a call
   * that failed, or an answer of the wrong shape). Null when the report passed.
   */
  fallbackReason: FallbackReason | null
  /** How many attempts were made; fewer than the maximum when a failure was one that retrying cannot fix. */
  attempts: number
  /** Why each failed attempt failed (empty when the first passed). */
  failures: string[][]
}

export type WriteOptions = {
  /** The pause before trying again after a failure that may pass (a rate limit, an overloaded server). */
  transientDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

const MAX_ATTEMPTS = 2
const TRANSIENT_DELAY_MS = 30_000

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
  // The model is shown the figures as the game's screens show them, rounded; the facts kept on
  // Walrus keep every digit.
  const body: Record<string, unknown> = {
    facts: displayFacts(input.facts),
    followups: input.followups.map(displayFollowup),
    yourEarlierObservations: input.observations.map((o) => ({ epoch: o.epoch, metric: o.metric, direction: o.direction, statement: o.statement })),
    previousReports: input.previousReports,
  }
  if (priorFailure && priorFailure.length > 0) {
    body.yourLastAttemptWasRejectedBecause = priorFailure
  }
  return JSON.stringify(body)
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Writes the commentary, trying at most twice. A failed check is retried with
 * the reasons shown to the model. A call that failed for good (a bad key, a
 * refused request) is not retried at all; one that may pass (a rate limit, an
 * overloaded server) is retried after a pause; an answer of the wrong shape
 * is retried at once. If no attempt passes, the fixed text is returned and
 * `fallbackReason` says whether that was the checks or the model being out of
 * reach — the two read differently in the report and to the operator.
 */
export async function composeReport(llm: LlmProvider, input: WriteInput, options: WriteOptions = {}): Promise<WriteResult> {
  const system = buildSystem(input.systemPrompt, input.notes)
  const castBudgetBytes = LIMITS.castBytes - new TextEncoder().encode(castSuffix(input.reportUrl)).length
  const derived = derivedNumbers(input.followups.map(displayFollowup))
  const sleep = options.sleep ?? realSleep
  const failures: string[][] = []
  let reason: FallbackReason = 'unavailable'
  let attempts = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt
    let raw: unknown
    try {
      raw = await llm.generate({ system, user: buildUser(input, failures.at(-1)) })
    } catch (e) {
      const text = redact(e instanceof Error ? e.message : 'unknown error').slice(0, 200)
      reason = 'unavailable'
      if (e instanceof LlmCallError && e.kind === 'permanent') {
        failures.push([`the model call failed and will not be retried: ${text}`])
        break
      }
      failures.push([`the model call failed: ${text}`])
      if (e instanceof LlmCallError && attempt < MAX_ATTEMPTS) await sleep(options.transientDelayMs ?? TRANSIENT_DELAY_MS)
      continue
    }
    if (!isLlmReport(raw)) {
      failures.push(['the output was not { en, ja, cast, observations }'])
      reason = 'unavailable'
      continue
    }
    const checked = checkReport(raw, { facts: input.facts, derived, castBudgetBytes })
    if (checked.ok) {
      return {
        text: { en: raw.en.trim(), ja: raw.ja.trim() },
        cast: raw.cast.trim(),
        observations: checked.observations,
        fallback: false,
        fallbackReason: null,
        attempts: attempt,
        failures,
      }
    }
    failures.push(checked.reasons)
    reason = 'checks'
  }

  return {
    text: {
      en: fallbackReport(input.facts, input.followups, 'en', reason),
      ja: fallbackReport(input.facts, input.followups, 'ja', reason),
    },
    cast: `The Gardener's report for epoch ${input.facts.epoch} is out.`,
    observations: [],
    fallback: true,
    fallbackReason: reason,
    attempts,
    failures,
  }
}

/**
 * What the operator should be told when a report had no commentary, for the
 * notifier to send (it redacts again on the way out). Null when the report passed.
 */
export function operatorNotice(result: WriteResult, epoch: number): string | null {
  if (!result.fallback || !result.fallbackReason) return null
  const last = (result.failures.at(-1) ?? []).join('; ')
  const head =
    result.fallbackReason === 'unavailable'
      ? `Epoch ${epoch}: the commentary could not be written, so the report has only the figures. Last problem: ${last}`
      : `Epoch ${epoch}: the commentary failed its checks, so the report has only the figures. Last reasons: ${last}`
  return redact(head)
}
