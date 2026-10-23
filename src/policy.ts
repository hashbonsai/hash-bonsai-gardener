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

export function voteWordIn(text: string): string | null {
  const lower = text.toLowerCase()
  for (const w of VOTE_WORDS) if (lower.includes(w.toLowerCase())) return w
  return null
}
