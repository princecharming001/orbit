import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPrefs,
  flushPrefs,
  LEGACY_LOCALSTORAGE_KEY,
  llmFeatures,
  loadPrefs,
  readPrefs,
  resetPrefsMemoryForTests,
  writePrefs,
} from './prefs';

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
