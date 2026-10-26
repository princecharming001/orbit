/**
 * Hundreds of morning briefs, built from made-up accounts of every shape (empty, one person, hundreds; every card kind
 * alone and mixed; drafts with and without a body; duplicates with and without LinkedIn; stage questions, intros,
 * warm-ups, chats today; long names, no photos, weekends, nothing due, fifty cards at once), each checked against what
 * a student should be able to trust: the counts are right, nothing shows twice, every decision can be finished in the
 * deck, the words match the data, and the last slide adds up.
 */
import type { Suggestion } from '@orbit/core';
import { differentLinkedInProfiles } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { type Built, build, KINDS, localDate, readAccount, rng, specs } from '../test/morningAccounts';
import { isMessageSuggestion, needsWarmUp } from './brief';
import { loadDemo } from './demo';
import {
  decisionActions,
  MORNING_MAX_DECISIONS,
  MORNING_MAX_MOVES,
  type MorningDeck,
  type MorningOutcome,
  morningDeck,
  morningSummary,
  reasonHolds,
} from './morning';
import { stillTrue } from './today';

// ---------- what must hold ----------

const BANNED = /—|!|\bundefined\b|\bNaN\b|\bnull\b|\[object/;
const QUESTION = new Set(['confirm_stage', 'confirm_intro', 'confirm_merge']);
const TIMELY = new Set(['prep_brief', 'schedule_confirm']);
const IN_FLIGHT = new Set(['queued', 'sending', 'handed_off', 'failed']);
const group = (s: Suggestion) =>
  TIMELY.has(s.kind) ? 0 : QUESTION.has(s.kind) ? 1 : isMessageSuggestion(s.kind) ? 2 : 3;

/** Every card the deck should account for (as a decision or in "more in Drafts"), worked out on its own. */
function expectedCards(b: Built): Suggestion[] {
  const people = new Map(b.people.map((p) => [p.id, p]));
  const visible = (id?: string) => !id || (people.has(id) && !people.get(id)!.hiddenAt);
  const inFlight = new Set(b.outbound.filter((o) => IN_FLIGHT.has(o.status)).map((o) => o.id));
  return b.suggestions.filter((s) => {
    if (!visible(s.personId) || !stillTrue(s, b.now)) return false;
    // two LinkedIn profiles are two people: a duplicate question about them is never asked
    if (s.kind === 'confirm_merge') {
      const a = people.get(s.personId!);
      const o = people.get(s.payload.otherPersonId as string);
      if (a && o && differentLinkedInProfiles(a, o)) return false;
    }
    const inBrief = !!b.brief?.suggestionIds.includes(s.id);
    if (!inBrief && s.deferred) return false;
    if (isMessageSuggestion(s.kind))
      return s.status === 'pending' && !(s.outboundMessageId && inFlight.has(s.outboundMessageId));
    return (
      s.status === 'pending' ||
      (s.status === 'snoozed' && !!s.snoozedUntil && new Date(s.snoozedUntil) <= b.now)
    );
  });
}

function check(b: Built, deck: MorningDeck, problem: (what: string, detail?: string) => void) {
  const people = new Map(b.people.map((p) => [p.id, p]));
  const texts = [
    deck.greeting,
    deck.dateLabel,
    deck.headline,
    ...deck.moves.flatMap((m) => [m.text, m.sub ?? '']),
  ];
  for (const t of texts) if (BANNED.test(t)) problem('text has a banned character or word', t);

  // the decisions
  const expected = expectedCards(b);
  if (deck.decisions.length > MORNING_MAX_DECISIONS) problem('more decisions than the cap');
  if (deck.decisions.length + deck.moreInDrafts !== expected.length)
    problem(
      'decisions plus "more in Drafts" do not match the cards for today',
      `${deck.decisions.length}+${deck.moreInDrafts} vs ${expected.length}`,
    );
  if (expected.length && !deck.decisions.length) problem('cards for today but no decision shown');
  const ids = deck.decisions.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problem('a decision shows twice');
  for (const s of deck.decisions) {
    if (!expected.some((x) => x.id === s.id)) problem('a decision that is not a card for today', s.kind);
    if (s.personId && (!people.get(s.personId) || people.get(s.personId)!.hiddenAt))
      problem('a decision about a hidden or missing person', s.kind);
  }
  for (let i = 1; i < deck.decisions.length; i++)
    if (group(deck.decisions[i]!) < group(deck.decisions[i - 1]!))
      problem('decisions out of order (a time today, questions, messages, the rest)');
  // the most pressing are the ones shown: nothing left for Drafts outranks what made the cut
  const shownWorst = Math.max(-1, ...deck.decisions.map(group));
  const left = expected.filter((s) => !ids.includes(s.id));
  if (deck.decisions.length === MORNING_MAX_DECISIONS && left.some((s) => group(s) < shownWorst))
    problem('a more pressing card was left out for a less pressing one');

  // what each decision offers
  for (const s of deck.decisions) {
    const p = s.personId ? people.get(s.personId) : undefined;
    const draft = s.outboundMessageId ? b.outbound.find((o) => o.id === s.outboundMessageId) : undefined;
    const coldStart =
      s.kind === 'new_outreach' &&
      !s.chatId &&
      !!p &&
      !p.primaryEmail &&
      needsWarmUp(p, 'linkedin', b.settings.warmUpEnabled, false);
    const stageEvent = b.stageEvents.find((e) => e.id === s.payload.stageEventId);
    for (const opened of [false, true]) {
      const actions = decisionActions(s, {
        firstName: p?.firstName,
        hasDraft: !!draft,
        coldStart,
        toStage: stageEvent?.toStage,
        openedLinkedIn: opened,
      });
      if (!actions.length) problem('a decision with no actions', s.kind);
      if (actions.filter((a) => a.primary).length !== 1)
        problem('a decision without exactly one primary', s.kind);
      if (!actions.some((a) => ['resolve', 'compose', 'snooze'].includes(a.effect)))
        problem('a decision that cannot be finished inside the deck', s.kind);
      const primary = actions.find((a) => a.primary);
      if (primary?.effect === 'page' && !['prep_brief', 'confirm_note_match'].includes(s.kind))
        problem('a primary action that leaves the deck', s.kind);
      if (primary?.effect === 'compose' && !p) problem('a message to write with nobody to write to', s.kind);
      for (const a of actions) {
        if (!a.label.trim() || BANNED.test(a.label) || BANNED.test(a.hint))
          problem('an action label with bad text', a.label);
        if (a.effect === 'page' && !/^(Open|Pick)\b/.test(a.label))
          problem('a page action that does not say it opens a page', a.label);
      }
      if (new Set(actions.map((a) => a.id)).size !== actions.length) problem('an action shows twice', s.kind);
    }
    if (s.kind === 'confirm_merge') {
      const other = people.get(s.payload.otherPersonId as string);
      if (!other || !p) problem('a possible duplicate without both records');
    }
  }

  // worth doing today
  if (deck.moves.length > MORNING_MAX_MOVES) problem('more moves than the cap');
  const decided = new Set(deck.decisions.map((s) => s.personId));
  const seen = new Set<string>();
  for (const m of deck.moves) {
    const p = people.get(m.personId);
    if (!p || p.hiddenAt) problem('a move about a hidden or missing person', m.kind);
    if (decided.has(m.personId)) problem('a person in a decision and again in a move', m.kind);
    if (seen.has(m.personId)) problem('a person twice under worth doing today', m.kind);
    seen.add(m.personId);
    if (!m.text.includes(p?.firstName ?? '\u0000')) problem('a move that does not name its person', m.text);
    if (m.kind === 'prep') {
      const e = b.events.find((x) => `ev:${x.id}` === m.id);
      if (!e || new Date(e.startAt) <= b.now) problem('prep for a chat that already started', m.sub);
    }
    if (m.kind === 'warm_up') {
      const c = b.chats.find((x) => x.id === m.chatId);
      const a = c?.warmUp?.actions.find((x) => x.id === m.actionId);
      if (!a || a.doneAt || a.skippedAt || !m.url) problem('a warm-up move that cannot be done in place');
      const card = b.suggestions.find((s) => s.dedupeKey === `warm:${m.chatId}:${m.actionId}`);
      if (card?.status === 'snoozed' && card.snoozedUntil && new Date(card.snoozedUntil) > b.now)
        problem('a warm-up step put off until tomorrow shows again today');
    }
    if (m.kind === 'reach_out') {
      const rec = b.recs.find((x) => x.id === m.recommendationId);
      const said = rec?.reasons.find((x) => x.text === m.sub);
      if (said && p && !reasonHolds(said, p)) problem('a Discover reason that no longer holds');
    }
  }

  // the numbers
  const replies = b.chats.filter(
    (c) =>
      c.lastInboundAt &&
      b.now.getTime() - new Date(c.lastInboundAt).getTime() <= 86_400_000 &&
      new Date(c.lastInboundAt) <= b.now &&
      !people.get(c.personId)?.hiddenAt,
  ).length;
  if (deck.stats.replies !== replies) problem('replies count is off', `${deck.stats.replies} vs ${replies}`);
  const chatsToday = b.events.filter(
    (e) =>
      e.status !== 'cancelled' &&
      localDate(new Date(e.startAt)) === localDate(b.now) &&
      e.attendeePersonIds.some((id) => people.get(id) && !people.get(id)!.hiddenAt),
  ).length;
  if (deck.stats.chatsToday !== chatsToday) problem('chats today count is off');
  if (deck.stats.replyRate !== undefined && (deck.stats.replyRate < 0 || deck.stats.replyRate > 100))
    problem('reply rate out of range');

  // the headline says what the deck shows, and nothing more
  const h = deck.headline;
  const n = deck.decisions.length;
  if (n && !h.startsWith(`${n} thing${n === 1 ? '' : 's'} to decide`))
    problem('headline miscounts the decisions', h);
  if (!n && /to decide/.test(h) && !/^Nothing to decide/.test(h))
    problem('headline promises decisions there are none of', h);
  if (n && /^Nothing/.test(h)) problem('headline says nothing is waiting while decisions are', h);
  if (deck.moreInDrafts && !h.includes(`${deck.moreInDrafts} more in Drafts`))
    problem('headline hides the cards left in Drafts', h);
  if (/chat/.test(h) !== deck.stats.chatsToday > 0) problem('headline and chats today disagree', h);
  if (deck.stats.chatsToday && !h.includes(`${deck.stats.chatsToday} chat`))
    problem('headline miscounts chats', h);
  if (/repl/.test(h) !== deck.stats.replies > 0) problem('headline and replies disagree', h);
  if (/^Nothing is waiting/.test(h) && (n || deck.stats.replies || deck.stats.chatsToday))
    problem('headline says nothing is waiting', h);
  if (!b.people.length && !/Add a few people/.test(h))
    problem('an empty account is not told how to start', h);
  const hour = b.now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  if (!deck.greeting.startsWith(part)) problem('greeting does not match the time of day', deck.greeting);
  if (!deck.dateLabel.startsWith(b.now.toLocaleDateString('en-US', { weekday: 'long' })))
    problem('date label is not today', deck.dateLabel);

  // the last slide adds up, whatever the student did
  const r = rng(b.user.id.length + deck.decisions.length);
  for (let k = 0; k < 4; k++) {
    const outcomes: Record<string, MorningOutcome | undefined> = {};
    for (const s of deck.decisions)
      if (r.chance(0.8)) outcomes[s.id] = r.pick(['sent', 'done', 'later', 'skipped'] as const);
    const sum = morningSummary(deck, outcomes);
    const untouched = deck.decisions.filter((s) => !outcomes[s.id]).length;
    if (sum.sent + sum.done + sum.later + sum.skipped + untouched !== deck.decisions.length)
      problem('the last slide does not add up');
    if (sum.waitingInDrafts !== sum.skipped + untouched + deck.moreInDrafts)
      problem('the last slide counts cards put off until tomorrow as waiting in Drafts');
    if (sum.waitingInDrafts && /^Nothing/.test(sum.rest))
      problem('the last slide says nothing is left while cards are');
    if (!sum.waitingInDrafts && !/^Nothing/.test(sum.rest))
      problem('the last slide says cards are left when none are');
    for (const t of [...sum.lines, sum.rest]) if (BANNED.test(t)) problem('the last slide has bad text', t);
  }
}

describe('hundreds of morning briefs', () => {
  it('every brief is counted right, says only what the data backs, and can be finished in place', async () => {
    const all = specs();
    expect(all.length).toBeGreaterThanOrEqual(300);
    const problems = new Map<string, string[]>();
    let decks = 0;
    let decisions = 0;
    const kindsSeen = new Set<string>();
    for (const spec of all) {
      const b = await build(spec);
      const deck = await morningDeck(b.user, b.now);
      decks++;
      decisions += deck.decisions.length;
      for (const s of deck.decisions) kindsSeen.add(s.kind);
      check(b, deck, (what, detail) => {
        const list = problems.get(what) ?? [];
        list.push(`${spec.name}${detail ? `: ${detail}` : ''}`);
        problems.set(what, list);
      });
    }
    const report = [...problems].map(([k, v]) => `${v.length} × ${k} (e.g. ${v[0]})`);
    if (report.length) console.log(`morning sim, ${decks} decks:\n${report.join('\n')}`);
    expect(report).toEqual([]);
    expect(decks).toBeGreaterThanOrEqual(300);
    expect(decisions).toBeGreaterThan(500);
    // every kind of card was put in front of the deck at least once
    for (const k of KINDS) expect(kindsSeen, k).toContain(k);
  }, 240_000);
});

describe('the demo student, through the real engine, on the days a student opens it', () => {
  for (const at of [
    '2026-10-06T10:00:00',
    '2026-10-09T18:00:00',
    '2026-10-10T10:00:00',
    '2026-10-11T23:00:00',
    '2026-10-05T07:00:00',
  ])
    it(`holds on ${at}`, async () => {
      const now = new Date(at);
      const user = await loadDemo({ reset: true, now });
      const deck = await morningDeck(user, now);
      const problems: string[] = [];
      check(await readAccount(user, now), deck, (what, detail) =>
        problems.push(`${what}${detail ? `: ${detail}` : ''}`),
      );
      expect(problems).toEqual([]);
      expect(deck.decisions.length).toBeGreaterThan(0);
    }, 90_000);
});
