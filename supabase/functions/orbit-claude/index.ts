import { defaultOrigins, makeHandler, postgrestSecret, postgrestSpend, postgrestTake } from './proxy.ts';

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
    // $20 per user until raised; set ORBIT_USER_CAP_USD to change it
    spend: postgrestSpend(url, serviceKey),
    capUsd: num('ORBIT_USER_CAP_USD', 20),
    sessionSecret: Deno.env.get('ORBIT_SESSION_SECRET') || undefined,
    limits: {
      perMinute: num('ORBIT_LIMIT_PER_MINUTE', 30),
      perDay: num('ORBIT_LIMIT_PER_DAY', 250),
      globalPerDay: num('ORBIT_LIMIT_GLOBAL_PER_DAY', 3000),
      // reading a chat turn for memory, and reading a resume: their own daily counts per visitor
      perDayCall: {
        memory: num('ORBIT_LIMIT_MEMORY_PER_DAY', 200),
        resume: num('ORBIT_LIMIT_RESUME_PER_DAY', 5),
      },
    },
  }),
);
