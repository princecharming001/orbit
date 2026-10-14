/**
 * orbit-webhooks entry: Gmail push (Pub/Sub) and Unipile webhooks. Bundled into dist/index.js by
 * scripts/build-functions.mjs. Deploy with verify_jwt off: each route checks its own shared secret.
 */
import { connectDb } from '../_shared/db.ts';
import { makeLogger } from '../_shared/http.ts';
import { makeWebhookHandler } from './webhooks.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const dbUrl = env('SUPABASE_DB_URL');
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');

Deno.serve(
  makeWebhookHandler({
    db: dbUrl ? connectDb(dbUrl, 2) : undefined,
    pubsubToken: env('ORBIT_PUBSUB_TOKEN'),
    unipileSecret: env('ORBIT_UNIPILE_WEBHOOK_SECRET'),
    log: makeLogger(salt),
  }),
);
