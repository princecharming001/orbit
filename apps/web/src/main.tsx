import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { fakeEngineRequest } from './chat/testing/flag';
import type { ChatEngine } from './chat/types';
import { db } from './db/schema';
import { isAccountMode, loadSession } from './integrations/orbitApi';
import { loadPrefs } from './integrations/prefs';
import './styles/index.css';

// End-to-end tests drive live changes (someone new, a stage change) through the same database the app reads.
if (navigator.webdriver) (window as unknown as { __orbitDb: typeof db }).__orbitDb = db;

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

Promise.all([loadPrefs().catch(() => undefined), chatEngine(), account()]).then(([, engine]) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App chatEngine={engine} />
    </React.StrictMode>,
  );
});
