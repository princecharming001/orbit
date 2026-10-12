/**
 * Whether this page run should use the FakeChatEngine instead of the real one. Read once at startup, only under
 * test automation (`navigator.webdriver`): `?fakeEngine=1` turns it on for the tab (kept in sessionStorage so a
 * reload keeps it), `&fakeMode=llm` makes the fake report mode 'llm'. A normal visit never sees either.
 */
export function fakeEngineRequest(): { mode: 'llm' | 'router' } | undefined {
  if (typeof navigator === 'undefined' || !navigator.webdriver) return undefined;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fakeEngine') === '1') {
      const mode = params.get('fakeMode') === 'llm' ? 'llm' : 'router';
      sessionStorage.setItem('orbit:fakeEngine', mode);
      return { mode };
    }
    const kept = sessionStorage.getItem('orbit:fakeEngine');
    if (kept === 'llm' || kept === 'router') return { mode: kept };
  } catch {
    // storage blocked: no fake
  }
  return undefined;
}
