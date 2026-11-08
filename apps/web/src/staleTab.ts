/**
 * A tab left open across a deploy keeps running the version it opened with, so fixes never reach it until someone
 * reloads. When the student comes back to a tab that sat hidden for a while, Orbit asks the site which version is
 * live and, if it is newer and nothing is typed on the page, loads it.
 */
const HIDDEN_FOR_MS = 5 * 60 * 1000;

function scriptOf(html: string): string | undefined {
  return html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1];
}

function currentScript(): string | undefined {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return el ? new URL(el.src, location.href).pathname : undefined;
}

/** Something typed and not sent: a reload would lose it. */
function somethingTyped(): boolean {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'textarea, input[type="text"], input:not([type])',
  ))
    if (el.value.trim()) return true;
  return !!document.querySelector('[contenteditable="true"]:not(:empty)');
}

export async function newerVersionLive(fetcher: typeof fetch = fetch): Promise<boolean> {
  const mine = currentScript();
  if (!mine) return false;
  try {
    const res = await fetcher(`${import.meta.env.BASE_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const live = scriptOf(await res.text());
    return !!live && new URL(live, location.href).pathname !== mine;
  } catch {
    return false;
  }
}

export function watchForNewVersion(): void {
  let hiddenAt: number | undefined;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
    hiddenAt = undefined;
    if (away < HIDDEN_FOR_MS) return;
    void newerVersionLive().then((newer) => {
      if (newer && !somethingTyped()) location.reload();
    });
  });
}
