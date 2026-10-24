/**
 * Hundreds of Discover pages, built from made-up students of every shape (every goal, schools, target lists or none,
 * LinkedIn or not, networks from empty to two thousand people) and candidates of every kind (strong fits, weak fits,
 * mutuals only, a headline and nothing else, no title, names in capitals or initials, third degree, recruiters,
 * students, VPs, people already written to, hidden or turned down, duplicates). Each page is checked against what a
 * career coach would accept: nobody suggested without a specific reason tied to the student's goals or a real tie,
 * the junk and the already-contacted never shown, the picks the strongest few with the right action, reasons that
 * name names instead of counting, clean names, an order that follows the score, and scores that spread.
 */
import { normalizeCompany, type WhyReason } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { BAD, buildDiscover, type DiscoverBuilt, discoverSpecs, GOOD_FOUND } from '../test/discoverAccounts';
import { recommendationsRefresh } from './brief';
import { loadDemo } from './demo';
import { type DiscoverCard, type DiscoverView, discoverView, loadMoreDiscover } from './discoverFeed';
import { connectLinkedInLive } from './linkedinLive';

// ---------- what a card says, as the page shows it ----------

interface Shown {
  key: string;
  kind: 'found' | 'network';
  name: string;
  role?: string;
  why: WhyReason[];
  /** the combined score the page ranks by, and the three meters */
  score: number;
  match: number;
  reach: number;
  odds?: number;
  action: 'intro' | 'warm_up' | 'write' | 'save';
  /** the one line a pick shows */
  pickLine?: string;
  distance?: number;
  warmPath: boolean;
  seniorTitle: boolean;
  company: string;
  /** who the way in is (the friend at their company, the introducer) */
  via?: string;
  saved: boolean;
}

function shown(c: DiscoverCard): Shown {
  const senior = (t?: string) =>
    /\b(vp|vice president|director|head of|chief|partner|managing director)\b/i.test(t ?? '');
  if (c.kind === 'found')
    return {
      key: c.entry.memberId,
      kind: 'found',
      name: c.name,
      role: c.role,
      why: c.why,
      score: c.metrics.score,
      match: c.metrics.match,
      reach: c.metrics.reach,
      odds: c.metrics.odds,
      action: c.action,
      pickLine: c.why[0]?.text,
      distance: c.entry.distance,
      warmPath: !!c.colleague,
      seniorTitle: senior(c.role),
      company: normalizeCompany(c.entry.company),
      via: c.colleague?.personId,
      saved: false,
    };
  return {
    key: c.person.id,
    kind: 'network',
    name: c.name,
    role: c.person.currentTitle,
    why: c.why,
    score: c.metrics.score,
    match: c.metrics.match,
    reach: c.metrics.reach,
    odds: c.metrics.odds,
    action: c.action,
    pickLine: c.why[0]?.text,
    warmPath: !!c.introducer,
    seniorTitle: senior(c.person.currentTitle),
    company: normalizeCompany(c.person.currentOrganizationRaw),
    via: c.introducer?.id,
    saved: c.rec.status === 'saved',
  };
}

// ---------- what must hold ----------

const BANNED_TEXT = /\bundefined\b|\bNaN\b|\bnull\b|\[object|—/;
/** Lines that are true of thousands of people, or say nothing about why to meet them: never a card's lead reason. */
const GENERIC_LEAD = [
  /mutual connection/i,
  /^Connected on LinkedIn/i,
  /^Works in [a-z &]+ \(/i,
  /a role you('| a)re targeting$/i,
  /^Based in|where you want to work$/i,
  /^Found by the search/i,
  /^Second degree/i,
  /^Went to .*, like you$/i,
  /^Works in .*, an industry on your list$/i,
  /^(In|Also in) /,
  /^New in the role|^Moved to/,
];
const THIN = /That's all Orbit knows|Only their (LinkedIn headline|title and company)|Not much known/;
const DESCRIPTIVE = /\b(experienced|versatile|passionate|results-driven|seasoned|dynamic|helping)\b/i;

function check(b: DiscoverBuilt, v: DiscoverView, problem: (what: string, detail?: string) => void) {
  const picks = v.suggestions.map(shown);
  const feed = v.feed.map(shown);
  const all = [...picks, ...feed];
  const label = (s: Shown) =>
    `${s.name} (${b.archetype.get(s.key) ?? '?'}): ${s.why.map((w) => w.text).join(' / ')}`;

  // nobody who must never be suggested
  for (const s of all) {
    const a = b.archetype.get(s.key);
    if (a && BAD.has(a)) problem(`a ${a} person is suggested`, label(s));
  }
  // the strong new people are all there
  // a person found twice counts as shown under either id
  const keys = new Set(all.flatMap((s) => [s.key, b.dupOf.get(s.key) ?? s.key]));
  for (const e of b.found) {
    const a = b.archetype.get(e.memberId)!;
    if (GOOD_FOUND.has(a) && !keys.has(e.memberId)) problem(`a strong ${a} person is missing`, e.headline);
  }
  // a friend at a company is named as the way in for a couple of the people there (the best two), and they are shown
  const colleagues = new Map<string, number>();
  for (const e of b.found)
    if (b.archetype.get(e.memberId) === 'f_colleague') {
      const k = normalizeCompany(e.company);
      colleagues.set(k, (colleagues.get(k) ?? 0) + 1);
    }
  for (const [k, made] of colleagues) {
    const intros = all.filter((s) => s.kind === 'found' && s.warmPath && s.company === k).length;
    if (intros < Math.min(2, made))
      problem('a friend at the company is not offered as the way in', `${k} ${intros}/${made}`);
  }
  // a network with strong people in it shows some of them
  const strongNet = b.people.filter((p) =>
    ['n_target_role', 'n_alum_field', 'n_intro_target', 'n_replied_field', 'n_caps_name'].includes(
      b.archetype.get(p.id) ?? '',
    ),
  );
  if (strongNet.length && !all.some((s) => s.kind === 'network'))
    problem('strong people in the network, none suggested', `${strongNet.length} strong`);

  // nobody twice
  const seen = new Set<string>();
  for (const s of all) {
    const k = b.dupOf.get(s.key) ?? s.key;
    if (seen.has(k)) problem('the same person twice', label(s));
    seen.add(k);
  }

  // every card: a specific reason first, no filler, clean names
  for (const s of all) {
    const lead = s.why[0];
    if (!lead) problem('a card with no reason', label(s));
    else if (GENERIC_LEAD.some((re) => re.test(lead.text)))
      problem('a card led by a generic reason', label(s));
    for (const w of s.why) {
      if (THIN.test(w.text)) problem('a card says Orbit knows little about them', label(s));
      if (BANNED_TEXT.test(w.text)) problem('a reason with bad text', w.text);
      if (/^Works in [a-z &]+ \(/i.test(w.text)) problem('a generic function line', w.text);
      if (DESCRIPTIVE.test(w.text)) problem('a headline used as a role in a reason', w.text);
    }
    if (s.role && DESCRIPTIVE.test(s.role)) problem('a headline shown as their role', s.role);
    if (s.role && s.why.filter((w) => w.text.includes(`${s.role} at`)).length > 1)
      problem('a card says the same role twice', label(s));
    if (
      s.why.filter((w) => w.kind === 'school').length > 0 &&
      s.why.some((w) => / alum[, ]/.test(w.text)) &&
      s.why.some((w) => /^Went to /.test(w.text))
    )
      problem('a card says the same school twice', label(s));
    if (s.name.length > 3 && s.name === s.name.toUpperCase() && /[A-Z]{2}/.test(s.name))
      problem('a name in capitals', s.name);
    if (s.odds === undefined || Number.isNaN(s.odds)) problem('a card without reply odds', label(s));
    for (const m of [s.match, s.reach, s.odds ?? 0, s.score])
      if (!(m >= 0 && m <= 1)) problem('a meter out of range', `${label(s)} ${m}`);
  }

  // the picks: the strongest few, each with the right single action
  // one pick for every three people, four at most: a short list keeps its full cards
  if (picks.length > Math.min(4, Math.floor(all.length / 3)))
    problem('more picks than the list has room for');
  for (let i = 1; i < picks.length; i++)
    if (picks[i]!.score > picks[i - 1]!.score + 1e-9) problem('picks not best first');
  const weakestPick = Math.min(...picks.map((s) => s.score));
  for (const s of picks) {
    if (s.kind === 'found' && s.distance === 3 && !s.warmPath) problem('a cold third-degree pick', label(s));
    if (s.seniorTitle && !s.warmPath) problem('a cold pick of a VP or director', label(s));
    if (b.archetype.get(s.key) === 'f_initial_last')
      problem('a pick with only an initial for a last name', s.name);
    if (s.action === 'save') problem('a pick whose action is only to save them', label(s));
    if (s.warmPath && s.action !== 'intro' && s.action !== 'write')
      problem('a pick with a way in not asked for an intro', label(s));
    if (!s.warmPath && s.action === 'intro') problem('an intro pick with nobody to ask', label(s));
    if (!s.pickLine || GENERIC_LEAD.some((re) => re.test(s.pickLine!)))
      problem('a pick with a weak line', label(s));
  }
  // nothing stronger left in the feed, unless the picks already hold two at its company or ask its friend
  const perCo = new Map<string, number>();
  for (const s of picks) if (s.company) perCo.set(s.company, (perCo.get(s.company) ?? 0) + 1);
  const vias = new Set(picks.map((s) => s.via).filter(Boolean));
  for (const s of feed) {
    if (!pickable(s) || (s.company && (perCo.get(s.company) ?? 0) >= 2) || (s.via && vias.has(s.via)))
      continue;
    if (picks.length < Math.min(4, Math.floor(all.length / 3)) || s.score > weakestPick + 1e-9)
      problem('a stronger card left out of the picks', label(s));
  }

  // the feed follows the score (people the student saved lead)
  const ranked = feed.filter((s) => !s.saved);
  for (let i = 1; i < ranked.length; i++)
    if (ranked[i]!.score > ranked[i - 1]!.score + 1e-9) {
      problem(
        'feed not ordered by score',
        `${ranked[i - 1]!.name} ${ranked[i - 1]!.score} < ${ranked[i]!.name} ${ranked[i]!.score}`,
      );
      break;
    }
  // the scores spread
  // the scores spread: a page of eight or more is not one number (a page all of one kind may share a Match, but then
  // the rank still tells them apart)
  if (all.length >= 12 && new Set(all.map((s) => s.company)).size > 1) {
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const ms = all.map((s) => s.match);
    if (spread(ms) < 0.15 && spread(all.map((s) => s.score)) < 0.1)
      problem('scores bunched up', all.map((s) => `${s.match}/${s.score}`).join(','));
  }
}

/** Could this card be a pick at all (picks skip cold third degree, cold VPs, initials and save-only). */
function pickable(s: Shown): boolean {
  return (
    !s.saved &&
    !(s.kind === 'found' && s.distance === 3 && !s.warmPath) &&
    !(s.seniorTitle && !s.warmPath) &&
    s.action !== 'save' &&
    !/\b\p{L}\.?$/u.test(s.name)
  );
}

describe('hundreds of Discover pages', () => {
  it('suggest only people worth meeting, each for a specific reason, best first', async () => {
    const specs = discoverSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(300);
    const problems = new Map<string, string[]>();
    let pages = 0;
    let cards = 0;
    const leads = new Map<string, number>();
    const metrics = { match: [] as number[], reach: [] as number[], odds: [] as number[] };
    for (const spec of specs) {
      const b = await buildDiscover(spec);
      await recommendationsRefresh(b.user, b.now, { batchSize: 20 });
      const v = await discoverView(b.user, b.now);
      pages++;
      cards += v.feed.length + v.suggestions.length;
      for (const c of [...v.suggestions, ...v.feed]) {
        const s = shown(c);
        const k = s.why[0]?.kind ?? 'none';
        leads.set(k, (leads.get(k) ?? 0) + 1);
        for (const [m, x] of [
          ['match', s.match],
          ['reach', s.reach],
          ['odds', s.odds ?? 0],
        ] as const)
          metrics[m].push(x);
      }
      check(b, v, (what, detail) => {
        const list = problems.get(what) ?? [];
        list.push(`${spec.name}${detail ? `: ${detail}` : ''}`);
        problems.set(what, list);
      });
    }
    const report = [...problems]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, v]) => `${v.length} × ${k} (e.g. ${v[0]})`);
    const total = [...problems.values()].reduce((n, v) => n + v.length, 0);
    console.log(
      `discover sim: ${pages} pages, ${cards} cards, ${total} violations\nleads: ${[...leads].map(([k, n]) => `${k} ${n}`).join(', ')}\n${report.join('\n')}`,
    );
    // across every page the meters use their range: not everyone between 50 and 70
    const bands = Object.fromEntries(
      Object.entries(metrics).map(([k, xs]) => {
        const band = (lo: number, hi: number) => xs.filter((x) => x >= lo && x < hi).length / xs.length;
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
        return [k, { sd, mid: band(0.5, 0.7), low: band(0, 0.4), high: band(0.7, 1.01) }];
      }),
    );
    console.log('meters:', JSON.stringify(bands));
    for (const [k, b] of Object.entries(bands)) {
      expect(b.sd, `${k} spread`).toBeGreaterThan(0.1);
      expect(b.mid, `${k} share between 50 and 70`).toBeLessThan(0.6);
    }
    expect(report).toEqual([]);
    expect(pages).toBeGreaterThanOrEqual(300);
    expect(cards).toBeGreaterThan(1500);
  }, 600_000);
});

describe('the demo student', () => {
  it('keeps a rich page: most cards give two or more specific reasons', async () => {
    const now = new Date('2026-10-06T10:00:00');
    const user = await loadDemo({ reset: true, now });
    // as the page does when it opens, and once LinkedIn is connected (the sample student's is a mock)
    await recommendationsRefresh(user, now, { batchSize: 20 });
    expect((await connectLinkedInLive(user)).ok).toBe(true);
    await loadMoreDiscover(user, { now });
    const v = await discoverView(user, now);
    expect(v.found.length).toBeGreaterThan(4);
    const all = [...v.suggestions, ...v.feed].map(shown);
    expect(all.length).toBeGreaterThan(10);
    // two or more specific lines: not a count of mutuals, a LinkedIn connection, the city or the role alone
    const rich = all.filter(
      (s) => s.why.filter((w) => !GENERIC_LEAD.some((re) => re.test(w.text))).length >= 2,
    );
    expect(rich.length / all.length).toBeGreaterThan(0.7);
    for (const s of all) expect(GENERIC_LEAD.some((re) => re.test(s.why[0]?.text ?? ''))).toBe(false);
  }, 90_000);
});
