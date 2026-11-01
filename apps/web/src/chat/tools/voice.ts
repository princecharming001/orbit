/**
 * The student's voice in the chat (plan 29 §B5): what Orbit learned about how they write (the card in sentences, the
 * notes from their edits, how much recent drafts sound like them) and forgetting one note, by its id or by the words
 * the student uses for it. One engine call each (engine/voice.ts), which reads the server for an account and this
 * browser otherwise. A forgotten note is never learned again, and drafts stop following it at once.
 */
import type { VoiceNote } from '@orbit/core';
import { findVoiceNote } from '@orbit/core';
import { decideNote, readVoice, type VoiceView } from '../../engine/voice';
import { z } from '../../zod';
import { type AnyTool, clip, defineTool, ok, plural, toModel } from './_shared';

/** The notes as the model reads them: the id to forget one by, the words, kept or learned, and how many edits. */
function notesForModel(notes: VoiceNote[]) {
  return notes.map((n) => ({
    id: n.id,
    text: n.text,
    kept: !!n.keptAt,
    edits: n.evidence.length,
  }));
}

/** The notes as one line each, numbered, for the summary. */
function notesLine(notes: VoiceNote[]): string {
  return notes.map((n, i) => `${i + 1}) ${n.text}${n.keptAt ? ' (kept)' : ''}`).join('; ');
}

function scoreLine(v: VoiceView): string {
  return v.soundsLikeYou === null ? '' : ` Recent drafts sound like you ${v.soundsLikeYou.toFixed(1)} of 3.`;
}

export const listVoiceNotesTool = defineTool({
  name: 'list_voice_notes',
  kind: 'read',
  description:
    'Call this when the student asks what Orbit has learned about how they write ("what have you learned about how I write", "show my voice notes", "what do you know about my style"). Returns their style card as sentences, the notes Orbit learned from their edits (each with an id, whether they kept it, and how many edits back it), and the sounds-like-you score. Quote the notes as given; never invent one.',
  input: z.object({}),
  capabilities: ['voice_notes'],
  progress: 'Reading what Orbit learned about how you write',
  async execute(_input, ctx) {
    const v = await readVoice(ctx.user);
    const style = v.cardProse[0] ?? '';
    const shown = v.notes.slice(0, 3);
    const more = v.notes.length > shown.length ? `, and ${v.notes.length - shown.length} more` : '';
    const learned = v.notes.length
      ? `From your edits: ${notesLine(shown)}${more}.`
      : v.edits
        ? `Nothing learned from your ${plural(v.edits, 'edit')} yet; a pattern needs two or more.`
        : 'Nothing learned from your edits yet; Orbit notes what you change in a draft before it goes.';
    const data = {
      cardProse: v.cardProse,
      notes: notesForModel(v.notes),
      soundsLikeYou: v.soundsLikeYou,
      edits: v.edits,
      ownWords: v.ownWords.map((w) => ({ question: w.label, answer: clip(w.text, 300) })),
      mode: v.mode,
      ...(v.offline
        ? { offline: 'The account could not be read just now: these are the notes this browser has.' }
        : {}),
    };
    return ok('text', data, data, `${style} ${learned}${scoreLine(v)}`.trim(), '/settings/voice');
  },
  toModel,
});

export const forgetVoiceNoteTool = defineTool({
  name: 'forget_voice_note',
  kind: 'write',
  description:
    'Call this when the student wants Orbit to forget something it learned about how they write ("forget the note about Thanks either way", "drop that voice note"). Give the noteId from list_voice_notes, or the note in the student\'s words. A forgotten note is never learned again and drafts stop following it. Without either, it lists the notes so the student can say which.',
  input: z.object({
    noteId: z.string().max(100).optional().describe('The note (from list_voice_notes).'),
    note: z.string().max(300).optional().describe('The note, as the student says it.'),
  }),
  capabilities: ['voice_forget'],
  progress: 'Forgetting the note',
  async execute(input, ctx) {
    const v = await readVoice(ctx.user);
    const said = (input.noteId ?? input.note ?? '').trim();
    const note = said ? findVoiceNote(v.notes, said) : undefined;
    if (!note) {
      const list = v.notes.length
        ? `The notes: ${notesLine(v.notes)}.`
        : 'Orbit has learned nothing from your edits yet.';
      const summary = said
        ? `No note of mine matches "${clip(said, 80)}". ${list}`
        : `Which one should I forget? ${list}`;
      return ok(
        'text',
        { forgotten: null, notes: notesForModel(v.notes) },
        { forgotten: null, notes: notesForModel(v.notes) },
        summary,
        '/settings/voice',
      );
    }
    const r = await decideNote(ctx.user.id, note.id, 'forget', ctx.now);
    if (!r.ok) throw new Error(r.message);
    return ok(
      'settings',
      { changes: [{ label: 'Voice note', to: 'Forgotten' }] },
      { forgotten: { id: note.id, text: note.text }, neverRelearned: true },
      `Forgotten: "${note.text}". Orbit will not learn it again, and your drafts stop following it.`,
      '/settings/voice',
    );
  },
  toModel,
});

export const voiceTools: AnyTool[] = [listVoiceNotesTool, forgetVoiceNoteTool];
