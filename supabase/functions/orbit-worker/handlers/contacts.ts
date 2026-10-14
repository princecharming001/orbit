/**
 * sync.contacts (§1.5, §12.3): Google's "other contacts" and the user's own contacts, each with its sync token in
 * sync_state.contacts. They are used only to name addresses: a person whose name is still a stand-in taken from
 * their address ("tom.wu") gets the contact's name. No one is created from contacts. An expired token (410, or 400
 * EXPIRED_SYNC_TOKEN) lists everything again; a source the user did not grant (403) is skipped.
 */
import { isPlaceholderName } from '@orbit/core/entity/resolve';
import { normalizeEmail, parseName } from '@orbit/core/text/normalize';
import { type ContactPerson, type ContactsSource, contactsApi } from '../../_shared/contacts.ts';
import type { Db } from '../../_shared/db.ts';
import { NeedsReauth } from '../../_shared/google.ts';
import { GoogleApiError } from '../../_shared/googleApi.ts';
import { loadAccount, PERSON_COLUMNS, patchSyncState, toPerson } from '../../_shared/ingest/util.ts';
import type { JobHandler } from '../worker.ts';
import { googleFor, type HandlerDeps, JobSkipped, LONG_VT_SEC } from './deps.ts';

const PAGES_MAX = 50;
const SOURCES: ContactsSource[] = ['otherContacts', 'connections'];

const expired = (e: unknown) =>
  e instanceof GoogleApiError &&
  (e.status === 410 ||
    (e.status === 400 && /EXPIRED_SYNC_TOKEN|FAILED_PRECONDITION|failedPrecondition/i.test(e.reason)));

/** Names stand-in people from contacts; returns how many were renamed. */
export async function nameFromContacts(db: Db, userId: string, contacts: ContactPerson[]): Promise<number> {
  const names = new Map<string, string>();
  for (const c of contacts) {
    const name = c.names?.find((n) => n.displayName?.trim())?.displayName?.trim();
    if (!name || name.includes('@')) continue;
    for (const e of c.emailAddresses ?? [])
      if (e.value?.includes('@')) names.set(normalizeEmail(e.value), name);
  }
  if (!names.size) return 0;
  const rows = await db.query<Record<string, unknown> & { addr: string }>(
    `select ${PERSON_COLUMNS}, pi.value_norm as addr from orbit.person_identities pi
       join orbit.people p on p.id = pi.person_id
      where pi.user_id = $1::uuid and pi.kind = 'email' and pi.value_norm = any($2::text[])
        and not p.is_self and p.merged_into is null and p.deleted_at is null`,
    [userId, [...names.keys()]],
  );
  let renamed = 0;
  const done = new Set<string>();
  for (const r of rows) {
    const id = r.id as string;
    if (done.has(id)) continue;
    const person = toPerson(r, [{ kind: 'email', value_norm: r.addr }]);
    if (!isPlaceholderName(person)) continue;
    const n = parseName(names.get(r.addr));
    if (!n.full) continue;
    done.add(id);
    await db.sql`
      update orbit.people set display_name = ${n.full}, first_name = ${n.first || null}, last_name = ${n.last || null},
             name_norm = ${n.normalized}
       where id = ${id}::uuid and user_id = ${userId}::uuid`;
    renamed++;
  }
  return renamed;
}

export function contactsHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  const google = googleFor(deps);
  return {
    'sync.contacts': async (job, ctx) => {
      const userId = job.userId;
      if (!userId) throw new JobSkipped('no_user');
      const acct = await loadAccount(ctx.db, userId, 'google');
      if (!acct) throw new JobSkipped('not_connected');
      if (acct.status !== 'active') throw new JobSkipped(acct.status);
      if (!acct.scopes.some((s) => /contacts/.test(s))) throw new JobSkipped('missing_scope');
      const api = contactsApi(google(ctx.db), userId);
      await ctx.queue.setVt(job.queue, job.msgId, LONG_VT_SEC);
      const now = ctx.now();
      const state = acct.syncState.contacts ?? {};
      const patch: Record<string, unknown> = {};
      let renamed = 0;
      try {
        for (const source of SOURCES) {
          const key = `${source}SyncToken`;
          let syncToken = typeof state[key] === 'string' ? (state[key] as string) : undefined;
          let pageToken: string | undefined;
          for (let i = 0; i < PAGES_MAX; i++) {
            let page: Awaited<ReturnType<typeof api.list>>;
            try {
              page = await api.list(source, { pageToken, syncToken });
            } catch (e) {
              if (expired(e) && syncToken) {
                syncToken = undefined;
                pageToken = undefined;
                continue;
              }
              // the user did not grant this source's scope
              if (e instanceof GoogleApiError && e.status === 403) break;
              throw e;
            }
            renamed += await nameFromContacts(ctx.db, userId, page.people);
            pageToken = page.nextPageToken;
            if (!pageToken) {
              if (page.nextSyncToken) patch[key] = page.nextSyncToken;
              break;
            }
          }
        }
      } catch (e) {
        if (e instanceof NeedsReauth) throw new JobSkipped('needs_reauth');
        throw e;
      }
      await patchSyncState(ctx.db, userId, 'google', 'contacts', {
        ...patch,
        renamed,
        syncedAt: now.toISOString(),
      });
    },
  };
}
