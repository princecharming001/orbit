/**
 * Unipile for the LinkedIn sync (§12.3), through the user's own connected account:
 * - `GET /api/v1/users/me?account_id=` → the account's own member: `provider_id`, `public_identifier`, names.
 * - `GET /api/v1/users/relations?account_id=&limit=1000&cursor=` → `{items: [{member_id, public_identifier,
 *   public_profile_url, first_name, last_name, headline, profile_picture_url, created_at}], cursor}` until the cursor
 *   is null.
 * - `GET /api/v1/chats?account_id=&limit=250&after=<ISO>&cursor=` → `{items: [{id, type (0 = 1:1), name,
 *   attendee_provider_id, timestamp, ...}], cursor}`.
 * - `GET /api/v1/chats/{chat_id}/attendees` → `{items: [{id, provider_id, name, is_self, profile_url, specifics}]}`.
 * - `GET /api/v1/chats/{chat_id}/messages?limit=100` → `{items: [{id, chat_id, sender_id, sender_attendee_id, text,
 *   timestamp, is_sender, is_event, hidden, deleted}], cursor}`.
 * - `POST /api/v1/hosted/accounts/link` → `{url}` (hosted auth, §12.3 "Connect").
 * Everything is read tolerantly (loose objects, nullish fields). Failures come back as ProviderResult errors.
 */
import {
  type ProviderOptions,
  type ProviderResult,
  query,
  requestJson,
  trimBase,
  unconfigured,
} from './request';
import { z } from './zod';

const when = z.union([z.string(), z.number()]).nullish();

export const unipileMeSchema = z.looseObject({
  provider_id: z.string().nullish(),
  public_identifier: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
});

export const unipileRelationSchema = z.looseObject({
  member_id: z.string().nullish(),
  member_urn: z.string().nullish(),
  public_identifier: z.string().nullish(),
  public_profile_url: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  headline: z.string().nullish(),
  profile_picture_url: z.string().nullish(),
  created_at: when,
});
export type UnipileRelation = z.infer<typeof unipileRelationSchema>;

export const unipileChatSchema = z.looseObject({
  id: z.string(),
  type: z.union([z.number(), z.string()]).nullish(),
  name: z.string().nullish(),
  attendee_provider_id: z.string().nullish(),
  timestamp: when,
  content_type: z.string().nullish(),
});
export type UnipileChat = z.infer<typeof unipileChatSchema>;

export const unipileAttendeeSchema = z.looseObject({
  id: z.string().nullish(),
  provider_id: z.string().nullish(),
  name: z.string().nullish(),
  is_self: z.union([z.number(), z.boolean()]).nullish(),
  profile_url: z.string().nullish(),
  picture_url: z.string().nullish(),
  specifics: z.looseObject({ occupation: z.string().nullish(), location: z.string().nullish() }).nullish(),
});
export type UnipileAttendee = z.infer<typeof unipileAttendeeSchema>;

export const unipileMessageSchema = z.looseObject({
  id: z.string(),
  chat_id: z.string().nullish(),
  sender_id: z.string().nullish(),
  sender_attendee_id: z.string().nullish(),
  text: z.string().nullish(),
  timestamp: when,
  is_sender: z.union([z.number(), z.boolean()]).nullish(),
  is_event: z.union([z.number(), z.boolean()]).nullish(),
  hidden: z.union([z.number(), z.boolean()]).nullish(),
  deleted: z.union([z.number(), z.boolean()]).nullish(),
});
export type UnipileMessage = z.infer<typeof unipileMessageSchema>;

const page = <S extends z.ZodType>(item: S) =>
  z.looseObject({ items: z.array(item).default([]), cursor: z.string().nullish() });

export interface UnipileSync {
  readonly configured: boolean;
  me(accountId: string): Promise<ProviderResult<z.infer<typeof unipileMeSchema>>>;
  relations(
    accountId: string,
    cursor?: string | null,
  ): Promise<ProviderResult<{ items: UnipileRelation[]; cursor?: string | null }>>;
  chats(
    accountId: string,
    o: { after: string; cursor?: string | null },
  ): Promise<ProviderResult<{ items: UnipileChat[]; cursor?: string | null }>>;
  attendees(chatId: string): Promise<ProviderResult<UnipileAttendee[]>>;
  messages(chatId: string): Promise<ProviderResult<UnipileMessage[]>>;
  hostedLink(body: {
    name: string;
    notifyUrl: string;
    successRedirectUrl: string;
    failureRedirectUrl?: string;
    expiresOn: string;
  }): Promise<ProviderResult<{ url: string }>>;
  /** LinkedIn's people search from the account, any degree: the people a typed name or role finds, best first */
  searchPeople(accountId: string, keywords: string, limit?: number): Promise<ProviderResult<UnipileFound[]>>;
}

/** One person a LinkedIn search found, as the app shows them: photo, name, headline. */
export interface UnipileFound {
  memberId: string;
  name: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  pictureUrl?: string;
  /** 1, 2 or 3: how far out on LinkedIn they are */
  distance?: number;
}

const unipileSearchItemSchema = z.looseObject({
  id: z.string().nullish(),
  name: z.string().nullish(),
  headline: z.string().nullish(),
  location: z.string().nullish(),
  public_profile_url: z.string().nullish(),
  profile_url: z.string().nullish(),
  profile_picture_url: z.string().nullish(),
  network_distance: z.union([z.string(), z.number()]).nullish(),
});

/**
 * 50 a page: filing a relation (person, identities, employer) is a handful of round trips, and a page is filed whole
 * before the job can save its place. 1,000 took longer than a worker run lasts; 100 still overran the platform's limit
 * on some pages of a 6,000-person first import (three jobs read 11 times without finishing, 10-30).
 */
export const RELATIONS_LIMIT = 50;
export const CHATS_LIMIT = 250;
export const MESSAGES_LIMIT = 100;

export function createUnipileSync(opts: ProviderOptions): UnipileSync {
  const configured = !!opts.apiKey && !!opts.baseUrl;
  const base = trimBase(opts.baseUrl ?? '');
  const headers = () => ({ 'X-API-KEY': opts.apiKey ?? '' });
  const no = () => unconfigured('unipile', 'API key or base URL');
  const get = <S extends z.ZodType>(path: string, schema: S) =>
    requestJson(opts, { provider: 'unipile', url: `${base}${path}`, headers: headers(), schema });

  return {
    configured,
    async me(accountId) {
      if (!configured) return no();
      return get(`/api/v1/users/me${query({ account_id: accountId })}`, unipileMeSchema);
    },
    async relations(accountId, cursor) {
      if (!configured) return no();
      return get(
        `/api/v1/users/relations${query({ account_id: accountId, limit: RELATIONS_LIMIT, cursor: cursor ?? undefined })}`,
        page(unipileRelationSchema),
      );
    },
    async chats(accountId, o) {
      if (!configured) return no();
      return get(
        `/api/v1/chats${query({ account_id: accountId, limit: CHATS_LIMIT, after: o.after, cursor: o.cursor ?? undefined })}`,
        page(unipileChatSchema),
      );
    },
    async attendees(chatId) {
      if (!configured) return no();
      const r = await get(
        `/api/v1/chats/${encodeURIComponent(chatId)}/attendees`,
        page(unipileAttendeeSchema),
      );
      return r.ok ? { ok: true, value: r.value.items } : r;
    },
    async messages(chatId) {
      if (!configured) return no();
      const r = await get(
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages${query({ limit: MESSAGES_LIMIT })}`,
        page(unipileMessageSchema),
      );
      return r.ok ? { ok: true, value: r.value.items } : r;
    },
    async hostedLink(b) {
      if (!configured) return no();
      return requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/hosted/accounts/link`,
        method: 'POST',
        headers: headers(),
        body: {
          type: 'create',
          providers: ['LINKEDIN'],
          api_url: base,
          expiresOn: b.expiresOn,
          name: b.name,
          notify_url: b.notifyUrl,
          success_redirect_url: b.successRedirectUrl,
          ...(b.failureRedirectUrl ? { failure_redirect_url: b.failureRedirectUrl } : {}),
        },
        schema: z.looseObject({ url: z.string() }),
      });
    },
    async searchPeople(accountId, keywords, limit = 8) {
      if (!configured) return no();
      const r = await requestJson(opts, {
        provider: 'unipile',
        url: `${base}/api/v1/linkedin/search${query({ account_id: accountId, limit })}`,
        method: 'POST',
        headers: headers(),
        body: { api: 'classic', category: 'people', keywords, network_distance: [1, 2, 3] },
        schema: page(unipileSearchItemSchema),
      });
      if (!r.ok) return r;
      const degree = (d: unknown) => {
        const m = /(\d)/.exec(String(d ?? ''));
        return m ? Number(m[1]) : undefined;
      };
      return {
        ok: true,
        value: r.value.items
          .filter((p) => !!p.id && !!p.name?.trim())
          .map((p) => ({
            memberId: p.id!,
            name: p.name!.trim(),
            headline: p.headline?.trim() || undefined,
            location: p.location?.trim() || undefined,
            profileUrl: p.public_profile_url || p.profile_url || undefined,
            pictureUrl: p.profile_picture_url || undefined,
            distance: degree(p.network_distance),
          })),
      };
    },
  };
}

/** Unipile timestamps arrive as ISO strings or epoch milliseconds. */
export function unipileTime(v: string | number | null | undefined): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const d = typeof v === 'number' ? new Date(v) : /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "Product Designer at Figma" → title and company; undefined when the headline does not read that way. */
export function parseHeadline(headline: string | null | undefined): { title?: string; company?: string } {
  const h = (headline ?? '').split('|')[0]!.trim();
  const m = /^(.{2,80}?)\s+(?:at|@)\s+(.{2,80})$/i.exec(h);
  if (!m) return {};
  return { title: m[1]!.trim(), company: m[2]!.replace(/[.,;]+$/, '').trim() };
}
