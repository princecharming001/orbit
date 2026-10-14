import { describe, expect, it } from 'vitest';
import {
  asksIn,
  type ComposeContext,
  fleschKincaidGrade,
  syllables,
  validateComposed,
  wordRange,
} from '../drafts/compose';
import {
  COMPOSE_KINDS,
  type ComposeTemplateInput,
  composeFallback,
  composeInputsText,
} from '../drafts/templates';
import { GOAL_KINDS, type GoalKind } from '../types';

const PER_GOAL: Record<GoalKind, Partial<ComposeTemplateInput>> = {
  recruiting: { topic: 'payments products' },
  advice: { topic: 'how to pick a first job' },
  fundraising: {
    user: {
      firstName: 'Alex',
      company: 'Tidewater',
      pitch: 'helps cities plan for floods',
      traction: 'We have 12 city pilots and 3 paid contracts.',
    },
  },
  sales: { user: { firstName: 'Alex', company: 'Shiftly', pitch: 'builds shift plans for warehouse teams' } },
  hiring: {
    user: { firstName: 'Alex', company: 'Shiftly', pitch: 'builds shift plans for warehouse teams' },
    topic: 'our first data role',
  },
  cofounder: {
    user: { firstName: 'Alex', company: 'Tidewater', pitch: 'helps cities plan for floods' },
    topic: 'city budgets',
  },
  community: { topic: 'the Ithaca climate tech meetup' },
  collaboration: {
    user: { firstName: 'Alex', pitch: 'causal methods for gene data' },
    topic: 'small samples',
  },
};

function input(
  kind: ComposeTemplateInput['kind'],
  goal: GoalKind,
  channel: 'gmail' | 'linkedin' = 'gmail',
): ComposeTemplateInput {
  const g = PER_GOAL[goal];
  return {
    kind,
    goal,
    channel,
    personId: 'p1',
    goalId: 'g1',
    recipient: { firstName: 'Maya', org: 'Stripe', title: 'Product Manager' },
    hook: { text: 'your post on fraud models', sourceId: 'dossier:maya:1' },
    via: { introducerId: 'p2', introducerFirstName: 'Lena', pathScore: 0.4 },
    target: { firstName: 'Priya', org: 'Stripe' },
    topic: 'payments products',
    ...g,
    user: { firstName: 'Alex', school: 'Cornell', about: 'a junior at Cornell studying CS', ...g.user },
  };
}

function ctxFor(i: ComposeTemplateInput): ComposeContext {
  return {
    goal: i.goal,
    recipientFirstName: i.kind === 'forwardable_blurb' ? (i.target?.firstName ?? '') : i.recipient.firstName,
    inputs: composeInputsText(i),
    userFirstName: i.user.firstName,
  };
}

const GOOD_FIRST_TOUCH = `Hi Maya,

My name is Alex, a junior at Cornell studying CS. Your post on fraud models stuck with me.

Your team at Stripe works on payments products, which is the work I want to do. It would help to hear how you got there and what a normal week looks like.

Would you have 15 minutes for a call about your path and your team?

Best,
Alex`;

const good = {
  kind: 'first_touch' as const,
  channel: 'gmail' as const,
  subject: 'your path at Stripe',
  body: GOOD_FIRST_TOUCH,
  hooks: [{ text: 'your post on fraud models', sourceId: 'dossier:maya:1' }],
};
const ctx = ctxFor(input('first_touch', 'recruiting'));

describe('reading level', () => {
  it('counts syllables', () => {
    expect(
      ['cat', 'table', 'make', 'asked', 'likes', 'beautiful', 'introduction', 'coffee', 'yes'].map(syllables),
    ).toEqual([1, 2, 1, 1, 1, 3, 4, 2, 1]);
  });
  it('grades plain text low and dense text high', () => {
    expect(fleschKincaidGrade(GOOD_FIRST_TOUCH)).toBeLessThan(7);
    expect(
      fleschKincaidGrade(
        'Hi Maya,\n\nIn consideration of your organization’s considerable institutional expertise regarding international regulatory infrastructure, I would appreciate an opportunity to understand the organizational implications.\n\nBest,\nAlex',
      ),
    ).toBeGreaterThan(12);
  });
});

describe('validateComposed (§7.8 test 1)', () => {
  it('passes a plain first touch', () => {
    const r = validateComposed(good, ctx);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.words).toBeGreaterThanOrEqual(50);
    expect(r.grade).toBeLessThanOrEqual(7);
  });

  it('rejects a 130-word first touch', () => {
    const filler =
      ' I also want to learn how your team picks what to build and how you test new ideas with real users.'.repeat(
        4,
      );
    const long = GOOD_FIRST_TOUCH.replace(
      'what a normal week looks like.',
      `what a normal week looks like.${filler}`,
    );
    expect(long).toContain(filler);
    const r = validateComposed({ ...good, body: long }, ctx);
    expect(r.words).toBeGreaterThan(110);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('words_out_of_range');
    // sales is held to 40–90
    expect(wordRange('first_touch', 'sales')).toEqual([40, 90]);
    expect(wordRange('bump', 'advice')).toEqual([15, 50]);
  });

  it('rejects two asks', () => {
    const r = validateComposed(
      {
        ...good,
        body: GOOD_FIRST_TOUCH.replace('Would you have', 'Could you send me your team page? Would you have'),
      },
      ctx,
    );
    expect(r.issues.map((i) => i.code)).toContain('several_asks');
    expect(
      validateComposed(
        { ...good, body: GOOD_FIRST_TOUCH.replace(/Would you have.*\?/, 'Thanks for reading.') },
        ctx,
      ).issues.map((i) => i.code),
    ).toContain('no_ask');
  });

  it('rejects a reading grade above 7', () => {
    const dense = GOOD_FIRST_TOUCH.replace(
      'It would help to hear how you got there and what a normal week looks like.',
      'I would appreciate understanding the organizational considerations underlying your professional trajectory and your responsibilities.',
    );
    const r = validateComposed({ ...good, body: dense }, ctx);
    expect(r.grade).toBeGreaterThan(7);
    expect(r.issues.map((i) => i.code)).toContain('reading_grade');
  });

  it('rejects a first touch without a sourced hook', () => {
    expect(validateComposed({ ...good, hooks: [] }, ctx).issues.map((i) => i.code)).toContain('hook_missing');
    expect(validateComposed({ ...good, hooks: [{ text: 'x', sourceId: '' }] }, ctx).ok).toBe(false);
  });

  it('rejects LinkedIn messages over 400 characters and connection notes over 200', () => {
    const li = { ...good, channel: 'linkedin' as const, subject: null };
    const longer = `${GOOD_FIRST_TOUCH.replace('Best,', 'It would mean a lot to hear from you, even if the answer is no for now.\n\nBest,')}`;
    const r = validateComposed({ ...li, body: longer }, ctx);
    expect(longer.length).toBeGreaterThan(400);
    expect(r.issues.map((i) => i.code)).toContain('linkedin_too_long');
    const note =
      'Hi Maya, my name is Alex, a junior at Cornell studying CS. Your post on fraud models stuck with me. Would you have 15 minutes for a call about your path and your team? It would mean a lot to me this fall.';
    expect(note.length).toBeGreaterThan(200);
    expect(
      validateComposed({ ...li, body: note }, { ...ctx, connectionNote: true }).issues.map((i) => i.code),
    ).toContain('connection_note_too_long');
  });

  it('rejects names and numbers that are not in the inputs', () => {
    const r = validateComposed(
      {
        ...good,
        body: GOOD_FIRST_TOUCH.replace(
          'Your post on fraud models',
          'Your post on fraud models with Jordan Blake, read by 40,000 people,',
        ),
      },
      ctx,
    );
    const details = r.issues.filter((i) => i.code === 'unknown_detail').map((i) => i.detail);
    expect(details.join(' ')).toMatch(/Jordan Blake/);
    expect(details.join(' ')).toMatch(/40,000/);
  });

  it('checks the subject: 2–6 words, ≤ 45 characters, lower-case except names, no clickbait', () => {
    const codes = (subject: string | null) =>
      validateComposed({ ...good, subject }, ctx).issues.map((i) => i.code);
    expect(codes(null)).toContain('subject_missing');
    expect(codes('hello')).toContain('subject_length');
    expect(codes('a very long subject line that keeps on going')).toContain('subject_length');
    expect(codes('Your Path At Stripe')).toContain('subject_case');
    expect(codes('quick question for Maya')).toEqual(expect.arrayContaining(['subject_banned']));
    expect(codes('your path at Stripe')).toEqual([]);
  });

  it('bans flattery, dashes and exclamation marks unless the voice uses them', () => {
    const codes = (body: string, c: ComposeContext = ctx) =>
      validateComposed({ ...good, body }, c).issues.map((i) => i.code);
    expect(codes(GOOD_FIRST_TOUCH.replace('stuck with me', 'was amazing'))).toContain('banned_phrase');
    expect(codes(GOOD_FIRST_TOUCH.replace('Your post on', 'Quick question about your post on'))).toContain(
      'banned_phrase',
    );
    expect(codes(GOOD_FIRST_TOUCH.replace('fraud models stuck', 'fraud models — it stuck'))).toContain(
      'em_dash',
    );
    const bang = GOOD_FIRST_TOUCH.replace('stuck with me.', 'stuck with me!');
    expect(codes(bang)).toContain('exclamation');
    expect(codes(bang, { ...ctx, style: { exclamationsPerMessage: 0.8 } })).not.toContain('exclamation');
  });

  it('still runs the v1 checks (placeholders, unknown links, the recipient name)', () => {
    const codes = validateComposed(
      {
        ...good,
        body: GOOD_FIRST_TOUCH.replace('Hi Maya', 'Hi there').replace(
          'stuck with me.',
          'stuck with me [add detail]. See https://evil.example.com',
        ),
      },
      ctx,
    ).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['placeholder', 'unknown_url', 'missing_name']));
  });

  it('counts asks by sentence', () => {
    expect(
      asksIn('Hi Maya,\n\nWould you be open to a look? Worth a quick look.\n\nBest,\nAlex'),
    ).toHaveLength(2);
    expect(asksIn('Hi Maya,\n\nThanks again for the time.\n\nBest,\nAlex')).toHaveLength(0);
  });
});

describe('compose v2 template fallbacks', () => {
  for (const goal of GOAL_KINDS)
    for (const kind of COMPOSE_KINDS)
      for (const channel of ['gmail', 'linkedin'] as const)
        it(`${kind} × ${goal} on ${channel} passes validateComposed`, () => {
          const i = input(kind, goal, channel);
          const m = composeFallback(i);
          const r = validateComposed(m, ctxFor(i));
          expect(r.issues, `${m.subject ?? ''}\n${m.body}`).toEqual([]);
          expect(m.promptVersion).toBe('template-v2');
          expect(m.channel).toBe(channel);
          if (channel === 'linkedin') expect(m.subject).toBeNull();
        });

  it('writes the forwardable blurb in the third person, under 90 words', () => {
    const m = composeFallback(input('forwardable_blurb', 'recruiting'));
    expect(m.body).not.toMatch(/\b(I|my|me)\b/);
    expect(m.body).toMatch(/^Alex is a junior at Cornell/);
    expect(validateComposed(m, ctxFor(input('forwardable_blurb', 'recruiting'))).words).toBeLessThanOrEqual(
      90,
    );
  });

  it('asks nothing in a re-engage note and names the mutual in a warm first touch', () => {
    const re = composeFallback(input('reengage', 'advice'));
    expect(re.ask.kind).toBe('none');
    expect(asksIn(re.body)).toEqual([]);
    const warm = composeFallback(input('warm_first_touch', 'fundraising'));
    expect(warm.body).toMatch(/Lena said I should write to you/);
    expect(warm.via).toEqual({ introducerId: 'p2', pathScore: 0.4 });
    expect(warm.hooks).toEqual([{ text: 'your post on fraud models', sourceId: 'dossier:maya:1' }]);
  });
});
