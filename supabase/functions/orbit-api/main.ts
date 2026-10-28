/**
 * orbit-api entry: reads the environment and serves api.ts. Bundled with its imports into dist/index.js by
 * scripts/build-functions.mjs; index.ts loads that bundle. Deploy with verify_jwt off (Orbit checks its own tokens).
 */
import { connectDb } from '../_shared/db.ts';
import { makeLogger } from '../_shared/http.ts';
import { providerSecret, resolveSecret } from '../_shared/secrets.ts';
import { agentEnvFrom } from '../_shared/services.ts';
import { makeApiHandler } from './api.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const supabaseUrl = env('SUPABASE_URL');
const dbUrl = env('SUPABASE_DB_URL');
const db = dbUrl ? connectDb(dbUrl) : undefined;
// read together, so a cold start waits on one round trip to the database, not five in a row.
// Unipile (account-mode LinkedIn), and where Google sends sign-in back: a function secret, else the value stored in
// orbit_private.secrets. The redirect stays this function's own address until ORBIT_GOOGLE_REDIRECT_URI is stored
// (https://tryorbit.today/auth/google/callback, the site page that passes sign-in on, once Google lists it).
const [sessionSecret, unipileWebhookSecret, unipileKey, unipileBase, redirectUri] = await Promise.all([
  resolveSecret(env, db, 'ORBIT_SESSION_SECRET', 'orbit_session_secret'),
  resolveSecret(env, db, 'ORBIT_UNIPILE_WEBHOOK_SECRET', 'orbit_unipile_webhook_secret'),
  providerSecret(env, db, 'UNIPILE_API_KEY'),
  providerSecret(env, db, 'UNIPILE_BASE_URL'),
  providerSecret(env, db, 'ORBIT_GOOGLE_REDIRECT_URI'),
]);
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');

Deno.serve(
  makeApiHandler({
    env: {
      googleClientId: env('ORBIT_GOOGLE_CLIENT_ID'),
      googleClientSecret: env('ORBIT_GOOGLE_CLIENT_SECRET'),
      googleRedirectUri:
        redirectUri ??
        (supabaseUrl ? `${supabaseUrl}/functions/v1/orbit-api/auth/google/callback` : undefined),
      sessionSecret,
      appUrl: env('ORBIT_APP_URL'),
      unipileKey,
      unipileBase,
      unipileWebhookSecret,
      functionsUrl: supabaseUrl ? `${supabaseUrl}/functions/v1` : undefined,
    },
    db,
    agent: { env: agentEnvFrom(env) },
    log: makeLogger(salt),
    salt,
    limits: {
      ipPerMinute: num('ORBIT_API_IP_PER_MINUTE', 120),
      userPerMinute: num('ORBIT_API_USER_PER_MINUTE', 240),
      userPerDay: num('ORBIT_API_USER_PER_DAY', 20_000),
    },
  }),
);
