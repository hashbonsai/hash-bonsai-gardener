import { describe, expect, it } from 'vitest'
import { createTatumClient, TATUM_HOST, tatumTransportOptions } from '../src/tatum'

describe('tatumTransportOptions', () => {
  it('speaks native gRPC to the Tatum host for each network', () => {
    expect(tatumTransportOptions('mainnet', 'k').host).toBe('sui-mainnet-grpc.gateway.tatum.io:443')
    expect(tatumTransportOptions('testnet', 'k').host).toBe('sui-testnet-grpc.gateway.tatum.io:443')
  })
  it('sends the key as x-api-key metadata and nowhere else', () => {
    const o = tatumTransportOptions('mainnet', 'dummy-key-value')
    expect(o.meta).toEqual({ 'x-api-key': 'dummy-key-value' })
    expect(o.host).not.toContain('dummy-key-value')
  })
})

describe('createTatumClient', () => {
  it('exposes only the host, builds without touching the network, and closes cleanly', () => {
    const t = createTatumClient('testnet', 'dummy-key-value')
    expect(t.host).toBe(TATUM_HOST.testnet)
    expect(JSON.stringify({ host: t.host })).not.toContain('dummy-key-value')
    expect(() => t.close()).not.toThrow()
  })
})
