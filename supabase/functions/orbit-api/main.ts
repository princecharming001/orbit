/**
 * orbit-api entry: reads the environment and serves api.ts. Bundled with its imports into dist/index.js by
 * scripts/build-functions.mjs; index.ts loads that bundle. Deploy with verify_jwt off (Orbit checks its own tokens).
 */
import { connectDb } from '../_shared/db.ts';
import { makeLogger } from '../_shared/http.ts';
import { resolveSecret } from '../_shared/secrets.ts';
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
const sessionSecret = await resolveSecret(env, db, 'ORBIT_SESSION_SECRET', 'orbit_session_secret');
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');

Deno.serve(
  makeApiHandler({
    env: {
      googleClientId: env('ORBIT_GOOGLE_CLIENT_ID'),
      googleClientSecret: env('ORBIT_GOOGLE_CLIENT_SECRET'),
      googleRedirectUri:
        env('ORBIT_GOOGLE_REDIRECT_URI') ??
        (supabaseUrl ? `${supabaseUrl}/functions/v1/orbit-api/auth/google/callback` : undefined),
      sessionSecret,
      appUrl: env('ORBIT_APP_URL'),
      unipileKey: env('UNIPILE_API_KEY'),
      unipileBase: env('UNIPILE_BASE_URL'),
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
