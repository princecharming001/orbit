/**
 * "Connect with Cal.com", "Fathom", "Granola" and "Wispr Flow": the app's own sign-in in a small window, the way most
 * apps connect. The student approves on the app's site, it sends them to Orbit's /auth/app page, which hands the code
 * back to this tab. For Cal.com and Fathom, Orbit's server trades it for tokens with the secret only it holds.
 * Granola and Wispr Flow open their meeting servers (MCP) to any app that registers itself, so Orbit registers
 * itself, proves the code is its own (PKCE) and trades it as a public client; no secret is involved. Their sign-in
 * servers answer without the CORS header a browser needs, so the registration and the token calls go through
 * Orbit's orbit-notes function, which only forwards them. Either way the tokens stay in this browser, like a pasted
 * key, and are renewed before they run out.
 */
import { db, type IntegrationAccount } from '../db/schema';
import { type AppAuth, oauthClients, oauthRegister, oauthTokens } from '../integrations/notesApps';

export type SignInApp = 'calcom' | 'fathom' | 'granola' | 'wispr';
/** apps whose meeting server lets Orbit register itself: sign-in needs nothing set up on Orbit's side */
export type McpApp = 'granola' | 'wispr';
export const isMcpApp = (app: SignInApp): app is McpApp => app === 'granola' || app === 'wispr';

/**
 * Where each meeting server says its sign-in lives; read again at each sign-in, these are the fallbacks. Registering
 * and trading codes go through orbit-notes, which keeps those two addresses itself (MCP_AUTH in notes.ts).
 */
export const MCP_APPS: Record<
  McpApp,
  { resource: string; metadata: string; authorize: string; scope: string }
> = {
  granola: {
    resource: 'https://mcp.granola.ai/mcp',
    metadata: 'https://mcp.granola.ai/.well-known/oauth-protected-resource/mcp',
    authorize: 'https://mcp-auth.granola.ai/oauth2/authorize',
    scope: 'mcp offline_access',
  },
  wispr: {
    resource: 'https://api.wisprflow.ai/connect/mcp',
    metadata: 'https://api.wisprflow.ai/.well-known/oauth-protected-resource/connect/mcp',
    authorize: 'https://mcp-auth.wisprflow.com/oauth2/authorize',
    scope: 'openid offline_access',
  },
};

const AUTHORIZE: Record<'calcom' | 'fathom', { url: string; scope: string }> = {
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
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string; clientId?: string }
  | { ok: false; message: string };

function randomState(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Open the sign-in window and wait for the code it sends back (undefined: closed before it finished). */
async function awaitCode(
  url: string,
  state: string,
): Promise<{ code?: string; error?: string } | undefined | 'blocked'> {
  const win = window.open(url, 'orbit-app-sign-in', 'width=520,height=720');
  if (!win) return 'blocked';
  return new Promise((resolve) => {
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
}

function refusal(
  answer: { code?: string; error?: string } | undefined | 'blocked',
): { ok: false; message: string } | undefined {
  if (answer === 'blocked')
    return {
      ok: false,
      message: 'Your browser blocked the sign-in window. Allow pop-ups for Orbit and try again.',
    };
  if (!answer) return { ok: false, message: 'The sign-in window was closed before it finished.' };
  if (!answer.code)
    return {
      ok: false,
      message:
        answer.error === 'access_denied'
          ? 'You did not allow Orbit in.'
          : 'The app did not let Orbit in. Try again.',
    };
  return undefined;
}

const expiry = (seconds?: number) =>
  seconds ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;

/**
 * Open the app's sign-in and wait for the student to approve. Resolves with tokens, or with a plain reason (closed
 * the window, said no, the app is not set up for sign-in yet).
 */
export async function signInToApp(app: SignInApp): Promise<SignInOutcome> {
  if (isMcpApp(app)) return signInToMeetingServer(app);
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
  const answer = await awaitCode(`${AUTHORIZE[app].url}?${q}`, state);
  const no = refusal(answer);
  if (no || answer === 'blocked' || !answer?.code) return no ?? { ok: false, message: 'Try again.' };
  const t = await oauthTokens({ provider: app, grant: 'code', code: answer.code, redirectUri });
  if (!t.ok) return { ok: false, message: t.message };
  return {
    ok: true,
    accessToken: t.value.accessToken,
    refreshToken: t.value.refreshToken,
    expiresAt: expiry(t.value.expiresIn),
  };
}

/** The meeting server's sign-in, as it describes it now (falling back to what it said when this was written). */
async function discover(app: McpApp) {
  const known = MCP_APPS[app];
  try {
    const res = (await (await fetch(known.metadata)).json()) as {
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    const issuer = res.authorization_servers?.[0];
    if (!issuer) return known;
    const as = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as {
      authorization_endpoint?: string;
      scopes_supported?: string[];
    };
    // what the meeting server asks for, plus staying signed in when the sign-in server offers it
    const scopes = [...(res.scopes_supported ?? [])];
    if (as.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access'))
      scopes.push('offline_access');
    return {
      ...known,
      authorize: as.authorization_endpoint ?? known.authorize,
      scope: scopes.length ? scopes.join(' ') : known.scope,
    };
  } catch {
    return known;
  }
}

/** Orbit's registration with this meeting server for this address, made once and remembered in this browser. */
async function registeredClient(
  app: McpApp,
  redirectUri: string,
  scope: string,
): Promise<{ ok: true; clientId: string } | { ok: false; message: string }> {
  const key = `orbit:mcp-client:${app}:${redirectUri}`;
  try {
    const kept = localStorage.getItem(key);
    if (kept) return { ok: true, clientId: kept };
  } catch {}
  const r = await oauthRegister({ server: app, redirectUri, scope });
  if (!r.ok) return r;
  try {
    localStorage.setItem(key, r.value.clientId);
  } catch {}
  return { ok: true, clientId: r.value.clientId };
}

/** Forget Orbit's registration with a meeting server (it was refused), so the next sign-in registers again. */
function forgetClient(app: McpApp, redirectUri: string) {
  try {
    localStorage.removeItem(`orbit:mcp-client:${app}:${redirectUri}`);
  } catch {}
}

async function signInToMeetingServer(app: McpApp): Promise<SignInOutcome> {
  const name = app === 'granola' ? 'Granola' : 'Wispr Flow';
  const ep = await discover(app);
  const redirectUri = appRedirectUri();
  const reg = await registeredClient(app, redirectUri, ep.scope);
  // the server's own words: the app refused (with its status), or Orbit could not reach it
  if (!reg.ok) return { ok: false, message: reg.message };
  const clientId = reg.clientId;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = `${app}.${randomState()}`;
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ep.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: ep.resource,
  });
  const answer = await awaitCode(`${ep.authorize}?${q}`, state);
  if (answer && answer !== 'blocked' && answer.error === 'invalid_client') forgetClient(app, redirectUri);
  const no = refusal(answer);
  if (no || answer === 'blocked' || !answer?.code) return no ?? { ok: false, message: 'Try again.' };
  const t = await oauthTokens({
    provider: app,
    grant: 'code',
    clientId,
    code: answer.code,
    redirectUri,
    codeVerifier: verifier,
  });
  if (!t.ok) {
    // the sign-in server refused this registration or code: register afresh next time
    if (t.reason === 'bad_key') forgetClient(app, redirectUri);
    return { ok: false, message: `${name} did not finish signing in. Try again.` };
  }
  return {
    ok: true,
    accessToken: t.value.accessToken,
    refreshToken: t.value.refreshToken,
    expiresAt: expiry(t.value.expiresIn),
    clientId,
  };
}

/** The /auth/app page: pass the code (or the refusal) back to the tab that opened the sign-in, then close. */
export function finishAppSignIn(search: string): boolean {
  const p = new URLSearchParams(search);
  const state = p.get('state') ?? '';
  if (!/^(calcom|fathom|granola|wispr)\.[0-9a-f]{32}$/.test(state)) return false;
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
  const t = isMcpApp(app)
    ? await refreshMeetingServer(app, row.oauth.refreshToken, row.oauth.clientId)
    : await oauthTokens({ provider: app, grant: 'refresh', refreshToken: row.oauth.refreshToken });
  if (!t.ok) {
    await db.integrations.update(row.id, { status: 'needs_reauth', lastError: t.message });
    return undefined;
  }
  // a refresh token works once: keep the new one
  await db.integrations.update(row.id, {
    accessToken: t.value.accessToken,
    oauth: {
      ...row.oauth,
      refreshToken: t.value.refreshToken ?? row.oauth.refreshToken,
      expiresAt: expiry(t.value.expiresIn),
    },
  });
  return { accessToken: t.value.accessToken };
}

/** Renew a meeting server's sign-in: no secret, just Orbit's registration and the refresh token (via orbit-notes). */
async function refreshMeetingServer(
  app: McpApp,
  refreshToken: string,
  clientId: string | undefined,
): Promise<
  | { ok: true; value: { accessToken: string; refreshToken?: string; expiresIn?: number } }
  | { ok: false; message: string }
> {
  const name = app === 'granola' ? 'Granola' : 'Wispr Flow';
  if (!clientId) return { ok: false, message: `${name} needs you to connect again.` };
  const t = await oauthTokens({ provider: app, grant: 'refresh', clientId, refreshToken });
  if (!t.ok)
    return {
      ok: false,
      message: t.reason === 'bad_key' ? `${name} needs you to connect again.` : t.message,
    };
  return { ok: true, value: t.value };
}
