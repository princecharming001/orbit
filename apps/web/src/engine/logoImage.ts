/**
 * Finding a company's logo image for its web domain. The logos shipped with the app (public/logos: the companies and
 * schools students name most) come first and need no network. Otherwise DuckDuckGo's and Google's icon services are
 * asked; they answer a site they have no icon for with a stand-in picture (a grey arrow, a globe) and a status the
 * page cannot read, so each source is loaded off screen and judged by its size (core judgeLogo) before a tile shows
 * it: DuckDuckGo, then Google, then the site's own touch icon and favicon. The answer is kept per domain in this
 * browser (two weeks for a logo, three days for none), so a page full of the same company asks once.
 */
import { judgeLogo, logoSources } from '@orbit/core';

/** The logos in public/logos, by the domain they belong to (and the file's name there). */
const BUNDLED: Record<string, string> = {
  'airbnb.com': 'airbnb',
  'amazon.com': 'amazon',
  'aws.amazon.com': 'amazon',
  'anthropic.com': 'anthropic',
  'apple.com': 'apple',
  'bain.com': 'bain',
  'bcg.com': 'bcg',
  'berkeley.edu': 'berkeley',
  'blackstone.com': 'blackstone',
  'brown.edu': 'brown',
  'caltech.edu': 'caltech',
  'citadel.com': 'citadel',
  'citadelsecurities.com': 'citadel',
  'cmu.edu': 'cmu',
  'columbia.edu': 'columbia',
  'cornell.edu': 'cornell',
  'dartmouth.edu': 'dartmouth',
  'databricks.com': 'databricks',
  'duke.edu': 'duke',
  'figma.com': 'figma',
  'gatech.edu': 'gatech',
  'georgetown.edu': 'georgetown',
  'goldmansachs.com': 'goldman',
  'gs.com': 'goldman',
  'google.com': 'google',
  'harvard.edu': 'harvard',
  'illinois.edu': 'illinois',
  'janestreet.com': 'janestreet',
  'jhu.edu': 'jhu',
  'jpmorganchase.com': 'jpmorgan',
  'linear.app': 'linear',
  'mckinsey.com': 'mckinsey',
  'meta.com': 'meta',
  'microsoft.com': 'microsoft',
  'mit.edu': 'mit',
  'morganstanley.com': 'morganstanley',
  'netflix.com': 'netflix',
  'northwestern.edu': 'northwestern',
  'notion.so': 'notion',
  'makenotion.com': 'notion',
  'nd.edu': 'notredame',
  'nvidia.com': 'nvidia',
  'nyu.edu': 'nyu',
  'openai.com': 'openai',
  'palantir.com': 'palantir',
  'upenn.edu': 'penn',
  'princeton.edu': 'princeton',
  'ramp.com': 'ramp',
  'rice.edu': 'rice',
  'scale.com': 'scale',
  'stanford.edu': 'stanford',
  'stripe.com': 'stripe',
  'tesla.com': 'tesla',
  'twosigma.com': 'twosigma',
  'uchicago.edu': 'uchicago',
  'ucla.edu': 'ucla',
  'umich.edu': 'umich',
  'usc.edu': 'usc',
  'utexas.edu': 'utexas',
  'virginia.edu': 'uva',
  'vanderbilt.edu': 'vanderbilt',
  'wustl.edu': 'wustl',
  'yale.edu': 'yale',
};

const base = () => (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/** A logo shipped with the app for this domain, or undefined. */
export function bundledLogo(domain: string): string | undefined {
  const file = BUNDLED[domain.toLowerCase()];
  return file ? `${base()}logos/${file}.png` : undefined;
}

/** Whether an image is one of the app's own logo files. */
export const isBundledLogo = (src: string) => src.startsWith(`${base()}logos/`);

/** The domain a sub-site belongs to: "stern.nyu.edu" is part of "nyu.edu"; undefined for a domain of two parts. */
function parentDomain(domain: string): string | undefined {
  const parts = domain.split('.');
  if (parts.length < 3) return undefined;
  const parent = parts.slice(1).join('.');
  // "ox.ac.uk" has no parent site; "ac.uk" is not one
  return /^(ac|edu|co|com|org|gov)\.[a-z]{2}$/.test(parent) ? undefined : parent;
}

const KEY = 'orbit:logos:v1';
const FOUND_MS = 14 * 86_400_000;
const NONE_MS = 3 * 86_400_000;
const KEEP = 600;

interface Entry {
  /** the image to show, or null when the domain has none */
  src: string | null;
  at: number;
}

let known: Record<string, Entry> | undefined;

function entries(): Record<string, Entry> {
  if (known) return known;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    known = raw && typeof raw === 'object' ? (raw as Record<string, Entry>) : {};
  } catch {
    known = {};
  }
  return known;
}

function remember(domain: string, src: string | null, keep: boolean) {
  const all = entries();
  all[domain] = { src, at: Date.now() };
  if (!keep) return;
  try {
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage full or blocked: the answer still holds for this visit
  }
}

/**
 * What is known about a domain's logo without loading anything: a logo shipped with the app, an image found before,
 * null for a domain known to have none, undefined when it has not been looked for yet.
 */
export function knownLogo(domain: string, now = Date.now()): string | null | undefined {
  const bundled = bundledLogo(domain);
  if (bundled) return bundled;
  const e = entries()[domain];
  if (!e) return undefined;
  return now - e.at < (e.src ? FOUND_MS : NONE_MS) ? e.src : undefined;
}

/** An image that was found but then failed to show: look again next time. */
export function forgetLogo(domain: string) {
  const all = entries();
  if (!all[domain]) return;
  delete all[domain];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // nothing to do
  }
}

export type ImageSize = { width: number; height: number };

/** Load an image off screen: its natural size, or undefined when it does not load in time. */
export function loadImageSize(url: string, timeoutMs = 8000): Promise<ImageSize | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    let done = false;
    const finish = (v: ImageSize | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => finish(undefined);
    img.src = url;
  });
}

const running = new Map<string, Promise<string | null>>();

/**
 * The logo image for a domain, or null when no source has a real one. One look per domain at a time; a tiny real
 * icon is used only when nothing larger turns up, and a school inside a university ("stern.nyu.edu") with no icon of
 * its own wears the university's shipped logo. When nothing loaded at all (offline), the answer is not kept.
 */
export function resolveLogo(domain: string, load = loadImageSize): Promise<string | null> {
  const k = knownLogo(domain);
  if (k !== undefined) return Promise.resolve(k);
  const busy = running.get(domain);
  if (busy) return busy;
  const p = (async () => {
    let weak: string | undefined;
    let answered = false;
    for (const s of logoSources(domain)) {
      const size = await load(s.url);
      if (!size) continue;
      answered = true;
      const v = judgeLogo(s.kind, size.width, size.height);
      if (v === 'ok') {
        remember(domain, s.url, true);
        return s.url;
      }
      if (v === 'weak') weak ??= s.url;
    }
    const parent = parentDomain(domain);
    const inherited = parent ? bundledLogo(parent) : undefined;
    const found = weak ?? inherited ?? null;
    remember(domain, found, answered || !!inherited);
    return found;
  })().finally(() => running.delete(domain));
  running.set(domain, p);
  return p;
}

/** For tests: forget everything. */
export function resetLogoCache() {
  known = {};
  running.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
