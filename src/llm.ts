/**
 * The model sits behind this one small seam, so the provider can change (or
 * be replaced by a fake in a test) without touching anything that writes or
 * checks a report. An implementation returns the model's structured output as
 * parsed JSON, untrusted: `write.ts` validates the shape and `check.ts`
 * validates the content.
 */
export interface LlmProvider {
  generate(input: { system: string; user: string }): Promise<unknown>
  /**
   * The model that answered the last call, which may not be the one asked for
   * when the provider fell back; recorded in the report so it is honest.
   */
  servedModel?(): string | null
}

/**
 * A failed call, sorted by whether trying again can help:
 *  - `permanent`: a bad key, a refused request, a missing model. Another try
 *    would fail the same way, so none is made.
 *  - `transient`: a rate limit, an overloaded or failing server, a dropped
 *    connection. A try after a pause may work.
 * Any other error a provider throws (an unusable answer, for one) is retried
 * once straight away.
 */
export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly kind: 'permanent' | 'transient',
  ) {
    super(message)
    this.name = 'LlmCallError'
  }
}
