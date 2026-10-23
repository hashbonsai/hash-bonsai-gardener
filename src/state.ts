import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { FallbackReason } from './templates'
import type { EditorNote, Facts, Followup, Observation } from './types'

/**
 * What the gardener remembers between rounds, in one JSON file next to the
 * service. It holds public things only (facts, text, blob ids, counters); the
 * keys live in their own files. A file that cannot be read is an error, not a
 * fresh start: starting over would write an epoch twice.
 */

export const STATE_SCHEMA = 1

/** A report the gardener has composed and not yet published. */
export type Draft = {
  facts: Facts
  followups: Followup[]
  /** The commentary; empty strings when `fallback`. */
  commentary: { en: string; ja: string }
  cast: string
  observations: Observation[]
  fallback: boolean
  fallbackReason: FallbackReason | null
  executeMissing: boolean
  model: string
  promptSha256: string
  attempts: number
  generatedAt: string
  /** The memories this report drew on (MemWal blob ids). */
  recalledBlobIds: string[]
  /** The text of the draft as the operator reads it. */
  readable: { en: string; ja: string }
}

export type Pending = {
  epoch: number
  createdAtMs: number
  /** `awaiting`: a person has not looked yet. `approved`/`rejected`: they have; a rejected draft is published as figures only. */
  status: 'awaiting' | 'approved' | 'rejected'
  /** The operator's note from `approve` or `reject`; it becomes a memory that shapes later reports. */
  note: string | null
  draft: Draft
  /** MemWal blob ids of the memories already written for this draft, so a retry does not write them twice. */
  memoryWritten: string[] | null
}

export type PublishedReport = { epoch: number; blobId: string; objectId: string; endEpoch: number; savedAtMs: number }

export type State = {
  schema: typeof STATE_SCHEMA
  lastReportedEpoch: number
  /** The Walrus blob id of the last report, which the next one links back to. */
  previousBlobId: string | null
  pending: Pending | null
  /** When each language-model call was made, for the daily and monthly limits. */
  llmCallsMs: number[]
  /** When this gardener first saw an epoch final, keyed by epoch, for the six-hour notices. */
  firstSeenFinalMs: Record<string, number>
  /** When a notice with this key was last sent, so the same problem is told once a day. */
  notifiedMs: Record<string, number>
  /** Memory records that could not be written and are tried again next round. */
  memoryBacklog: string[]
  /** The balances at the last report, to work out what a round cost. */
  lastBalances: { sui: string; wal: string } | null
  reports: PublishedReport[]
  /** Ballot announcements already made, so each is made once. */
  announced: { opened: number[]; applied: number[] }
}

export function initialState(lastReportedEpoch: number): State {
  return {
    schema: STATE_SCHEMA,
    lastReportedEpoch,
    previousBlobId: null,
    pending: null,
    llmCallsMs: [],
    firstSeenFinalMs: {},
    notifiedMs: {},
    memoryBacklog: [],
    lastBalances: null,
    reports: [],
    announced: { opened: [], applied: [] },
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numberList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum)

/** Throws, naming the field, unless `value` has the shape of a state. A hand-edited or damaged file stops the round. */
export function assertState(value: unknown): asserts value is State {
  if (!isRecord(value)) throw new Error('the state file is not a JSON object')
  const bad = (field: string): never => {
    throw new Error(`the state file's "${field}" is missing or the wrong shape`)
  }
  if (value.schema !== STATE_SCHEMA) bad('schema')
  if (!Number.isInteger(value.lastReportedEpoch)) bad('lastReportedEpoch')
  if (value.previousBlobId !== null && typeof value.previousBlobId !== 'string') bad('previousBlobId')
  if (!numberList(value.llmCallsMs)) bad('llmCallsMs')
  if (!isRecord(value.firstSeenFinalMs)) bad('firstSeenFinalMs')
  if (!isRecord(value.notifiedMs)) bad('notifiedMs')
  if (!Array.isArray(value.memoryBacklog) || !value.memoryBacklog.every((t) => typeof t === 'string')) bad('memoryBacklog')
  if (!Array.isArray(value.reports)) bad('reports')
  if (!isRecord(value.announced) || !numberList(value.announced.opened) || !numberList(value.announced.applied)) bad('announced')
  const p = value.pending
  if (p !== null) {
    if (!isRecord(p) || !Number.isInteger(p.epoch) || !isNum(p.createdAtMs)) bad('pending')
    const pending = p as Record<string, unknown>
    if (pending.status !== 'awaiting' && pending.status !== 'approved' && pending.status !== 'rejected') bad('pending.status')
    if (pending.note !== null && typeof pending.note !== 'string') bad('pending.note')
    if (!isRecord(pending.draft)) bad('pending.draft')
    if (pending.memoryWritten !== null && !(Array.isArray(pending.memoryWritten) && pending.memoryWritten.every((b) => typeof b === 'string'))) bad('pending.memoryWritten')
  }
}

export interface StateStore {
  load(): State
  save(state: State): void
}

/** The state in a file. A missing file starts from `initial`; a damaged one throws. Writes go through a temporary file and a rename, so a crash leaves the old state whole. */
export function fileStateStore(path: string, initial: () => State): StateStore {
  return {
    load() {
      if (!existsSync(path)) return initial()
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        throw new Error('the state file is not valid JSON; fix or move it rather than start over, which would write an epoch twice')
      }
      assertState(parsed)
      return parsed
    },
    save(state) {
      const temp = `${path}.tmp`
      writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      renameSync(temp, path)
    },
  }
}

/** For tests and dry runs: a state held in memory. */
export function memoryStateStore(initial: State): StateStore & { current: State } {
  let current = structuredClone(initial)
  return {
    get current() {
      return current
    },
    load: () => structuredClone(current),
    save: (s) => {
      current = structuredClone(s)
    },
  }
}

export function noteOf(pending: Pending, epoch: number): EditorNote | null {
  return pending.note ? { epoch, note: pending.note } : null
}

/**
 * Marks the waiting draft approved or rejected, with the operator's note. It
 * must be the draft for `epoch` and must still be waiting: a decision is made
 * once, and the next round carries it out.
 */
export function applyDecision(state: State, epoch: number, status: 'approved' | 'rejected', note: string | null): State {
  const p = state.pending
  if (!p) throw new Error('there is no draft waiting for a decision')
  if (p.epoch !== epoch) throw new Error(`the draft waiting is for epoch ${p.epoch}, not ${epoch}`)
  if (p.status !== 'awaiting') throw new Error(`epoch ${epoch}'s draft was already ${p.status}`)
  return { ...state, pending: { ...p, status, note: note && note.trim() ? note.trim() : null } }
}
