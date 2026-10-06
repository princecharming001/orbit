import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { loadPrefs } from './integrations/prefs';
import './styles/index.css';

// Local prefs (API key, client id, AI settings) live in IndexedDB; load them before the first render
// so synchronous readers see them.
loadPrefs().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
