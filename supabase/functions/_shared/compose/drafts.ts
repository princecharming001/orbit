/**
 * orbit.drafts rows as the API returns them (ServerDraft), and the lookups the draft routes share.
 */
import type { ServerDraft } from '@orbit/core/server/api';
import type { MessageKind } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { iso } from '../rows.ts';
import { askUserMarkers } from './prompts.ts';

export type DraftRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  person_id: string;
  chat_id: string | null;
  goal_id: string | null;
  channel: 'gmail' | 'linkedin';
  kind: string;
  subject: string | null;
  body: string;
  status: ServerDraft['status'];
  ask: DraftMeta | null;
  hooks: { text: string; sourceId: string }[];
  via: Record<string, unknown> | null;
  thread_external_id: string | null;
  in_reply_to: string | null;
  autonomy_level: number;
  send_at: Date | string | null;
  sent_at: Date | string | null;
  provider_message_id: string | null;
  error: string | null;
  cancel_reason: string | null;
  validator: ServerDraft['validator'];
  generated_by: string;
  prompt_version: string | null;
  /** plan 29 §B3: not sent before this (the evening review), which rung sent it on its own, how it ended */
  review_until: Date | string | null;
  auto_rung: string | null;
  outcome: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** What drafts.ask holds: the ask, plus what the send path needs to know about how the draft came to be. */
export interface DraftMeta {
  kind: string;
  text: string;
  /** the inbound message a reply answers */
  replyToMessageId?: string;
  /** slot starts offered in the message (a time beyond these is a new commitment, §14.6) */
  slots?: string[];
  /** why cadence drafted it */
  reason?: string;
  /** the compliance footer added to a sales first touch (§7.7) */
  footer?: string;
}

export function toServerDraft(r: DraftRow): ServerDraft {
  return {
    id: r.id,
    personId: r.person_id,
    chatId: r.chat_id ?? null,
    goalId: r.goal_id ?? null,
    channel: r.channel,
    kind: r.kind as MessageKind,
    subject: r.subject ?? null,
    body: r.body,
    status: r.status,
    sendAt: iso(r.send_at),
    sentAt: iso(r.sent_at),
    validator: r.validator ?? null,
    generatedBy: r.generated_by === 'llm' ? 'llm' : 'template',
    hooks: Array.isArray(r.hooks) ? r.hooks : [],
    needsInput: askUserMarkers(`${r.subject ?? ''}\n${r.body}`),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export async function loadDraft(db: Db, userId: string, draftId: unknown): Promise<DraftRow> {
  if (typeof draftId !== 'string' || !/^[0-9a-f-]{36}$/i.test(draftId))
    throw new HttpError(400, 'bad_request', 'draftId is required');
  const [r] = await db.sql<DraftRow>`
    select * from orbit.drafts where id = ${draftId}::uuid and user_id = ${userId}::uuid`;
  if (!r) throw new HttpError(404, 'not_found', 'no such draft');
  return r;
}

export async function draftById(db: Db, draftId: string): Promise<DraftRow | undefined> {
  const [r] = await db.sql<DraftRow>`select * from orbit.drafts where id = ${draftId}::uuid`;
  return r;
}
