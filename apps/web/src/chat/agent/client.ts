import Anthropic from '@anthropic-ai/sdk';
import { readPrefs } from '../../integrations/prefs';

/**
 * The SDK client the chat loop talks to. Built with the student's own key from local prefs, in the browser
 * (`dangerouslyAllowBrowser`: the key never leaves this device except to Anthropic). Tests replace the factory with
 * one that builds the real client over a scripted `fetch`, so the real tool runner, Zod validation and SSE parsing run.
 */
export type ChatClient = Pick<Anthropic, 'beta'>;

export interface ChatClientOptions {
  /** a custom fetch (the scripted one in tests, or a proxying one) */
  fetch?: typeof fetch;
  maxRetries?: number;
}

let factory: ((apiKey: string) => ChatClient) | undefined;

/** Test hook: replace the SDK client. Pass undefined to restore the real one. */
export function setChatClientFactoryForTests(f: ((apiKey: string) => ChatClient) | undefined): void {
  factory = f;
}

export function makeChatClient(apiKey: string, opts: ChatClientOptions = {}): Anthropic {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: opts.maxRetries ?? 2,
    timeout: 120_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/** The client for the saved key, or undefined when no key is saved on this device. */
export function chatClient(opts: ChatClientOptions = {}): ChatClient | undefined {
  const key = readPrefs().anthropicApiKey;
  if (!key) return undefined;
  if (factory) return factory(key);
  return makeChatClient(key, opts);
}
