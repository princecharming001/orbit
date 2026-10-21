/**
 * Sample research briefs for three of the demo's made-up people, so the About tab shows what research looks like
 * without an account. Every source is marked `demo`: the page names the site but links nowhere, because these
 * people do not exist.
 */
import type { Dossier } from '@orbit/core';

const src = (id: string, url: string, title: string) => ({ id, url, title, demo: true });

export function demoDossiers(userId: string, now = new Date(), school = 'Cornell University'): Dossier[] {
  const Y = now.getFullYear();
  const at = now.toISOString();
  // a sample never goes stale: it is not research, so nothing should offer to redo it
  const expiresAt = new Date(now.getTime() + 3650 * 86_400_000).toISOString();
  const base = {
    userId,
    costUsd: 0,
    model: 'sample',
    createdAt: at,
    updatedAt: at,
    expiresAt,
    status: 'ready' as const,
  };
  return [
    {
      ...base,
      id: 'demo-dossier-p1',
      personId: 'p1',
      sources: [
        src('S1', 'https://www.linkedin.com/', 'LinkedIn profile'),
        src('S2', 'https://stripe.com/blog', 'Designing retries that never charge twice'),
        src('S3', 'https://www.youtube.com/', 'Payments reliability talk, Seattle Systems meetup'),
        src('S4', 'https://github.com/', 'GitHub: idempotency-keys sample'),
      ],
      content: {
        who: 'Daniel Okafor is a software engineer on Stripe’s payments reliability team in Seattle, known for writing plainly about retries and idempotency.',
        now: { role: 'Software Engineer', org: 'Stripe', since: String(Y - 3), source_ids: ['S1'] },
        recently: [
          {
            date: `${Y}`,
            text: 'Wrote about designing retries that never charge a customer twice.',
            source_ids: ['S2'],
          },
        ],
        in_common: [
          { text: 'You both care about payments infrastructure', kind: 'interest', source_ids: ['S2'] },
        ],
        history: { first_contact: null, last_contact: null, summary: null },
        openers: [
          {
            text: 'Your retries post made idempotency keys click for me; how do you test them?',
            source_ids: ['S2'],
          },
          { text: 'Curious how the reliability team decides what to page on.', source_ids: ['S3'] },
        ],
        careful: [],
        confidence: 'high',
        career: [
          { role: 'Software Engineer', org: 'Stripe', start: String(Y - 3), end: null, source_ids: ['S1'] },
          {
            role: 'Software Engineering Intern',
            org: 'Datadog',
            start: String(Y - 4),
            end: String(Y - 4),
            source_ids: ['S1'],
          },
        ],
        education: [
          {
            school: 'Georgia Tech',
            degree: 'BS, Computer Science',
            years: `${Y - 7}–${Y - 3}`,
            source_ids: ['S1'],
          },
        ],
        profiles: [
          { kind: 'linkedin', url: 'https://www.linkedin.com/' },
          { kind: 'github', url: 'https://github.com/' },
        ],
        highlights: [
          {
            kind: 'article',
            title: 'Designing retries that never charge twice',
            date: `${Y}`,
            url: 'https://stripe.com/blog',
            summary: 'Why every payment write needs an idempotency key, and how to pick its lifetime.',
            source_ids: ['S2'],
          },
          {
            kind: 'talk',
            title: 'What we page on, and what we stopped paging on',
            date: `${Y - 1}`,
            url: 'https://www.youtube.com/',
            summary: 'A 20-minute talk on cutting alert noise on a payments team.',
            source_ids: ['S3'],
          },
          {
            kind: 'project',
            title: 'idempotency-keys: a small sample service',
            date: null,
            url: 'https://github.com/',
            summary: 'A teaching repo that shows safe retries end to end.',
            source_ids: ['S4'],
          },
        ],
        topics: ['Payments reliability', 'Idempotency', 'On-call', 'Distributed systems'],
      },
    },
    {
      ...base,
      id: 'demo-dossier-p5',
      personId: 'p5',
      sources: [
        src('S1', 'https://www.linkedin.com/', 'LinkedIn profile'),
        src('S2', 'https://ramp.com/blog', 'How Ramp runs its new-grad program'),
        src('S3', 'https://open.spotify.com/', 'Engineering Managers podcast, episode 41'),
      ],
      content: {
        who: 'Lena Novak manages an engineering team at Ramp after five years as an engineer at Stripe, and speaks about growing new engineers.',
        now: { role: 'Engineering Manager', org: 'Ramp', since: String(Y - 2), source_ids: ['S1'] },
        recently: [
          { date: `${Y}`, text: 'Wrote about how Ramp runs its new-grad program.', source_ids: ['S2'] },
        ],
        in_common: [
          {
            text: 'She hires interns and new grads, which is what you are looking for',
            kind: 'interest',
            source_ids: ['S2'],
          },
        ],
        history: { first_contact: null, last_contact: null, summary: null },
        openers: [
          { text: 'Your point that new grads should ship in week one stuck with me.', source_ids: ['S3'] },
        ],
        careful: [],
        confidence: 'high',
        career: [
          { role: 'Engineering Manager', org: 'Ramp', start: String(Y - 2), end: null, source_ids: ['S1'] },
          {
            role: 'Senior Software Engineer',
            org: 'Ramp',
            start: String(Y - 4),
            end: String(Y - 2),
            source_ids: ['S1'],
          },
          {
            role: 'Software Engineer',
            org: 'Stripe',
            start: String(Y - 9),
            end: String(Y - 4),
            source_ids: ['S1'],
          },
        ],
        education: [
          {
            school: 'Carnegie Mellon University',
            degree: 'BS, Computer Science',
            years: `${Y - 13}–${Y - 9}`,
            source_ids: ['S1'],
          },
        ],
        profiles: [{ kind: 'linkedin', url: 'https://www.linkedin.com/' }],
        highlights: [
          {
            kind: 'article',
            title: 'How we run our new-grad program',
            date: `${Y}`,
            url: 'https://ramp.com/blog',
            summary: 'Pairing, a first project in week one, and a written review at 90 days.',
            source_ids: ['S2'],
          },
          {
            kind: 'podcast',
            title: 'Growing engineers who ship',
            date: `${Y - 1}`,
            url: 'https://open.spotify.com/',
            summary: 'On moving from engineer to manager, and what she looks for in interns.',
            source_ids: ['S3'],
          },
        ],
        topics: ['Engineering management', 'New-grad hiring', 'Fintech'],
      },
    },
    {
      ...base,
      id: 'demo-dossier-p9',
      personId: 'p9',
      sources: [
        src('S1', 'https://www.linkedin.com/', 'LinkedIn profile'),
        src('S2', 'https://medium.com/', 'What I wish I knew before my first on-call'),
        src('S3', 'https://x.com/', 'Posts on X'),
      ],
      content: {
        who: 'Maya Chen is a software engineer at Stripe in San Francisco and a fellow alum who mentors students applying to Stripe.',
        now: { role: 'Software Engineer', org: 'Stripe', since: String(Y - 5), source_ids: ['S1'] },
        recently: [{ date: `${Y}`, text: 'Wrote about her first on-call rotation.', source_ids: ['S2'] }],
        in_common: [{ text: 'You went to the same university', kind: 'school', source_ids: ['S1'] }],
        history: { first_contact: null, last_contact: null, summary: null },
        openers: [
          { text: 'Your on-call post was the most honest thing I have read about it.', source_ids: ['S2'] },
        ],
        careful: [],
        confidence: 'high',
        career: [
          { role: 'Software Engineer', org: 'Stripe', start: String(Y - 5), end: null, source_ids: ['S1'] },
        ],
        education: [{ school, degree: null, years: `${Y - 9}–${Y - 5}`, source_ids: ['S1'] }],
        profiles: [
          { kind: 'linkedin', url: 'https://www.linkedin.com/' },
          { kind: 'x', url: 'https://x.com/' },
        ],
        highlights: [
          {
            kind: 'post',
            title: 'What I wish I knew before my first on-call',
            date: `${Y}`,
            url: 'https://medium.com/',
            summary: 'Runbooks, asking for help early, and sleeping the night before.',
            source_ids: ['S2'],
          },
        ],
        topics: ['Mentoring', 'On-call', 'Payments'],
      },
    },
  ];
}
