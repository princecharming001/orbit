import { describe, expect, it } from 'vitest';
import { conflictingFacts } from '../notes/conflicts';
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
        // clean third-person sentences: no speaker labels, no trailing punctuation, a capitalised start,
        // never the counterpart's own first person, never "you" for the counterpart
        expect(f.text, dump).not.toMatch(/^[A-Z][\p{L}'-]+(\s[A-Z][\p{L}'-]+)?:\s/u);
        expect(f.text, dump).not.toMatch(/[.!?,;:]$/);
        expect(f.text, dump).toMatch(/^[\p{Lu}"]/u);
        expect(f.text, dump).not.toMatch(/^(I|I'll|I'm|I'd|We|We're|You|You'd|You'll|You're)\b/);
        if (f.type === 'offer') expect(f.text, dump).toMatch(/\boffered (to|an?)\b/);
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

describe('proper nouns in a dictated note (L20)', () => {
  const dictated = `ok so just talked to maya from figma um she said the new grad process opens in like august and she grew up in new york but she's from houston originally and she speaks spanish`;
  it('capitalises places, languages and the employer, wherever the fact is stored', () => {
    const r = heuristicNoteExtraction(dictated, {
      people: [{ key: 'm', first: 'Maya', last: 'Wu' }],
      organizations: ['Figma'],
    });
    const all = [...r.facts.flatMap((f) => [f.text, f.evidence ?? '']), r.summary].join(' | ');
    expect(all).toMatch(/\bHouston\b/);
    expect(all).toMatch(/\bNew York\b/);
    expect(all).not.toMatch(/\b(houston|new york|figma|august|spanish)\b/);
    expect(r.summary).toMatch(/Maya from Figma/);
    expect(r.facts.map((f) => f.text)).toContain("She's from Houston originally");
  });
  it('recases "may" only as the month, and an everyday word only where it names the employer', () => {
    const r = heuristicNoteExtraction(
      'she may have an opening on her team in may. she said my target role is a good fit at target.',
      { people: [{ key: 'm', first: 'Maya' }], organizations: ['Target'] },
    );
    const all = [...r.facts.flatMap((f) => [f.text, f.evidence ?? '']), r.summary].join(' | ');
    expect(all).toMatch(/\bmay have\b/);
    expect(all).not.toMatch(/\bMay have\b/);
    expect(all).toMatch(/\bin May\b/);
    expect(all).not.toMatch(/\bmy Target role\b/);
  });
});

describe('employer recasing leaves everyday words alone (L20)', () => {
  const people = [{ key: 'r', first: 'Rae', last: 'Lin' }];
  const textOf = (r: ReturnType<typeof heuristicNoteExtraction>) =>
    [...r.facts.flatMap((f) => [f.text, f.evidence ?? '']), r.summary].join(' | ');
  it('does not recase a firm named after a verb or noun where the word is used as one', () => {
    const r = heuristicNoteExtraction(
      'call with rae. she said it took her two months to ramp up and she grew up in boulder. she said to target the fall and that i am back to square one. she told me to block time',
      { people, organizations: ['Ramp', 'Target', 'Square', 'Block'] },
    );
    const all = textOf(r);
    expect(all).toMatch(/\bto ramp up\b/);
    expect(all).toMatch(/\bto target the fall\b/);
    expect(all).toMatch(/\bto block time\b/);
    expect(all).not.toMatch(/\b(Ramp|Target|Square|Block)\b/);
    expect(all).toMatch(/\bBoulder\b/);
  });
  it('still recases the employer where it names the firm', () => {
    const r = heuristicNoteExtraction(
      'call with rae. she works at ramp and joined ramp from square, she left bain last year',
      {
        people,
        organizations: ['Ramp', 'Square', 'Bain & Company'],
      },
    );
    const all = textOf(r);
    expect(all).toMatch(/works at Ramp and joined Ramp from Square/);
    expect(all).toMatch(/left Bain\b/);
  });
  it('keeps the modal "may" after this, next or last', () => {
    const r = heuristicNoteExtraction(
      'call with rae. she said this may take a few weeks. she started there last may and she moves teams next may.',
      { people },
    );
    const all = textOf(r);
    expect(all).toMatch(/\bthis may take\b/);
    expect(all).toMatch(/\blast May\b/);
    expect(all).toMatch(/\bnext May\b/);
  });
});

describe('NRC-14: advice is not a promise', () => {
  it('keeps "she recommended I apply" as advice without a made-up due date', () => {
    const r = heuristicNoteExtraction('She recommended I apply to the APM program.', 'Maya');
    expect(r.actionItems).toHaveLength(0);
    expect(r.facts[0]).toMatchObject({ type: 'advice', text: 'She recommended I apply to the APM program' });
  });
  it('finds explicit deadlines', () => {
    expect(extractDueHint('apply by the early deadline in October')).toBe('by the early deadline in October');
    expect(extractDueHint('register by Oct 20')).toBe('by Oct 20');
    expect(extractDueHint('send it in two weeks')).toBe('in two weeks');
    expect(extractDueHint('see you next week')).toBe('next week');
  });
});

describe('NRC-22: numbers at the start of a sentence', () => {
  it('only a list marker is stripped, never a year or a count', () => {
    const x = heuristicNoteExtraction(
      '3. 2024 was a big year for them. 2 of her teammates left for Ramp.',
      'Maya',
    );
    expect(x.summary).toBe('2024 was a big year for them. 2 of her teammates left for Ramp.');
  });
});

describe('stored fact form: third person with a subject, the raw sentence as evidence', () => {
  const priya = { people: [{ key: 'p', first: 'Priya', last: 'Patel' }] };
  it('keeps a typed note as the student wrote it', () => {
    const r = heuristicNoteExtraction(
      'Met Priya for coffee. She offered to refer me to the APM program. She recommended I apply early.',
      priya,
    );
    expect(r.facts.map((f) => [f.type, f.text])).toEqual([
      ['offer', 'She offered to refer me to the APM program'],
      ['advice', 'She recommended I apply early'],
    ]);
    expect(r.offers).toEqual(['She offered to refer me to the APM program']);
    expect(r.suggestedNextStep).toBe("Follow up on Priya's offer to refer you to the APM program.");
  });
  it('never turns a third party into the counterpart', () => {
    const r = heuristicNoteExtraction("she said she'd forward my resume to her if i send it over", priya);
    expect(r.facts.find((f) => f.type === 'offer')?.text).toBe(
      'She offered to forward my resume to her if I send it over',
    );
  });
  it("puts a transcript speaker's first person in the third person", () => {
    const r = heuristicNoteExtraction(
      `Priya Patel: I lead a 6-person team on payments onboarding.
Priya Patel: No guarantee of course, the process is pretty competitive, but I'll put in a good word.
Priya Patel: You should apply early, we're hiring in January.`,
      { ...priya, userNames: ['Ravi Jain'] },
    );
    const texts = r.facts.map((f) => f.text);
    expect(texts).toContain('They lead a 6-person team on payments onboarding');
    expect(texts).toContain('They offered to put in a good word');
    expect(texts).toContain('They said I should apply early');
    expect(texts).toContain("They're hiring in January");
    for (const t of texts) expect(t).not.toMatch(/\b(you|your)\b/i);
    expect(r.suggestedNextStep).toBe("Follow up on Priya's offer to put in a good word.");
  });
  it('gives a subjectless dictated fragment a subject', () => {
    const r = heuristicNoteExtraction('Coffee with Tom. Recommended reading the last three postmortems.', {
      people: [{ key: 't', first: 'Tom' }],
    });
    expect(r.facts[0]?.text).toBe('They recommended reading the last three postmortems');
  });
});

describe('facts that disagree', () => {
  it('points at two answers to the same question and leaves agreeing ones alone', () => {
    const f = (id: string, text: string) => ({ id, text });
    const out = conflictingFacts([
      f('a', 'She grew up in Pittsburgh and still roots for the Steelers'),
      f('b', 'She grew up in Chicago'),
      f('c', 'She leads the payments risk team'),
      f('d', 'She leads the bill pay engineering team'),
      f('e', 'She is from Pittsburgh'),
      f('g', 'She recommended one concrete project story'),
    ]);
    expect(out.get('b')).toMatch(/Pittsburgh/);
    expect(out.has('a')).toBe(true);
    expect(out.get('c')).toMatch(/bill pay/);
    expect(out.has('g')).toBe(false);
    expect(
      conflictingFacts([f('a', 'She grew up in Pittsburgh'), f('e', 'She is from Pittsburgh, PA')]).size,
    ).toBe(0);
  });
});

describe('notes students pasted in usability testing', () => {
  const kinds = (text: string, people: { key: string; first: string; last?: string }[], user: string) => {
    const r = heuristicNoteExtraction(text, { people, userNames: [user] });
    return {
      facts: r.facts.map((f) => `${f.type}: ${f.text}`),
      actions: r.actionItems.filter((a) => a.owner === 'user').map((a) => a.text),
    };
  };
  it('a notetaker summary: key points are not promises, and the student named in it is "me"', () => {
    const r = kinds(
      `Meeting summary - Hannah Brooks (Figma) / Alex Rivera
Action items:
- Alex to send portfolio link by Monday
Key points:
- Hannah recommended taking HCI course
- Figma APM applications open in January
- Hannah offered to review Alex's resume`,
      [{ key: 'h', first: 'Hannah', last: 'Brooks' }],
      'Alex Rivera',
    );
    expect(r.actions).toEqual(['Send portfolio link by Monday']);
    expect(r.facts).toContain('advice: Hannah recommended taking HCI course');
    expect(r.facts).toContain('hook: Figma APM applications open in January');
    expect(r.facts).toContain('offer: Hannah offered to review my resume');
    // the offer list says it the same way, so it is not stored twice
    expect(
      heuristicNoteExtraction("Key points:\n- Hannah offered to review Alex's resume", {
        people: [{ key: 'h', first: 'Hannah', last: 'Brooks' }],
        userNames: ['Alex Rivera'],
      }).offers,
    ).toEqual(['Hannah offered to review my resume']);
  });
  it('keeps every point of a typed note, and a second promise reads as one sentence', () => {
    const r = kinds(
      `Talked with Lena for 30 min. She runs the platform team at Ramp. She said the best interns write a design doc before coding. She recommended I read the Ramp engineering blog post on their ledger. Ramp opens intern applications Nov 1. I promised to send her my resume by Friday and to share my side project link.`,
      [{ key: 'l', first: 'Lena', last: 'Novak' }],
      'Alex Rivera',
    );
    expect(r.facts).toContain('advice: She said the best interns write a design doc before coding');
    expect(r.facts).toContain('hook: Ramp opens intern applications Nov 1');
    expect(r.actions).toEqual(['Send her my resume by Friday and share my side project link']);
  });
  it('a labelled "Advice:" line is advice in their words, not "Advice: ..."', () => {
    const r = kinds(
      `Talked with Hannah for 25 min. She leads growth PM for FigJam. Advice: pick one metric story and practice it out loud.`,
      [{ key: 'h', first: 'Hannah', last: 'Brooks' }],
      'Alex Rivera',
    );
    expect(r.facts).toContain('advice: She said to pick one metric story and practice it out loud');
  });
  it('splits a date from the advice joined to it, and keeps a team they love', () => {
    const r = kinds(
      `Talked to Tom Becker from McKinsey today for 20 min. He said consulting recruiting at Ross opens in January, and to prep with Case in Point plus live cases. He loves the Detroit Pistons.`,
      [{ key: 't', first: 'Tom', last: 'Becker' }],
      'Jamie Chen',
    );
    expect(r.facts).toContain('hook: Consulting recruiting at Ross opens in January');
    expect(r.facts).toContain('advice: He said to prep with Case in Point plus live cases');
    expect(r.facts).toContain('personal: He loves the Detroit Pistons');
  });
});
