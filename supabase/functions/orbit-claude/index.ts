import {
  defaultOrigins,
  makeHandler,
  postgrestEnabled,
  postgrestSecret,
  postgrestSessionSecret,
  postgrestSpend,
  postgrestTake,
  postgrestUsage,
} from './proxy.ts';

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
    // $3 per user per UTC day; set ORBIT_USER_CAP_USD to change it
    spend: postgrestSpend(url, serviceKey),
    capUsd: num('ORBIT_USER_CAP_USD', 3),
    anonIpDailyUsd: num('ORBIT_ANON_IP_DAILY_USD', 1),
    globalDailyUsd: num('ORBIT_GLOBAL_DAILY_USD', 25),
    // $10 of Claude a calendar month per signed-in student, chat and server work together; set ORBIT_USER_MONTHLY_USD
    monthlyUsd: num('ORBIT_USER_MONTHLY_USD', 10),
    // the owner tests on the live site: no monthly allowance (a function secret, else the copy in the secrets table)
    ownerId: Deno.env.get('ORBIT_OWNER_ID') || postgrestSecret(url, serviceKey, 'ORBIT_OWNER_ID'),
    // the key orbit-api signs sessions with: a function secret, else the copy in Vault (where it lives today)
    sessionSecret: Deno.env.get('ORBIT_SESSION_SECRET') || postgrestSessionSecret(url, serviceKey),
    // orbit_private.provider_switches: the anthropic row off pauses the shared access within five minutes
    enabled: postgrestEnabled(url, serviceKey, 'anthropic'),
    usage: postgrestUsage(url, serviceKey),
    limits: {
      perMinute: num('ORBIT_LIMIT_PER_MINUTE', 120),
      perDay: num('ORBIT_LIMIT_PER_DAY', 5000),
      globalPerDay: num('ORBIT_LIMIT_GLOBAL_PER_DAY', 100_000),
      // memory, resume, reply-tone and search-judge reads: their own daily counts per visitor
      perDayCall: {
        memory: num('ORBIT_LIMIT_MEMORY_PER_DAY', 3000),
        resume: num('ORBIT_LIMIT_RESUME_PER_DAY', 50),
        rapport: num('ORBIT_LIMIT_RAPPORT_PER_DAY', 3000),
        judge: num('ORBIT_LIMIT_JUDGE_PER_DAY', 5000),
      },
    },
  }),
);
