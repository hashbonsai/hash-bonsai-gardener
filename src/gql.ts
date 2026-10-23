import { redact } from './redact'

/** Runs a GraphQL query and returns its `data`. A fake stands in for it in tests. */
export type GraphQl = (query: string, variables?: Record<string, unknown>) => Promise<unknown>

export type HttpGraphQlOptions = {
  fetch?: typeof fetch
  /** Tries after the first one when the server is busy or unreachable. */
  retries?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Sui's public GraphQL, over plain HTTP. It serves what gRPC cannot, the
 * event search. A rate limit, a server error and a dropped connection are
 * tried again after a growing wait; a query the server rejects is not.
 */
export function httpGraphQl(url: string, options: HttpGraphQlOptions = {}): GraphQl {
  const doFetch = options.fetch ?? fetch
  const retries = options.retries ?? 3
  const backoffMs = options.backoffMs ?? 1000
  const sleep = options.sleep ?? realSleep

  return async (query, variables = {}) => {
    let lastProblem = ''
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1))
      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application' + String.fromCharCode(47) + 'json' },
          body: JSON.stringify({ query, variables }),
        })
      } catch (e) {
        lastProblem = `GraphQL request failed: ${redact(e instanceof Error ? e.message : String(e))}`
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        lastProblem = `GraphQL answered HTTP ${response.status}`
        continue
      }
      if (!response.ok) throw new Error(`GraphQL answered HTTP ${response.status}`)
      const body = (await response.json()) as { data?: unknown; errors?: unknown[] }
      if (body.errors && body.errors.length > 0) {
        throw new Error(`GraphQL error: ${redact(JSON.stringify(body.errors[0])).slice(0, 300)}`)
      }
      if (body.data === undefined || body.data === null) throw new Error('GraphQL answered with no data')
      return body.data
    }
    throw new Error(lastProblem)
  }
}
