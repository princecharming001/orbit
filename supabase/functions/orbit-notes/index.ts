import { defaultOrigins, makeHandler, memoryTake, postgrestTake } from './notes.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

Deno.serve(
  makeHandler({
    origins: defaultOrigins,
    // per-visitor counters in the store the other proxies use; in memory when it is not reachable from here
    take: url && serviceKey ? postgrestTake(url, serviceKey) : memoryTake(),
    salt: serviceKey.slice(-16) || 'orbit',
    limits: {
      perMinute: num('ORBIT_NOTES_PER_MINUTE', 30),
      perDay: num('ORBIT_NOTES_PER_DAY', 400),
    },
  }),
);
