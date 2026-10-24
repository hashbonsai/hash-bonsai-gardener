import type { Sources } from '../src/collect'
import type { TransactionChanges } from '../src/events'
import type { LlmProvider } from '../src/llm'
import type { MemoryStore } from '../src/memory'
import type { Notifier } from '../src/notify'
import { runRound, type RoundConfig, type RoundDeps } from '../src/round'
import { initialState, memoryStateStore, type State } from '../src/state'
import type { ReportStore, SavedReport } from '../src/walrus'
import type { Report } from '../src/report'

/** Fakes for every part a round touches, set to a finished epoch 5 with the board on 6. */

export const U = 1_000_000_000n
export const HOUR = 3_600_000
export const T4 = Date.UTC(2026, 10, 1)
export const T5 = T4 + 7 * 24 * HOUR
/** A moment soon after epoch 5 ended. */
export const NOW = T5 + HOUR

const player = (n: number) => '0x' + String(n).padStart(64, '0')
const GAME = '0xgame'

function settleTransaction(): TransactionChanges {
  const change = (type: string, over: Partial<TransactionChanges['changes'][number]>): TransactionChanges['changes'][number] => ({
    address: '0x' + 'e'.repeat(64),
    created: false,
    deleted: false,
    type,
    before: null,
    after: null,
    ...over,
  })
  return {
    digest: 'SETTLE5',
    sender: player(99),
    changes: [
      change(`${GAME}::economy::EpochBoard`, {
        before: { epoch: '5', top: [{ player: player(1), score: '900000000000' }, { player: player(2), score: '700000000000' }] },
        after: { epoch: '6', top: [] },
      }),
      change(`${GAME}::economy::GameBank`, { before: { treasury: '400000000000' }, after: { treasury: '360123456789' } }),
      change(`${GAME}::economy::EpochPrize`, { created: true, after: { epoch: '5', awards: [{ tier: 0 }, { tier: 1 }], pot: '1' } }),
    ],
  }
}

export function sources(over: Partial<Sources> = {}): Sources {
  return {
    board: async () => ({ epoch: 6, endsAtMs: T5 + 7 * 24 * HOUR }),
    gameBank: async () => ({ treasury: 360n * U, totalMinted: 1_300 }),
    epochMinted: async (e) => (e === 5 ? 1_300 : e === 4 ? 1_200 : null),
    // The settle transaction above changes no rules, so the board's own field is what a round reads.
    currentRules: async () => ({
      value: {
        tiers: [
          { max_rank: '1', amount_per_slot: String(60n * U) },
          { max_rank: '3', amount_per_slot: String(30n * U) },
          { max_rank: '10', amount_per_slot: String(12n * U) },
          { max_rank: '20', amount_per_slot: String(6n * U) },
        ],
        buyback_bps: '800',
        span_ms: '604800000',
        standing_fee_sui: '500000000',
      },
    }),
    arena: async () => ({ stationed: 70, seeded: 18 }),
    distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 6, unallocated: 49_500n * U, holderUnallocated: 29_000n * U, pool: 78_500n * U }),
    governance: async () => ({ bootstrapped: true, firstBallotEpoch: 9, ballotsTableId: '0xtable' }),
    ballot: async () => null,
    operatorLock: async () => ({ balance: 15_000_000n * U }),
    balances: async () => ({ sui: 2n * U, wal: 9_990_000_000n }),
    burns: async () => [
      { digest: 'b1', timestampMs: T4 + 1, player: player(1), epoch: 5, burned: 100n * U, gained: 100n * U, newScore: 100n * U },
      { digest: 'b2', timestampMs: T4 + 2, player: player(1), epoch: 5, burned: 50n * U, gained: 40n * U, newScore: 140n * U },
      { digest: 'b3', timestampMs: T4 + 3, player: player(2), epoch: 5, burned: 70n * U, gained: 70n * U, newScore: 70n * U },
    ],
    settles: async () => [
      { digest: 'SETTLE4', timestampMs: T4, epoch: 4, extracted: 0n, awarded: 0n },
      { digest: 'SETTLE5', timestampMs: T5, epoch: 5, extracted: 40n * U, awarded: 40n * U - 1n },
    ],
    drains: async () => [T4 + 1, T4 + 2].map((t) => ({ digest: 'd', timestampMs: t })),
    emissions: async () => [{ digest: 'ADV5', epoch: 5, amount: 5_500n * U }],
    holderEmissions: async () => [{ digest: 'ADV5', epoch: 5, amount: 600n * U, count: 1_300 }],
    ballotsExecuted: async () => [],
    transaction: async () => settleTransaction(),
    ...over,
  }
}

/** A report that passes every check against epoch 5's facts above: 2 players, 3 burns. */
export const GOOD = {
  en: 'Epoch 5 closed with 2 players and 3 burns.',
  ja: 'シーズン 5 は参加者 2 人、スコアに変換した回数は 3 回でした。',
  cast: 'Epoch 5 closed with 2 players.',
  observations: [{ metric: 'players', direction: 'up', statement: 'Player count may keep growing.' }],
}

export function llm(...outputs: unknown[]): LlmProvider & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = []
  let served: string | null = null
  return {
    calls,
    // As the real provider: a model is named only once one has answered.
    servedModel: () => served,
    async generate(input) {
      calls.push(input)
      const next = outputs[Math.min(calls.length - 1, outputs.length - 1)]
      if (next instanceof Error) throw next
      served = 'claude-sonnet-5-5'
      return next
    },
  }
}

export function memory(): MemoryStore & { texts: string[]; failNext: number; readFails: boolean } {
  const m = {
    texts: [] as string[],
    failNext: 0,
    readFails: false,
    async remember(text: string) {
      if (m.failNext > 0) {
        m.failNext -= 1
        throw new Error('relay down')
      }
      m.texts.push(text)
      return { blobId: `mem-${m.texts.length}` }
    },
    async recall(query: string, limit: number) {
      if (m.readFails) throw new Error('relay down')
      return m.texts.map((text, i) => ({ text, blobId: `mem-${i + 1}` })).filter((r) => r.text.startsWith(query)).slice(-limit)
    },
    async count() {
      return m.texts.length
    },
  }
  return m
}

export function store(): ReportStore & { saved: { report: Report; saved: SavedReport }[]; failSaves: number; costWal: bigint; epochs: number } {
  const s = {
    saved: [] as { report: Report; saved: SavedReport }[],
    failSaves: 0,
    costWal: 540_000_000n,
    epochs: 53,
    url: (blobId: string) => `https://aggregator.example/v1/blobs/${blobId}`,
    async maxEpochs() {
      return s.epochs
    },
    async estimate() {
      return s.costWal
    },
    async save(report: Report) {
      if (s.failSaves > 0) {
        s.failSaves -= 1
        throw new Error('storage nodes did not answer')
      }
      const saved = { blobId: `blob-${s.saved.length + 1}`, objectId: `0xobject${s.saved.length + 1}`, endEpoch: 95, bytes: 1000 }
      s.saved.push({ report, saved })
      return saved
    },
    async read(blobId: string) {
      const found = s.saved.find((x) => x.saved.blobId === blobId)
      if (!found) throw new Error(`blob ${blobId} not found`)
      return found.report
    },
  }
  return s
}

export function notifier(): Notifier & { messages: string[] } {
  const n = {
    messages: [] as string[],
    async send(text: string) {
      n.messages.push(text)
    },
  }
  return n
}

export type Kit = ReturnType<typeof kit>

export function kit(
  over: { state?: Partial<State>; src?: Partial<Sources>; config?: Partial<RoundConfig>; llmOutputs?: unknown[]; now?: number } = {},
) {
  const stateStore = memoryStateStore({ ...initialState(4), ...over.state })
  const fakeMemory = memory()
  const fakeStore = store()
  const fakeNotifier = notifier()
  const fakeLlm = llm(...(over.llmOutputs ?? [GOOD]))
  const logs: string[] = []
  let now = over.now ?? NOW
  const deps: RoundDeps = {
    config: { requireApproval: true, useMemory: true, dryRun: false, ...over.config },
    nowMs: () => now,
    state: stateStore,
    src: sources(over.src),
    memory: fakeMemory,
    llm: fakeLlm,
    store: fakeStore,
    notifier: fakeNotifier,
    systemPrompt: 'SYSTEM PROMPT',
    log: (l) => logs.push(l),
  }
  return {
    deps,
    state: stateStore,
    memory: fakeMemory,
    store: fakeStore,
    notifier: fakeNotifier,
    llm: fakeLlm,
    logs,
    round: () => runRound(deps),
    advance: (ms: number) => {
      now += ms
    },
    setSources: (patch: Partial<Sources>) => {
      deps.src = { ...deps.src, ...patch }
    },
  }
}
