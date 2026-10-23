/**
 * The model sits behind this one small seam, so the provider can change (or
 * be replaced by a fake in a test) without touching anything that writes or
 * checks a report. An implementation returns the model's structured output as
 * parsed JSON, untrusted: `write.ts` validates the shape and `check.ts`
 * validates the content.
 */
export interface LlmProvider {
  generate(input: { system: string; user: string }): Promise<unknown>
}
