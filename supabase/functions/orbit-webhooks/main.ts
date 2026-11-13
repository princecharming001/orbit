/**
 * orbit-webhooks entry: Gmail push (Pub/Sub), Unipile and Zoom webhooks. Bundled into dist/index.js by
 * scripts/build-functions.mjs. Deploy with verify_jwt off: each route checks its own shared secret.
 */
import { connectDb } from '../_shared/db.ts';
import { makeLogger } from '../_shared/http.ts';
import { providerSecret, resolveSecret } from '../_shared/secrets.ts';
import { offeredSources } from '../_shared/sources/states.ts';
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
// Zoom's webhook secret token: read when a Zoom webhook arrives, again at most once a minute while it is missing
let zoomSecret: { at: number; v?: string } | undefined;
const readZoomSecret = async () => {
  if (!zoomSecret || (!zoomSecret.v && Date.now() - zoomSecret.at > 60_000))
    zoomSecret = { at: Date.now(), v: await providerSecret(env, db, 'ZOOM_WEBHOOK_SECRET_TOKEN') };
  return zoomSecret.v;
};
const salt = env('ORBIT_LOG_SALT') ?? ((env('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-16) || 'orbit');

Deno.serve(
  makeWebhookHandler({
    db,
    pubsubToken,
    unipileSecret,
    // plan 43 §3.1: the optional sources the owner offers, read once; unset is none and nothing changes
    offered: offeredSources(env('ORBIT_EXTRA_SOURCES')),
    zoomSecret: readZoomSecret,
    log: makeLogger(salt),
  }),
);
