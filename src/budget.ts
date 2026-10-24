import { LlmCallError, type LlmProvider } from './llm'
import type { State } from './state'

/**
 * The cost brakes. A language model runaway or an empty wallet must stop the
 * gardener quietly rather than spend: the model is called at most 4 times a
 * day and 16 a month (UTC), and nothing is stored or posted unless the
 * gardener's address holds at least 0.1 SUI and enough WAL for one save.
 */

export type LlmLimits = { perDay: number; perMonth: number }
export const LLM_LIMITS: LlmLimits = { perDay: 4, perMonth: 16 }
/** 0.1 SUI, in MIST. */
export const MIN_SUI = 100_000_000n

const DAY_MS = 24 * 60 * 60 * 1000
/** Calls older than this are of no use to the counters. */
const KEEP_MS = 40 * DAY_MS

const sameUtcDay = (a: number, b: number) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10)
const sameUtcMonth = (a: number, b: number) => new Date(a).toISOString().slice(0, 7) === new Date(b).toISOString().slice(0, 7)

export function llmUsage(callsMs: number[], nowMs: number): { today: number; month: number } {
  return { today: callsMs.filter((t) => sameUtcDay(t, nowMs)).length, month: callsMs.filter((t) => sameUtcMonth(t, nowMs)).length }
}

export type Allowance = { ok: true } | { ok: false; reason: string }

export function llmAllowance(callsMs: number[], nowMs: number, limits: LlmLimits = LLM_LIMITS): Allowance {
  const u = llmUsage(callsMs, nowMs)
  if (u.today >= limits.perDay) return { ok: false, reason: `the model has been called ${u.today} times today (the limit is ${limits.perDay} a day)` }
  if (u.month >= limits.perMonth) return { ok: false, reason: `the model has been called ${u.month} times this month (the limit is ${limits.perMonth} a month)` }
  return { ok: true }
}

/** Whether the gardener's address can pay for one save and the gas around it. */
export function fundsAllowance(balances: { sui: bigint; wal: bigint }, storageCostWal: bigint): Allowance {
  if (balances.sui < MIN_SUI) return { ok: false, reason: `the gardener holds ${Number(balances.sui) / 1e9} SUI, below the 0.1 SUI floor` }
  if (balances.wal < storageCostWal) {
    return { ok: false, reason: `the gardener holds ${Number(balances.wal) / 1e9} WAL and one save costs about ${Number(storageCostWal) / 1e9} WAL` }
  }
  return { ok: true }
}

/**
 * Counts every call the model is asked for, in `state`, and refuses one past a
 * limit. A refusal is permanent for the writer (retrying today is no use), so
 * the report falls back to the figures instead of looping.
 */
export function budgetedProvider(inner: LlmProvider, state: State, nowMs: () => number, limits: LlmLimits = LLM_LIMITS): LlmProvider {
  return {
    servedModel: () => inner.servedModel?.() ?? null,
    async generate(input) {
      const now = nowMs()
      const allowance = llmAllowance(state.llmCallsMs, now, limits)
      if (!allowance.ok) throw new LlmCallError(`call refused: ${allowance.reason}`, 'permanent')
      state.llmCallsMs = [...state.llmCallsMs.filter((t) => now - t < KEEP_MS), now]
      return inner.generate(input)
    },
  }
}
