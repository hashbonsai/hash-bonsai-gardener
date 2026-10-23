import type { Signer } from '@mysten/sui/cryptography'
import { redact } from './redact'
import type { Report } from './report'

/**
 * Stores each report on Walrus as a blob that cannot be deleted, for as many
 * epochs as Walrus will sell at the time, and reads earlier reports back from
 * a public aggregator. The signer is the guarded one (`chain.ts`): it signs
 * only what a Walrus storage transaction contains.
 */

/** The slice of `WalrusClient` used here, so a test can stand in for it. */
export interface WalrusLike {
  writeBlob(options: { blob: Uint8Array; deletable: boolean; epochs: number; signer: Signer }): Promise<{
    blobId: string
    blobObject: { id: string; deletable: boolean; storage: { end_epoch: number } }
  }>
  storageCost(size: number, epochs: number): Promise<{ totalCost: bigint }>
  systemState(): Promise<{ future_accounting: { length: number } }>
}

export type SavedReport = { blobId: string; objectId: string; endEpoch: number; bytes: number }

export interface ReportStore {
  /** How many epochs ahead Walrus will sell storage now. */
  maxEpochs(): Promise<number>
  /** What storing `sizeBytes` for `epochs` costs, in WAL's smallest unit. */
  estimate(sizeBytes: number, epochs: number): Promise<bigint>
  save(report: Report, epochs: number): Promise<SavedReport>
  read(blobId: string): Promise<unknown>
  url(blobId: string): string
}

/** Large enough for any report; a bigger answer from the aggregator is not one of ours. */
const MAX_READ_BYTES = 2_000_000

export function walrusReportStore(deps: { walrus: WalrusLike; signer: Signer; aggregatorUrl: string; fetch?: typeof fetch }): ReportStore {
  const doFetch = deps.fetch ?? fetch
  const base = deps.aggregatorUrl.replace(/\/+$/, '')
  const url = (blobId: string) => `${base}/v1/blobs/${encodeURIComponent(blobId)}`

  return {
    url,
    async maxEpochs() {
      return (await deps.walrus.systemState()).future_accounting.length
    },
    async estimate(sizeBytes, epochs) {
      return (await deps.walrus.storageCost(sizeBytes, epochs)).totalCost
    },
    async save(report, epochs) {
      const bytes = new TextEncoder().encode(JSON.stringify(report))
      const { blobId, blobObject } = await deps.walrus.writeBlob({ blob: bytes, deletable: false, epochs, signer: deps.signer })
      // The audit record must not be deletable by anyone, the operator included. If the stored
      // object says otherwise, stop loudly; the report must not be treated as published.
      if (blobObject.deletable !== false) throw new Error(`the stored blob ${blobId} is deletable; it must not be`)
      return { blobId, objectId: blobObject.id, endEpoch: blobObject.storage.end_epoch, bytes: bytes.length }
    },
    async read(blobId) {
      const response = await doFetch(url(blobId))
      if (response.status === 404) throw new Error(`blob ${blobId} not found on the aggregator (stored long enough ago to have expired?)`)
      if (!response.ok) throw new Error(`the aggregator answered HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > MAX_READ_BYTES) throw new Error(`blob ${blobId} is larger than a report can be`)
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new Error(`blob ${blobId} is not JSON: ${redact(text.slice(0, 40))}`)
      }
    },
  }
}
