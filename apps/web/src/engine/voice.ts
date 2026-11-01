/**
 * The student's voice in the browser (plan 29 §B2.4, §B5).
 *
 * Keeping the card current: every tenth send learns the card again from what the student wrote (`learnStyle`) and,
 * for an account, gives it to the server through /settings/profile, so the server's drafts and its voice check read
 * the same card this browser drafts with.
 *
 * Edits: every send whose words the student changed is kept as a typed `draftEdits` row (what Orbit wrote, what
 * went), in both modes; the outbox takes an account's to orbit.draft_edits.
 *
 * Notes: what the edits show, one line each, kept or forgotten in Settings, Voice and the chat. An account reads them
 * from the server (GET /voice), which distills them every night; this browser keeps a copy in settings.voiceNotes so
 * its own drafts follow them. In local mode the notes live in settings.voiceNotes alone and are distilled here,
 * through the student's own Claude key when there is one, else as plain observations (the phrases they cut or
 * replace most). A forgotten note is never learned again, in either mode.
 */
import type {
  DraftEdit,
  LearnedNote,
  OutboundMessage,
  OwnWordsKey,
  StyleCard,
  Suggestion,
  User,
  VoiceNote,
} from '@orbit/core';
import {
  activeVoiceNotes,
  cardProse,
  decideVoiceNote,
  editObservations,
  findVoiceNote,
  meanVoiceScore,
  mergeVoiceNotes,
  newId,
  OWN_WORDS_QUESTIONS,
  ownWordsOf,
  VOICE_EDITS_FOR_DISTILL,
  VOICE_LEARN_EVERY,
  voiceCheck,
  voiceScore,
  wordEditDistance,
} from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';
import { pushProfileSettings } from './settings';
import { currentStyleCard, learnStyle } from './style';

const sendsKey = (userId: string) => `voice.sends:${userId}`;

/** Give the card this browser drafts with to the server (account mode only); resolves to whether it took it. */
export async function shareStyleCard(userId: string, card?: StyleCard): Promise<boolean> {
  if (!isServerUser(userId)) return false;
  const c = card ?? (await db.styles.get(userId))?.card;
  if (!c) return false;
  return pushProfileSettings(userId, { styleCard: c });
}

/**
 * One more message went out: every VOICE_LEARN_EVERY sends the card is learned again from everything the student
 * wrote, and an account's server gets the new card. Never throws; returns whether it learned this time.
 */
export async function noteSendForVoice(
  user: Pick<User, 'id' | 'firstName'>,
  now = new Date(),
): Promise<boolean> {
  try {
    const key = sendsKey(user.id);
    const had = Number((await db.kv.get(key))?.value) || 0;
    const count = had + 1;
    if (count < VOICE_LEARN_EVERY) {
      await db.kv.put({ key, value: count });
      return false;
    }
    await db.kv.put({ key, value: 0 });
    // local mode reads its own edits into notes at the same beat; an account's server does it every night
    if (!isServerUser(user.id)) await distillLocal(user, now).catch(() => undefined);
    const r = await learnStyle(user, { now });
    if (!r.ok) return false;
    await shareStyleCard(user.id, r.card);
    return true;
  } catch {
    return false;
  }
}

/**
 * An edited send, typed (plan 29 §B2.4): what Orbit wrote and what the student sent, every time the words changed,
 * whether a card raised the draft or not. For an account the outbox takes it to orbit.draft_edits.
 */
export async function recordEdit(
  userId: string,
  msg: Pick<OutboundMessage, 'id' | 'kind' | 'bodyDraft' | 'bodyFinal'>,
  suggestion?: Pick<Suggestion, 'payload'>,
  now = new Date(),
): Promise<DraftEdit | undefined> {
  const after = (msg.bodyFinal ?? '').trim();
  const before = msg.bodyDraft.trim();
  if (!after || !before || after.replace(/\s+/g, ' ') === before.replace(/\s+/g, ' ')) return undefined;
  const cls = suggestion?.payload?.replyClass;
  const edit: DraftEdit = {
    id: newId('edit'),
    userId,
    draftId: msg.id,
    kind: msg.kind,
    ...(typeof cls === 'string' ? { replyClass: cls } : {}),
    before,
    after,
    distance: wordEditDistance(before, after),
    createdAt: now.toISOString(),
  };
  // one row per draft: sent again after another edit, the newer words replace the older
  const had = await db.draftEdits.where('draftId').equals(msg.id).first();
  if (had) await db.draftEdits.update(had.id, { after, distance: edit.distance });
  else await db.draftEdits.add(edit);
  return had ? { ...had, after, distance: edit.distance } : edit;
}

// ---- notes ------------------------------------------------------------------------------------------------------

/** Everything Settings, Voice and the chat show about the student's voice. */
export interface VoiceView {
  mode: 'account' | 'local';
  card: StyleCard;
  /** the card as sentences */
  cardProse: string[];
  /** the notes in force (kept, or learned and not yet forgotten) */
  notes: VoiceNote[];
  /** 0 to 3, how much recent drafts sound like the student; null before there are any */
  soundsLikeYou: number | null;
  relearnedAt: string | null;
  /** what the student wrote about themselves in setup that drafts draw on, with the question each answers */
  ownWords: { key: OwnWordsKey; label: string; text: string }[];
  /** edits kept so far */
  edits: number;
  /** the account could not be read just now: the notes shown are this browser's copy */
  offline?: boolean;
}

/** The answers drafts use to sound like the student (plan 24), in the order setup asked them. */
const VOICE_WORDS: OwnWordsKey[] = ['story', 'aim', 'proudOf', 'neverDo'];

async function ownWordsFor(userId: string): Promise<VoiceView['ownWords']> {
  const words = ownWordsOf(await db.goals.get(userId));
  return VOICE_WORDS.filter((k) => words[k]).map((k) => ({
    key: k,
    label: OWN_WORDS_QUESTIONS[k].label,
    text: words[k] as string,
  }));
}

/** The notes this browser keeps (the account's copy, or local mode's own). */
export async function storedVoiceNotes(userId: string): Promise<VoiceNote[]> {
  return (await db.settings.get(userId))?.voiceNotes ?? [];
}

async function saveNotes(userId: string, notes: VoiceNote[]): Promise<void> {
  await db.settings.update(userId, { voiceNotes: notes });
}

/** The newest drafts Orbit wrote here, read for "sounds like you" by the voice check. */
async function localScore(userId: string, card: StyleCard, notes: VoiceNote[]): Promise<number | null> {
  const since = Date.now() - 30 * 86_400_000;
  const recent = (await db.outbound.where('userId').equals(userId).toArray())
    .filter((o) => o.channel === 'gmail' && Date.parse(o.createdAt) >= since && o.status !== 'cancelled')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);
  return meanVoiceScore(
    recent.map((o) => voiceScore(voiceCheck({ body: o.bodyDraft, subject: o.subject }, { card, notes }))),
  );
}

/**
 * The voice as it stands: for an account, the server's card in sentences, notes and score (a copy of the notes kept
 * here so drafting follows them); in local mode, this browser's own.
 */
export async function readVoice(user: Pick<User, 'id' | 'firstName'>): Promise<VoiceView> {
  const [card, ownWords, edits] = await Promise.all([
    currentStyleCard(user),
    ownWordsFor(user.id),
    db.draftEdits.where('userId').equals(user.id).count(),
  ]);
  if (isServerUser(user.id)) {
    const r = await callApi('/voice', {});
    if (r.ok) {
      const kept = await storedVoiceNotes(user.id);
      // the forgotten ones stay in the copy so this browser never shows them again either
      const forgotten = kept.filter((n) => n.forgottenAt && !r.value.notes.some((x) => x.id === n.id));
      await saveNotes(user.id, [...r.value.notes, ...forgotten]);
      return {
        mode: 'account',
        card: r.value.card ?? card,
        cardProse: r.value.cardProse.length ? r.value.cardProse : cardProse(card),
        notes: r.value.notes,
        soundsLikeYou: r.value.soundsLikeYou,
        relearnedAt: r.value.relearnedAt,
        ownWords,
        edits,
      };
    }
    const notes = activeVoiceNotes(await storedVoiceNotes(user.id));
    return {
      mode: 'account',
      card,
      cardProse: cardProse(card),
      notes,
      soundsLikeYou: null,
      relearnedAt: null,
      ownWords,
      edits,
      offline: true,
    };
  }
  const notes = await storedVoiceNotes(user.id);
  const live = activeVoiceNotes(notes);
  const learnedAt = (await db.kv.get(`voice.distilledAt:${user.id}`))?.value;
  return {
    mode: 'local',
    card,
    cardProse: cardProse(card),
    notes: live,
    soundsLikeYou: await localScore(user.id, card, live),
    relearnedAt: typeof learnedAt === 'string' ? learnedAt : null,
    ownWords,
    edits,
  };
}

export type NoteOutcome = { ok: true; note: VoiceNote } | { ok: false; message: string };

/** Keep or forget one note, on the account or here; a forgotten note is never learned again. */
export async function decideNote(
  userId: string,
  id: string,
  action: 'keep' | 'forget',
  now = new Date(),
): Promise<NoteOutcome> {
  if (isServerUser(userId)) {
    const r = await callApi('/voice/notes', { id, action });
    if (!r.ok) return { ok: false, message: r.message };
    const mine = await storedVoiceNotes(userId);
    const has = mine.some((n) => n.id === id);
    await saveNotes(
      userId,
      has ? mine.map((n) => (n.id === id ? r.value.note : n)) : [...mine, r.value.note],
    );
    return { ok: true, note: r.value.note };
  }
  const r = decideVoiceNote(await storedVoiceNotes(userId), id, action, now);
  if (!r.note) return { ok: false, message: 'Orbit has no such note.' };
  await saveNotes(userId, r.notes);
  return { ok: true, note: r.note };
}

/** Forget the note the student means, by id or by its words ("the one about Thanks either way"). */
export async function forgetNoteBySaying(
  user: Pick<User, 'id' | 'firstName'>,
  said: string,
  now = new Date(),
): Promise<NoteOutcome> {
  const view = await readVoice(user);
  const note = findVoiceNote(view.notes, said);
  if (!note) return { ok: false, message: "No note of Orbit's matches that." };
  return decideNote(user.id, note.id, 'forget', now);
}

/**
 * Local mode's distillation: the last thirty edits read into notes through the student's own Claude key, else as
 * plain observations, merged so a forgotten note never comes back. Returns how the notes were found.
 */
export async function distillLocal(
  user: Pick<User, 'id' | 'firstName'>,
  now = new Date(),
): Promise<{ by: 'claude' | 'observations' | 'too_few_edits'; added: VoiceNote[] }> {
  const edits = (await db.draftEdits.where('userId').equals(user.id).toArray())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, VOICE_EDITS_FOR_DISTILL)
    .map((e) => ({ id: e.id, kind: e.kind, before: e.before, after: e.after }));
  if (edits.length < 2) return { by: 'too_few_edits', added: [] };
  const current = await storedVoiceNotes(user.id);
  const ids = new Set(edits.map((e) => e.id));
  let by: 'claude' | 'observations' = 'observations';
  let learned: LearnedNote[] | undefined;
  try {
    const { llmVoiceNotes } = await import('../integrations/anthropic');
    learned = await llmVoiceNotes({
      card: await currentStyleCard(user),
      edits,
      kept: current.filter((n) => n.keptAt && !n.forgottenAt).map((n) => n.text),
      forgotten: current.filter((n) => n.forgottenAt).map((n) => n.text),
    });
  } catch {
    learned = undefined;
  }
  if (learned) {
    by = 'claude';
    learned = learned
      .map((n) => ({ ...n, evidence: n.evidence.filter((e) => ids.has(e)) }))
      .filter((n) => n.evidence.length > 0);
  } else learned = editObservations(edits);
  // the notes as they are now: one forgotten while Claude was reading stays forgotten
  const merged = mergeVoiceNotes(await storedVoiceNotes(user.id), learned, { now, newId: () => newId('vn') });
  await saveNotes(user.id, merged.notes);
  await db.kv.put({ key: `voice.distilledAt:${user.id}`, value: now.toISOString() });
  return { by, added: merged.added };
}

/**
 * "Relearn from my sent mail": the card learned again from everything the student wrote, given to the server, and
 * the edits read into notes (on the server for an account, here otherwise). Says what happened in a sentence.
 */
export async function relearnVoice(
  user: Pick<User, 'id' | 'firstName'>,
  now = new Date(),
): Promise<{ ok: boolean; message: string }> {
  const learned = await learnStyle(user, { now });
  if (learned.ok) await shareStyleCard(user.id, learned.card);
  if (isServerUser(user.id)) {
    const r = await callApi('/voice/relearn', {});
    if (!r.ok) return { ok: false, message: r.message };
    return {
      ok: true,
      message: 'Orbit is reading your sent mail and your edits again. The notes update in a few minutes.',
    };
  }
  const d = await distillLocal(user, now);
  if (!learned.ok && d.by === 'too_few_edits') return { ok: false, message: learned.reason };
  const n = d.added.length;
  return {
    ok: true,
    message:
      d.by === 'too_few_edits'
        ? 'Your style is learned again. Orbit needs two or more edits before it can say what they show.'
        : n
          ? `Your style is learned again, with ${n} new ${n === 1 ? 'note' : 'notes'} from your edits.`
          : 'Your style is learned again. Your edits show nothing new.',
  };
}

/** The notes drafting follows here: the ones in force (a forgotten note never shapes a draft). */
export async function notesInForce(userId: string): Promise<VoiceNote[]> {
  return activeVoiceNotes(await storedVoiceNotes(userId));
}
