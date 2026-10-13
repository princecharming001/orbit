import { defaultOrigins, makeHandler, memoryTake, postgrestTake } from './connectors.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

Deno.serve(
  makeHandler({
    // pasting these as function secrets turns each provider on; until then its routes answer "unconfigured"
    unipileKey: Deno.env.get('UNIPILE_API_KEY') || undefined,
    unipileBase: Deno.env.get('UNIPILE_BASE_URL') || undefined,
    villageKey: Deno.env.get('VILLAGE_API_KEY') || undefined,
    villageBase: Deno.env.get('VILLAGE_BASE_URL') || 'https://api.village.do',
    origins: defaultOrigins,
    // per-visitor counters in the shared store orbit-claude uses; in memory when it is not reachable from here
    take: url && serviceKey ? postgrestTake(url, serviceKey) : memoryTake(),
    salt: serviceKey.slice(-16) || 'orbit',
    limits: {
      perMinute: num('ORBIT_CONNECTORS_PER_MINUTE', 120),
      perDay: num('ORBIT_CONNECTORS_PER_DAY', 3000),
    },
  }),
);
