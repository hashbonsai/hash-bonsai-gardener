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
 * The game's Japanese glossary, as the model must follow it (the table is in
 * the system prompt). These spellings never appear in `ja`:
 *  - Japanese spellings the glossary rules out: the tree is "Bonsai" in English
 *    letters, an epoch is 「シーズン」, a burn is 「スコアに変換」, to settle is
 *    「確定」 (not 「精算」or 「清算」).
 *  - English words that have a Japanese term: Standing → ランキング,
 *    Arena → アリーナ, Gardener → 庭師. They are fine in the English text, so
 *    they are checked in `ja` only.
 */
export const JAPANESE_SPELLINGS_RULED_OUT = ['盆栽', 'ボンサイ', '盆景', 'エポック', 'バーン', '精算', '清算'] as const
export const ENGLISH_WORDS_RULED_OUT_IN_JA = ['Standing', 'Arena', 'Gardener'] as const
export const FORBIDDEN_TERMS_JA = [...JAPANESE_SPELLINGS_RULED_OUT, ...ENGLISH_WORDS_RULED_OUT_IN_JA] as const

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
  /** Figures of the facts that the English commentary, and the Japanese, may each use; the table has the rest. */
  factFigures: 4,
} as const

export function forbiddenWordIn(text: string): string | null {
  const lower = text.toLowerCase()
  for (const w of [...FORBIDDEN_WORDS_JA, ...FORBIDDEN_WORDS_EN]) {
    if (lower.includes(w.toLowerCase())) return w
  }
  return null
}

/** The first term in `text` that the Japanese text must not use (see `FORBIDDEN_TERMS_JA`), or null. */
export function forbiddenTermJaIn(text: string): string | null {
  for (const w of FORBIDDEN_TERMS_JA) if (text.includes(w)) return w
  return null
}

/**
 * 「放出額」 is the SUI prize's word on the game's screens; a PRUNE handout is 「配布」.
 * Returns the first Japanese sentence that has both PRUNE and 「放出」, or null.
 * Sentences end at 。！？ or a line break.
 */
export function pruneReleasedSentenceIn(text: string): string | null {
  for (const sentence of text.split(/[。！？!?\n]/)) {
    if (sentence.includes('PRUNE') && sentence.includes('放出')) return sentence.trim()
  }
  return null
}

/**
 * Words the Japanese commentary does not use, in a different way from the glossary's: the commentary
 * speaks as 「私」, so it has no name for the AI to write down, and the words of pruning read as the
 * PRUNE token. Substrings, on purpose: 「刈り取」 covers 刈り取り, 刈り取った and the rest.
 */
export const NOT_IN_JA_COMMENTARY = ['剪定', '刈り取', '庭師'] as const

/** The first of those words in `text`, or null. */
export function notInJaCommentaryIn(text: string): string | null {
  for (const w of NOT_IN_JA_COMMENTARY) if (text.includes(w)) return w
  return null
}

/** "$PRUNE" is a ticker, which reads as talk of the token's price. Not written in any language, in any case. */
export function tickerPruneIn(text: string): string | null {
  return /\$PRUNE/i.exec(text)?.[0] ?? null
}

/**
 * 「シーズン N を確定しました」 reads as if the Gardener settled the epoch. The game's settle function
 * does that, anyone may call it, and the Gardener calls no game function; the report says the
 * epoch 「が確定しました」 instead. These are the two spellings that make the Gardener the actor.
 */
export const SETTLED_BY_GARDENER_JA = ['を確定しました', 'を確定した'] as const

/** The first phrase in the Japanese text that reads as the Gardener having settled something, or null. */
export function settledByGardenerIn(text: string): string | null {
  for (const w of SETTLED_BY_GARDENER_JA) if (text.includes(w)) return w
  return null
}

/**
 * The first Japanese spelling the glossary rules out, or null. Used on text
 * that is not itself Japanese copy (an observation's sentence), where an
 * English word like "Standing" is fine but a banned Japanese spelling is not.
 */
export function ruledOutJapaneseSpellingIn(text: string): string | null {
  for (const w of JAPANESE_SPELLINGS_RULED_OUT) if (text.includes(w)) return w
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
