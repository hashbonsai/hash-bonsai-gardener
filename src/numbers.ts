import type { Facts } from './types'

export type FoundNumber = {
  /** The text as written, for the failure report. */
  text: string
  value: number
  /** The size of the last place it is written to: 10^-decimals × the suffix multiplier. */
  tolerance: number
  /** Where it starts in the text. */
  index: number
}

const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, 万: 1e4, 億: 1e8 }

// Digits with optional thousands commas and decimals, an optional magnitude
// suffix, an optional percent sign. A lookbehind keeps hex digits in an
// address and the middle of a longer word from reading as numbers.
const NUMBER = /(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?([kKmMbB万億])?(?![\w])%?/g

export function extractNumbers(text: string): FoundNumber[] {
  const out: FoundNumber[] = []
  for (const m of text.matchAll(NUMBER)) {
    const mantissa = m[1].replace(/,/g, '')
    const mult = m[2] ? SUFFIX[m[2]] : 1
    const decimals = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0
    out.push({
      text: m[0].trim(),
      value: Number(mantissa) * mult,
      tolerance: Math.pow(10, -decimals) * mult,
      index: m.index,
    })
  }
  return out
}

/** Every number leaf of an object, depth-first. Booleans and strings are not numbers. */
function leaves(value: unknown, into: number[]): void {
  if (typeof value === 'number' && Number.isFinite(value)) into.push(value)
  else if (Array.isArray(value)) for (const v of value) leaves(v, into)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, into)
}

/**
 * The numbers the prose may use: each value in the facts, anything the code
 * derived and passed in (follow-up results), the epoch and its neighbours,
 * and the ranks 1–3. A number the model computed itself is not in this set,
 * so it fails — which is the point.
 */
export function allowedNumbers(facts: Facts, derived: number[] = []): number[] {
  const out: number[] = [1, 2, 3, facts.epoch - 1, facts.epoch, facts.epoch + 1]
  leaves(facts, out)
  out.push(...derived)
  // Ratios the table also states as percentages are derived by the caller;
  // nothing is derived here, so a model-made percentage cannot slip in.
  return out
}

/**
 * A number as written stands for every value that rounds to it: "99" for 98.5 up to 99.5, "7.18"
 * for 7.175 up to 7.185. So it matches a fact within half of the last place it is written to — not
 * a whole place, which would let "99" pass for a fact of 100.
 */
export function isAllowed(found: FoundNumber, allowed: number[]): boolean {
  return allowed.some((a) => Math.abs(found.value - a) <= found.tolerance / 2 + 1e-9)
}

/** A number right after one of these is an epoch's number, not a figure of the facts. */
const EPOCH_LABEL = /(?:epochs?|シーズン)\s*$/i

/**
 * The figures `text` takes from the facts, each value once: the table that goes with every report
 * already has all of them, so the commentary is allowed only a few. Not counted: an epoch's number
 * (a number right after "epoch" or 「シーズン」), and the numbers of the follow-ups (`derived`: the
 * before and after of a look back, and the epochs it spans). A number that is not a fact at all
 * (a rank, say) is not counted either; the number check deals with that.
 */
export function factFiguresIn(text: string, facts: Facts, derived: number[]): FoundNumber[] {
  const fromFacts: number[] = []
  leaves(facts, fromFacts)
  const seen = new Set<number>()
  const out: FoundNumber[] = []
  for (const n of extractNumbers(text)) {
    if (EPOCH_LABEL.test(text.slice(0, n.index))) continue
    if (isAllowed(n, derived) || !isAllowed(n, fromFacts)) continue
    if (seen.has(n.value)) continue
    seen.add(n.value)
    out.push(n)
  }
  return out
}

export function disallowedNumbers(text: string, allowed: number[]): FoundNumber[] {
  return extractNumbers(text).filter((n) => !isAllowed(n, allowed))
}
