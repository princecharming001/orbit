import { beforeEach, describe, expect, it } from 'vitest';
import { bundledLogo, knownLogo, resetLogoCache, resolveLogo } from './logoImage';

/** A fake off-screen loader: what each source answers, by a part of its address. */
const loader =
  (answers: Record<string, { width: number; height: number } | undefined>) => async (url: string) => {
    const hit = Object.keys(answers).find((k) => url.includes(k));
    return hit ? answers[hit] : undefined;
  };

beforeEach(() => resetLogoCache());

describe('finding a logo image', () => {
  it("rejects DuckDuckGo's 48 px stand-in and Google's 16 px globe, and takes the first real icon", async () => {
    const load = loader({
      'icons.duckduckgo.com': { width: 48, height: 48 },
      'google.com/s2': { width: 16, height: 16 },
      'apple-touch-icon': { width: 180, height: 180 },
    });
    const src = await resolveLogo('example-university.edu', load);
    expect(src).toBe('https://example-university.edu/apple-touch-icon.png');
    // kept, so the next tile asks nothing
    expect(knownLogo('example-university.edu')).toBe(src);
  });

  it("takes Google's large icon when DuckDuckGo only has its stand-in", async () => {
    const load = loader({
      'icons.duckduckgo.com': { width: 48, height: 48 },
      'google.com/s2': { width: 128, height: 128 },
    });
    expect(await resolveLogo('somewhere.edu', load)).toContain('google.com/s2/favicons?domain=somewhere.edu');
  });

  it('answers none when every source is a stand-in or missing, and remembers that', async () => {
    const load = loader({
      'icons.duckduckgo.com': { width: 48, height: 48 },
      'google.com/s2': { width: 16, height: 16 },
    });
    expect(await resolveLogo('nothing-here.io', load)).toBeNull();
    expect(knownLogo('nothing-here.io')).toBeNull();
  });

  it('keeps a tiny real icon only when nothing larger turns up', async () => {
    const load = loader({ 'icons.duckduckgo.com': { width: 16, height: 16 } });
    expect(await resolveLogo('tiny.io', load)).toContain('icons.duckduckgo.com');
  });

  it('does not keep an answer past this visit when nothing loaded at all (offline)', async () => {
    expect(await resolveLogo('offline.io', loader({}))).toBeNull();
    expect(localStorage.getItem('orbit:logos:v1') ?? '').not.toContain('offline.io');
    const load = loader({ 'icons.duckduckgo.com': { width: 48, height: 48 } });
    expect(await resolveLogo('known-none.io', load)).toBeNull();
    expect(localStorage.getItem('orbit:logos:v1') ?? '').toContain('known-none.io');
  });

  it('shows a logo shipped with the app without asking any service', async () => {
    expect(bundledLogo('berkeley.edu')).toMatch(/\/logos\/berkeley\.png$/);
    expect(bundledLogo('nyu.edu')).toMatch(/\/logos\/nyu\.png$/);
    expect(bundledLogo('unknown.io')).toBeUndefined();
    let asked = 0;
    const src = await resolveLogo('stripe.com', async () => {
      asked++;
      return undefined;
    });
    expect(src).toMatch(/\/logos\/stripe\.png$/);
    expect(asked).toBe(0);
  });

  it("gives a school inside a university its university's shipped logo when it has none of its own", async () => {
    const load = loader({ 'icons.duckduckgo.com': { width: 48, height: 48 } });
    expect(await resolveLogo('law.nyu.edu', load)).toMatch(/\/logos\/nyu\.png$/);
    // not for a domain with its own icon
    const own = loader({ 'icons.duckduckgo.com': { width: 32, height: 32 } });
    expect(await resolveLogo('stern.nyu.edu', own)).toContain('icons.duckduckgo.com/ip3/stern.nyu.edu');
  });
});
