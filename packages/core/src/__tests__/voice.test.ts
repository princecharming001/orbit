/**
 * The voice (plan 29 §B2.4): the card in sentences, notes merged with a cap and the forgotten-note rule, notes into
 * the card drafting reads, the observations a browser without a key shows, and the check before an auto send.
 */
import { describe, expect, it } from 'vitest';
import type { VoiceNote } from '../server/api';
import { buildStyleCard, defaultStyleCard } from '../style/card';
import {
  avoidOf,
  cardProse,
  decideVoiceNote,
  editObservations,
  findVoiceNote,
  mergeVoiceNotes,
  normaliseNoteText,
  VOICE_NOTES_MAX,
  voiceCheck,
  voiceScore,
  withVoiceNotes,
  wordEditDistance,
} from '../style/voice';

const NOW = new Date('2026-11-02T12:00:00Z');
let n = 0;
const newId = () => `vn_${++n}`;

const SENT = [
  "Hi Dana,\n\nI'm a junior at Cornell studying CS. I saw your post on the payments team and wanted to ask how you got there. Would you have 15 minutes next week?\n\nThanks,\nMaya",
  "Hi Leo,\n\nI'm working on a small ledger project and your talk on idempotency helped a lot. Could I ask you two questions about it sometime this month?\n\nThanks,\nMaya",
  "Hi Priya,\n\nI'm a Cornell junior and I'd love to hear how you picked Stripe over the bigger banks. Do you have 15 minutes in the next two weeks?\n\nThanks,\nMaya",
  "Hi Sam,\n\nThanks for the chat yesterday, it helped. I'll apply to the infra role this week and let you know how it goes.\n\nThanks,\nMaya",
];
const card = buildStyleCard(SENT, 'Maya');

const note = (over: Partial<VoiceNote> & { text: string }): VoiceNote => ({
  id: newId(),
  evidence: ['e1', 'e2'],
  createdAt: '2026-10-01T00:00:00.000Z',
  keptAt: null,
  forgottenAt: null,
  ...over,
});

describe('cardProse', () => {
  it('says the card in plain sentences, with no dashes or exclamation marks', () => {
    const prose = cardProse(card);
    expect(prose[0]).toBe('You greet with Hi and sign off with Thanks.');
    expect(prose.join(' ')).toMatch(
      /You write short, about \d+ words, with contractions and no exclamation marks\./,
    );
    expect(prose.join(' ')).toContain('Learned from 4 messages you wrote.');
    for (const p of [...prose, ...cardProse(defaultStyleCard('warm', 'Maya'))])
      expect(p).not.toMatch(/[!–—]/);
    expect(cardProse(defaultStyleCard('formal', 'Maya')).join(' ')).toContain('Orbit has not learned');
  });
});

describe('mergeVoiceNotes', () => {
  it('adds new notes, merges evidence into the same note, and never adds a forgotten one again', () => {
    const current = [
      note({ text: "You cut 'Thanks either way' every time", forgottenAt: '2026-10-20T00:00:00.000Z' }),
      note({ text: 'You sign with your first name only', keptAt: '2026-10-10T00:00:00.000Z' }),
    ];
    const r = mergeVoiceNotes(
      current,
      [
        // the forgotten one, reworded only by case and quotes: still forgotten
        { text: 'you cut "thanks either way" every time.', evidence: ['e7'] },
        // the same phrase as the forgotten one, said another way: its avoided phrase gives it away
        { text: 'You always drop the closing courtesy', avoid: 'Thanks either way', evidence: ['e8'] },
        { text: 'You sign with your first name only', evidence: ['e9'] },
        { text: 'You put the ask in the second sentence', evidence: ['e3', 'e4'] },
      ],
      { now: NOW, newId },
    );
    expect(r.added.map((x) => x.text)).toEqual(['You put the ask in the second sentence']);
    const live = r.notes.filter((x) => !x.forgottenAt);
    expect(live).toHaveLength(2);
    expect(live.find((x) => x.text.startsWith('You sign'))!.evidence).toEqual(['e1', 'e2', 'e9']);
    // the forgotten note is remembered, so the rule holds next time
    expect(r.notes.filter((x) => x.forgottenAt)).toHaveLength(1);
  });

  it('keeps at most eight live, kept notes first, then the newly learned', () => {
    const kept = Array.from({ length: 3 }, (_, i) =>
      note({ text: `Kept rule ${i}`, keptAt: '2026-10-01T00:00:00.000Z' }),
    );
    const old = Array.from({ length: 4 }, (_, i) => note({ text: `Old rule ${i}` }));
    const learned = Array.from({ length: 6 }, (_, i) => ({ text: `New rule ${i}`, evidence: [`n${i}`] }));
    const r = mergeVoiceNotes([...kept, ...old], learned, { now: NOW, newId });
    const live = r.notes.filter((x) => !x.forgottenAt);
    expect(live).toHaveLength(VOICE_NOTES_MAX);
    expect(live.filter((x) => x.keptAt)).toHaveLength(3);
    expect(live.filter((x) => x.text.startsWith('New'))).toHaveLength(5);
    expect(live.some((x) => x.text.startsWith('Old'))).toBe(false);
  });

  it('cleans what a model wrote: one line, no dashes, no exclamation marks', () => {
    const r = mergeVoiceNotes([], [{ text: 'You keep it short — always!', evidence: ['e1'] }], {
      now: NOW,
      newId,
    });
    expect(r.added[0]!.text).toBe('You keep it short, always.');
  });
});

describe('notes into the card, keep and forget', () => {
  it('adds the live notes to the card and their phrases to the avoid list', () => {
    const notes = [
      note({ text: "You cut 'Thanks either way' every time" }),
      note({ text: 'You never open with the connection line twice' }),
      note({ text: "You cut 'Hope this finds you well'", forgottenAt: NOW.toISOString() }),
    ];
    const c = withVoiceNotes(card, notes);
    expect(c.avoid).toEqual(['Thanks either way']);
    expect(c.notes).toContain('What Orbit learned from your edits');
    expect(c.notes).toContain('You never open with the connection line twice');
    expect(c.notes).not.toContain('Hope this finds you well');
    expect(withVoiceNotes(card, [])).toBe(card);
  });

  it('reads the avoided phrase from the note, not from an apostrophe', () => {
    expect(avoidOf({ text: "You don't say 'circle back'" })).toBe('circle back');
    expect(avoidOf({ text: "You're warm with alumni" })).toBeUndefined();
    expect(normaliseNoteText("You cut 'Thanks either way'.")).toBe('cut thanks either way');
  });

  it('forgets a note by id or by the words the student uses', () => {
    const notes = [note({ id: 'vn_a', text: "You cut 'Thanks either way' every time" })];
    expect(findVoiceNote(notes, 'thanks either way')?.id).toBe('vn_a');
    expect(findVoiceNote(notes, 'vn_a')?.id).toBe('vn_a');
    const r = decideVoiceNote(notes, 'vn_a', 'forget', NOW);
    expect(r.note?.forgottenAt).toBe(NOW.toISOString());
    expect(findVoiceNote(r.notes, 'thanks either way')).toBeUndefined();
  });
});

describe('editObservations', () => {
  it('finds the phrase the student cuts in several edits, and a word they always swap', () => {
    const edits = [1, 2, 3].map((i) => ({
      id: `e${i}`,
      before: `Hi Ana,\n\nI'm a junior at Cornell and would love to chat about Stripe. Would you be open to a quick call? Thanks either way.\n\nBest,\nMaya ${i}`,
      after: `Hi Ana,\n\nI'm a junior at Cornell and would love to chat about Stripe. Would you be open to a call?\n\nThanks,\nMaya ${i}`,
    }));
    const obs = editObservations(edits);
    expect(obs[0]).toMatchObject({
      text: "You cut 'Thanks either way' in 3 edits",
      avoid: 'Thanks either way',
    });
    expect(obs[0]!.evidence.sort()).toEqual(['e1', 'e2', 'e3']);
    expect(obs.find((o) => /'Best' to 'Thanks'/.test(o.text))).toMatchObject({ avoid: null });
    expect(obs.find((o) => o.text.startsWith("You cut 'quick'"))).toBeDefined();
    expect(wordEditDistance(edits[0]!.before, edits[0]!.after)).toBeGreaterThan(3);
  });

  it('says nothing from one edit when there are several', () => {
    expect(
      editObservations([
        { id: 'a', before: 'Hi Ana, quick note. Thanks either way.', after: 'Hi Ana, quick note.' },
        { id: 'b', before: 'Hi Bo, a question for you.', after: 'Hi Bo, a question for you.' },
      ]),
    ).toEqual([]);
  });
});

describe('voiceCheck', () => {
  const ok =
    "Hi Dana,\n\nI'm a junior at Cornell studying CS. I saw your post on the ledger team. Would you have 15 minutes next week?\n\nThanks,\nMaya";

  it('passes a draft in the student’s voice', () => {
    expect(voiceCheck({ body: ok }, { card })).toEqual({ ok: true, problems: [] });
  });

  it('names each thing that does not sound like them', () => {
    const off =
      'Dear Dana,\n\nI am reaching out because I am deeply interested in the remarkable work that your organization has been doing across the payments landscape over these past several years! I do not want to take much of your valuable time, but it is my hope that we could connect at some point in the coming weeks to discuss your career trajectory in considerable detail. Thanks either way, and I really do hope to hear back from you about this whenever it is convenient for you to respond.\n\nBest regards,\nMaya Chen';
    const r = voiceCheck(
      { body: off },
      {
        card: { ...card, avoid: ['remarkable work'] },
        notes: [
          note({ text: "You cut 'Thanks either way' every time" }),
          note({ text: 'You sign with your first name only' }),
        ],
      },
    );
    const codes = r.problems.map((p) => p.code);
    expect(r.ok).toBe(false);
    for (const c of [
      'greeting',
      'signoff',
      'sentence_length',
      'avoid',
      'note',
      'exclamation',
      'contractions',
    ])
      expect(codes).toContain(c);
    expect(r.problems.find((p) => p.code === 'avoid')!.detail).toBe(
      "It says 'remarkable work', which you never say.",
    );
    expect(r.problems.some((p) => p.detail.includes('full name'))).toBe(true);
    for (const p of r.problems) expect(p.detail).not.toMatch(/[!–—]/);
    expect(voiceScore(r)).toBe(0);
  });

  it('leaves the greeting and sign-off alone on a starting preset, unless their sent mail shows them', () => {
    const preset = defaultStyleCard('formal', 'Maya');
    expect(voiceCheck({ body: ok }, { card: preset }).ok).toBe(true);
    const withMail = voiceCheck(
      { body: ok.replace('Hi Dana', 'Yo Dana') },
      { card: preset, exemplars: SENT },
    );
    expect(withMail.problems.map((p) => p.code)).toContain('greeting');
  });
});
