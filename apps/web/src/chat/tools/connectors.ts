/**
 * Live LinkedIn (Unipile) from the chat: sync it again, unlink it, and ask who the student knows who also knows
 * someone. Connecting itself happens in the LinkedIn setup widget (show_setup linkedin), because it needs the
 * student's own sign-in.
 */
import { db } from '../../db/schema';
import {
  disconnectLinkedInLive,
  LIVE_SOON,
  linkedInLiveStatus,
  liveLinkedInAvailable,
  mutualsFor,
  syncLinkedInLive,
} from '../../engine/linkedinLive';
import { z } from '../../zod';
import { readSetupStatus } from '../setupStatus';
import type { ResultEnvelope } from '../types';
import { type AnyTool, defineTool, ok, personRef, plural, requirePerson, toModel, wrapped } from './_shared';

export const syncLinkedinTool = defineTool({
  name: 'sync_linkedin',
  kind: 'write',
  description:
    'Call this when the student asks to sync, refresh or pull their LinkedIn connections again and LinkedIn is connected live (Settings shows LinkedIn (live)). It re-pulls every connection, adds new people and updates the rest (nobody is doubled), and refreshes who to meet. When LinkedIn is not connected live, or live sync is not switched on yet, it shows the LinkedIn setup widget instead, which connects it or takes the export.',
  input: z.object({}),
  capabilities: ['linkedin_live_sync'],
  progress: 'Syncing your LinkedIn',
  async execute(_input, ctx): Promise<ResultEnvelope> {
    const r = await syncLinkedInLive(ctx.user, { signal: ctx.signal });
    if (r.ok) {
      const out = {
        source: 'LinkedIn',
        connections: r.rows,
        added: r.added,
        updated: r.updated,
        recommended: r.recommended,
      };
      const lead = `LinkedIn synced: ${plural(r.rows, 'connection')}, ${r.added} new, ${r.updated} updated.`;
      return ok(
        'import',
        { source: 'LinkedIn', counts: { connections: r.rows, new: r.added, updated: r.updated } },
        out,
        r.recommended && r.added ? `${lead} ${r.recommended} worth a coffee chat are on Discover.` : lead,
        r.added && r.recommended ? '/discover' : '/people',
      );
    }
    if (r.reason === 'error') throw new Error(`LinkedIn did not sync: ${r.message}`);
    // not connected live, or not switched on yet: the widget connects it or takes the export
    const status = await readSetupStatus(ctx.user.id, 'linkedin');
    const summary =
      r.reason === 'unconfigured' || !liveLinkedInAvailable(ctx.user)
        ? `${LIVE_SOON} The widget takes a LinkedIn export file too.`
        : 'LinkedIn is not connected live yet. The widget has the Connect LinkedIn button.';
    return { kind: 'setup', data: status, summary, href: '/settings/integrations' };
  },
  toModel: (d) => toModel(d),
});

export const disconnectLinkedinTool = defineTool({
  name: 'disconnect_linkedin',
  kind: 'risky',
  description:
    "Call this only when the student asks to disconnect or unlink LinkedIn, or to stop syncing it live. Unipile unlinks the account and Orbit stops syncing; every person already imported stays. It does not delete the LinkedIn export import. Needs the student's approval.",
  input: z.object({}),
  capabilities: ['linkedin_live_disconnect'],
  progress: 'Disconnecting LinkedIn',
  async summarizeIntent(_input, ctx) {
    const st = await linkedInLiveStatus(ctx.user);
    return {
      text: 'Disconnect LinkedIn. Orbit stops syncing your connections; everyone already imported stays.',
      blockedReason: st.connected ? undefined : 'LinkedIn is not connected live.',
    };
  },
  async execute(_input, ctx) {
    const r = await disconnectLinkedInLive(ctx.user);
    if (!r.ok) throw new Error(r.message);
    const out = { connected: false, unlinkedAtUnipile: r.unlinkedAtUnipile };
    return ok(
      'settings',
      out,
      out,
      r.unlinkedAtUnipile
        ? 'Disconnected LinkedIn. Everyone already imported stays in Orbit.'
        : 'Orbit stopped syncing LinkedIn and everyone imported stays. Unipile could not be reached to unlink the account, so try disconnecting again later.',
      '/settings/integrations',
    );
  },
  toModel,
});

export const getMutualConnections = defineTool({
  name: 'get_mutual_connections',
  kind: 'read',
  description:
    "Call this when the student asks who they know who knows someone, for mutual connections with a person, or who could vouch for them with that person (give the personId from search_people). It asks LinkedIn (live, through Unipile) for the people in their network connected to that person. When LinkedIn is not connected live it says so; then find_routes gives Orbit's own routes instead.",
  input: z.object({
    personId: z.string().describe('The person to find mutual connections with (from search_people).'),
  }),
  capabilities: ['mutual_connections'],
  progress: 'Looking for mutual connections',
  async execute(input, ctx) {
    const target = await requirePerson(ctx, input.personId);
    const r = await mutualsFor(ctx.user, target, { signal: ctx.signal });
    if (!r.ok)
      return ok(
        'text',
        { target: personRef(target), mutuals: [], reason: r.reason },
        { target: personRef(target), mutuals: [], reason: r.reason },
        r.reason === 'not_connected' || r.reason === 'unconfigured'
          ? `${r.message} Orbit's own routes to ${target.firstName} still work.`
          : r.message,
        `/people/${target.id}`,
      );
    const ids = r.mutuals.map((m) => m.personId).filter((id): id is string => !!id);
    const rows = ids.length ? await db.people.bulkGet(ids) : [];
    const known = new Map(rows.filter((p) => !!p).map((p) => [p!.id, p!]));
    const people = r.mutuals
      .map((m) => (m.personId ? known.get(m.personId) : undefined))
      .filter((p) => !!p)
      .map((p) => ({ ...personRef(p!), why: p!.headline }));
    const names = r.mutuals.map((m) => m.name);
    const summary = r.mutuals.length
      ? `${plural(r.mutuals.length, 'mutual connection')} with ${target.displayName}${names.length ? `, including ${names.slice(0, 2).join(' and ')}` : ''}.`
      : `No mutual connections with ${target.displayName} on LinkedIn.`;
    return ok(
      'people',
      { target: personRef(target), people, source: r.source },
      {
        target: personRef(target),
        source: r.source,
        mutuals: r.mutuals.map((m) => ({
          personId: m.personId,
          who: wrapped(ctx, 'linkedin', [m.name, m.headline].filter(Boolean).join(', '), 200),
        })),
      },
      summary,
      `/people/${target.id}`,
    );
  },
  toModel,
});

export const connectorTools: AnyTool[] = [syncLinkedinTool, disconnectLinkedinTool, getMutualConnections];
