/**
 * Plan 44: a fake of the job boards for the Roles tests. Routes answer by URL (and method); every call is recorded;
 * an optional clock moves on per request so a test can see a tick keep to its time share.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../functions/_shared/__fixtures__/roles');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

export interface FakeBoards {
  fetch: typeof fetch;
  calls: { url: string; method: string; body?: string }[];
  /** ms the fake clock moves on per request */
  cost: number;
  clock: () => number;
  advance: (ms: number) => void;
  sleep: (ms: number) => Promise<void>;
}

export function fakeBoards(routes: Route[], o: { cost?: number; start?: number } = {}): FakeBoards {
  let t = o.start ?? 1_000_000;
  const f: FakeBoards = {
    calls: [],
    cost: o.cost ?? 0,
    clock: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms) => {
      t += ms;
    },
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      f.calls.push({
        url: url.toString(),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      t += f.cost;
      for (const r of routes) {
        const res = await r(url, init);
        if (res) return res;
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

export const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
