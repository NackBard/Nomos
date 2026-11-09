// A model that answers an agent: the language model API of VS Code, or the Anthropic API with the person's key (D-063).

export interface Cancellation { readonly isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }

export interface Backend {
  /** Streams the answer; the system text goes first, the context after it. */
  send(system: string, user: string, onText: (text: string) => void, cancellation: Cancellation): Promise<void>;
}

/** A problem the person can fix (no model, no key); shown as is, without a stack. */
export class BackendError extends Error {}
