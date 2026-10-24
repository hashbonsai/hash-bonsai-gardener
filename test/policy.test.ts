import { describe, expect, it } from 'vitest'
import {
  ENGLISH_WORDS_RULED_OUT_IN_JA,
  FORBIDDEN_TERMS_JA,
  FORBIDDEN_WORDS_EN,
  FORBIDDEN_WORDS_JA,
  forbiddenTermJaIn,
  forbiddenWordIn,
  HANDED_OUT_BY_GARDENER_JA,
  handedOutByGardenerIn,
  JAPANESE_SPELLINGS_RULED_OUT,
  LIMITS,
  NOT_IN_JA_COMMENTARY,
  notInJaCommentaryIn,
  numberWordIn,
  pruneReleasedSentenceIn,
  ruledOutJapaneseSpellingIn,
  SETTLED_BY_GARDENER_JA,
  settledByGardenerIn,
  tickerPruneIn,
  VOTE_WORDS,
  voteWordIn,
} from '../src/policy'

// These lists are the operator's published promise about what the report
// never says. Changing one should fail a test, so the change is deliberate.
describe('policy', () => {
  it('pins the forbidden Japanese words', () => {
    expect([...FORBIDDEN_WORDS_JA]).toEqual(['値段', '価格', '相場', '稼', '儲', '利回り', '投資', '値上がり', '換金', '配当'])
  })
  it('pins the forbidden English words', () => {
    expect([...FORBIDDEN_WORDS_EN]).toEqual(['price', 'profit', 'yield', 'APY', 'APR', 'invest', 'ROI', 'dividend', 'moon', 'pump'])
  })
  it('pins the voting words', () => {
    expect([...VOTE_WORDS]).toEqual(['vote', 'voting', 'ballot', '投票'])
  })
  it('pins the Japanese spellings the glossary rules out, and the English words ruled out in Japanese text', () => {
    expect([...JAPANESE_SPELLINGS_RULED_OUT]).toEqual(['盆栽', 'ボンサイ', '盆景', 'エポック', 'バーン', '精算', '清算'])
    expect([...ENGLISH_WORDS_RULED_OUT_IN_JA]).toEqual(['Standing', 'Arena', 'Gardener'])
    expect([...FORBIDDEN_TERMS_JA]).toEqual(['盆栽', 'ボンサイ', '盆景', 'エポック', 'バーン', '精算', '清算', 'Standing', 'Arena', 'Gardener'])
  })
  it('pins the limits', () => {
    expect(LIMITS).toEqual({ commentaryChars: 600, commentaryWordsEn: 120, castBytes: 320, observations: { min: 0, max: 3 }, factFigures: 4 })
  })

  it('finds a forbidden word as a part of a longer word, in any case', () => {
    expect(forbiddenWordIn('Priceless')).toBe('price')
    expect(forbiddenWordIn('INVESTORS')).toBe('invest')
    expect(forbiddenWordIn('Epoch 5 closed with 12 players.')).toBeNull()
  })
  it('finds a term the Japanese text must not use', () => {
    expect(forbiddenTermJaIn('小さな盆栽')).toBe('盆栽')
    expect(forbiddenTermJaIn('エポック 5')).toBe('エポック')
    expect(forbiddenTermJaIn('バーンが増えた')).toBe('バーン')
    expect(forbiddenTermJaIn('精算後の賞金プール')).toBe('精算')
    expect(forbiddenTermJaIn('清算後の賞金プール')).toBe('清算')
    expect(forbiddenTermJaIn('確定後の賞金プール')).toBeNull()
    expect(forbiddenTermJaIn('Standing の上位')).toBe('Standing')
    expect(forbiddenTermJaIn('Arena の木')).toBe('Arena')
    expect(forbiddenTermJaIn('Gardener の記録')).toBe('Gardener')
    expect(forbiddenTermJaIn('シーズン 5 の Bonsai、ランキング、アリーナ、庭師、スコアに変換')).toBeNull()
  })
  it('pins the phrases that make the Gardener the one who handed PRUNE out, and finds them', () => {
    expect([...HANDED_OUT_BY_GARDENER_JA]).toEqual(['を配布しました', 'を配布した'])
    expect(handedOutByGardenerIn('ランキングに 100,000 PRUNE を配布しました。')).toBe('を配布しました')
    expect(handedOutByGardenerIn('100,000 PRUNE を配布した。')).toBe('を配布した')
    expect(handedOutByGardenerIn('ランキングに 100,000 PRUNE が配布されました。')).toBeNull()
    expect(handedOutByGardenerIn('PRUNE の配布は 100,000 でした。')).toBeNull()
    expect(handedOutByGardenerIn('PRUNE を配布し、')).toBeNull()
  })
  it('pins the words the Japanese commentary does not use, and finds them as parts of longer words', () => {
    expect([...NOT_IN_JA_COMMENTARY]).toEqual(['剪定', '刈り取', '庭師'])
    expect(notInJaCommentaryIn('枝の剪定')).toBe('剪定')
    expect(notInJaCommentaryIn('刈り取りの季節')).toBe('刈り取')
    expect(notInJaCommentaryIn('庭師の記録')).toBe('庭師')
    expect(notInJaCommentaryIn('シーズン 5 の Bonsai、ランキング、アリーナ、私の記録、PRUNE を配布')).toBeNull()
  })
  it('finds "$PRUNE" in any case, and not PRUNE', () => {
    expect(tickerPruneIn('buy $PRUNE')).toBe('$PRUNE')
    expect(tickerPruneIn('$prune is up')).toBe('$prune')
    expect(tickerPruneIn('PRUNE and 100 $ of it')).toBeNull()
    expect(tickerPruneIn('5 PRUNE')).toBeNull()
  })
  it('pins the phrases that make the Gardener the one who settled, and finds them', () => {
    expect([...SETTLED_BY_GARDENER_JA]).toEqual(['を確定しました', 'を確定した'])
    expect(settledByGardenerIn('シーズン 3 を確定しました。')).toBe('を確定しました')
    expect(settledByGardenerIn('シーズン 3 の結果を確定した。')).toBe('を確定した')
    expect(settledByGardenerIn('シーズン 3 が確定しました。')).toBeNull()
    expect(settledByGardenerIn('確定後の賞金プール')).toBeNull()
    expect(settledByGardenerIn('シーズン 3 は確定した。')).toBeNull()
  })
  it('lets an English sentence use the English words, and still catches a Japanese spelling in it', () => {
    expect(ruledOutJapaneseSpellingIn('The Standing may keep filling in the Arena, says the Gardener.')).toBeNull()
    expect(ruledOutJapaneseSpellingIn('バーンが増える')).toBe('バーン')
  })
  it('finds a number written as a word, and returns what it found', () => {
    expect(numberWordIn('Twenty-one players')).toBe('Twenty')
    expect(numberWordIn('hundreds of burns')).toBe('hundreds')
    expect(numberWordIn('十二回')).toBe('十二回')
    expect(numberWordIn('12 players, 40 burns, 12 人')).toBeNull()
  })
  it('finds a Japanese sentence that uses 放出 about PRUNE, and only within one sentence', () => {
    expect(pruneReleasedSentenceIn('PRUNE が放出されました。')).toBe('PRUNE が放出されました')
    expect(pruneReleasedSentenceIn('放出額は 7 SUI です。PRUNE を配布しました。')).toBeNull()
    expect(pruneReleasedSentenceIn('放出額は 7 SUI です\nPRUNE を配布しました')).toBeNull()
    expect(pruneReleasedSentenceIn('放出額は 7 SUI で、PRUNE も出ました。')).toBe('放出額は 7 SUI で、PRUNE も出ました')
    expect(pruneReleasedSentenceIn('賞金プールは 64 SUI です。')).toBeNull()
  })
  it('finds a voting word, in any case', () => {
    expect(voteWordIn('Voting opens')).toBe('voting')
    expect(voteWordIn('She voted')).toBe('vote')
    expect(voteWordIn('BALLOT')).toBe('ballot')
    expect(voteWordIn('Nothing here.')).toBeNull()
  })
})
