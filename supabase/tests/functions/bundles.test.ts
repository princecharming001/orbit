/**
 * Loads each committed bundle (supabase/functions/<fn>/dist/index.js) the way Deno would, with `npm:` specifiers
 * mapped back to the workspace's packages and a stand-in `Deno` global, and checks that with no secrets set every
 * function answers 503 `unconfigured` (§17 P1 "functions deployed and answering unconfigured").
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const functions = join(here, '../../functions');
const tmp = join(here, '../.bundles');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function load(fn: string): Promise<(req: Request) => Promise<Response>> {
  const src = readFileSync(join(functions, fn, 'dist/index.js'), 'utf8').replace(
    /from "npm:((?:@[^/"]+\/)?[^@/"]+)@[^/"]+(\/[^"]*)?"/g,
    (_m, name: string, sub: string | undefined) => `from "${name}${sub ?? ''}"`,
  );
  expect(src).not.toMatch(/from "(?!\.)[^"]*@\d/);
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, `${fn}.mjs`);
  writeFileSync(file, src);
  let handler: ((req: Request) => Promise<Response>) | undefined;
  (globalThis as { Deno?: unknown }).Deno = {
    env: { get: () => undefined },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  };
  await import(/* @vite-ignore */ `${pathToFileURL(file).href}?t=${Date.now()}`);
  delete (globalThis as { Deno?: unknown }).Deno;
  expect(handler).toBeTypeOf('function');
  return handler!;
}

describe('function bundles', () => {
  it('every bundled function imports only npm: packages pinned in its deno.json', () => {
    for (const fn of ['orbit-api', 'orbit-worker', 'orbit-webhooks', 'orbit-research']) {
      const src = readFileSync(join(functions, fn, 'dist/index.js'), 'utf8');
      const imports = JSON.parse(readFileSync(join(functions, fn, 'deno.json'), 'utf8')).imports as Record<
        string,
        string
      >;
      const specs = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const s of specs) {
        expect(s.startsWith('npm:'), s).toBe(true);
        expect(
          Object.values(imports).some((v) => s.startsWith(v.replace(/\/$/, ''))),
          s,
        ).toBe(true);
      }
      expect(readFileSync(join(functions, fn, 'index.ts'), 'utf8')).toContain("import './dist/index.js';");
    }
  });

  it('orbit-api answers unconfigured', async () => {
    const h = await load('orbit-api');
    const r = await h(new Request('https://ref.supabase.co/functions/v1/orbit-api/auth/google/start'));
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
  });

  it('orbit-worker answers unconfigured', async () => {
    const h = await load('orbit-worker');
    const r = await h(
      new Request('https://ref.supabase.co/functions/v1/orbit-worker', { method: 'POST', body: '{}' }),
    );
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
  });

  it('orbit-webhooks answers unconfigured', async () => {
    const h = await load('orbit-webhooks');
    const r = await h(
      new Request('https://ref.supabase.co/functions/v1/orbit-webhooks/gmail?token=x', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
  });

  it('orbit-research answers unconfigured', async () => {
    const h = await load('orbit-research');
    const r = await h(
      new Request('https://ref.supabase.co/functions/v1/orbit-research/quick', {
        method: 'POST',
        headers: { origin: 'https://tryorbit.today', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
  });
});
