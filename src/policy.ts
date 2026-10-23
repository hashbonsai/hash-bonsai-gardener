/**
 * What the report may never say. The words are matched case-insensitively and
 * as substrings, on purpose: a near miss that fails the check costs one
 * retry, while a miss that gets published reads as the operator talking
 * about money. Pinned by `test/policy.test.ts` so a change is deliberate.
 */

export const FORBIDDEN_WORDS_JA = ['値段', '価格', '相場', '稼', '儲', '利回り', '投資', '値上がり', '換金', '配当'] as const

export const FORBIDDEN_WORDS_EN = [
  'price',
  'profit',
  'yield',
  'APY',
  'APR',
  'invest',
  'ROI',
  'dividend',
  'moon',
  'pump',
] as const

/**
 * Voting is announced by fixed templates only; the model never mentions it.
 * "voting" is listed on its own because it does not contain "vote".
 */
export const VOTE_WORDS = ['vote', 'voting', 'ballot', '投票'] as const

/**
 * House style for Japanese copy: the tree is written "Bonsai" in English
 * letters and an epoch is 「シーズン」. These spellings never appear in `ja`.
 */
export const FORBIDDEN_TERMS_JA = ['盆栽', 'ボンサイ', '盆景', 'エポック'] as const

/**
 * Every figure must be written in digits so the number check can see it. An
 * English number word, or a kanji numeral with a counter after it, is a number
 * the check would miss.
 */
const NUMBER_WORDS_EN =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|(?:hundred|thousand|million|billion|dozen)s?)\b/i
const NUMBER_KANJI_JA = /[一二三四五六七八九十百千万]+(?:人|回|本|枚|件|個|割)/

export const LIMITS = {
  /** Characters, for both en and ja commentary. */
  commentaryChars: 600,
  /** Words, en only. */
  commentaryWordsEn: 120,
  /** A normal Farcaster cast, in bytes, before the fixed suffix is taken off. */
  castBytes: 320,
  observations: { min: 0, max: 3 },
} as const

export function forbiddenWordIn(text: string): string | null {
  const lower = text.toLowerCase()
  for (const w of [...FORBIDDEN_WORDS_JA, ...FORBIDDEN_WORDS_EN]) {
    if (lower.includes(w.toLowerCase())) return w
  }
  return null
}

/** The first spelling in `text` that Japanese copy must not use, or null. */
export function forbiddenTermJaIn(text: string): string | null {
  for (const w of FORBIDDEN_TERMS_JA) if (text.includes(w)) return w
  return null
}

/** The first number written as a word (English) or as a kanji numeral with a counter (Japanese), or null. */
export function numberWordIn(text: string): string | null {
  return NUMBER_WORDS_EN.exec(text)?.[0] ?? NUMBER_KANJI_JA.exec(text)?.[0] ?? null
}

export function voteWordIn(text: string): string | null {
  const lower = text.toLowerCase()
  for (const w of VOTE_WORDS) if (lower.includes(w.toLowerCase())) return w
  return null
}
