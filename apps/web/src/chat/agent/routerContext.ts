import { db } from '../../db/schema';
import { DEMO_USER_ID } from '../../engine/demo';
import { activeGoals } from '../../engine/goals';
import { recentPaths } from '../../engine/paths';
import { isServerUser } from '../../integrations/orbitApi';
import { chatModeNote, SETTINGS_ROUTE } from './mode';
import type { RouterContext } from './router';
import { peopleWaitingNow } from './setup';

/**
 * What the no-key router knows about the student when it reads a message: their people and companies, open cards,
 * unsent drafts, the next booked chat, goals, routes found in this tab and what is connected. The engine builds it for
 * every router turn; the offline simulation builds the same thing to see where a chip's message would go.
 */
export async function routerContextFor(
  userId: string,
  now: Date,
): Promise<Omit<RouterContext, 'registry' | 'thread'>> {
  const [all, companies, extra, user, more] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    companiesFor(userId),
    routerExtras(userId, now),
    db.users.get(userId),
    routerMore(userId),
  ]);
  const humans = all.filter((p) => p.isHuman);
  return {
    people: humans.filter((p) => !p.hiddenAt),
    hidden: humans.filter((p) => !!p.hiddenAt),
    companies,
    ...extra,
    ...more,
    now,
    firstName: user?.firstName,
    modeNote: chatModeNote()?.text ?? '',
    settingsHref: SETTINGS_ROUTE,
  };
}

async function companiesFor(userId: string): Promise<string[]> {
  const [targets, people] = await Promise.all([
    db.targetCompanies.where('userId').equals(userId).toArray(),
    db.people.where('userId').equals(userId).toArray(),
  ]);
  const names = new Set<string>();
  for (const t of targets) names.add(t.nameRaw);
  for (const p of people) if (p.currentOrganizationRaw) names.add(p.currentOrganizationRaw);
  return [...names];
}

/** The open cards, unsent drafts and next booked chat the router can name. */
async function routerExtras(userId: string, now: Date) {
  const [cards, drafts, events, briefs, integrations] = await Promise.all([
    db.suggestions
      .where('userId')
      .equals(userId)
      .filter((s) => s.status === 'pending')
      .toArray(),
    db.outbound
      .where('userId')
      .equals(userId)
      .filter((o) => ['draft', 'failed', 'handed_off'].includes(o.status))
      .toArray(),
    db.events
      .where('userId')
      .equals(userId)
      .filter((e) => e.status !== 'cancelled' && !!e.chatId && new Date(e.startAt).getTime() > now.getTime())
      .toArray(),
    db.briefs.where('userId').equals(userId).toArray(),
    db.integrations.where('userId').equals(userId).toArray(),
  ]);
  const live = integrations.some(
    (i) => i.provider === 'linkedin_live' && i.status !== 'revoked' && !!i.externalAccountId,
  );
  const latestBrief = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const next = events.sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  const nextChat = next?.chatId ? await db.chats.get(next.chatId) : undefined;
  return {
    cards: cards
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => ({ id: c.id, personId: c.personId, kind: c.kind })),
    drafts: drafts
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((d) => ({
        id: d.id,
        personId: d.personId,
        status: d.status,
        kind: d.kind,
        body: d.bodyFinal ?? d.bodyDraft ?? '',
        subject: d.subject ?? undefined,
        suggestionId: d.suggestionId ?? undefined,
      })),
    nextChat: nextChat ? { personId: nextChat.personId } : undefined,
    goals: (await activeGoals(userId)).map((g) => ({ id: g.id, kind: g.kind, title: g.title })),
    paths: recentPaths(),
    account: isServerUser(userId),
    waiting: peopleWaitingNow(cards, latestBrief, now),
    // what is connected, the same way the snapshot's Setup line counts it
    setup: {
      linkedin: live || integrations.some((i) => i.provider === 'linkedin_csv'),
      linkedinLive: live,
      google: integrations.some((i) => i.provider === 'google' && i.status !== 'revoked'),
      demo: userId === DEMO_USER_ID,
    },
  };
}

/** The rows a card button acts on, so the router can name them: open promises, target companies, recommendations,
 * warm-ups in progress, duplicate suggestions and notes that found nobody. */
async function routerMore(userId: string) {
  const [items, targets, recs, chats, merges, notes] = await Promise.all([
    db.actionItems
      .where('userId')
      .equals(userId)
      .filter((a) => a.status === 'open')
      .toArray(),
    db.targetCompanies.where('userId').equals(userId).toArray(),
    db.recommendations.where('userId').equals(userId).toArray(),
    db.chats
      .where('userId')
      .equals(userId)
      .filter((c) => c.stage === 'warming' && !!c.warmUp)
      .toArray(),
    db.merges
      .where('userId')
      .equals(userId)
      .filter((m) => m.status === 'pending')
      .toArray(),
    db.notes
      .where('userId')
      .equals(userId)
      .filter((n) => n.matchStatus === 'unmatched')
      .toArray(),
  ]);
  return {
    actionItems: items.map((a) => ({ id: a.id, personId: a.personId, text: a.text })),
    targets: targets.map((t) => ({ id: t.id, name: t.nameRaw })),
    recs: recs.map((r) => ({ id: r.id, personId: r.personId, status: r.status })),
    warmups: chats.map((c) => ({
      chatId: c.id,
      personId: c.personId,
      next: c.warmUp?.actions.find((a) => !a.doneAt && !a.skippedAt)?.id,
    })),
    merges: merges.map((m) => ({ id: m.id, personIds: [m.personAId, m.personBId] })),
    unmatchedNotes: notes.map((n) => ({ id: n.id, title: n.title, at: n.occurredAt })),
  };
}
