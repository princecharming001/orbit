/**
 * Plan 23's tools: the plan from a job posting, and the week's chats. The weekly review's numbers come from
 * week_review (engine/weekReview.ts), and what Orbit may send on its own from update_limits' autoKinds.
 */
import { db } from '../../db/schema';
import { afterText, type ChatRow, clockOf, upcomingChats } from '../../engine/chatsView';
import { connectedNotetaker } from '../../engine/notesCheck';
import { planFromInput, postingLine, whenText } from '../../engine/targetPlan';
import { buildWeekReview } from '../../engine/weekReview';
import { z } from '../../zod';
import { type AnyTool, defineTool, ok, toModel } from './_shared';

export const planForPosting = defineTool({
  name: 'plan_for_posting',
  kind: 'write',
  description:
    'Call this when the student pastes a job posting link, pastes a posting\'s text, or says which role and company they are applying to ("I\'m applying to Stripe", "SWE intern at Ramp"). Orbit reads the posting, adds the company as a target, and picks up to three people who can get them in (someone who recruits, someone on the team, someone who leads it), each with the way in and the day. Nothing is drafted or sent: the card\'s Draft all three does that.',
  input: z.object({
    url: z.string().optional().describe('The posting link, as pasted.'),
    text: z
      .string()
      .optional()
      .describe(
        'The posting text, or the role and company ("Software Engineer Intern at Stripe"), or a company.',
      ),
  }),
  capabilities: ['job_plan'],
  progress: 'Reading the posting',
  async execute(input, ctx) {
    const what = input.url?.trim() || input.text?.trim();
    if (!what) throw new Error('Paste the job link, or name the role and company.');
    const r = await planFromInput(ctx.user, what, ctx.now);
    if (!r.ok) throw new Error(r.message);
    const p = r.plan;
    const names = new Map(
      (await db.people.bulkGet(p.steps.map((s) => s.personId))).filter((x) => !!x).map((x) => [x!.id, x!]),
    );
    const first = (id: string) => names.get(id)?.firstName ?? 'them';
    const steps = p.steps.map((s) => ({
      personId: s.personId,
      name: names.get(s.personId)?.displayName ?? s.found?.name,
      role: s.roleText,
      route: s.route.line,
      score: Math.round(s.route.score * 100),
      when: whenText(s, first, ctx.now, ctx.user.timezone),
    }));
    const target = await db.targetCompanies.get(p.targetCompanyId);
    const summary = p.steps.length
      ? `Your plan for ${postingLine(p.posting)}: ${steps.map((s) => `${s.name} (${s.role}, ${s.when})`).join('; ')}. Nothing is drafted until you say so.`
      : p.cold
        ? `${p.posting.company} is a target now. Nobody in your network touches it yet: connect LinkedIn and Orbit finds who can get you in.`
        : `${p.posting.company} is a target now. Everyone Orbit would pick there is already in your pipeline.`;
    return ok(
      'plan',
      { planId: p.id },
      { posting: p.posting, steps, inPipeline: p.inPipeline, more: p.more },
      summary,
      target?.organizationId ? `/companies/${target.organizationId}` : undefined,
    );
  },
  toModel,
});

function rowOut(r: ChatRow, tz: string) {
  return {
    personId: r.person.id,
    name: r.person.displayName,
    at: r.startAt ? clockOf(r.startAt, tz) : undefined,
    minutes: r.minutes,
    join: r.joinUrl,
    after: r.after ? afterText(r.after) : undefined,
  };
}

export const listUpcomingChats = defineTool({
  name: 'list_upcoming_chats',
  kind: 'read',
  description:
    'Call this when the student asks about their coffee chats: who they are meeting today or this week, when the next chat is, what came back from a chat that just happened (notes in, a thank-you ready), or which chats have no time yet. Returns the days with each chat, the ones that just happened, and the ones agreed to with no time set.',
  input: z.object({}),
  capabilities: ['chats_upcoming'],
  progress: 'Looking at your chats',
  async execute(_input, ctx) {
    const userId = ctx.user.id;
    const tz = ctx.user.timezone || 'UTC';
    const [events, chats, people, notes, facts, suggestions, taker] = await Promise.all([
      db.events.where('userId').equals(userId).toArray(),
      db.chats.where('userId').equals(userId).toArray(),
      db.people.where('userId').equals(userId).toArray(),
      db.notes.where('userId').equals(userId).toArray(),
      db.facts.where('userId').equals(userId).toArray(),
      db.suggestions
        .where('userId')
        .equals(userId)
        .filter((s) => s.status === 'pending')
        .toArray(),
      connectedNotetaker(userId),
    ]);
    const v = upcomingChats(
      { events, chats, people, notes, facts, suggestions, notetaker: taker?.name },
      ctx.now,
      tz,
    );
    const items = [
      ...v.justHappened.map((r) => ({
        text: `${r.person.displayName} · ${afterText(r.after!)}`,
        sub: 'Just happened',
        href: `/people/${r.person.id}`,
      })),
      ...v.days.flatMap((d) =>
        d.rows.map((r) => ({
          text: `${r.person.displayName} · ${clockOf(r.startAt!, tz)}`,
          sub: d.label,
          href: `/people/${r.person.id}?tab=facts&prep=1`,
        })),
      ),
      ...v.noTime.map((r) => ({
        text: `${r.person.displayName} · no time set`,
        sub: 'No time yet',
        href: `/people/${r.person.id}`,
      })),
    ];
    const n = v.days.reduce((k, d) => k + d.rows.length, 0);
    const summary = items.length
      ? `${n ? `${n} ${n === 1 ? 'chat' : 'chats'} coming up${v.todayCount ? `, ${v.todayCount} today` : ''}` : 'No chats coming up'}${v.justHappened.length ? `; ${v.justHappened.length} just happened` : ''}${v.noTime.length ? `; ${v.noTime.length} with no time yet` : ''}.`
      : 'No chats booked. When someone agrees to talk, it shows up in Chats.';
    return ok(
      'list',
      { title: 'Your chats', items },
      {
        days: v.days.map((d) => ({ day: d.label, chats: d.rows.map((r) => rowOut(r, tz)) })),
        justHappened: v.justHappened.map((r) => rowOut(r, tz)),
        noTime: v.noTime.map((r) => rowOut(r, tz)),
      },
      summary,
      '/chats',
    );
  },
  toModel,
});

export const weekReviewTool = defineTool({
  name: 'week_review',
  kind: 'read',
  description:
    'Call this when the student asks how their week went, for their weekly review or recap, or what moved this week. Returns the week that ends on the last Sunday: how many they reached, who replied, chats booked and who went quiet against their weekly target, who moved, what is waiting on them, and next week. The same numbers as the Sunday review.',
  input: z.object({}),
  capabilities: ['week_review'],
  progress: 'Adding up your week',
  async execute(_input, ctx) {
    const r = await buildWeekReview(ctx.user, ctx.now);
    const names = (xs: { name: string }[]) => xs.map((x) => x.name);
    const out = {
      weekEnding: r.weekEnding,
      reached: names(r.reached),
      replied: names(r.replied),
      booked: names(r.booked),
      wentQuiet: names(r.quiet),
      weeklyTarget: r.target,
      moved: r.moved.map((m) => m.text),
      waitingCards: r.waiting.suggestionIds.length,
      overduePromises: r.waiting.overdue.map((o) => o.text),
      next: r.next,
      holiday: r.holiday,
    };
    const items = [
      ...r.moved.map((m) => ({ text: m.text, href: `/people/${m.personId}` })),
      ...(r.next.planLine ? [{ text: r.next.planLine }] : []),
    ];
    return ok(
      'list',
      { title: `Your week: ${r.headline}`, items },
      out,
      `${r.headline}. Your target is ${r.target} first messages a week.${r.waiting.suggestionIds.length ? ` ${r.waiting.suggestionIds.length} waiting on you in Drafts.` : ''}`,
      '/inbox?review=1',
    );
  },
  toModel,
});

export const goalFirstTools: AnyTool[] = [planForPosting, listUpcomingChats, weekReviewTool];
