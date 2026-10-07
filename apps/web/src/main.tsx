import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { db } from './db/schema';
import { loadPrefs } from './integrations/prefs';
import './styles/index.css';

// End-to-end tests drive live changes (someone new, a stage change) through the same database the app reads.
if (navigator.webdriver) (window as unknown as { __orbitDb: typeof db }).__orbitDb = db;

// Local prefs (API key, client id, AI settings) live in IndexedDB; load them before the first render
// so synchronous readers see them.
loadPrefs().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
