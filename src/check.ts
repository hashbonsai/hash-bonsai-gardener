import { displayFacts } from './display'
import { allowedNumbers, disallowedNumbers } from './numbers'
import {
  forbiddenTermJaIn,
  forbiddenWordIn,
  LIMITS,
  notInJaCommentaryIn,
  numberWordIn,
  pruneReleasedSentenceIn,
  ruledOutJapaneseSpellingIn,
  settledByGardenerIn,
  tickerPruneIn,
  voteWordIn,
} from './policy'
import { OBSERVATION_METRICS, type Direction, type Facts, type LlmReport, type Observation, type ObservationMetric, type RawObservation } from './types'
import { metricValue } from './learn'

export type CheckContext = {
  facts: Facts
  /** Numbers the code derived (follow-up results); the only numbers the model may use beyond the facts. */
  derived?: number[]
  /** Bytes left for the cast once the fixed link and sentence are appended. */
  castBudgetBytes: number
}

export type CheckResult = { ok: true; observations: Observation[] } | { ok: false; reasons: string[] }

export function shortAddress(address: string): string {
  const a = address.toLowerCase()
  return a.length <= 12 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`
}

function wordCountEn(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

const ADDRESS = /0x[0-9a-fA-F]{2,}(?:…[0-9a-fA-F]+)?/g

function badAddresses(text: string, allowed: Set<string>): string[] {
  return [...text.matchAll(ADDRESS)].map((m) => m[0].toLowerCase()).filter((a) => !allowed.has(a))
}

const DIRECTIONS: Direction[] = ['up', 'down', 'flat']

/**
 * Keeps the observations that fit the shape (a known metric, a known
 * direction, a statement that is not empty and carries no forbidden word) and
 * drops the rest one at a time — a bad observation costs only itself.
 * `baseline` is read from the facts; the model's own figure is never used.
 */
export function acceptObservations(raw: RawObservation[], facts: Facts, allowed: number[] = allowedNumbers(displayFacts(facts))): Observation[] {
  const out: Observation[] = []
  const shortOk = new Set((facts.top ?? []).map((t) => t.address.toLowerCase()))
  for (const r of raw) {
    if (typeof r?.statement !== 'string' || !r.statement.trim()) continue
    if (!(OBSERVATION_METRICS as readonly string[]).includes(r.metric)) continue
    if (!DIRECTIONS.includes(r.direction as Direction)) continue
    if (forbiddenWordIn(r.statement) || voteWordIn(r.statement)) continue
    if (numberWordIn(r.statement) || ruledOutJapaneseSpellingIn(r.statement)) continue
    if (disallowedNumbers(r.statement, allowed).length > 0) continue
    if (badAddresses(r.statement, shortOk).length > 0) continue
    const metric = r.metric as ObservationMetric
    const baseline = metricValue(facts, metric)
    if (baseline === null) continue
    out.push({
      id: `obs-${facts.epoch}-${out.length + 1}`,
      epoch: facts.epoch,
      metric,
      direction: r.direction as Direction,
      baseline,
      statement: r.statement.trim(),
    })
  }
  return out.slice(0, LIMITS.observations.max)
}

export function checkReport(report: LlmReport, ctx: CheckContext): CheckResult {
  const reasons: string[] = []
  // What the model was shown is the rounded figures, so those are what it may quote.
  const allowed = allowedNumbers(displayFacts(ctx.facts), ctx.derived)
  const shortOk = new Set((ctx.facts.top ?? []).map((t) => t.address.toLowerCase()))

  const texts: [string, string][] = [
    ['en', report.en],
    ['ja', report.ja],
    ['cast', report.cast],
  ]
  for (const [name, text] of texts) {
    if (typeof text !== 'string' || !text.trim()) {
      reasons.push(`${name}: empty or not a string`)
      continue
    }
    const word = forbiddenWordIn(text)
    if (word) reasons.push(`${name}: forbidden word "${word}"`)
    const vote = voteWordIn(text)
    if (vote) reasons.push(`${name}: mentions voting ("${vote}")`)
    const written = numberWordIn(text)
    if (written) reasons.push(`${name}: number written as a word ("${written}"); write every number in digits`)
    const term = name === 'ja' ? forbiddenTermJaIn(text) : null
    if (term) reasons.push(`ja: house style does not allow "${term}" (use the game's Japanese term from the glossary in the instructions)`)
    const ticker = tickerPruneIn(text)
    if (ticker) reasons.push(`${name}: "${ticker}" reads as a ticker; write PRUNE`)
    const voice = name === 'ja' ? notInJaCommentaryIn(text) : null
    if (voice) reasons.push(`ja: 「${voice}」 is not used in the commentary (it reads as the PRUNE token, or as a name for the AI or the players); speak as 「私」`)
    const settled = name === 'ja' ? settledByGardenerIn(text) : null
    if (settled) reasons.push(`ja: 「${settled}」 reads as if the Gardener settled the epoch, but the game does and the Gardener calls no game function — write 「シーズン N が確定しました」`)
    const released = name === 'ja' ? pruneReleasedSentenceIn(text) : null
    if (released) reasons.push(`ja: 「放出」 is the SUI prize's word (放出額); a PRUNE handout is 「配布」 — in the sentence "${released.slice(0, 60)}"`)
    for (const n of disallowedNumbers(text, allowed)) reasons.push(`${name}: number "${n.text}" is not in the facts`)
    for (const a of badAddresses(text, shortOk)) reasons.push(`${name}: address ${a} is not one of the top three`)
  }

  if (typeof report.en === 'string') {
    if (report.en.length > LIMITS.commentaryChars) reasons.push(`en: ${report.en.length} chars exceeds ${LIMITS.commentaryChars}`)
    if (wordCountEn(report.en) > LIMITS.commentaryWordsEn) reasons.push(`en: ${wordCountEn(report.en)} words exceeds ${LIMITS.commentaryWordsEn}`)
  }
  if (typeof report.ja === 'string' && report.ja.length > LIMITS.commentaryChars) {
    reasons.push(`ja: ${report.ja.length} chars exceeds ${LIMITS.commentaryChars}`)
  }
  if (typeof report.cast === 'string' && utf8Bytes(report.cast) > ctx.castBudgetBytes) {
    reasons.push(`cast: ${utf8Bytes(report.cast)} bytes exceeds ${ctx.castBudgetBytes}`)
  }
  if (!Array.isArray(report.observations)) reasons.push('observations: not an array')

  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, observations: acceptObservations(report.observations, ctx.facts, allowed) }
}
