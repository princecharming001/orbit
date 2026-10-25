import { postgrestPostingCache } from '../_shared/postings.ts';
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
const [
  unipileKey,
  unipileBase,
  villageSecret,
  villageLegacyKey,
  villageBase,
  villageEmail,
  villageExternalUser,
] = await Promise.all([
  providerSecret('UNIPILE_API_KEY'),
  providerSecret('UNIPILE_BASE_URL'),
  // Village, the same way: a function secret, else the secrets table
  providerSecret('VILLAGE_SECRET_KEY'),
  providerSecret('VILLAGE_API_KEY'),
  providerSecret('VILLAGE_BASE_URL'),
  providerSecret('VILLAGE_USER_EMAIL'),
  providerSecret('VILLAGE_EXTERNAL_USER_ID'),
]);

// enrichment (plan 17 E): optional web and people-data keys; each one left out keeps its step switched off
const [exaKey, firecrawlKey, apolloKey, pdlKey, anthropicKey] = await Promise.all([
  providerSecret('EXA_API_KEY'),
  providerSecret('FIRECRAWL_API_KEY'),
  providerSecret('APOLLO_API_KEY'),
  providerSecret('PDL_API_KEY'),
  // job postings (plan 23 §4.1) are read by a small model with Orbit's own key
  providerSecret('ORBIT_ANTHROPIC_API_KEY'),
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
    // Village v2: the app secret key mints a token per user (POST /v2/auth/tokens); VILLAGE_API_KEY is the old name.
    // Without the key or VILLAGE_USER_EMAIL, /paths answers 503 with x-orbit-connector: unconfigured, which the app
    // shows as "Village isn't set up". The paths are that one Village user's network, for every visitor.
    villageKey: villageSecret || villageLegacyKey || undefined,
    villageBase: villageBase || 'https://api.village.do',
    villageUser: villageEmail
      ? { externalUserId: villageExternalUser || 'orbit-local', email: villageEmail }
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
    enrichment: {
      webPerDay: num('ORBIT_WEB_LOOKUPS_PER_DAY', 30),
      exaKey,
      firecrawlKey,
      apolloKey,
      pdlKey,
    },
    sendsPerDay: num('ORBIT_LINKEDIN_SENDS_PER_DAY', 25),
    postings: {
      anthropicKey,
      cache: url && serviceKey ? postgrestPostingCache(url, serviceKey) : undefined,
      perDay: num('ORBIT_POSTINGS_PER_DAY', 10),
    },
    // LinkedIn reads per Unipile account per day, one ledger per kind (plan 21 §6; ceilings per caller in connectors.ts)
    ledger: {
      profile: num('ORBIT_LINKEDIN_PROFILE_READS_PER_DAY', 100),
      posts: num('ORBIT_LINKEDIN_POST_READS_PER_DAY', 100),
      search: num('ORBIT_LINKEDIN_SEARCH_CALLS_PER_DAY', 100),
    },
    limits: {
      perMinute: num('ORBIT_CONNECTORS_PER_MINUTE', 120),
      perDay: num('ORBIT_CONNECTORS_PER_DAY', 3000),
    },
  }),
);
