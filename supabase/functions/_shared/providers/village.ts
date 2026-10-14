/**
 * Village API v2 (https://docs.village.ai/api-reference/introduction.md; OpenAPI at
 * https://api.village.do/v2/docs/openapi.json). Confirmed from the spec:
 * - `POST /v2/auth/tokens`, header `secret-key: <app secret>`, body `{external_user_id, email, grant?}` →
 *   `{data: {token, expires_in, expires_at, token_type: "Bearer"}, metadata}` (tokens live a year; Orbit re-mints
 *   every 50 minutes anyway, §4.2).
 * - `POST /v2/people/paths`, Bearer token, body `{linkedin_url}` or `{url}` (no name/company form), 5 credits →
 *   `{data: {person, summary, paths: [{degree, summary{score 0..100}, starters[], introducer{profile, score,
 *   score_label, score_meta[]}, score_meta[]}], count}}`; 404 = person unknown or no paths.
 * - `POST /v2/companies/paths`, body `{domain}` or `{linkedin_url}` (+ `limit` ≤ 50, `connection_degrees`), 5
 *   credits → `{data: {company, summary, target_people: [{target, paths[], summary, count, degree}]}}`.
 */
import {
  type Clock,
  type ProviderOptions,
  type ProviderResult,
  requestJson,
  trimBase,
  unconfigured,
} from './request';
import { z } from './zod';

export const VILLAGE_BASE = 'https://api.village.do';
/** credits per call (from the spec's x-mint notes) and Village's list price per credit */
export const VILLAGE_PERSON_CREDITS = 5;
export const VILLAGE_COMPANY_CREDITS = 5;
export const VILLAGE_USD_PER_CREDIT = 0.02;
/** how long a minted token is reused before minting again */
export const VILLAGE_TOKEN_TTL_MS = 50 * 60_000;

export interface VillageUser {
  /** the Orbit user id (or another stable id) Village provisions the user under */
  externalUserId: string;
  email: string;
}

const scoreMetaSchema = z.looseObject({ title: z.string().nullish(), description: z.string().nullish() });
const profileSchema = z.looseObject({
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  full_name: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  headline: z.string().nullish(),
});
const summarySchema = z
  .looseObject({
    score: z.number().nullish(),
    score_label: z.string().nullish(),
    description: z.string().nullish(),
  })
  .nullish();

export const villagePathSchema = z.looseObject({
  degree: z.number().nullish(),
  summary: summarySchema,
  starters: z
    .array(
      z.looseObject({
        profile: profileSchema.nullish(),
        score: z.number().nullish(),
        is_current_user: z.boolean().nullish(),
      }),
    )
    .nullish(),
  introducer: z
    .looseObject({
      profile: profileSchema.nullish(),
      score: z.number().nullish(),
      score_label: z.string().nullish(),
      score_meta: z.array(scoreMetaSchema).nullish(),
    })
    .nullish(),
  score_meta: z.array(scoreMetaSchema).nullish(),
});
export type VillageRawPath = z.infer<typeof villagePathSchema>;

const targetSchema = z.looseObject({
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  full_name: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  title: z.string().nullish(),
  id: z.string().nullish(),
});

/** Village wraps answers in `{data, metadata}`; accept a bare body too. */
function envelope<S extends z.ZodType>(inner: S) {
  return z.union([z.looseObject({ data: inner }).transform((x) => x.data as z.output<S>), inner]);
}

export const villagePersonPathsSchema = envelope(
  z.looseObject({
    person: targetSchema.nullish(),
    summary: summarySchema,
    paths: z.array(villagePathSchema).default([]),
    count: z.number().nullish(),
  }),
);
export type VillagePersonPaths = z.output<typeof villagePersonPathsSchema>;

export const villageCompanyPathsSchema = envelope(
  z.looseObject({
    company: z
      .looseObject({
        name: z.string().nullish(),
        domain: z.string().nullish(),
        linkedin_url: z.string().nullish(),
      })
      .nullish(),
    summary: summarySchema,
    target_people: z
      .array(
        z.looseObject({
          target: targetSchema.nullish(),
          paths: z.array(villagePathSchema).default([]),
          degree: z.number().nullish(),
        }),
      )
      .default([]),
  }),
);
export type VillageCompanyPaths = z.output<typeof villageCompanyPathsSchema>;

export const villageTokenSchema = envelope(
  z.looseObject({
    token: z.string(),
    expires_in: z.number().nullish(),
    expires_at: z.number().nullish(),
  }),
);

export type VillagePersonQuery = { linkedin_url: string } | { url: string };
export type VillageCompanyQuery = ({ domain: string } | { linkedin_url: string }) & {
  limit?: number;
  connection_degrees?: number[];
  cursor?: string;
};

export interface Village {
  readonly configured: boolean;
  token(user: VillageUser): Promise<ProviderResult<string>>;
  personPaths(user: VillageUser, q: VillagePersonQuery): Promise<ProviderResult<VillagePersonPaths>>;
  companyPaths(user: VillageUser, q: VillageCompanyQuery): Promise<ProviderResult<VillageCompanyPaths>>;
}

export function createVillage(opts: ProviderOptions & { secretKey?: string }): Village {
  const secret = opts.secretKey ?? opts.apiKey;
  const base = trimBase(opts.baseUrl ?? VILLAGE_BASE);
  const clock: Clock = opts.clock ?? Date.now;
  const tokens = new Map<string, { token: string; until: number }>();

  async function token(user: VillageUser, fresh = false): Promise<ProviderResult<string>> {
    if (!secret) return unconfigured('village', 'secret key');
    const hit = tokens.get(user.externalUserId);
    if (!fresh && hit && hit.until > clock()) return { ok: true, value: hit.token };
    const r = await requestJson(opts, {
      provider: 'village',
      url: `${base}/v2/auth/tokens`,
      method: 'POST',
      headers: { 'secret-key': secret },
      body: { external_user_id: user.externalUserId, email: user.email },
      schema: villageTokenSchema,
    });
    if (!r.ok) return r;
    const now = clock();
    const expiresAt = r.value.expires_at ? r.value.expires_at * 1000 : Number.POSITIVE_INFINITY;
    tokens.set(user.externalUserId, {
      token: r.value.token,
      until: Math.min(now + VILLAGE_TOKEN_TTL_MS, expiresAt - 60_000),
    });
    return { ok: true, value: r.value.token };
  }

  /** a call with the user's token; a 401 on a cached token mints a new one and tries once more */
  async function authed<S extends z.ZodType>(
    user: VillageUser,
    path: string,
    body: unknown,
    schema: S,
    onEmpty: () => z.output<S>,
  ): Promise<ProviderResult<z.output<S>>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(user, attempt > 0);
      if (!t.ok) return t;
      const r = await requestJson(opts, {
        provider: 'village',
        url: `${base}${path}`,
        method: 'POST',
        headers: { authorization: `Bearer ${t.value}` },
        body,
        schema,
        emptyOn: [404],
        onEmpty,
      });
      if (!r.ok && r.status === 401 && attempt === 0) {
        tokens.delete(user.externalUserId);
        continue;
      }
      return r;
    }
    return { ok: false, kind: 'http', provider: 'village', status: 401, message: 'village 401' };
  }

  return {
    configured: !!secret,
    token: (user) => token(user),
    personPaths: (user, q) =>
      authed(user, '/v2/people/paths', q, villagePersonPathsSchema, () => ({ summary: null, paths: [] })),
    companyPaths: (user, q) =>
      authed(user, '/v2/companies/paths', q, villageCompanyPathsSchema, () => ({
        summary: null,
        target_people: [],
      })),
  };
}

// ---- normalization ----------------------------------------------------------------------------------------

export interface VillageIntro {
  introducer: { name: string; headline?: string; linkedinUrl?: string };
  /** 0..1 (Village scores 0..100) */
  warmth: number;
  degree: number;
  scoreLabel?: string;
  /** why Village thinks the path is warm: score_meta titles and descriptions */
  reasons: string[];
  target: { name?: string; linkedinUrl?: string; title?: string };
}

function profileName(p: z.infer<typeof profileSchema> | null | undefined): string {
  if (!p) return '';
  return (p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`).trim();
}

function targetName(t: z.infer<typeof targetSchema> | null | undefined): string | undefined {
  if (!t) return undefined;
  return (t.full_name ?? `${t.first_name ?? ''} ${t.last_name ?? ''}`).trim() || undefined;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Village's score on a 0..100 scale (some answers already use 0..1) to a 0..1 warmth. */
export function villageWarmth(score: number | null | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return clamp01(score > 1 ? score / 100 : score);
}

function introFrom(p: VillageRawPath, target: VillageIntro['target']): VillageIntro | null {
  const name = profileName(p.introducer?.profile);
  // degree 1 paths are direct ties: no introducer between the user and the target
  if (!name || (p.degree ?? 2) < 2) return null;
  const meta = [...(p.introducer?.score_meta ?? []), ...(p.score_meta ?? [])];
  return {
    introducer: {
      name,
      headline: p.introducer?.profile?.headline ?? undefined,
      linkedinUrl: p.introducer?.profile?.linkedin_url ?? undefined,
    },
    warmth: villageWarmth(p.summary?.score ?? p.introducer?.score),
    degree: p.degree ?? 2,
    scoreLabel: p.summary?.score_label ?? p.introducer?.score_label ?? undefined,
    reasons: meta
      .map((m) => [m.title, m.description].filter(Boolean).join(': '))
      .filter((s) => s.length > 0)
      .slice(0, 3),
    target,
  };
}

export function personIntros(r: VillagePersonPaths): VillageIntro[] {
  const target = {
    name: targetName(r.person),
    linkedinUrl: r.person?.linkedin_url ?? undefined,
    title: r.person?.title ?? undefined,
  };
  return r.paths
    .map((p) => introFrom(p, target))
    .filter((x): x is VillageIntro => !!x)
    .sort((a, b) => b.warmth - a.warmth);
}

export function companyIntros(r: VillageCompanyPaths): VillageIntro[] {
  return r.target_people
    .flatMap((tp) =>
      tp.paths.map((p) =>
        introFrom(p, {
          name: targetName(tp.target),
          linkedinUrl: tp.target?.linkedin_url ?? undefined,
          title: tp.target?.title ?? undefined,
        }),
      ),
    )
    .filter((x): x is VillageIntro => !!x)
    .sort((a, b) => b.warmth - a.warmth);
}
