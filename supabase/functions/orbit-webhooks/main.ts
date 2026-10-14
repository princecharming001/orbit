/**
 * orbit-webhooks entry: Gmail push (Pub/Sub) and Unipile webhooks. Bundled into dist/index.js by
 * scripts/build-functions.mjs. Deploy with verify_jwt off: each route checks its own shared secret.
 */
import { connectDb } from '../_shared/db.ts';
import { makeLogger } from '../_shared/http.ts';
import { resolveSecret } from '../_shared/secrets.ts';
import { makeWebhookHandler } from './webhooks.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const dbUrl = env('SUPABASE_DB_URL');
const db = dbUrl ? connectDb(dbUrl, 2) : undefined;
const pubsubToken = await resolveSecret(env, db, 'ORBIT_PUBSUB_TOKEN', 'orbit_pubsub_token');
const unipileSecret = await resolveSecret(
  env,
  db,
  'ORBIT_UNIPILE_WEBHOOK_SECRET',
  'orbit_unipile_webhook_secret',
);
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');

Deno.serve(
  makeWebhookHandler({
    db,
    pubsubToken,
    unipileSecret,
    log: makeLogger(salt),
  }),
);
