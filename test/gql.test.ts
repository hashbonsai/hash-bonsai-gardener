import { describe, expect, it } from 'vitest'
import { httpGraphQl } from '../src/gql'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function scripted(...responses: (Response | Error)[]) {
  const calls: { url: string; body: any }[] = []
  const slept: number[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (next instanceof Error) throw next
    return next.clone()
  }) as unknown as typeof fetch
  return { calls, slept, options: { fetch: fetchImpl, sleep: async (ms: number) => void slept.push(ms), backoffMs: 100 } }
}

describe('httpGraphQl', () => {
  it('posts the query with its variables and returns the data', async () => {
    const s = scripted(json({ data: { a: 1 } }))
    expect(await httpGraphQl('https://gql.example/graphql', s.options)('query { a }', { x: 1 })).toEqual({ a: 1 })
    expect(s.calls[0].body).toEqual({ query: 'query { a }', variables: { x: 1 } })
  })

  it('tries a rate limit and a server error again after growing waits', async () => {
    const s = scripted(json({}, 429), json({}, 503), json({ data: { ok: true } }))
    expect(await httpGraphQl('https://gql.example/graphql', s.options)('q')).toEqual({ ok: true })
    expect(s.calls).toHaveLength(3)
    expect(s.slept).toEqual([100, 200])
  })

  it('tries a dropped connection again, and gives up after the retries with the last problem', async () => {
    const s = scripted(new Error('socket hang up'))
    await expect(httpGraphQl('https://gql.example/graphql', { ...s.options, retries: 2 })('q')).rejects.toThrow(/socket hang up/)
    expect(s.calls).toHaveLength(3)
  })

  it('does not try a query the server rejected again', async () => {
    const s = scripted(json({ errors: [{ message: 'unknown field' }] }))
    await expect(httpGraphQl('https://gql.example/graphql', s.options)('q')).rejects.toThrow(/unknown field/)
    expect(s.calls).toHaveLength(1)
  })

  it('does not try a client error again', async () => {
    const s = scripted(json({}, 400))
    await expect(httpGraphQl('https://gql.example/graphql', s.options)('q')).rejects.toThrow(/HTTP 400/)
    expect(s.calls).toHaveLength(1)
  })

  it('refuses an answer with no data', async () => {
    await expect(httpGraphQl('https://gql.example/graphql', scripted(json({})).options)('q')).rejects.toThrow(/no data/)
  })
})
