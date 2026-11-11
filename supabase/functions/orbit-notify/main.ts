/**
 * orbit-notify entry (plan 40): readiness of the first import, the student's phone number, and "Orbit is ready" by
 * email and text. Bundled into dist/index.js by scripts/build-functions.mjs. Deploy with verify_jwt off: the student
 * routes check Orbit's own session, the sweep checks the cron secret.
 */
import { connectDb } from '../_shared/db.ts';
import { originPolicy } from '../_shared/http.ts';
import { providerSecret, resolveSecret } from '../_shared/secrets.ts';
import { makeNotifyHandler } from './notify.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const dbUrl = env('SUPABASE_DB_URL');
const db = dbUrl ? connectDb(dbUrl, 3) : undefined;
const [sessionSecret, cronSecret] = await Promise.all([
  resolveSecret(env, db, 'ORBIT_SESSION_SECRET', 'orbit_session_secret'),
  resolveSecret(env, db, 'ORBIT_CRON_SECRET', 'orbit_cron_secret'),
]);
const appUrl = env('ORBIT_APP_URL') ?? 'https://tryorbit.today';

Deno.serve(
  makeNotifyHandler({
    db,
    origins: originPolicy(appUrl),
    sessionSecret,
    cronSecret,
    // read on each use: a key saved in orbit_private.secrets later works without a redeploy
    secret: (name) => providerSecret(env, db, name),
    appUrl,
    log: (line) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...line })),
  }),
);
