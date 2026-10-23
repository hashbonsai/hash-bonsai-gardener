import Anthropic from '@anthropic-ai/sdk'
import type { LlmProvider } from './llm'
import { OBSERVATION_METRICS } from './types'

export const DEFAULT_MODEL = 'claude-opus-5-5'

/**
 * `fallbacks: "default"` asks the API to re-run a request the model declined
 * for policy reasons on its server-defined substitute, inside the same call.
 * Whatever model answers, its text still goes through every check in `check.ts`.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** What the model must return; `check.ts` still validates every value in it. */
export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    en: { type: 'string' },
    ja: { type: 'string' },
    cast: { type: 'string' },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: [...OBSERVATION_METRICS] },
          direction: { type: 'string', enum: ['up', 'down', 'flat'] },
          statement: { type: 'string' },
        },
        required: ['metric', 'direction', 'statement'],
        additionalProperties: false,
      },
    },
  },
  required: ['en', 'ja', 'cast', 'observations'],
  additionalProperties: false,
} as const

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Message = Anthropic.Beta.BetaMessage

/** The one call this provider makes, so a test can stand in for the SDK. */
export type MessagesApi = { create(params: Params): Promise<Message> }

export type AnthropicOptions = {
  model?: string
  /** `medium` is the model's default; the report is short, so spend the thinking on getting it right. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens?: number
}

export function anthropicProvider(api: MessagesApi, options: AnthropicOptions = {}): LlmProvider {
  const model = options.model ?? DEFAULT_MODEL
  let served: string | null = null

  return {
    servedModel: () => served,
    async generate({ system, user }) {
      const response = await api.create({
        model,
        max_tokens: options.maxTokens ?? 16000,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: options.effort ?? 'high', format: { type: 'json_schema', schema: REPORT_SCHEMA } },
        system,
        messages: [{ role: 'user', content: user }],
      })
      served = response.model

      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified'
        throw new Error(`the model declined to write the report (${category})`)
      }
      if (response.stop_reason === 'max_tokens') throw new Error('the model ran out of tokens before finishing the report')

      const text = response.content.find((block) => block.type === 'text')
      if (!text || text.type !== 'text') throw new Error('the model returned no text')
      try {
        return JSON.parse(text.text) as unknown
      } catch {
        throw new Error('the model\'s output was not valid JSON')
      }
    },
  }
}

/** The real thing. The key is read by the caller from its file and handed in; it is not logged. */
export function anthropicClient(apiKey: string): MessagesApi {
  const client = new Anthropic({ apiKey, timeout: 180_000 })
  return { create: (params) => client.beta.messages.create(params) }
}
