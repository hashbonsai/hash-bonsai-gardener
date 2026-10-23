import { describe, expect, it } from 'vitest'
import { FORBIDDEN_WORDS_EN, FORBIDDEN_WORDS_JA, forbiddenWordIn, LIMITS, VOTE_WORDS, voteWordIn } from '../src/policy'

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
  it('pins the limits', () => {
    expect(LIMITS).toEqual({ commentaryChars: 600, commentaryWordsEn: 120, castBytes: 320, observations: { min: 0, max: 3 } })
  })

  it('finds a forbidden word as a part of a longer word, in any case', () => {
    expect(forbiddenWordIn('Priceless')).toBe('price')
    expect(forbiddenWordIn('INVESTORS')).toBe('invest')
    expect(forbiddenWordIn('Epoch 5 closed with 12 players.')).toBeNull()
  })
  it('finds a voting word, in any case', () => {
    expect(voteWordIn('Voting opens')).toBe('voting')
    expect(voteWordIn('She voted')).toBe('vote')
    expect(voteWordIn('BALLOT')).toBe('ballot')
    expect(voteWordIn('Nothing here.')).toBeNull()
  })
})
