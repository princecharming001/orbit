/**
 * "Connect with Cal.com" and "Connect with Fathom": the app's own sign-in in a small window, the way most apps
 * connect. The student approves on the app's site, it sends them to Orbit's /auth/app page, which hands the code
 * back to this tab; Orbit's server trades it for tokens with the secret only it holds. The tokens stay in this
 * browser, like a pasted key, and are renewed before they run out.
 */
import { db, type IntegrationAccount } from '../db/schema';
import { type AppAuth, oauthClients, oauthTokens } from '../integrations/notesApps';

export type SignInApp = 'calcom' | 'fathom';

const AUTHORIZE: Record<SignInApp, { url: string; scope: string }> = {
  calcom: { url: 'https://app.cal.com/auth/oauth2/authorize', scope: 'EVENT_TYPE_READ PROFILE_READ' },
  fathom: { url: 'https://fathom.video/external/v1/oauth2/authorize', scope: 'public_api' },
};

/** Where every app's sign-in comes back; register exactly this address with Cal.com and Fathom. */
export function appRedirectUri(): string {
  const base = (import.meta.env.BASE_URL as string | undefined) ?? '/';
  return `${window.location.origin}${base.replace(/\/?$/, '/')}auth/app`;
}

let clients: Promise<{ calcom: string | null; fathom: string | null }> | undefined;

/** The apps Orbit can sign in to (asked once per visit); a pasted key works for the others. */
export function signInClients(): Promise<{ calcom: string | null; fathom: string | null }> {
  clients ??= oauthClients().then((r) => (r.ok ? r.value : { calcom: null, fathom: null }));
  return clients;
}

/** Test hook. */
export function resetSignInClients(): void {
  clients = undefined;
}

const CHANNEL = 'orbit-app-sign-in';

export type SignInOutcome =
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { ok: false; message: string };

function randomState(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Open the app's sign-in and wait for the student to approve. Resolves with tokens, or with a plain reason (closed
 * the window, said no, the app is not set up for sign-in yet).
 */
export async function signInToApp(app: SignInApp): Promise<SignInOutcome> {
  const ids = await signInClients();
  const clientId = ids[app];
  if (!clientId)
    return { ok: false, message: 'Signing in is not set up for this app yet. Use an API key instead.' };
  const state = `${app}.${randomState()}`;
  const redirectUri = appRedirectUri();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: AUTHORIZE[app].scope,
    state,
  });
  const win = window.open(`${AUTHORIZE[app].url}?${q}`, 'orbit-app-sign-in', 'width=520,height=720');
  if (!win)
    return {
      ok: false,
      message: 'Your browser blocked the sign-in window. Allow pop-ups for Orbit and try again.',
    };
  const answer = await new Promise<{ code?: string; error?: string } | undefined>((resolve) => {
    const channel = new BroadcastChannel(CHANNEL);
    const done = (v: { code?: string; error?: string } | undefined) => {
      channel.close();
      clearInterval(watch);
      resolve(v);
    };
    channel.onmessage = (e: MessageEvent<{ state?: string; code?: string; error?: string }>) => {
      if (e.data?.state === state) done({ code: e.data.code, error: e.data.error });
    };
    // closed without finishing: give the page a moment to post first
    const watch = setInterval(() => {
      if (win.closed) setTimeout(() => done(undefined), 800);
    }, 500);
  });
  if (!answer) return { ok: false, message: 'The sign-in window was closed before it finished.' };
  if (!answer.code)
    return {
      ok: false,
      message:
        answer.error === 'access_denied'
          ? 'You did not allow Orbit in.'
          : 'The app did not let Orbit in. Try again.',
    };
  const t = await oauthTokens({ provider: app, grant: 'code', code: answer.code, redirectUri });
  if (!t.ok) return { ok: false, message: t.message };
  return {
    ok: true,
    accessToken: t.value.accessToken,
    refreshToken: t.value.refreshToken,
    expiresAt: t.value.expiresIn ? new Date(Date.now() + t.value.expiresIn * 1000).toISOString() : undefined,
  };
}

/** The /auth/app page: pass the code (or the refusal) back to the tab that opened the sign-in, then close. */
export function finishAppSignIn(search: string): boolean {
  const p = new URLSearchParams(search);
  const state = p.get('state') ?? '';
  if (!/^(calcom|fathom)\.[0-9a-f]{32}$/.test(state)) return false;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ state, code: p.get('code') ?? undefined, error: p.get('error') ?? undefined });
  channel.close();
  return true;
}

/**
 * How to reach a connected app now: its pasted key, or a fresh access token (renewed a minute before it runs out,
 * and saved). Undefined when a renewal fails, so the row asks the student to connect again.
 */
export async function appAuth(app: SignInApp, row: IntegrationAccount): Promise<AppAuth | undefined> {
  if (!row.accessToken) return undefined;
  if (!row.oauth) return row.accessToken;
  const exp = row.oauth.expiresAt ? Date.parse(row.oauth.expiresAt) : Number.POSITIVE_INFINITY;
  if (exp - Date.now() > 60_000) return { accessToken: row.accessToken };
  if (!row.oauth.refreshToken) return undefined;
  const t = await oauthTokens({ provider: app, grant: 'refresh', refreshToken: row.oauth.refreshToken });
  if (!t.ok) {
    await db.integrations.update(row.id, { status: 'needs_reauth', lastError: t.message });
    return undefined;
  }
  // a refresh token works once: keep the new one
  await db.integrations.update(row.id, {
    accessToken: t.value.accessToken,
    oauth: {
      refreshToken: t.value.refreshToken ?? row.oauth.refreshToken,
      expiresAt: t.value.expiresIn
        ? new Date(Date.now() + t.value.expiresIn * 1000).toISOString()
        : undefined,
    },
  });
  return { accessToken: t.value.accessToken };
}
