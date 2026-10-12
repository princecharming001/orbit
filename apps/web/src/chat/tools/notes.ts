/** Notes: save what was said in a conversation, and say who an unmatched note was with. */
import { STAGE_LABELS } from '@orbit/core';
import { z } from 'zod/v4';
import { db } from '../../db/schema';
import { ingestNote, rematchNote } from '../../engine/notes';
import {
  type AnyTool,
  defineTool,
  fmtWhen,
  ok,
  personRef,
  plural,
  requirePerson,
  toModel,
  wrapped,
} from './_shared';

const SOURCES = ['manual', 'wispr_capture', 'granola_email', 'upload'] as const;

async function stageOf(personId?: string) {
  if (!personId) return undefined;
  return (await db.chats.where('personId').equals(personId).toArray()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )[0]?.stage;
}

export const addNote = defineTool({
  name: 'add_note',
  kind: 'write',
  description:
    'Call this when the student gives notes from a conversation ("add a note from my chat with Priya: she leads payments onboarding, offered to refer me, I will send my resume by Friday"), dictates them, pastes a notetaker summary, or attaches a notes file. Pass personId when they named the person; otherwise call preview_note_match first and ask if it returns several. Orbit extracts facts and promises, may move the chat to Completed, drafts the thank-you, and raises a match card when it cannot tell who the note was with.',
  input: z.object({
    text: z.string().min(1).describe('The notes, as given.'),
    source: z
      .enum(SOURCES)
      .optional()
      .describe(
        'manual (typed, default), wispr_capture (dictated), granola_email (a notetaker app summary), upload (a file).',
      ),
    personId: z.string().optional().describe('Who the conversation was with, when known.'),
    when: z
      .string()
      .optional()
      .describe(
        'When the conversation happened, ISO 8601; default now. A note dated before a booked chat does not complete that chat.',
      ),
    title: z.string().optional().describe('A title for the note, optional.'),
  }),
  capabilities: ['note_save', 'note_upload_file', 'person_add_note', 'note_clear_draft'],
  progress: 'Saving your notes',
  async execute(input, ctx) {
    const person = input.personId ? await requirePerson(ctx, input.personId) : undefined;
    const when = input.when ? new Date(input.when) : ctx.now;
    if (Number.isNaN(when.getTime())) throw new Error('Orbit could not read that date. Give it as ISO 8601.');
    const before = await stageOf(person?.id);
    const n = await ingestNote(
      ctx.user,
      {
        text: input.text,
        source: input.source ?? 'manual',
        personIds: person ? [person.id] : undefined,
        occurredAt: when.toISOString(),
        title: input.title,
      },
      ctx.now,
    );
    const [facts, promises] = await Promise.all([
      db.facts
        .where('userId')
        .equals(ctx.user.id)
        .filter((f) => f.sourceId === n.id && !f.deletedAt)
        .toArray(),
      db.actionItems
        .where('userId')
        .equals(ctx.user.id)
        .filter((a) => a.sourceId === n.id)
        .toArray(),
    ]);
    const who = n.personIds[0] ? await db.people.get(n.personIds[0]) : undefined;
    const thanks = who
      ? await db.suggestions
          .where('userId')
          .equals(ctx.user.id)
          .filter((x) => x.status === 'pending' && x.kind === 'thank_you' && x.personId === who.id)
          .first()
      : undefined;
    const thankDraft = thanks?.outboundMessageId
      ? await db.outbound.get(thanks.outboundMessageId)
      : undefined;
    const after = await stageOf(who?.id);
    const moved =
      after && after !== before && who ? ` Moved ${who.firstName} to ${STAGE_LABELS[after]}.` : '';
    const out = {
      noteId: n.id,
      matchStatus: n.matchStatus,
      person: who ? personRef(who) : undefined,
      when: fmtWhen(n.occurredAt, ctx),
      summary: wrapped(ctx, 'note', n.summary, 400),
      facts: facts.map((f) => ({ id: f.id, type: f.type, text: wrapped(ctx, 'fact', f.text, 200) })),
      promises: promises.map((a) => ({
        actionItemId: a.id,
        text: wrapped(ctx, 'promise', a.text, 200),
        dueAt: a.dueAt,
      })),
      stage: after ? STAGE_LABELS[after] : undefined,
      thankYou: thanks
        ? {
            cardId: thanks.id,
            draftId: thanks.outboundMessageId,
            firstLine: thankDraft
              ? wrapped(ctx, 'draft', (thankDraft.bodyFinal ?? thankDraft.bodyDraft).split('\n')[0], 160)
              : undefined,
          }
        : undefined,
    };
    if (n.matchStatus === 'unmatched') {
      const summary = n.personIds.length
        ? 'Saved. Orbit is not sure who this was with; check the match card on Today or say who with rematch_note.'
        : 'Saved. Who was this with? Say so with rematch_note, or it stays unfiled.';
      return ok('note', out, out, summary, `/notes/new?note=${n.id}`);
    }
    const found = [
      facts.length ? `${plural(facts.length, 'thing')} to remember` : '',
      promises.length ? `${plural(promises.length, 'promise')} you made` : '',
    ].filter(Boolean);
    const summary = `Saved${who ? ` for ${who.displayName}` : ''}.${found.length ? ` Orbit noted ${found.join(' and ')}.` : ''}${moved}${thanks ? ' Your thank-you draft is ready.' : ''}`;
    return ok(
      'note',
      out,
      out,
      summary,
      who ? `/people/${who.id}${facts.length && !thanks ? '?tab=facts' : ''}` : '/today',
    );
  },
  toModel,
});

export const rematchNoteTool = defineTool({
  name: 'rematch_note',
  kind: 'write',
  description:
    'Call this only when the student says who a note was with that Orbit could not match ("that note from Tuesday was with Priya"), or that it was with nobody they track (no personId). Whatever a wrong guess wrote from the note is undone, and the note is processed for the chosen person.',
  input: z.object({
    noteId: z.string().describe('The note id (from the match card or list_notes).'),
    personId: z.string().optional().describe('Who it was with; leave out for "nobody I track".'),
  }),
  capabilities: ['note_rematch', 'card_note_match_pick'],
  progress: 'Filing the note',
  async execute(input, ctx) {
    const note = await db.notes.get(input.noteId);
    if (!note || note.userId !== ctx.user.id) throw new Error('Orbit has no note with that id.');
    const person = input.personId ? await requirePerson(ctx, input.personId) : undefined;
    await rematchNote(ctx.user, note.id, person?.id, ctx.now);
    const fresh = (await db.notes.get(note.id))!;
    const out = {
      noteId: fresh.id,
      matchStatus: fresh.matchStatus,
      person: person ? personRef(person) : undefined,
    };
    return ok(
      'note',
      out,
      out,
      person ? `Note filed with ${person.displayName} and processed for them.` : 'Saved without a person.',
      person ? `/people/${person.id}?tab=facts` : '/today',
    );
  },
  toModel,
});

export const noteTools: AnyTool[] = [addNote, rematchNoteTool];
