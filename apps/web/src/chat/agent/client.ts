import Anthropic from '@anthropic-ai/sdk';
import { currentAccessToken } from '../../integrations/orbitApi';
import { readPrefs } from '../../integrations/prefs';
import { sharedClaudeAvailable, sharedClaudeUrl, sharedClientId } from '../../integrations/shared-claude';

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

/** The placeholder key sent to Orbit's shared access; the server function swaps in the real one. */
export const SHARED_KEY = 'orbit-shared';

export function makeChatClient(
  apiKey: string,
  opts: ChatClientOptions & { baseURL?: string; headers?: Record<string, string> } = {},
): Anthropic {
  return new Anthropic({
    apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
    dangerouslyAllowBrowser: true,
    maxRetries: opts.maxRetries ?? 2,
    timeout: 120_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * The client for the saved key; without one, the client for Orbit's shared access when it is available; else
 * undefined. The shared client sends a placeholder key to Orbit's server function, never a real one.
 */
export function chatClient(opts: ChatClientOptions = {}): ChatClient | undefined {
  const key = readPrefs().anthropicApiKey;
  if (key) return factory ? factory(key) : makeChatClient(key, opts);
  if (!sharedClaudeAvailable()) return undefined;
  if (factory) return factory(SHARED_KEY);
  // who is asking, so the server holds each student to their own allowance: the account when signed in, else this
  // browser's id
  const token = currentAccessToken();
  return makeChatClient(SHARED_KEY, {
    ...opts,
    baseURL: sharedClaudeUrl(),
    headers: { 'x-orbit-client': sharedClientId(), ...(token ? { 'x-orbit-session': token } : {}) },
  });
}
