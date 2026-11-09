// Claude through the Anthropic API with the person's key (SecretStorage, else ANTHROPIC_API_KEY). The SDK is the
// one dependency of the package that runs (D-063).
import Anthropic from "@anthropic-ai/sdk";
import type { Backend, Cancellation } from "./backend";
import { BackendError } from "./backend";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicTexts { refused: string; cutOff: string; badKey: string; failed: string }

/** Models that accept server-side fallback on a refusal (`fallbacks: "default"`). */
const FallbackModels = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FallbackBeta = "server-side-fallback-2026-07-01";
const MaxTokens = 64_000;

export class AnthropicBackend implements Backend {
  constructor(private readonly apiKey: string | undefined, private readonly model: string, private readonly effort: Effort, private readonly texts: AnthropicTexts) {}

  async send(system: string, user: string, onText: (text: string) => void, cancellation: Cancellation): Promise<void> {
    // Without a key from the settings the SDK takes ANTHROPIC_API_KEY or a profile of `ant auth login`.
    const client = new Anthropic(this.apiKey ? { apiKey: this.apiKey } : {});
    const fallback = FallbackModels.has(this.model);
    const stream = client.beta.messages.stream({
      model: this.model,
      max_tokens: MaxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      system,
      messages: [{ role: "user", content: user }],
      ...(fallback ? { betas: [FallbackBeta], fallbacks: "default" } : {}),
    } as Anthropic.Beta.Messages.MessageStreamParams);
    const subscription = cancellation.onCancellationRequested(() => stream.abort());
    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText(event.delta.text);
      }
      if (cancellation.isCancellationRequested) return;
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") onText(`\n\n> ${this.texts.refused}`);
      else if (final.stop_reason === "max_tokens") onText(`\n\n> ${this.texts.cutOff}`);
    } catch (e) {
      if (cancellation.isCancellationRequested) return;
      if (e instanceof Anthropic.AuthenticationError) throw new BackendError(this.texts.badKey);
      if (e instanceof Anthropic.APIError) throw new BackendError(`${this.texts.failed} ${e.status ?? ""} ${e.message}`.trim());
      throw e;
    } finally {
      subscription.dispose();
    }
  }
}
