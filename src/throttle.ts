import { RpcError, UnaryCall, type RpcInterceptor } from '@protobuf-ts/runtime-rpc'

export type ThrottleOptions = {
  /** Smallest gap between two calls leaving this process. */
  minIntervalMs: number
  /** How many times a rate-limited call is tried again before its error is passed on. */
  maxRetries: number
  /** First wait after a rate-limit answer; doubles each time. */
  backoffMs: number
  /** Called before each wait that follows a rate-limit answer, so a run can say it is waiting. */
  onRetry?: (info: { attempt: number; waitMs: number }) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Tatum's free plan allows 3 requests per second and answers more with HTTP
 * 429, which the gRPC client reports as an error whose message names the
 * status. 2.5 per second stays under it.
 */
export const TATUM_THROTTLE: ThrottleOptions = { minIntervalMs: 400, maxRetries: 4, backoffMs: 1000 }

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  return error.code === 'RESOURCE_EXHAUSTED' || /\b429\b/.test(error.message)
}

/**
 * Spaces unary calls out and tries a rate-limited call again after a growing
 * wait. Any other error, and the last rate-limit error, reach the caller
 * unchanged.
 */
export function throttleInterceptor(options: ThrottleOptions): RpcInterceptor {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? realSleep
  let nextSlot = 0

  async function take(): Promise<void> {
    const slot = Math.max(now(), nextSlot)
    nextSlot = slot + options.minIntervalMs
    const wait = slot - now()
    if (wait > 0) await sleep(wait)
  }

  return {
    interceptUnary(next, method, input, requestOptions) {
      // The call is boxed: a `UnaryCall` is thenable, so returning it bare from an
      // async function would wait for it and turn a failed call into a rejection here.
      const settled = (async (): Promise<{ call: UnaryCall }> => {
        for (let attempt = 0; ; attempt++) {
          await take()
          const call = next(method, input, requestOptions)
          try {
            await call.response
            return { call }
          } catch (e) {
            if (attempt >= options.maxRetries || !isRateLimited(e)) return { call }
            const waitMs = options.backoffMs * 2 ** attempt
            options.onRetry?.({ attempt: attempt + 1, waitMs })
            await sleep(waitMs)
          }
        }
      })()
      // On failure every part of the call rejects, but callers read only
      // `response`; the others get a no-op handler so they do not surface as
      // unhandled rejections.
      const part = <T>(pick: (call: UnaryCall) => Promise<T>): Promise<T> => {
        const promise = settled.then(({ call }) => pick(call))
        promise.catch(() => {})
        return promise
      }
      return new UnaryCall(
        method,
        requestOptions.meta ?? {},
        input,
        part((c) => c.headers),
        part((c) => c.response),
        part((c) => c.status),
        part((c) => c.trailers),
      )
    },
  }
}
