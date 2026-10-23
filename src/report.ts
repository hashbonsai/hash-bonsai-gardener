import { createHash } from 'node:crypto'
import { notebookLines } from './templates'
import type { FallbackReason } from './templates'
import type { Draft } from './state'
import type { Facts } from './types'

/**
 * The report as it is stored on Walrus, and how an earlier one is read back.
 * The stored facts keep every digit the chain gave; only what a reader sees
 * and what the model is shown is rounded.
 */

export const REPORT_SCHEMA = 1

export type Report = {
  schema: typeof REPORT_SCHEMA
  epoch: number
  generatedAt: string
  facts: Facts
  /** The commentary the model wrote; empty strings when the report has none (`fallback`). */
  text: { en: string; ja: string }
  /** The notebook: what became of the earlier observations, worked out by code. */
  notebook: { en: string[]; ja: string[] }
  fallback: boolean
  fallbackReason: FallbackReason | null
  /** True when the epoch ran a ballot whose result was never applied in time: the report carries none. */
  executeMissing: boolean
  model: string
  /** The SHA-256 of the system prompt it was written under. */
  promptSha256: string
  previousBlobId: string | null
  memory: { recalled: string[]; written: string[] }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

export function buildReport(draft: Draft, previousBlobId: string | null, memoryWritten: string[]): Report {
  return {
    schema: REPORT_SCHEMA,
    epoch: draft.facts.epoch,
    generatedAt: draft.generatedAt,
    facts: draft.facts,
    text: draft.fallback ? { en: '', ja: '' } : draft.commentary,
    notebook: { en: notebookLines(draft.followups, 'en'), ja: notebookLines(draft.followups, 'ja') },
    fallback: draft.fallback,
    fallbackReason: draft.fallbackReason,
    executeMissing: draft.executeMissing,
    model: draft.model,
    promptSha256: draft.promptSha256,
    previousBlobId,
    memory: { recalled: draft.recalledBlobIds, written: memoryWritten },
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What an earlier report is read for: its epoch, its English commentary and the
 * link to the one before it. Null if what was fetched is not a report of this
 * schema; the gardener then goes without it rather than pass a stranger's
 * text to the model.
 */
export function readEarlier(value: unknown): { epoch: number; commentaryEn: string; previousBlobId: string | null } | null {
  if (!isRecord(value) || value.schema !== REPORT_SCHEMA) return null
  if (!Number.isInteger(value.epoch) || !isRecord(value.text) || typeof value.text.en !== 'string') return null
  if (value.previousBlobId !== null && typeof value.previousBlobId !== 'string') return null
  return { epoch: value.epoch as number, commentaryEn: value.text.en, previousBlobId: value.previousBlobId as string | null }
}
