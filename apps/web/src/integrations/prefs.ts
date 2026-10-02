// Browser-local preferences that must never leave the device (API keys, OAuth client id).
const KEY = 'orbit.prefs.v1';
export interface LocalPrefs {
  anthropicApiKey?: string;
  googleClientId?: string;
  theme?: 'light' | 'dark' | 'system';
}
export function readPrefs(): LocalPrefs {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as LocalPrefs;
  } catch {
    return {};
  }
}
export function writePrefs(p: Partial<LocalPrefs>): LocalPrefs {
  const next = { ...readPrefs(), ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  return next;
}
export function envGoogleClientId(): string | undefined {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || undefined;
}
