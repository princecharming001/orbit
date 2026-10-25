/**
 * Reading a job posting through Orbit's connector proxy (/posting on orbit-connectors, plan 23 §4.1). The browser
 * cannot fetch another site, so the server does, and answers one fixed shape. The sample student gets a canned Stripe
 * posting with no network call, and when the proxy cannot be reached, what the student pasted still makes a target:
 * a company name alone, or a line like "Software Engineer Intern at Stripe".
 */
import type { PostingInfo } from '@orbit/core';
import { usesMockConnectors } from './connectorsMock';
import { unipileProxyCall } from './unipile';

export type PostingRead =
  | {
      ok: true;
      posting: PostingInfo;
      source: 'jsonld' | 'model' | 'text' | 'demo' | 'typed';
      cached?: boolean;
    }
  | {
      ok: false;
      reason: 'not_a_posting' | 'careers_list' | 'unreachable' | 'unconfigured' | 'limit' | 'bad_request';
      message: string;
    };

/** A job link: an address on the web, pasted as it is. */
export function isJobLink(text: string): boolean {
  return (
    /^\s*(https?:\/\/|www\.)\S+\s*$/i.test(text) ||
    /^\s*[\w-]+(\.[\w-]+)+\/\S*(job|career|posting|position|opening|requisition|gh_jid)\S*\s*$/i.test(text)
  );
}

/** The first link in a message ("here's a posting https://…"). */
export function linkIn(text: string): string | undefined {
  const m = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/i.exec(text);
  if (!m) return undefined;
  const u = m[1]!.replace(/[.,;:!?]+$/, '');
  return u.startsWith('www.') ? `https://${u}` : u;
}

/**
 * What a typed line says without the server: "Software Engineer Intern at Stripe", "I'm applying to Stripe", or a
 * company name alone.
 */
export function postingFromText(text: string): PostingInfo | undefined {
  const t = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');
  if (!t || t.length > 120 || linkIn(t)) return undefined;
  const applying =
    /\b(?:applying|apply|applied)\s+(?:to|at|for)\s+(?:the\s+)?(.+?)(?:\s+(?:role|position|job))?$/i.exec(t);
  if (applying) {
    const rest = applying[1]!;
    const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(rest);
    return at ? { role: at[1]!.trim(), company: at[2]!.trim() } : { role: '', company: rest.trim() };
  }
  const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(t);
  if (at && at[1]!.split(' ').length <= 8) return { role: at[1]!.trim(), company: at[2]!.trim() };
  if (t.split(' ').length <= 5) return { role: '', company: t };
  return undefined;
}

/** "I'm applying to Stripe": the chat's router sends this to the plan. */
export function saysApplying(text: string): boolean {
  return /\b(i'?m|i am|we'?re)\s+(applying|going to apply|about to apply)\s+(to|at|for)\b/i.test(text);
}

/** The sample student's canned posting: Stripe's Payments intern role, ready in an instant. */
export function demoPosting(url: string, now = new Date()): PostingInfo | undefined {
  const deadline = new Date(now.getTime() + 21 * 86_400_000).toISOString().slice(0, 10);
  if (/stripe/i.test(url))
    return {
      company: 'Stripe',
      role: 'Software Engineer Intern',
      team: 'Payments',
      location: 'San Francisco, CA',
      level: 'Intern',
      deadline,
      namesOnPage: { recruiters: [], managers: [] },
      url,
    };
  // Greenhouse, Lever and Ashby put the company in the path: /stripe/jobs/123
  const m = /(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/([a-z0-9-]+)/i.exec(url);
  if (m)
    return {
      company: m[1]!.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      role: 'Software Engineer Intern',
      namesOnPage: { recruiters: [], managers: [] },
      url,
    };
  return undefined;
}

/** The demo's link, for the Map's placeholder and the e2e. */
export const DEMO_POSTING_URL = 'https://boards.greenhouse.io/stripe/jobs/6120000';

/** Read a posting from a link or its pasted text. Never throws. */
export async function readPosting(
  userId: string,
  input: { url?: string; text?: string },
  opts: { fetch?: typeof fetch; now?: Date } = {},
): Promise<PostingRead> {
  if (usesMockConnectors(userId)) {
    const p = input.url
      ? demoPosting(input.url, opts.now)
      : input.text
        ? postingFromText(input.text)
        : undefined;
    return p
      ? { ok: true, posting: p, source: 'demo' }
      : {
          ok: false,
          reason: 'not_a_posting',
          message: "That page doesn't look like a job posting. Try the company name.",
        };
  }
  const r = await unipileProxyCall<
    PostingRead | { ok: true; posting: PostingInfo; source: 'jsonld' | 'model' | 'text' }
  >('/posting', { url: input.url, text: input.text }, { fetch: opts.fetch, timeoutMs: 30_000 });
  if (r.ok) return r.value;
  // the proxy is out of reach: a typed line still makes a target
  const typed = input.text ? postingFromText(input.text) : undefined;
  if (typed) return { ok: true, posting: typed, source: 'typed' };
  return {
    ok: false,
    reason: 'unreachable',
    message: "Orbit couldn't read that just now. Paste the company name instead.",
  };
}
