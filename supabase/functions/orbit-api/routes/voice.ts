/**
 * The student's voice (plan 29 §B2.4, §B4):
 *   GET|POST /voice                 → {card, cardProse, notes, soundsLikeYou, relearnedAt}: the card in sentences,
 *                                      the notes in force, and how much recent drafts sound like the student
 *   POST /voice/notes {id, action}  → {note}: keep or forget one note; a forgotten note is never learned again
 *   POST /voice/relearn             → {queued}: the sent mail embedded, the card learned again from it and the edits
 *                                      read into notes, in the background
 */
import type { VoiceNoteResponse, VoiceRelearnResponse } from '@orbit/core/server/api';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { decideNote, queueRelearn, voiceStatus } from '../../_shared/voice/voice.ts';
import type { Ctx, Route } from '../api.ts';
import { body } from './body.ts';

async function status(ctx: Ctx): Promise<Response> {
  if (ctx.req.method === 'POST') await ctx.req.body?.cancel();
  return json(200, await voiceStatus(ctx.db, ctx.userId!, ctx.now()));
}

async function notes(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (typeof b.id !== 'string' || !b.id.trim() || b.id.length > 100) throw badRequest('id names a note');
  if (b.action !== 'keep' && b.action !== 'forget') throw badRequest('action is keep or forget');
  const note = await decideNote(ctx.db, ctx.userId!, b.id, b.action, ctx.now());
  if (!note) throw new HttpError(404, 'not_found', 'no such note');
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${ctx.userId!}::uuid, 'user', ${`voice.note.${b.action}`}, 'users', ${ctx.userId!}, ${{ note: b.id }}::jsonb)`;
  const out: VoiceNoteResponse = { note };
  return json(200, out);
}

async function relearn(ctx: Ctx): Promise<Response> {
  await ctx.req.body?.cancel();
  await queueRelearn(ctx.services().queue, ctx.userId!, ctx.now());
  const out: VoiceRelearnResponse = { queued: true };
  return json(200, out);
}

export const voiceRoutes: Record<string, Route> = {
  '/voice': { method: 'GET|POST', auth: true, run: status },
  '/voice/notes': { method: 'POST', auth: true, run: notes },
  '/voice/relearn': { method: 'POST', auth: true, run: relearn },
};
