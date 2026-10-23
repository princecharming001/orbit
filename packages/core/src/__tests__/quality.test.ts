import { describe, expect, it } from 'vitest';
import { article } from '../drafts/phrasing';
import {
  cleanName,
  cleanRole,
  directorOrAbove,
  junkProfile,
  liftOdds,
  rankScore,
  replyOdds,
  worthSuggesting,
} from '../recommend/quality';

describe('names as a card shows them', () => {
  it('puts capitals and all-lowercase in title case, and leaves a name written with care alone', () => {
    expect(cleanName('CHAYA MENDELSOHN')).toMatchObject({ name: 'Chaya Mendelsohn', quality: 'full' });
    expect(cleanName("CALEB O'NEIL")).toMatchObject({ name: "Caleb O'Neil", first: 'Caleb' });
    expect(cleanName('MARY-JANE WATSON').name).toBe('Mary-Jane Watson');
    expect(cleanName('jordan lee').name).toBe('Jordan Lee');
    expect(cleanName('Ana McKenzie de la Cruz').name).toBe('Ana McKenzie de la Cruz');
    expect(cleanName('Felix Garcia III').name).toBe('Felix Garcia III');
  });

  it('keeps an initial for a last name but marks it, and calls initials or a handle no name', () => {
    expect(cleanName('CHAYA M.')).toMatchObject({ name: 'Chaya M.', quality: 'initial', first: 'Chaya' });
    for (const junk of ['J. S.', 'K.L.', 'A B', 'LinkedIn Member', 'jdoe_1987', 'Maya', '.', ''])
      expect(cleanName(junk).quality, junk).toBe('junk');
  });

  it('drops emoji, pronouns and credentials', () => {
    expect(cleanName('Priya Shah 🚀 (she/her)').name).toBe('Priya Shah');
    expect(cleanName('Jordan Lee, MBA, PMP').name).toBe('Jordan Lee');
  });
});

describe('a role, never a self-description', () => {
  it('reads the role out of a describing headline, or none when there is no role', () => {
    expect(cleanRole('Experienced and versatile Product Manager')).toBe('Product Manager');
    expect(cleanRole('Dynamic and creative Product Designer')).toBe('Product Designer');
    expect(cleanRole('Seasoned Software Engineer')).toBe('Software Engineer');
    expect(cleanRole('Passionate about building products people love')).toBeUndefined();
    expect(cleanRole('Results-driven leader')).toBeUndefined();
    expect(cleanRole('Helping startups scale')).toBeUndefined();
  });

  it('leaves a real title as it is', () => {
    for (const t of [
      'Sr Product Manager',
      'Creative Director',
      'Strategy & Operations Associate',
      'APM',
      'Founder',
    ])
      expect(cleanRole(t)).toBe(t);
  });
});

describe('junk profiles', () => {
  it('no real name, spam, or neither title nor company', () => {
    expect(junkProfile({ name: 'LinkedIn Member', title: 'PM', company: 'Google' })).toBe('no real name');
    expect(junkProfile({ name: 'Crypto King', headline: '💰 Crypto millionaire | DM me', title: 'x' })).toBe(
      'spam',
    );
    expect(junkProfile({ name: 'Wealth Coach', headline: 'FOREX TRADER LINK IN BIO', title: 'Trader' })).toBe(
      'spam',
    );
    expect(junkProfile({ name: 'Maya Chen' })).toBe('no title or company');
    expect(junkProfile({ name: 'Maya Chen', title: 'Product Manager', company: 'Stripe' })).toBeUndefined();
  });
});

describe('reply odds', () => {
  const cold = { title: 'Product Manager', distance: 2, mutualCount: 3 };
  it('a cold note to a stranger mid-career is answered about one time in five to three', () => {
    const p = replyOdds(cold);
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThan(0.4);
  });

  it('juniors answer more than directors and VPs; far out on LinkedIn less than a friend of a friend', () => {
    const at = (title: string) => replyOdds({ ...cold, title });
    expect(at('Associate Product Manager')).toBeGreaterThan(at('Senior Product Manager'));
    expect(at('Senior Product Manager')).toBeGreaterThan(at('Director of Product'));
    expect(at('Director of Product')).toBeGreaterThan(at('VP of Product'));
    expect(replyOdds({ ...cold, distance: 3 })).toBeLessThan(replyOdds(cold));
  });

  it('what the two share and a way in raise it, a reply before most of all', () => {
    const base = replyOdds(cold);
    expect(replyOdds({ ...cold, alum: true })).toBeGreaterThan(base);
    expect(replyOdds({ ...cold, sharedOrg: 'past' })).toBeGreaterThan(base);
    expect(replyOdds({ ...cold, warmPath: 'introducer' })).toBeGreaterThan(
      replyOdds({ ...cold, alum: true }),
    );
    expect(replyOdds({ ...cold, likeReplied: true })).toBeGreaterThan(base);
    expect(replyOdds({ title: 'Product Manager', strength: 0.6, replied: true })).toBeGreaterThan(0.8);
    expect(liftOdds(base, 1)).toBeGreaterThan(base);
    expect(liftOdds(0.99, 3)).toBeLessThanOrEqual(0.95);
  });
});

describe('the rank and the verdict', () => {
  it('ranks by Match most, then Reply odds and Reach, a name with only an initial a little lower', () => {
    const m = { match: 0.7, reach: 0.5, odds: 0.5 };
    expect(rankScore({ ...m, match: 0.8 })).toBeGreaterThan(rankScore({ ...m, odds: 0.6 }));
    expect(rankScore({ ...m, odds: 0.6 })).toBeGreaterThan(rankScore(m));
    expect(rankScore({ ...m, initialName: true })).toBeLessThan(rankScore(m));
  });

  it('needs a goal anchor, or a tie anchor with something tying them to the goals', () => {
    const goal = {
      kind: 'goal' as const,
      text: 'PM at Stripe, on your target list',
      strength: 100,
      anchor: 'goal' as const,
    };
    const tie = {
      kind: 'warm_path' as const,
      text: 'Ana could introduce you',
      strength: 88,
      anchor: 'tie' as const,
    };
    const count = { kind: 'mutuals' as const, text: '43 mutual connections', strength: 50 };
    const role = { kind: 'goal' as const, text: "PM at Acme, the role you're targeting", strength: 62 };
    expect(worthSuggesting([goal], false)).toBe(true);
    expect(worthSuggesting([tie], true)).toBe(true);
    expect(worthSuggesting([tie], false)).toBe(false);
    expect(worthSuggesting([count, role], true)).toBe(false);
  });

  it('knows a director from an engineer', () => {
    expect(directorOrAbove('VP of Product')).toBe(true);
    expect(directorOrAbove('Director of Engineering')).toBe(true);
    expect(directorOrAbove('Software Engineer')).toBe(false);
  });
});

describe('a or an', () => {
  it('by sound, initialisms letter by letter', () => {
    expect(article('Analyst')).toBe('an');
    expect(article('University Recruiter')).toBe('a');
    expect(article('M&A Associate')).toBe('an');
    expect(article('SDE')).toBe('an');
    expect(article('PM at Stripe')).toBe('a');
    expect(article('Product Manager')).toBe('a');
  });
});
