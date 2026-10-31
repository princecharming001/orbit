import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { fakeEngineRequest } from './chat/testing/flag';
import type { ChatEngine } from './chat/types';
import { reloadOnce } from './components/ErrorBoundary';
import { db } from './db/schema';
import { isAccountMode, loadSession } from './integrations/orbitApi';
import { loadPrefs } from './integrations/prefs';
import './styles/index.css';

// A part of the app this tab loads later was replaced by a deploy since the tab opened: load the new version once
// (a second miss within a minute is left to the page's own message, so it never loops)
window.addEventListener('vite:preloadError', (e) => {
  if (reloadOnce()) e.preventDefault();
});

// End-to-end tests drive live changes (someone new, a stage change) through the same database the app reads.
if (navigator.webdriver) (window as unknown as { __orbitDb: typeof db }).__orbitDb = db;

// The chat quality bench (plan 28, e2e/chat-live.spec.ts) runs the real model in the real UI: a browser under
// automation that set `window.__ORBIT_ANTHROPIC_KEY__` before the app loaded gets that key saved as the student's own,
// the way Settings would save it. Only under automation; a normal browser never has navigator.webdriver, and the key
// is read once and never written anywhere else.
async function liveKey(): Promise<void> {
  if (!navigator.webdriver) return;
  const g = window as unknown as { __ORBIT_ANTHROPIC_KEY__?: unknown };
  if (typeof g.__ORBIT_ANTHROPIC_KEY__ !== 'string' || !g.__ORBIT_ANTHROPIC_KEY__) return;
  const { writePrefs } = await import('./integrations/prefs');
  writePrefs({
    anthropicApiKey: g.__ORBIT_ANTHROPIC_KEY__,
    llmDailyRequestCap: 500,
    llmDailyTokenCap: 50_000_000,
  });
  delete g.__ORBIT_ANTHROPIC_KEY__;
}

// The chat's scripted engine for the e2e tests: only under automation, only when the first URL asks for it, and
// loaded as its own chunk so a normal visit never downloads it.
async function chatEngine(): Promise<ChatEngine | undefined> {
  const fake = fakeEngineRequest();
  if (!fake) return undefined;
  const { createFakeChatEngine } = await import('./chat/testing/fakeEngine');
  return createFakeChatEngine({ mode: fake.mode });
}

// Local prefs (API key, client id, AI settings) live in IndexedDB; load them before the first render
// so synchronous readers see them.
// Account mode only: the stored Orbit session (its refresh token), and the hooks that queue the student's own changes
// for the server.
async function account(): Promise<void> {
  if (!isAccountMode()) return;
  await loadSession().catch(() => undefined);
  const { installOutboxHooks } = await import('./engine/serverSync');
  installOutboxHooks();
}

Promise.all([
  loadPrefs()
    .catch(() => undefined)
    .then(liveKey),
  chatEngine(),
  account(),
]).then(([, engine]) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App chatEngine={engine} />
    </React.StrictMode>,
  );
});
