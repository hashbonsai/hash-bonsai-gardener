import { ChannelCredentials } from '@grpc/grpc-js'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { GrpcTransport, type GrpcOptions } from '@protobuf-ts/grpc-transport'
import { TATUM_THROTTLE, throttleInterceptor, type ThrottleOptions } from './throttle'

export type Network = 'mainnet' | 'testnet'

/**
 * Tatum's Sui endpoint speaks plain gRPC over HTTP/2. `SuiGrpcClient`'s own
 * default is gRPC-Web, which Tatum refuses ("unexpected response content type:
 * application/grpc"), so the client is built on protobuf-ts's native
 * `GrpcTransport` instead. The API key travels as gRPC metadata.
 */
export const TATUM_HOST: Record<Network, string> = {
  mainnet: 'sui-mainnet-grpc.gateway.tatum.io:443',
  testnet: 'sui-testnet-grpc.gateway.tatum.io:443',
}

/**
 * The transport options, separate from the client so a test can read them
 * without a network. Calls are spaced to stay under the plan's request rate and
 * a rate-limited call is tried again after a wait (see `throttle.ts`).
 */
export function tatumTransportOptions(network: Network, apiKey: string, throttle: ThrottleOptions = TATUM_THROTTLE): GrpcOptions {
  return {
    host: TATUM_HOST[network],
    channelCredentials: ChannelCredentials.createSsl(),
    meta: { 'x-api-key': apiKey },
    interceptors: [throttleInterceptor(throttle)],
  }
}

export type TatumClient = {
  client: SuiGrpcClient
  /** Only the host is ever logged; the key is not retained anywhere readable. */
  host: string
  close: () => void
}

export function createTatumClient(network: Network, apiKey: string, throttle: ThrottleOptions = TATUM_THROTTLE): TatumClient {
  const transport = new GrpcTransport(tatumTransportOptions(network, apiKey, throttle))
  const client = new SuiGrpcClient({ network, transport })
  return { client, host: TATUM_HOST[network], close: () => transport.close() }
}
