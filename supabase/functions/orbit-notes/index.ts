import { defaultOrigins, makeHandler, memoryTake, postgrestTake } from './notes.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// an app's sign-in turns on once Orbit's OAuth client for it is saved as function secrets
const client = (id: string, secret: string) => {
  const clientId = Deno.env.get(id)?.trim();
  const clientSecret = Deno.env.get(secret)?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

Deno.serve(
  makeHandler({
    origins: defaultOrigins,
    oauth: {
      calcom: client('CALCOM_CLIENT_ID', 'CALCOM_CLIENT_SECRET'),
      fathom: client('FATHOM_CLIENT_ID', 'FATHOM_CLIENT_SECRET'),
    },
    // per-visitor counters in the store the other proxies use; in memory when it is not reachable from here
    take: url && serviceKey ? postgrestTake(url, serviceKey) : memoryTake(),
    salt: serviceKey.slice(-16) || 'orbit',
    limits: {
      perMinute: num('ORBIT_NOTES_PER_MINUTE', 30),
      perDay: num('ORBIT_NOTES_PER_DAY', 400),
    },
  }),
);
