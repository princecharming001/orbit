import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPrefs,
  flushPrefs,
  LEGACY_LOCALSTORAGE_KEY,
  llmFeatures,
  loadPrefs,
  readPrefs,
  resetPrefsMemoryForTests,
  todaysLlmUsage,
  updatePrefs,
  writePrefs,
} from './prefs';

/** A second copy of the module, as a second browser tab would have, sharing the same IndexedDB. */
async function openOtherTab() {
  vi.resetModules();
  const tab = await import('./prefs');
  await tab.loadPrefs();
  return tab;
}

beforeEach(async () => {
  await clearPrefs();
  resetPrefsMemoryForTests();
});

describe('local prefs', () => {
  it('moves secrets from localStorage into IndexedDB and deletes the localStorage copy', async () => {
    localStorage.setItem(
      LEGACY_LOCALSTORAGE_KEY,
      JSON.stringify({ anthropicApiKey: 'sk-ant-old', googleClientId: 'cid.apps.googleusercontent.com' }),
    );
    const p = await loadPrefs();
    expect(p.anthropicApiKey).toBe('sk-ant-old');
    expect(localStorage.getItem(LEGACY_LOCALSTORAGE_KEY)).toBeNull();
    // a fresh page load reads them back from IndexedDB
    resetPrefsMemoryForTests();
    expect(readPrefs().anthropicApiKey).toBeUndefined();
    await loadPrefs();
    expect(readPrefs()).toMatchObject({
      anthropicApiKey: 'sk-ant-old',
      googleClientId: 'cid.apps.googleusercontent.com',
    });
  });

  it('persists writes outside localStorage and clears them on delete', async () => {
    await loadPrefs();
    writePrefs({ anthropicApiKey: 'sk-ant-new', llmFeatures: { emailTriage: true } });
    await flushPrefs();
    expect(localStorage.getItem(LEGACY_LOCALSTORAGE_KEY)).toBeNull();
    resetPrefsMemoryForTests();
    await loadPrefs();
    expect(readPrefs().anthropicApiKey).toBe('sk-ant-new');
    expect(llmFeatures()).toMatchObject({ drafts: true, emailTriage: true, notes: false });
    writePrefs({ anthropicApiKey: undefined });
    expect('anthropicApiKey' in readPrefs()).toBe(false);
    await clearPrefs();
    resetPrefsMemoryForTests();
    await loadPrefs();
    expect(readPrefs()).toEqual({});
  });
});

describe('several tabs', () => {
  it('a tab with an older copy does not undo a key removal or a feature opt-out made in another tab', async () => {
    await loadPrefs();
    writePrefs({ anthropicApiKey: 'sk-ant-x', llmFeatures: { emailTriage: true } });
    await flushPrefs();
    const tabB = await openOtherTab();
    expect(tabB.readPrefs().anthropicApiKey).toBe('sk-ant-x');

    // tab A: remove the key and turn email triage off
    writePrefs({ anthropicApiKey: undefined, llmFeatures: { emailTriage: false } });
    await flushPrefs();
    // tab B, before it hears about it, records usage from a Claude call it had in flight
    tabB.updatePrefs((cur) => {
      const u = tabB.todaysLlmUsage(cur);
      return { ...cur, llmUsage: { ...u, requests: u.requests + 1 } };
    });
    await tabB.flushPrefs();

    resetPrefsMemoryForTests();
    const stored = await loadPrefs();
    expect(stored.anthropicApiKey).toBeUndefined();
    expect(llmFeatures(stored).emailTriage).toBe(false);
    expect(todaysLlmUsage(stored).requests).toBe(1);
    // and tab B's own copy has caught up
    expect(tabB.readPrefs().anthropicApiKey).toBeUndefined();
  });

  it('usage from several tabs adds up to one daily total', async () => {
    await loadPrefs();
    const tabB = await openOtherTab();
    const bump = (u: typeof updatePrefs, usage: typeof todaysLlmUsage) =>
      u((cur) => {
        const x = usage(cur);
        return { ...cur, llmUsage: { ...x, requests: x.requests + 1, inputTokens: x.inputTokens + 10 } };
      });
    bump(updatePrefs, todaysLlmUsage);
    bump(tabB.updatePrefs, tabB.todaysLlmUsage);
    bump(updatePrefs, todaysLlmUsage);
    await Promise.all([flushPrefs(), tabB.flushPrefs()]);
    resetPrefsMemoryForTests();
    expect(todaysLlmUsage(await loadPrefs())).toMatchObject({ requests: 3, inputTokens: 30 });
  });

  it('"Delete all data" in one tab is not undone by a write from another open tab', async () => {
    await loadPrefs();
    writePrefs({ anthropicApiKey: 'sk-ant-x', googleClientId: 'cid' });
    await flushPrefs();
    const tabB = await openOtherTab();
    await clearPrefs();
    tabB.writePrefs({ theme: 'dark' });
    await tabB.flushPrefs();
    resetPrefsMemoryForTests();
    expect(await loadPrefs()).toEqual({ theme: 'dark' });
  });
});
