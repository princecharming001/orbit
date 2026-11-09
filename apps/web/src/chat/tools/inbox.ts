/**
 * The student's inbox in chat: list_inbox reads every conversation (Gmail live, LinkedIn as synced), and the replies
 * to their outreach use the same card. One row a conversation, with the sender's face, never one row a message.
 */
import type { InboxItem, ReplyItem } from '@orbit/core';
import { listInbox } from '../../engine/inbox';
import { REPLY_CLASS_LABELS } from '../../engine/replies';
import { isServerUser } from '../../integrations/orbitApi';
import { z } from '../../zod';
import type { ResultEnvelope, ToolContext } from '../types';
import type { MessageRow } from '../ui/cards/MessagesCard';
import { type AnyTool, defineTool, ok, plural, toModel, wrapped } from './_shared';
import { needsAccount } from './network';

const GOOD_CLASSES = new Set(['interested', 'scheduling', 'question', 'referral']);

/** Same person, same channel: one row (the newest), with every message they sent counted. */
function onePerPerson<T extends { personKey: string; count: number; at: string }>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const had = out.get(r.personKey);
    if (!had) out.set(r.personKey, { ...r });
    else {
      const newer = r.at > had.at ? { ...r } : had;
      newer.count = had.count + r.count;
      out.set(r.personKey, newer);
    }
  }
  return [...out.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export function inboxRows(items: InboxItem[]): MessageRow[] {
  return onePerPerson(
    items.map((x) => ({
      personKey: `${x.channel}:${x.personId ?? x.fromEmail ?? x.key}`,
      key: x.key,
      name: x.fromName,
      channel: x.channel,
      personId: x.personId ?? null,
      photoUrl: x.photoUrl ?? null,
      linkedinUrl: x.linkedinUrl ?? null,
      subject: x.subject ?? null,
      snippet: x.snippet,
      at: x.receivedAt,
      count: x.count,
      unread: x.unread,
      tag: x.unread ? 'Unread' : x.replyToYou ? 'Replied to you' : undefined,
      good: !!x.replyToYou,
      href: x.href,
    })),
  ).map(({ personKey: _k, ...r }) => r);
}

export function replyRows(replies: ReplyItem[]): MessageRow[] {
  return onePerPerson(
    replies.map((x) => ({
      personKey: `${x.channel}:${x.personId ?? x.personName}`,
      key: x.messageId,
      name: x.personName,
      channel: x.channel === 'gmail' ? ('email' as const) : ('linkedin' as const),
      personId: x.personId,
      photoUrl: x.photoUrl ?? null,
      linkedinUrl: x.linkedinUrl ?? null,
      snippet: x.snippet,
      at: x.receivedAt,
      count: x.count ?? 1,
      tag: REPLY_CLASS_LABELS[x.replyClass],
      good: GOOD_CLASSES.has(x.replyClass),
      href: x.personId ? `/people/${x.personId}` : '/inbox?tab=replies',
    })),
  ).map(({ personKey: _k, ...r }) => r);
}

/** Conversations list_inbox reads (plan 35 A3: was 30); the Inbox page shows the rest. */
export const INBOX_ROWS = 15;

/** The replies card: one row a person, newest first, with the face and what their reply meant. */
/** How to word an answer about replies (plan 35 A2), sent with the result instead of in the system prompt. */
export const REPLIES_HOW_TO_ANSWER =
  'The card lists every reply, so answer now, never with a menu of options and never a heading, a list or a repeat of the card: say how many replied and name each person once, grouped by what happened (need you, picking a time, answered, nothing to do, closed), one short line a group, first names only, under 60 words. Someone who declined or asked to stop is closed: never suggest writing to them.';

export function repliesEnvelope(ctx: ToolContext, replies: ReplyItem[]): ResultEnvelope {
  const rows = replyRows(replies).slice(0, 25);
  // the model sees the same rows (one a person), so it never names someone twice
  const byKey = new Map(replies.map((r) => [r.messageId, r]));
  return ok(
    'messages',
    {
      title: rows.length ? plural(rows.length, 'reply', 'replies') : 'No replies',
      sub: 'To your outreach, last 30 days',
      rows,
    },
    {
      replies: rows.map((row) => {
        const x = byKey.get(row.key)!;
        return {
          messageId: x.messageId,
          personId: x.personId,
          person: wrapped(ctx, 'reply', x.personName, 80),
          channel: x.channel,
          kind: x.replyClass,
          snippet: wrapped(ctx, 'reply', x.snippet, 300),
          messages: row.count ?? 1,
          draftId: x.draftId,
          received: x.receivedAt.slice(0, 10),
        };
      }),
      note: 'Replies to the student’s own outreach only. Messages out of the blue are in list_inbox. Draft an answer only when the student asks (draft_reply).',
      howToAnswer: REPLIES_HOW_TO_ANSWER,
    },
    rows.length
      ? `${plural(rows.length, 'person', 'people')} replied to your outreach in the last 30 days.`
      : 'No replies to your outreach in the last 30 days.',
    '/inbox?tab=replies',
  );
}

const EMAIL_NOTE: Record<string, string | undefined> = {
  not_connected:
    'Gmail is not connected, so email is not shown. Connect Google under Settings, Integrations.',
  needs_reauth:
    'Google needs you to sign in again before Orbit can read your email (Settings, Integrations).',
  error: 'Gmail did not answer this time, so email is missing. Try again in a moment.',
};
const LINKEDIN_NOTE: Record<string, string | undefined> = {
  not_connected: 'LinkedIn is not connected, so LinkedIn messages are not shown.',
};

export const listInboxTool = defineTool({
  name: 'list_inbox',
  kind: 'read',
  description:
    'Call this when the student asks about their inbox or recent messages: "list my recent emails", "any new emails", "what LinkedIn messages did I get", "who messaged me today", "emails from Maya", "unread mail". Reads every conversation, not only replies to their outreach: email live from Gmail (the primary inbox; newsletters and notifications left out unless asked) and LinkedIn messages as synced. One row a conversation, newest first. Use channel "email" when they say email or mail, "linkedin" when they say LinkedIn. Needs an Orbit account.',
  input: z.object({
    channel: z
      .enum(['all', 'email', 'linkedin'])
      .optional()
      .describe('email for mail only, linkedin for LinkedIn only; all (the default) for both.'),
    days: z.number().int().min(1).max(30).optional().describe('How far back, in days (default 7).'),
    unreadOnly: z.boolean().optional().describe('Only unread email.'),
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Words or a name to look for (Gmail search syntax works for email, e.g. from:maya).'),
    includeAutomated: z.boolean().optional().describe('Keep newsletters, receipts and notifications.'),
  }),
  capabilities: ['inbox_list'],
  progress: 'Reading your inbox',
  async execute(input, ctx) {
    if (!isServerUser(ctx.user.id)) return needsAccount('Reading your inbox');
    const days = input.days ?? 7;
    const r = await listInbox(ctx.user, { ...input, days, limit: INBOX_ROWS });
    if (!r.ok) throw new Error(r.message);
    const rows = inboxRows(r.items);
    const notes = [EMAIL_NOTE[r.email], LINKEDIN_NOTE[r.linkedin]].filter((x): x is string => !!x);
    const where =
      input.channel === 'email' ? 'Email' : input.channel === 'linkedin' ? 'LinkedIn messages' : 'Inbox';
    const span = days === 1 ? 'today' : `last ${days} days`;
    const inSpan = days === 1 ? 'today' : `in the last ${days} days`;
    const email = rows.filter((x) => x.channel === 'email').length;
    const li = rows.length - email;
    const counted =
      input.channel === 'email' || input.channel === 'linkedin' || !rows.length
        ? plural(rows.length, 'conversation')
        : `${plural(rows.length, 'conversation')}: ${email} email, ${li} LinkedIn`;
    const byKey = new Map(r.items.map((x) => [x.key, x]));
    return ok(
      'messages',
      { title: `${where}, ${span}`, sub: notes[0] ?? `${counted}, newest first`, rows },
      {
        conversations: rows.map((row) => {
          const x = byKey.get(row.key)!;
          return {
            from: wrapped(ctx, 'inbox', x.fromName, 80),
            email: x.fromEmail ?? undefined,
            personId: x.personId ?? undefined,
            channel: x.channel,
            subject: wrapped(ctx, 'inbox', x.subject ?? undefined, 160),
            latest: wrapped(ctx, 'inbox', x.snippet, 240),
            messages: row.count,
            unread: x.unread || undefined,
            replyToYou: x.replyToYou || undefined,
            received: x.receivedAt,
          };
        }),
        email: r.email,
        linkedin: r.linkedin,
        linkedinSyncedAt: r.linkedinSyncedAt,
        note: 'The card shows these rows with faces. Do not list them again in prose; say in a line what stands out. Draft an answer only when the student asks.',
      },
      [rows.length ? `${counted} ${inSpan}.` : `Nothing ${inSpan}.`, ...notes].join(' '),
      input.channel === 'email' ? undefined : '/inbox',
    );
  },
  toModel,
});

export const inboxTools: AnyTool[] = [listInboxTool];
