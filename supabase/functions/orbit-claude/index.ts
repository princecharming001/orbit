import { defaultOrigins, makeHandler, postgrestSecret, postgrestTake } from './proxy.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

Deno.serve(
  makeHandler({
    // a function secret wins; otherwise the key kept in the project's private schema
    apiKey:
      Deno.env.get('ORBIT_ANTHROPIC_API_KEY') || postgrestSecret(url, serviceKey, 'ORBIT_ANTHROPIC_API_KEY'),
    origins: defaultOrigins,
    take: postgrestTake(url, serviceKey),
    salt: serviceKey.slice(-16) || 'orbit',
    limits: {
      perMinute: num('ORBIT_LIMIT_PER_MINUTE', 30),
      perDay: num('ORBIT_LIMIT_PER_DAY', 250),
      globalPerDay: num('ORBIT_LIMIT_GLOBAL_PER_DAY', 3000),
    },
  }),
);
