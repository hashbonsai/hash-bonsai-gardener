import { RpcError, UnaryCall, type MethodInfo, type NextUnaryFn } from '@protobuf-ts/runtime-rpc'
import { describe, expect, it } from 'vitest'
import { isRateLimited, throttleInterceptor, type ThrottleOptions } from '../src/throttle'

const method = { name: 'GetBalance', localName: 'getBalance', service: { typeName: 'T', methods: [], options: {} }, options: {}, I: {}, O: {} } as unknown as MethodInfo

function ok(value: string): UnaryCall {
  return new UnaryCall(method, {}, {}, Promise.resolve({}), Promise.resolve(value), Promise.resolve({ code: 'OK', detail: '' }), Promise.resolve({}))
}
function failing(error: RpcError): UnaryCall {
  const response = Promise.reject(error)
  response.catch(() => {})
  return new UnaryCall(method, {}, {}, Promise.resolve({}), response, Promise.resolve({ code: error.code, detail: '' }), Promise.resolve({}))
}

/** A clock that only moves when the code sleeps, so spacing and backoff are exact. */
function clock() {
  let t = 1_000
  const slept: number[] = []
  return {
    slept,
    options: (over: Partial<ThrottleOptions> = {}): ThrottleOptions => ({
      minIntervalMs: 400,
      maxRetries: 3,
      backoffMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms)
        t += ms
      },
      ...over,
    }),
  }
}

const limited = () => new RpcError('Received HTTP status code 429', 'UNAVAILABLE')

describe('isRateLimited', () => {
  it('recognises a 429 reported by the gRPC client, and RESOURCE_EXHAUSTED', () => {
    expect(isRateLimited(limited())).toBe(true)
    expect(isRateLimited(new RpcError('quota', 'RESOURCE_EXHAUSTED'))).toBe(true)
  })
  it('does not treat other errors as rate limits', () => {
    expect(isRateLimited(new RpcError('Received HTTP status code 401', 'UNAUTHENTICATED'))).toBe(false)
    expect(isRateLimited(new RpcError('object 4290 not found', 'NOT_FOUND'))).toBe(false)
    expect(isRateLimited(new Error('429'))).toBe(false)
  })
})

describe('throttleInterceptor', () => {
  const run = (c: ReturnType<typeof clock>, next: NextUnaryFn, over?: Partial<ThrottleOptions>) =>
    throttleInterceptor(c.options(over)).interceptUnary!(next, method, {}, {})

  it('passes a good answer through', async () => {
    const c = clock()
    expect((await run(c, () => ok('hello')).response)).toBe('hello')
  })

  it('spaces calls that arrive together', async () => {
    const interceptor = throttleInterceptor({ minIntervalMs: 40, maxRetries: 0, backoffMs: 1 })
    const startedAt: number[] = []
    const next: NextUnaryFn = () => (startedAt.push(Date.now()), ok('x'))
    const calls = [1, 2, 3].map(() => interceptor.interceptUnary!(next, method, {}, {}))
    await Promise.all(calls.map((call) => call.response))
    expect(startedAt).toHaveLength(3)
    // setTimeout can fire a millisecond early; a gap of at least 35 of 40 shows they were spaced.
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(35)
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(35)
  })

  it('tries a rate-limited call again after growing waits, then succeeds', async () => {
    const c = clock()
    let n = 0
    const next: NextUnaryFn = () => (++n < 3 ? failing(limited()) : ok('finally'))
    expect(await run(c, next).response).toBe('finally')
    expect(n).toBe(3)
    expect(c.slept.filter((ms) => ms >= 1000)).toEqual([1000, 2000])
  })

  it('reports each wait it takes after a rate limit', async () => {
    const c = clock()
    const seen: Array<{ attempt: number; waitMs: number }> = []
    let n = 0
    const next: NextUnaryFn = () => (++n < 3 ? failing(limited()) : ok('finally'))
    await run(c, next, { onRetry: (info) => seen.push(info) }).response
    expect(seen).toEqual([{ attempt: 1, waitMs: 1000 }, { attempt: 2, waitMs: 2000 }])
  })

  it('gives up after the retries and passes the 429 on unchanged', async () => {
    const c = clock()
    let n = 0
    const next: NextUnaryFn = () => (n++, failing(limited()))
    await expect(run(c, next, { maxRetries: 2 }).response).rejects.toThrow(/429/)
    expect(n).toBe(3)
  })

  it('does not retry an error that is not a rate limit', async () => {
    const c = clock()
    let n = 0
    const next: NextUnaryFn = () => (n++, failing(new RpcError('Received HTTP status code 401', 'UNAUTHENTICATED')))
    await expect(run(c, next).response).rejects.toThrow(/401/)
    expect(n).toBe(1)
  })
})
