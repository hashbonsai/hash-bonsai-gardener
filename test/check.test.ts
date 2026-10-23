import { describe, expect, it } from 'vitest'
import { acceptObservations, checkReport, shortAddress } from '../src/check'
import { allowedNumbers, disallowedNumbers, extractNumbers } from '../src/numbers'
import { CLEAN_REPORT, sampleFacts } from './fixtures'

const facts = sampleFacts()
const ctx = { facts, castBudgetBytes: 200 }
const report = (over: Partial<typeof CLEAN_REPORT> = {}) => ({ ...CLEAN_REPORT, ...over })

function reasons(r: ReturnType<typeof checkReport>): string[] {
  return r.ok ? [] : r.reasons
}

describe('extractNumbers', () => {
  it('reads integers, commas, decimals, percent signs and magnitude suffixes', () => {
    const got = extractNumbers('1,234 and 8,500.5 and 12% and 1.2k and 3万').map((n) => n.value)
    expect(got).toEqual([1234, 8500.5, 12, 1200, 30000])
  })
  it('does not read digits inside an address or a word', () => {
    expect(extractNumbers('0xabc123…cdef and Erc20 and v4')).toEqual([])
  })
})

describe('numbers the prose may use', () => {
  const allowed = allowedNumbers(facts)
  const bad = (text: string) => disallowedNumbers(text, allowed).map((n) => n.text)

  it('allows a fact as written, with commas, and rounded to fewer decimals', () => {
    expect(bad('8,500.5 and 8,500 and 8,501 and 25.4 and 25')).toEqual([])
  })
  it('allows the epoch, its neighbours and the ranks 1 to 3', () => {
    expect(bad('epoch 4, 5 and 6, rank 1 2 3')).toEqual([])
  })
  it('allows a short form of a fact', () => {
    expect(bad('about 8.5k BONEXP')).toEqual([])
  })
  it('rejects a number that is in no fact', () => {
    expect(bad('37 players')).toEqual(['37'])
  })
  it('rejects a figure the model computed itself, such as a percentage', () => {
    expect(bad('players are up 233%')).toEqual(['233%'])
  })
  it('allows a derived number passed in by the code', () => {
    expect(disallowedNumbers('went from 3 to 4', allowedNumbers(facts, [3, 4]))).toEqual([])
  })
})

describe('checkReport', () => {
  it('passes a clean report and returns its observations with the baseline read from the facts', () => {
    const r = checkReport(report(), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.observations).toMatchObject([{ metric: 'players', direction: 'up', baseline: 12, epoch: 5 }])
  })

  it('rejects a number that is not in the facts, in either language and in the cast', () => {
    expect(reasons(checkReport(report({ en: 'Epoch 5 saw 99 players.' }), ctx)).join()).toMatch(/en: number "99"/)
    expect(reasons(checkReport(report({ ja: 'シーズン 5 は 99 人でした。' }), ctx)).join()).toMatch(/ja: number "99"/)
    expect(reasons(checkReport(report({ cast: 'Now 99 players.' }), ctx)).join()).toMatch(/cast: number "99"/)
  })

  it.each([
    ['price', 'The price is up.'],
    ['Profit', 'A nice profit.'],
    ['yield', 'High yield.'],
    ['MOON', 'To the moon.'],
    ['値段', '値段が上がった。'],
    ['儲', '儲かる。'],
    ['換金', '換金できる。'],
  ])('rejects the forbidden word %s, as a substring and regardless of case', (_word, text) => {
    expect(reasons(checkReport(report({ en: text }), ctx)).join()).toMatch(/forbidden word/)
    expect(reasons(checkReport(report({ ja: text }), ctx)).join()).toMatch(/forbidden word/)
  })

  it.each(['The vote opens.', 'Voting opens.', 'A ballot is open.', '投票が始まった。'])('rejects any mention of voting: %s', (text) => {
    expect(reasons(checkReport(report({ en: text }), ctx)).join()).toMatch(/voting/)
  })

  it('rejects an en text over 600 characters or 120 words', () => {
    expect(reasons(checkReport(report({ en: 'a '.repeat(301) }), ctx)).join()).toMatch(/en: 602 chars|words/)
    expect(reasons(checkReport(report({ en: 'word '.repeat(121) }), ctx)).join()).toMatch(/121 words/)
  })
  it('rejects a ja text over 600 characters', () => {
    expect(reasons(checkReport(report({ ja: 'あ'.repeat(601) }), ctx)).join()).toMatch(/ja: 601 chars/)
  })
  it('rejects a cast over its byte budget, counting bytes and not characters', () => {
    expect(reasons(checkReport(report({ cast: 'あ'.repeat(70) }), { ...ctx, castBudgetBytes: 200 })).join()).toMatch(/cast: 210 bytes/)
  })

  it('rejects an address that is not one of the top three, and accepts one that is', () => {
    expect(reasons(checkReport(report({ en: 'Epoch 5: 0xdeadbeef…1234 led.' }), ctx)).join()).toMatch(/not one of the top three/)
    expect(checkReport(report({ en: 'Epoch 5: 0xabc123…cdef led.' }), ctx).ok).toBe(true)
  })

  describe('house style', () => {
    it.each(['盆栽', 'ボンサイ', '盆景', 'エポック'])('rejects 「%s」 in the Japanese text', (term) => {
      const got = reasons(checkReport(report({ ja: `シーズン 5 の${term}は 12 人でした。` }), ctx)).join()
      expect(got).toContain(`ja: house style does not allow "${term}"`)
    })
    it.each(['バーン', '精算', 'Standing', 'Arena', 'Gardener'])('rejects 「%s」 in the Japanese text (the glossary has a Japanese term)', (term) => {
      const got = reasons(checkReport(report({ ja: `シーズン 5 の ${term} は 12 人でした。` }), ctx)).join()
      expect(got).toContain(`ja: house style does not allow "${term}"`)
    })
    it('accepts the glossary terms and Bonsai in English letters', () => {
      const ja = 'シーズン 5 は、確定後の賞金プールが 310.75 SUI で、ランキングに 12 人が入り、アリーナの Bonsai が 40 回スコアに変換されました。庭師の記録です。'
      expect(checkReport(report({ ja }), ctx).ok).toBe(true)
    })
    it('lets the English text and the cast use Standing, Arena and Gardener', () => {
      const r = checkReport(report({ en: 'Epoch 5: the Standing held 12 players and the Arena stayed busy.', cast: 'The Gardener on epoch 5.' }), ctx)
      expect(r.ok).toBe(true)
    })
    it('lets an English observation use them, and still drops one with a banned Japanese spelling', () => {
      const o = (statement: string) => ({ metric: 'players', direction: 'up', statement })
      const got = acceptObservations([o('The Standing may keep filling.'), o('The Arena stays busy.'), o('バーンが続く。')], facts)
      expect(got.map((x) => x.statement)).toEqual(['The Standing may keep filling.', 'The Arena stays busy.'])
    })
  })

  describe('numbers written as words', () => {
    it.each([
      ['zero', 'Zero burns happened.'],
      ['One', 'One player stood out.'],
      ['twelve', 'Twelve players joined.'],
      ['twenty', 'Twenty-one burns.'],
      ['ninety', 'About ninety players.'],
      ['hundred', 'A hundred burns.'],
      ['thousands', 'Thousands of BONEXP.'],
      ['million', 'A million PRUNE.'],
      ['billion', 'A billion.'],
      ['dozen', 'A dozen players.'],
    ])('rejects "%s" in the English text and the cast', (_word, text) => {
      expect(reasons(checkReport(report({ en: text }), ctx)).join()).toMatch(/en: number written as a word/)
      expect(reasons(checkReport(report({ cast: text }), ctx)).join()).toMatch(/cast: number written as a word/)
    })

    it.each(['三人', '十二回', '二本', '百件', '五枚', '三個', '二十人', '一万件', '三割'])('rejects the kanji numeral with a counter: %s', (text) => {
      expect(reasons(checkReport(report({ ja: `参加者は${text}でした。` }), ctx)).join()).toMatch(/ja: number written as a word/)
    })

    it('does not reject ordinary words that merely contain a number-word spelling', () => {
      // "none", "phone", "tone", "bone" contain "one" but are not the number.
      expect(checkReport(report({ en: 'Epoch 5 closed. The phone stayed quiet and the bone tree grew.' }), ctx).ok).toBe(true)
    })
    it('does not reject kanji that are not a numeral with a counter', () => {
      expect(checkReport(report({ ja: 'シーズン 5 は一部の参加者が活発でした。' }), ctx).ok).toBe(true)
    })
    it('accepts digits with Japanese counters', () => {
      expect(checkReport(report({ ja: 'シーズン 5 は 12 人、40 回でした。' }), ctx).ok).toBe(true)
    })
    it('drops an observation that spells a number out or breaks the Japanese house style', () => {
      const o = (statement: string) => ({ metric: 'players', direction: 'up', statement })
      expect(acceptObservations([o('Expect three more players.'), o('三人増えそうです。'), o('盆栽が増える。'), o('Players should keep growing.')], facts).map((x) => x.statement)).toEqual(['Players should keep growing.'])
    })
  })

  it('rejects an empty text', () => {
    expect(reasons(checkReport(report({ en: '  ' }), ctx)).join()).toMatch(/en: empty/)
  })
})

describe('acceptObservations', () => {
  const obs = (over: Record<string, string>) => ({ metric: 'players', direction: 'up', statement: 'Fine.', ...over })

  it('drops only the bad observation, not the others', () => {
    const got = acceptObservations(
      [obs({ metric: 'bananas' }), obs({ direction: 'sideways' }), obs({ statement: '' }), obs({ statement: 'Price will rise.' }), obs({}), obs({ metric: 'drains' })],
      facts,
    )
    expect(got.map((o) => o.metric)).toEqual(['players', 'drains'])
  })
  it('takes the baseline from the facts, ignoring any number the model attached', () => {
    const raw = { ...obs({}), baseline: 9999 } as never
    expect(acceptObservations([raw], facts)[0].baseline).toBe(12)
  })
  it('drops an observation about a metric the chain could not read', () => {
    expect(acceptObservations([obs({})], sampleFacts({ players: null }))).toEqual([])
  })
  it('drops an observation whose statement holds a number that is not a fact', () => {
    expect(acceptObservations([obs({ statement: 'Expect 77 players.' })], facts)).toEqual([])
  })
  it('keeps at most three', () => {
    expect(acceptObservations(Array.from({ length: 5 }, () => obs({})), facts)).toHaveLength(3)
  })
  it('gives stable ids', () => {
    expect(acceptObservations([obs({}), obs({})], facts).map((o) => o.id)).toEqual(['obs-5-1', 'obs-5-2'])
  })
})

describe('shortAddress', () => {
  it('keeps the first six and last four characters', () => {
    expect(shortAddress('0xABCDEF1234567890abcd')).toBe('0xabcd…abcd')
  })
})
