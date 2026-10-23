import { describe, expect, it } from 'vitest'
import { FORBIDDEN_TERMS_JA, FORBIDDEN_WORDS_EN, FORBIDDEN_WORDS_JA, forbiddenTermJaIn, forbiddenWordIn, LIMITS, numberWordIn, VOTE_WORDS, voteWordIn } from '../src/policy'

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
  it('pins the Japanese spellings that house style rules out', () => {
    expect([...FORBIDDEN_TERMS_JA]).toEqual(['盆栽', 'ボンサイ', '盆景', 'エポック'])
  })
  it('pins the limits', () => {
    expect(LIMITS).toEqual({ commentaryChars: 600, commentaryWordsEn: 120, castBytes: 320, observations: { min: 0, max: 3 } })
  })

  it('finds a forbidden word as a part of a longer word, in any case', () => {
    expect(forbiddenWordIn('Priceless')).toBe('price')
    expect(forbiddenWordIn('INVESTORS')).toBe('invest')
    expect(forbiddenWordIn('Epoch 5 closed with 12 players.')).toBeNull()
  })
  it('finds a Japanese spelling that house style rules out', () => {
    expect(forbiddenTermJaIn('小さな盆栽')).toBe('盆栽')
    expect(forbiddenTermJaIn('エポック 5')).toBe('エポック')
    expect(forbiddenTermJaIn('シーズン 5 の Bonsai')).toBeNull()
  })
  it('finds a number written as a word, and returns what it found', () => {
    expect(numberWordIn('Twenty-one players')).toBe('Twenty')
    expect(numberWordIn('hundreds of burns')).toBe('hundreds')
    expect(numberWordIn('十二回')).toBe('十二回')
    expect(numberWordIn('12 players, 40 burns, 12 人')).toBeNull()
  })
  it('finds a voting word, in any case', () => {
    expect(voteWordIn('Voting opens')).toBe('voting')
    expect(voteWordIn('She voted')).toBe('vote')
    expect(voteWordIn('BALLOT')).toBe('ballot')
    expect(voteWordIn('Nothing here.')).toBeNull()
  })
})
