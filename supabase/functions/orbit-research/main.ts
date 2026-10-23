import { createExa } from '../_shared/providers/exa';
import { postgrestSharedCache } from '../_shared/research/web';
import { postgrestSecret } from '../orbit-claude/proxy.ts';
import { defaultOrigins, makeHandler, postgrestStore, postgrestTake } from './research.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const num = (name: string, fallback: number) => {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** A provider secret: the function secret when set, else the project's private secrets table (orbit_secret). */
async function providerSecret(name: string): Promise<string | undefined> {
  const env = Deno.env.get(name);
  if (env) return env;
  if (!url || !serviceKey) return undefined;
  try {
    return await postgrestSecret(url, serviceKey, name)();
  } catch {
    return undefined;
  }
}

// Exa is optional: with EXA_API_KEY set it does the searching; without it, Claude's own web search does
const exaKey = await providerSecret('EXA_API_KEY');

// without the project's address and service key the function answers "unconfigured" (no signing key)
Deno.serve(
  makeHandler({
    origins: defaultOrigins,
    // account tokens are signed by orbit-connectors with the service role key, which never leaves the server
    signingKey: serviceKey || undefined,
    salt: serviceKey.slice(-16) || 'orbit',
    take: postgrestTake(url, serviceKey),
    store: postgrestStore(url, serviceKey),
    cache: postgrestSharedCache(url, serviceKey),
    // a function secret wins; otherwise the key kept in the project's private schema (as orbit-claude reads it)
    anthropicKey:
      Deno.env.get('ORBIT_ANTHROPIC_API_KEY') ||
      (url && serviceKey ? postgrestSecret(url, serviceKey, 'ORBIT_ANTHROPIC_API_KEY') : undefined),
    exa: exaKey ? createExa({ fetch, apiKey: exaKey, timeoutMs: 12_000, maxRetries: 1 }) : undefined,
    gatherModel: Deno.env.get('ORBIT_RESEARCH_GATHER_MODEL') || undefined,
    perMonth: num('ORBIT_RESEARCH_PER_MONTH', 15),
    usdPerDay: num('ORBIT_RESEARCH_USD_PER_DAY', 40),
    accountPerDay: num('ORBIT_RESEARCH_ACCOUNT_PER_DAY', 40),
    visitorPerMinute: num('ORBIT_RESEARCH_PER_MINUTE', 20),
    visitorPerDay: num('ORBIT_RESEARCH_PER_DAY', 200),
  }),
);
