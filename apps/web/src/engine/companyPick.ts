/**
 * Which LinkedIn company a name means, settled by the student (plan 37, the student's rule: a logo is that exact
 * company's). A name LinkedIn lists several companies for ("Triumph": Triumph Labs, TRIUMPH the aerospace group, ...)
 * never gets one of their logos on a guess: the student picks from LinkedIn's own list, with each company's logo,
 * industry and place, and the pick is kept for them (orbit-connectors /companies/pick) and on the organisation, exact.
 * The sample student picks from the demo's made-up companies.
 */
import { normalizeCompany, type User } from '@orbit/core';
import { db } from '../db/schema';
import { mockCompanyByName } from '../integrations/connectorsMock';
import {
  type CompanyOption,
  linkedInCompanyOptions,
  pickLinkedInCompany,
} from '../integrations/enrichmentProxy';
import { adoptCompany } from './enrichment/logos';
import { liveAccountFor } from './enrichment/sources';
import { upsertOrganization } from './people';

export type { CompanyOption };

export type OptionsOutcome =
  | { ok: true; options: CompanyOption[] }
  | { ok: false; reason: 'not_connected' | 'limit' | 'unavailable'; message: string };

/** One answer per name in this visit: looking the same name up again asks LinkedIn nothing. */
const asked = new Map<string, Promise<OptionsOutcome>>();

export function resetCompanyOptionsForTests(): void {
  asked.clear();
}

/** The companies LinkedIn lists for a name, in its own order. */
export function companyOptions(user: Pick<User, 'id'>, name: string): Promise<OptionsOutcome> {
  const q = name.trim();
  const key = `${user.id}|${normalizeCompany(q)}`;
  const hit = asked.get(key);
  if (hit) return hit;
  const run = (async (): Promise<OptionsOutcome> => {
    const live = await liveAccountFor(user).catch(() => undefined);
    if (!live)
      return {
        ok: false,
        reason: 'not_connected',
        message: 'Connect LinkedIn to pick the company from LinkedIn.',
      };
    if (live === 'mock') {
      // the demo: its own company of that name, and the made-up namesakes it carries
      const norm = normalizeCompany(q);
      const orgs = await db.organizations.toArray();
      const options: CompanyOption[] = [];
      for (const o of orgs) {
        const n = normalizeCompany(o.name);
        if (!n.split(' ').includes(norm.split(' ')[0] ?? '')) continue;
        const c = await mockCompanyByName(o.name);
        options.push({
          id: c?.id ?? `mock_company_${o.linkedinSlug ?? o.id}`,
          name: o.name,
          logoUrl: c?.logoUrl,
        });
      }
      return { ok: true, options };
    }
    const r = await linkedInCompanyOptions(live.accountId, q, { token: live.token });
    if (r.ok) return { ok: true, options: r.value };
    return r.reason === 'limit'
      ? {
          ok: false,
          reason: 'limit',
          message: "That's today's LinkedIn company lookups. Try again tomorrow.",
        }
      : {
          ok: false,
          reason: 'unavailable',
          message: 'LinkedIn could not be asked just now. Try again in a moment.',
        };
  })();
  asked.set(key, run);
  void run.then((r) => {
    if (!r.ok) asked.delete(key);
  });
  return run;
}

/**
 * The student picked `option` as the company `name` means: kept for them on Orbit's server (live) and on the
 * organisation of that name here, exact, with the logo LinkedIn shows for it.
 */
export async function pickCompany(
  user: Pick<User, 'id'>,
  name: string,
  option: CompanyOption,
  now = new Date(),
): Promise<{ ok: true; logoUrl?: string } | { ok: false; message: string }> {
  const live = await liveAccountFor(user).catch(() => undefined);
  if (!live) return { ok: false, message: 'Connect LinkedIn to pick the company from LinkedIn.' };
  let facts = {
    companyId: option.id,
    companySlug: option.publicIdentifier,
    logoUrl: option.logoUrl,
    exact: true,
  };
  if (live !== 'mock') {
    const r = await pickLinkedInCompany(live.accountId, name, option.id, { token: live.token });
    if (!r.ok) return { ok: false, message: 'LinkedIn could not be asked just now. Try again in a moment.' };
    facts = {
      companyId: r.value.companyId ?? option.id,
      companySlug: r.value.publicIdentifier ?? option.publicIdentifier,
      logoUrl: r.value.logoUrl ?? option.logoUrl,
      exact: true,
    };
  }
  const org = await upsertOrganization(name);
  if (!org) return { ok: false, message: 'That company could not be kept just now.' };
  await adoptCompany(org, facts, now);
  return { ok: true, logoUrl: facts.logoUrl };
}
