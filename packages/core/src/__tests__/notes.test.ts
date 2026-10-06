import { describe, expect, it } from 'vitest';
import { extractDueHint, heuristicNoteExtraction } from '../notes/extract';
import { NOTES } from './fixtures/notes';

const matches = (actual: string, want: string | RegExp) =>
  typeof want === 'string' ? actual === want : want.test(actual);

describe('note corpus (25 notes)', () => {
  it('has 25 notes', () => expect(NOTES).toHaveLength(25));
  for (const n of NOTES) {
    it(n.name, () => {
      const r = heuristicNoteExtraction(n.text, { people: n.people, userNames: n.userNames });
      const dump = JSON.stringify(
        { facts: r.facts.map((f) => [f.type, f.about, f.text]), actions: r.actionItems },
        null,
        1,
      );
      for (const want of n.facts ?? []) {
        const hit = r.facts.find((f) => f.type === want.type && matches(f.text, want.text));
        expect(hit, `missing ${want.type}: ${want.text}\n${dump}`).toBeDefined();
        if (want.about) expect(hit!.about, `${want.text} attributed to the wrong person`).toBe(want.about);
        expect(hit!.evidence?.length).toBeGreaterThan(5);
      }
      for (const want of n.actions ?? []) {
        const hit = r.actionItems.find((a) => a.owner === 'user' && matches(a.text, want.text));
        expect(hit, `missing action: ${want.text}\n${dump}`).toBeDefined();
        if (want.due) expect(hit!.dueHint ?? '').toMatch(want.due);
      }
      if (n.actions && n.actions.length === 0) expect(r.actionItems, dump).toHaveLength(0);
      if (n.noOffers) {
        expect(r.offers, dump).toHaveLength(0);
        expect(
          r.facts.filter((f) => f.type === 'offer'),
          dump,
        ).toHaveLength(0);
      }
      for (const f of r.facts) {
        // clean clauses: no speaker labels, no trailing punctuation, not about the person in the third person
        expect(f.text, dump).not.toMatch(/^[A-Z][\p{L}'-]+(\s[A-Z][\p{L}'-]+)?:\s/u);
        expect(f.text, dump).not.toMatch(/[.!?,;:]$/);
        expect(f.text, dump).not.toMatch(/^(she|he|her|his)\b/i);
        for (const p of n.people) expect(f.text.startsWith(`${p.first} `), dump).toBe(false);
        if (f.type === 'offer') expect(f.text, dump).not.toMatch(/^I\b/);
      }
      for (const a of n.absent ?? []) {
        const re = new RegExp(`(^|\\W)${a.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i');
        for (const f of r.facts) expect(f.text, dump).not.toMatch(re);
        expect(r.summary).not.toMatch(re);
      }
      expect(r.summary).not.toMatch(/Attendees:|Transcript/);
      expect(r.summary.length).toBeGreaterThan(10);
      expect(r.summary).toMatch(/[.!?"…]$/);
    });
  }
});

describe("NRC-03: the student's own promises", () => {
  it('"I\'ll send my resume" is an action item, never their offer', () => {
    const r = heuristicNoteExtraction(
      "I'll send my resume by Friday. I'll share the deck tomorrow.",
      'Priya',
    );
    expect(r.offers).toHaveLength(0);
    expect(r.actionItems.map((a) => a.text)).toEqual(['Send my resume by Friday', 'Share the deck tomorrow']);
    expect(r.suggestedNextStep).toBe('Do what you promised: Send my resume by Friday.');
  });
});

describe('NRC-04: dictated notes', () => {
  it('yields facts and a summary that does not stop mid-word', () => {
    const text = NOTES.find((n) => n.name === 'dictated voice note')!.text;
    const r = heuristicNoteExtraction(text, { people: [{ key: 'm', first: 'Maya', last: 'Wu' }] });
    expect(r.facts.length).toBeGreaterThanOrEqual(4);
    expect(r.summary).toMatch(/[.…]$/);
    expect(r.summary.split(' ').every((w) => w.length > 0)).toBe(true);
  });
});

describe('NRC-14: advice is not a promise', () => {
  it('keeps "she recommended I apply" as advice without a made-up due date', () => {
    const r = heuristicNoteExtraction('She recommended I apply to the APM program.', 'Maya');
    expect(r.actionItems).toHaveLength(0);
    expect(r.facts[0]).toMatchObject({ type: 'advice', text: 'I should apply to the APM program' });
  });
  it('finds explicit deadlines', () => {
    expect(extractDueHint('apply by the early deadline in October')).toBe('by the early deadline in October');
    expect(extractDueHint('register by Oct 20')).toBe('by Oct 20');
    expect(extractDueHint('send it in two weeks')).toBe('in two weeks');
    expect(extractDueHint('see you next week')).toBe('next week');
  });
});
