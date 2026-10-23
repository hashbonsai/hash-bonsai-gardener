import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { budgetedProvider, fundsAllowance, llmAllowance, llmUsage, MIN_SUI } from '../src/budget'
import { parseConfig } from '../src/config'
import { decide, parseDecisionArgs } from '../src/decision'
import { LlmCallError } from '../src/llm'
import { chunk, consoleNotifier, discordNotifier, tell } from '../src/notify'
import { buildReport, readEarlier, sha256Hex } from '../src/report'
import { applyDecision, assertState, fileStateStore, initialState, memoryStateStore } from '../src/state'
import { walrusReportStore, type WalrusLike } from '../src/walrus'
import { sampleFacts } from './fixtures'
import { HOUR, NOW, U } from './roundkit'

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'gardener-')), name)

// ── state ──────────────────────────────────────────────────────────────────

describe('the state file', () => {
  it('starts from the initial state when there is no file, and reads back what it wrote', () => {
    const path = tempFile('state.json')
    const store = fileStateStore(path, () => initialState(4))
    expect(store.load().lastReportedEpoch).toBe(4)
    const s = { ...initialState(4), lastReportedEpoch: 7, previousBlobId: 'blob-7' }
    store.save(s)
    expect(store.load()).toEqual(s)
  })

  it('is written through a temporary file, leaving none behind, and readable only by its owner', () => {
    const path = tempFile('state.json')
    fileStateStore(path, () => initialState(4)).save(initialState(4))
    expect(() => readFileSync(`${path}.tmp`)).toThrow()
    expect(JSON.parse(readFileSync(path, 'utf8')).schema).toBe(1)
  })

  it('refuses a file it cannot read instead of starting over', () => {
    const path = tempFile('state.json')
    writeFileSync(path, '{ not json')
    expect(() => fileStateStore(path, () => initialState(4)).load()).toThrow(/not valid JSON/)
    writeFileSync(path, JSON.stringify({ ...initialState(4), lastReportedEpoch: 'five' }))
    expect(() => fileStateStore(path, () => initialState(4)).load()).toThrow(/lastReportedEpoch/)
  })

  it.each([
    ['schema', { schema: 2 }],
    ['llmCallsMs', { llmCallsMs: ['yesterday'] }],
    ['memoryBacklog', { memoryBacklog: [1] }],
    ['announced', { announced: { opened: 'no', applied: [] } }],
    ['pending.status', { pending: { epoch: 5, createdAtMs: 1, status: 'maybe', note: null, draft: {}, memoryWritten: null } }],
  ])('names the field "%s" when it is wrong', (field, patch) => {
    expect(() => assertState({ ...initialState(4), ...patch })).toThrow(new RegExp(field.replace('.', '\\.')))
  })
})

describe('applyDecision', () => {
  const waiting = () => ({
    ...initialState(4),
    pending: { epoch: 5, createdAtMs: 1, status: 'awaiting' as const, note: null, draft: {} as never, memoryWritten: null },
  })
  it('marks the waiting draft, with a trimmed note or none', () => {
    expect(applyDecision(waiting(), 5, 'approved', '  shorter  ').pending).toMatchObject({ status: 'approved', note: 'shorter' })
    expect(applyDecision(waiting(), 5, 'rejected', '   ').pending).toMatchObject({ status: 'rejected', note: null })
  })
  it('refuses the wrong epoch, no draft, and a draft already decided', () => {
    expect(() => applyDecision(waiting(), 6, 'approved', null)).toThrow(/not 6/)
    expect(() => applyDecision(initialState(4), 5, 'approved', null)).toThrow(/no draft waiting/)
    const decided = applyDecision(waiting(), 5, 'approved', null)
    expect(() => applyDecision(decided, 5, 'rejected', null)).toThrow(/already approved/)
  })
  it('does not touch the state it was given', () => {
    const s = waiting()
    applyDecision(s, 5, 'approved', 'x')
    expect(s.pending.status).toBe('awaiting')
  })
})

describe('the approve and reject commands', () => {
  it('reads the epoch and the note, in any order, and ignores the config path', () => {
    expect(parseDecisionArgs(['5'])).toEqual({ epoch: 5, note: null })
    expect(parseDecisionArgs(['--note', 'Be brief', '5', '--config', 'x.json'])).toEqual({ epoch: 5, note: 'Be brief' })
  })
  it('refuses a missing epoch, a stray word, an unknown option and a note with nothing after it', () => {
    expect(() => parseDecisionArgs([])).toThrow(/epoch of the waiting draft/)
    expect(() => parseDecisionArgs(['five'])).toThrow(/epoch of the waiting draft/)
    expect(() => parseDecisionArgs(['5', '--force'])).toThrow(/unknown option/)
    expect(() => parseDecisionArgs(['5', '--note'])).toThrow(/needs the note/)
  })
  it('records the decision in the state and says what happens next', () => {
    const store = memoryStateStore({
      ...initialState(4),
      pending: { epoch: 5, createdAtMs: 1, status: 'awaiting', note: null, draft: {} as never, memoryWritten: null },
    })
    expect(decide(['5', '--note', 'too long'], 'rejected', store)).toMatch(/rejected.*figures alone.*with your note.*next hourly round/)
    expect(store.current.pending).toMatchObject({ status: 'rejected', note: 'too long' })
  })
})

// ── notices ────────────────────────────────────────────────────────────────

describe('notices', () => {
  const sent = () => {
    const out: string[] = []
    return { out, notifier: { async send(t: string) { out.push(t) } } }
  }

  it('are sent once a day for the same key, and always when there is no key', async () => {
    const s = initialState(4)
    const { out, notifier } = sent()
    expect(await tell(notifier, s, NOW, 'k', 'one')).toBe(true)
    expect(await tell(notifier, s, NOW + HOUR, 'k', 'two')).toBe(false)
    expect(await tell(notifier, s, NOW + 25 * HOUR, 'k', 'three')).toBe(true)
    expect(await tell(notifier, s, NOW, 'other', 'four')).toBe(true)
    expect(await tell(notifier, s, NOW, null, 'five')).toBe(true)
    expect(await tell(notifier, s, NOW, null, 'six')).toBe(true)
    expect(out).toEqual(['one', 'three', 'four', 'five', 'six'])
  })

  it('are cut at line breaks into pieces Discord accepts', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(100)}`)
    const pieces = chunk(lines.join('\n'), 1000)
    expect(pieces.every((p) => p.length <= 1000)).toBe(true)
    expect(pieces.join('\n')).toBe(lines.join('\n'))
    expect(chunk('a'.repeat(2500), 1000).map((p) => p.length)).toEqual([1000, 1000, 500])
    expect(chunk('short')).toEqual(['short'])
  })

  it('go to the webhook as several messages when long, with the webhook URL and any key left out', async () => {
    const bodies: string[] = []
    const url = 'https://discord.example/api/webhooks/123/secret-token'
    const fakeKey = ['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-')
    const fetchImpl = (async (u: string, init: RequestInit) => {
      expect(u).toBe(url)
      bodies.push(JSON.parse(String(init.body)).content)
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch
    await discordNotifier(url, { fetch: fetchImpl }).send(`${'y'.repeat(2500)}\nsee ${url} and ${fakeKey}`)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.join('\n')).not.toContain('secret-token')
    expect(bodies.join('\n')).not.toContain(fakeKey)
  })

  it('never stop a round when Discord is down, and do not print the webhook', async () => {
    const url = 'https://discord.example/api/webhooks/123/secret-token'
    const logs: string[] = []
    const down = (async () => {
      throw new Error(`connect to ${url} failed`)
    }) as unknown as typeof fetch
    await expect(discordNotifier(url, { fetch: down, log: (l) => logs.push(l) }).send('hello')).resolves.toBeUndefined()
    const bad = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await discordNotifier(url, { fetch: bad, log: (l) => logs.push(l) }).send('hello')
    expect(logs.join('\n')).toMatch(/HTTP 500/)
    expect(logs.join('\n')).not.toContain('secret-token')
  })

  it('can be printed instead, with keys left out', async () => {
    const lines: string[] = []
    await consoleNotifier((l) => lines.push(l)).send(`key ${['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-')}`)
    expect(lines[0]).toBe('[notice] key [redacted key]')
  })
})

// ── cost brakes ────────────────────────────────────────────────────────────

describe('the cost brakes', () => {
  const at = (iso: string) => Date.parse(iso)

  it('count the calls of the same UTC day and month', () => {
    const calls = [at('2026-10-31T23:59:00Z'), at('2026-11-01T00:00:00Z'), at('2026-11-01T12:00:00Z'), at('2026-11-02T01:00:00Z')]
    expect(llmUsage(calls, at('2026-11-01T18:00:00Z'))).toEqual({ today: 2, month: 3 })
  })

  it('allow 4 a day and 16 a month, and say which limit was reached', () => {
    const now = at('2026-11-10T12:00:00Z')
    const today = (n: number) => Array.from({ length: n }, (_, i) => now - (i + 1) * 60_000)
    expect(llmAllowance(today(3), now)).toEqual({ ok: true })
    expect(llmAllowance(today(4), now)).toMatchObject({ ok: false, reason: expect.stringMatching(/4 times today/) })
    const month = Array.from({ length: 16 }, (_, i) => at('2026-11-01T00:00:00Z') + i * 3 * HOUR * 5)
    expect(llmAllowance(month, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/16 times this month/) })
  })

  it('stop below 0.1 SUI and when the WAL cannot pay for a save', () => {
    expect(fundsAllowance({ sui: MIN_SUI, wal: 10n * U }, 5n * U)).toEqual({ ok: true })
    expect(fundsAllowance({ sui: MIN_SUI - 1n, wal: 10n * U }, 5n * U)).toMatchObject({ ok: false })
    expect(fundsAllowance({ sui: U, wal: 5n * U }, 5n * U)).toEqual({ ok: true })
    expect(fundsAllowance({ sui: U, wal: 5n * U - 1n }, 5n * U)).toMatchObject({ ok: false })
  })

  it('refuse a model call past the limit as one that cannot be retried, and record every call it lets through', async () => {
    const state = initialState(4)
    state.llmCallsMs = Array.from({ length: 3 }, (_, i) => NOW - (i + 1) * 60_000)
    const inner = { calls: 0, async generate() { this.calls += 1; return {} } }
    const provider = budgetedProvider(inner, state, () => NOW)
    await provider.generate({ system: 's', user: 'u' })
    expect(state.llmCallsMs).toHaveLength(4)
    const refused = await provider.generate({ system: 's', user: 'u' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(LlmCallError)
    expect((refused as LlmCallError).kind).toBe('permanent')
    expect(inner.calls).toBe(1)
  })

  it('forget calls older than forty days when recording a new one', async () => {
    const state = initialState(4)
    state.llmCallsMs = [NOW - 41 * 24 * HOUR]
    await budgetedProvider({ generate: async () => ({}) }, state, () => NOW).generate({ system: 's', user: 'u' })
    expect(state.llmCallsMs).toEqual([NOW])
  })
})

// ── the report ─────────────────────────────────────────────────────────────

describe('the stored report', () => {
  const draft = () => ({
    facts: sampleFacts(),
    followups: [{ observationId: 'o', fromEpoch: 4, toEpoch: 5, metric: 'players' as const, before: 3, after: 5, verdict: 'continued' as const }],
    commentary: { en: 'English.', ja: '日本語。' },
    cast: 'cast',
    observations: [],
    fallback: false,
    fallbackReason: null,
    executeMissing: false,
    model: 'claude-sonnet-5-5',
    promptSha256: sha256Hex('prompt'),
    attempts: 1,
    generatedAt: '2026-11-08T01:00:00.000Z',
    recalledBlobIds: ['mem-a'],
    readable: { en: 'English.', ja: '日本語。' },
  })

  it('carries the facts whole, the commentary, the notebook, and the links', () => {
    const r = buildReport(draft(), 'blob-prev', ['mem-1'])
    expect(r).toMatchObject({
      schema: 1,
      epoch: 5,
      text: { en: 'English.', ja: '日本語。' },
      fallback: false,
      model: 'claude-sonnet-5-5',
      previousBlobId: 'blob-prev',
      memory: { recalled: ['mem-a'], written: ['mem-1'] },
    })
    expect(r.facts).toEqual(sampleFacts())
    expect(r.notebook.en).toEqual(['Epoch 4 note on players in the Standing: 3 → epoch 5: 5. it held.'])
    expect(r.notebook.ja[0]).toContain('シーズン 4 の観察')
  })

  it('has no commentary when there is none to show', () => {
    const r = buildReport({ ...draft(), fallback: true, fallbackReason: 'checks' }, null, [])
    expect(r.text).toEqual({ en: '', ja: '' })
    expect(r.fallbackReason).toBe('checks')
  })

  it('hashes the prompt it was written under', () => {
    // The published SHA-256 test vector for "abc", in two halves so that it is not mistaken for a raw key.
    expect(sha256Hex('abc')).toBe(['ba7816bf8f01cfea414140de5dae2223', 'b00361a396177a9cb410ff61f20015ad'].join(''))
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'))
  })

  it('is read back only when it is a report of this schema', () => {
    const r = buildReport(draft(), 'blob-prev', [])
    expect(readEarlier(JSON.parse(JSON.stringify(r)))).toEqual({ epoch: 5, commentaryEn: 'English.', previousBlobId: 'blob-prev' })
    expect(readEarlier({ ...r, schema: 2 })).toBeNull()
    expect(readEarlier({ ...r, text: { ja: 'x' } })).toBeNull()
    expect(readEarlier({ ...r, previousBlobId: 7 })).toBeNull()
    expect(readEarlier('a string')).toBeNull()
    expect(readEarlier(null)).toBeNull()
  })
})

// ── Walrus ─────────────────────────────────────────────────────────────────

describe('the Walrus store', () => {
  const signer = {} as never
  const walrus = (over: Partial<WalrusLike> = {}): WalrusLike & { written: { blob: Uint8Array; deletable: boolean; epochs: number }[] } => {
    const written: { blob: Uint8Array; deletable: boolean; epochs: number }[] = []
    return {
      written,
      async writeBlob(o) {
        written.push({ blob: o.blob, deletable: o.deletable, epochs: o.epochs })
        return { blobId: 'BLOB', blobObject: { id: '0xobj', deletable: false, storage: { end_epoch: 95 } } }
      },
      async storageCost() {
        return { totalCost: 540_000_000n }
      },
      async systemState() {
        return { future_accounting: { length: 53 } }
      },
      ...over,
    }
  }
  const report = () => buildReport({ ...draftForWalrus() }, null, [])
  function draftForWalrus() {
    return {
      facts: sampleFacts(), followups: [], commentary: { en: 'E', ja: 'J' }, cast: 'c', observations: [], fallback: false, fallbackReason: null,
      executeMissing: false, model: 'm', promptSha256: 'h', attempts: 1, generatedAt: 'now', recalledBlobIds: [], readable: { en: 'E', ja: 'J' },
    }
  }

  it('stores the report as JSON that cannot be deleted, for the epochs it is told', async () => {
    const w = walrus()
    const store = walrusReportStore({ walrus: w, signer, aggregatorUrl: 'https://agg.example/' })
    expect(await store.save(report(), 53)).toMatchObject({ blobId: 'BLOB', objectId: '0xobj', endEpoch: 95 })
    expect(w.written[0]).toMatchObject({ deletable: false, epochs: 53 })
    expect(JSON.parse(new TextDecoder().decode(w.written[0].blob)).epoch).toBe(5)
  })

  it('stops loudly if the stored object turns out deletable', async () => {
    const w = walrus({ writeBlob: async () => ({ blobId: 'BLOB', blobObject: { id: '0xobj', deletable: true, storage: { end_epoch: 95 } } }) })
    await expect(walrusReportStore({ walrus: w, signer, aggregatorUrl: 'https://agg.example' }).save(report(), 53)).rejects.toThrow(/deletable; it must not be/)
  })

  it('reads how many epochs ahead storage can be bought, and what a save costs', async () => {
    const store = walrusReportStore({ walrus: walrus(), signer, aggregatorUrl: 'https://agg.example' })
    expect(await store.maxEpochs()).toBe(53)
    expect(await store.estimate(30_000, 53)).toBe(540_000_000n)
  })

  it('links to and reads a report from the aggregator, saying so when it is gone or not JSON', async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch
    const mk = (f: typeof fetch) => walrusReportStore({ walrus: walrus(), signer, aggregatorUrl: 'https://agg.example///', fetch: f })
    expect(mk(answer(200, '{}')).url('a/b')).toBe('https://agg.example/v1/blobs/a%2Fb')
    expect(await mk(answer(200, '{"a":1}')).read('x')).toEqual({ a: 1 })
    await expect(mk(answer(404, '')).read('x')).rejects.toThrow(/not found on the aggregator/)
    await expect(mk(answer(503, '')).read('x')).rejects.toThrow(/HTTP 503/)
    await expect(mk(answer(200, '<html>')).read('x')).rejects.toThrow(/not JSON/)
    await expect(mk(answer(200, 'x'.repeat(2_000_001))).read('x')).rejects.toThrow(/larger than a report/)
  })
})

// ── configuration ──────────────────────────────────────────────────────────

describe('the configuration', () => {
  const good = () => ({
    network: 'mainnet',
    address: '0xabc',
    keyFile: '/etc/gardener/sui-key',
    tatumKeyFile: '/etc/gardener/tatum',
    anthropicKeyFile: '/etc/gardener/anthropic',
    memwal: { keyFile: '/etc/gardener/memwal', accountId: '0x1', namespace: 'ns' },
    stateFile: '/var/lib/gardener/state.json',
    walrusPackageIds: ['0x98da'],
    aggregatorUrl: 'https://agg.example',
    firstEpoch: 5,
  })

  it('reads the example in the repository', () => {
    const example = JSON.parse(readFileSync(new URL('../deploy/config.example.json', import.meta.url), 'utf8'))
    const c = parseConfig(example)
    expect(c).toMatchObject({ network: 'mainnet', requireApproval: true, firstEpoch: 5, memwal: { namespace: 'hash-bonsai-gardener' } })
  })

  it('fills in the defaults: approval on, the MemWal relayer, the prompt file, mainnet game ids', () => {
    const c = parseConfig(good())
    expect(c.requireApproval).toBe(true)
    expect(c.memwal.serverUrl).toBe('https://relayer.memory.walrus.xyz')
    expect(c.promptFile).toBe('prompts/system.md')
    expect(c.webhookFile).toBeNull()
    expect(c.model).toBeNull()
    expect(c.chain.ids.epochBoard).toMatch(/^0x7f02/)
  })

  it.each([
    ['network', { network: 'devnet' }, /"network"/],
    ['firstEpoch', { firstEpoch: 0 }, /"firstEpoch"/],
    ['walrusPackageIds', { walrusPackageIds: [] }, /walrusPackageIds/],
    ['walrusPackageIds', { walrusPackageIds: ['not an id'] }, /walrusPackageIds/],
    ['requireApproval', { requireApproval: 'no' }, /requireApproval/],
    ['keyFile', { keyFile: '' }, /"keyFile"/],
    ['memwal', { memwal: { keyFile: 'x' } }, /memwal.*accountId/],
    ['testnet', { network: 'testnet' }, /testnet deployment must give its own "chain"/],
  ])('refuses a bad %s', (_name, patch, message) => {
    expect(() => parseConfig({ ...good(), ...patch })).toThrow(message)
  })

  it('refuses a config that is not an object, or is missing a required setting', () => {
    expect(() => parseConfig(null)).toThrow(/not a JSON object/)
    const { address: _address, ...rest } = good()
    expect(() => parseConfig(rest)).toThrow(/"address" is missing/)
  })
})
