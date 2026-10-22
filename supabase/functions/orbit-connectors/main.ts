import {
  defaultOrigins,
  makeHandler,
  memoryLinks,
  memoryTake,
  postgrestLinks,
  postgrestTake,
} from './connectors.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/**
 * A provider secret: the function secret when set, else the project's private secrets table (read once per cold
 * start through the service-role-only orbit_secret function), so a key can be stored without the dashboard.
 */
async function providerSecret(name: string): Promise<string | undefined> {
  const env = Deno.env.get(name);
  if (env) return env;
  if (!url || !serviceKey) return undefined;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/orbit_secret`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ p_name: name }),
    });
    if (!r.ok) return undefined;
    return ((await r.json()) as string | null) || undefined;
  } catch {
    return undefined;
  }
}
const [unipileKey, unipileBase] = await Promise.all([
  providerSecret('UNIPILE_API_KEY'),
  providerSecret('UNIPILE_BASE_URL'),
]);

const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

Deno.serve(
  makeHandler({
    // pasting these as function secrets turns each provider on; until then its routes answer "unconfigured"
    unipileKey,
    unipileBase,
    // Village v2: the app secret key mints a token per user (POST /v2/auth/tokens); VILLAGE_API_KEY is the old name
    villageKey: Deno.env.get('VILLAGE_SECRET_KEY') || Deno.env.get('VILLAGE_API_KEY') || undefined,
    villageBase: Deno.env.get('VILLAGE_BASE_URL') || 'https://api.village.do',
    villageUser: Deno.env.get('VILLAGE_USER_EMAIL')
      ? {
          externalUserId: Deno.env.get('VILLAGE_EXTERNAL_USER_ID') || 'orbit-local',
          email: Deno.env.get('VILLAGE_USER_EMAIL')!,
        }
      : undefined,
    origins: defaultOrigins,
    // per-visitor counters in the shared store orbit-claude uses; in memory when it is not reachable from here
    take: url && serviceKey ? postgrestTake(url, serviceKey) : memoryTake(),
    salt: serviceKey.slice(-16) || 'orbit',
    // account tokens are signed with the service role key, which never leaves the server
    signingKey: serviceKey || undefined,
    // Unipile reports each finished LinkedIn sign-in to /connect/notify; the account is kept by the sign-in's reference
    links: url && serviceKey ? postgrestLinks(url, serviceKey) : memoryLinks(),
    publicUrl: url ? `${url}/functions/v1/orbit-connectors` : undefined,
    sendsPerDay: num('ORBIT_LINKEDIN_SENDS_PER_DAY', 25),
    searchesPerDay: num('ORBIT_LINKEDIN_SEARCHES_PER_DAY', 40),
    limits: {
      perMinute: num('ORBIT_CONNECTORS_PER_MINUTE', 120),
      perDay: num('ORBIT_CONNECTORS_PER_DAY', 3000),
    },
  }),
);
