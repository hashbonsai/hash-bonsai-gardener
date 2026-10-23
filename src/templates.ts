import type { Facts, Followup, Lang, ObservationMetric, Verdict } from './types'

/**
 * Everything the model does not write: the table of figures, the voting
 * notices, the notebook lines, the closing sentence, and the whole report when
 * there is no commentary to show. All text here is fixed in code,
 * so what it says about voting cannot drift and no figure in it can be wrong.
 */

// ── The closing sentence (fixed; changing it means changing its test too) ────

export const GARDENER_LONG: Record<Lang, string> = {
  en: "The Gardener is an AI run by the Hash Bonsai operator. It holds no permissions over Hash Bonsai's contracts: it calls no game or governance function, holds no PRUNE and does not vote.",
  ja: '庭師は Hash Bonsai の運営が動かす AI です。Hash Bonsai のコントラクトに対する権限は無く、ゲームと投票の関数を呼ばず、PRUNE を持たず、投票もしません。',
}

export const GARDENER_SHORT_EN = 'The Gardener is an AI run by the Hash Bonsai operator, with no permissions over its contracts.'

// ── Numbers ───────────────────────────────────────────────────────────────

/** Whole units with thousands separators and at most `maxFrac` decimals. */
export function fmt(n: number, maxFrac = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })
}

const L = {
  epoch: { en: 'Epoch', ja: 'シーズン' },
  players: { en: 'Players', ja: '参加者' },
  burns: { en: 'Burns', ja: '焼却の回数' },
  bonexpBurned: { en: 'BONEXP burned', ja: '焼いた BONEXP' },
  extracted: { en: 'Prize pool extracted (SUI)', ja: '取り出した賞金 (SUI)' },
  awarded: { en: 'Prize awarded (SUI)', ja: '配った賞金 (SUI)' },
  seeds: { en: 'Crown Seeds by tier', ja: 'Crown Seed(ティアごと)' },
  treasury: { en: 'Treasury after settlement (SUI)', ja: '確定後の賞金プール (SUI)' },
  treasuryNow: { en: 'Treasury, as of now (SUI)', ja: '賞金プール・現時点 (SUI)' },
  mints: { en: 'Minted this epoch', ja: 'このシーズンのミント' },
  mintsTotal: { en: 'Minted in total', ja: '累計のミント' },
  standing: { en: 'PRUNE to the Standing', ja: 'PRUNE: ランキングの枠' },
  holder: { en: 'PRUNE to holders', ja: 'PRUNE: 保有の枠' },
  trees: { en: 'Bonsai in the Arena', ja: 'アリーナの Bonsai' },
  seeded: { en: 'of them with a Crown Seed', ja: 'うち Crown Seed 付き' },
  drains: { en: 'Drains', ja: 'ドレインの回数' },
  top: { en: 'Top scores', ja: '上位の点数' },
} as const

/** The figures as plain lines, built from the facts by code. A field the chain could not answer is left out. */
export function factsTable(facts: Facts, lang: Lang): string[] {
  const rows: string[] = []
  const add = (label: { en: string; ja: string }, value: string | null) => {
    if (value !== null) rows.push(`${label[lang]}: ${value}`)
  }
  add(L.epoch, String(facts.epoch))
  add(L.players, facts.players === null ? null : fmt(facts.players, 0))
  add(L.burns, facts.burns === null ? null : fmt(facts.burns, 0))
  add(L.bonexpBurned, facts.bonexpBurned === null ? null : fmt(facts.bonexpBurned))
  if (facts.prize) {
    add(L.extracted, fmt(facts.prize.extracted))
    add(L.awarded, fmt(facts.prize.awarded))
    add(L.seeds, facts.prize.seedsByTier.map((n, i) => `T${i + 1}×${fmt(n, 0)}`).join(' '))
  }
  if (facts.treasury) add(facts.treasury.asOf === 'after-settle' ? L.treasury : L.treasuryNow, fmt(facts.treasury.value))
  if (facts.mints) {
    add(L.mints, fmt(facts.mints.delta, 0))
    add(L.mintsTotal, fmt(facts.mints.cumulative, 0))
  }
  if (facts.prune) {
    add(L.standing, fmt(facts.prune.standingEmission))
    add(L.holder, fmt(facts.prune.holderEmission))
  }
  if (facts.arena) {
    add(L.trees, fmt(facts.arena.trees, 0))
    add(L.seeded, fmt(facts.arena.seeded, 0))
  }
  add(L.drains, facts.drains === null ? null : fmt(facts.drains, 0))
  if (facts.top && facts.top.length > 0) add(L.top, facts.top.map((t) => `${t.address} ${fmt(t.score)}`).join(', '))
  return rows
}

// ── Notebook (follow-ups) ─────────────────────────────────────────────────

const METRIC: Record<ObservationMetric, { en: string; ja: string }> = {
  players: { en: 'players in the Standing', ja: 'ランキングの参加者' },
  burns: { en: 'burns', ja: '焼却の回数' },
  bonexpBurned: { en: 'BONEXP burned', ja: '焼いた BONEXP' },
  prizeOut: { en: 'prize awarded', ja: '配った賞金' },
  mints: { en: 'mints in the epoch', ja: 'シーズン中のミント' },
  arenaTrees: { en: 'Bonsai in the Arena', ja: 'アリーナの Bonsai' },
  seededTrees: { en: 'Bonsai with a Crown Seed', ja: 'Crown Seed 付きの Bonsai' },
  drains: { en: 'drains', ja: 'ドレインの回数' },
}

const VERDICT: Record<Verdict, { en: string; ja: string }> = {
  continued: { en: 'it held', ja: '続いた' },
  reversed: { en: 'it turned the other way', ja: '逆になった' },
  flat: { en: 'no change', ja: '変わらなかった' },
}

/** One line per follow-up, numbers and verdict from code. */
export function notebookLines(followups: Followup[], lang: Lang): string[] {
  return followups.map((f) =>
    lang === 'en'
      ? `Epoch ${f.fromEpoch} note on ${METRIC[f.metric].en}: ${fmt(f.before)} → epoch ${f.toEpoch}: ${fmt(f.after)}. ${VERDICT[f.verdict].en}.`
      : `シーズン ${f.fromEpoch} の観察(${METRIC[f.metric].ja}): ${fmt(f.before)} → シーズン ${f.toEpoch}: ${fmt(f.after)}。${VERDICT[f.verdict].ja}。`,
  )
}

// ── Voting notices (fixed — the model never writes these) ─────────────────

/** The four items and their three fixed options, in the order the ballot lists them. */
const VOTE_ITEMS: { en: string; ja: string; options: { en: string; ja: string }[] }[] = [
  { en: 'Prize shape', ja: '賞金の配り方', options: [
    { en: 'Top-heavy', ja: '上位に厚く' }, { en: 'Middle', ja: '中間' }, { en: 'Wide', ja: '広く' },
  ] },
  { en: 'Prize ceiling', ja: '賞金の上限', options: [
    { en: '6% of the Treasury', ja: '賞金プールの 6%' }, { en: '8% of the Treasury', ja: '賞金プールの 8%' }, { en: '10% of the Treasury', ja: '賞金プールの 10%' },
  ] },
  { en: 'Drain share', ja: 'ドレインで奪う割合', options: [
    { en: '25% of unbanked BONEXP', ja: '未回収の BONEXP の 25%' }, { en: '35% of unbanked BONEXP', ja: '未回収の BONEXP の 35%' }, { en: '45% of unbanked BONEXP', ja: '未回収の BONEXP の 45%' },
  ] },
  { en: 'Rate curve midpoint', ja: 'レートの曲線の折れ目', options: [
    { en: '50% into the epoch', ja: 'シーズンの 50% の時点' }, { en: '70% into the epoch', ja: 'シーズンの 70% の時点' }, { en: '90% into the epoch', ja: 'シーズンの 90% の時点' },
  ] },
]

const QUORUM = {
  en: 'A ballot passes with at least 10% of the circulating PRUNE and at least 1,000,000 PRUNE deposited. A tie changes nothing.',
  ja: '流通している PRUNE の 10% 以上、かつ 1,000,000 PRUNE 以上が預けられると成立します。同数なら変わりません。',
}

export function voteAnnouncement(lang: Lang, ballotEpoch: number): string[] {
  const head =
    lang === 'en'
      ? `The ballot of epoch ${ballotEpoch} is open until that epoch ends. PRUNE holders choose among three fixed values for each of four settings:`
      : `シーズン ${ballotEpoch} の投票が開いています(そのシーズンの終わりまで)。PRUNE の保有者が、4 つの設定ごとに、固定された 3 つの値から選びます:`
  const items = VOTE_ITEMS.map((i) => `- ${i[lang]}: ${i.options.map((o) => o[lang]).join(' / ')}`)
  return [head, ...items, QUORUM[lang]]
}

export function voteResult(lang: Lang, ballotEpoch: number, quorumMet: boolean, applied: boolean[]): string[] {
  if (!quorumMet) {
    return [
      lang === 'en'
        ? `The ballot of epoch ${ballotEpoch} was applied without quorum: nothing changed.`
        : `シーズン ${ballotEpoch} の投票は成立しなかったため、何も変わりません。`,
    ]
  }
  const lines = [
    lang === 'en'
      ? `The ballot of epoch ${ballotEpoch} reached quorum and was applied. Results take effect from the next epoch; the Drain share, immediately.`
      : `シーズン ${ballotEpoch} の投票は成立し、反映されました。結果は次のシーズンから効きます(ドレインで奪う割合だけは反映した時点から)。`,
  ]
  VOTE_ITEMS.forEach((item, i) => {
    const done = applied[i] === true
    lines.push(`- ${item[lang]}: ${done ? (lang === 'en' ? 'applied' : '反映') : lang === 'en' ? 'unchanged' : '変更なし'}`)
  })
  return lines
}

// ── Fallback and assembly ─────────────────────────────────────────────────

/** Why a report has no commentary: the text failed its checks, or no usable text could be had from the model. */
export type FallbackReason = 'checks' | 'unavailable'

const FALLBACK_NOTE: Record<FallbackReason, Record<Lang, string>> = {
  checks: {
    en: 'This week’s commentary did not pass its checks, so only the figures are shown.',
    ja: '今回の講評は検査に通らなかったため、数字のみを掲載します。',
  },
  unavailable: {
    en: 'This week’s commentary could not be written, so only the figures are shown.',
    ja: '今回の講評は作れなかったため、数字のみを掲載します。',
  },
}

/**
 * The report when there is no commentary to show: the figures, the notebook,
 * and the closing sentence — nothing the model wrote.
 */
export function fallbackReport(facts: Facts, followups: Followup[], lang: Lang, reason: FallbackReason = 'checks'): string {
  return [...factsTable(facts, lang), '', ...notebookLines(followups, lang), '', FALLBACK_NOTE[reason][lang], '', GARDENER_LONG[lang]].join('\n')
}

/** Short link + sentence appended to the cast; the model's cast text must fit what is left. */
export function castSuffix(url: string): string {
  return `\n${url}\n${GARDENER_SHORT_EN}`
}
