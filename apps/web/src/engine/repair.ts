/**
 * Repairs what older versions of Orbit saved from guesses, on a student's own profile (never the demo). Each is said
 * to the student somewhere, so a wrong one is a false claim on screen until it is fixed:
 *
 * - every visit: the alum label is set again from evidence (engine/alumni.ts). For anyone who loses it, what was said
 *   because of it goes too: the saved summary, the "alum" reason on a recommendation, cards that call them an alum,
 *   and untouched drafts that say so (written again from what is still true).
 * - once per repair version:
 *   - notes filed as meetings although they only name someone ("Need to email Sarah Chen about a referral") keep
 *     what they say about the person and lose the meeting, the completed chat, its notification and thank-you;
 *   - notes filed with everyone at a nearby meeting of several people that the note does not name go back to
 *     "Who was this with?";
 *   - calendar meetings marked as coffee chats with nobody in the pipeline, that are not one-on-one chats, are not;
 *   - titles copied whole from a LinkedIn headline ("Former Analyst at Goldman | ...") are read again, and the
 *     recruiter label that came from such a headline goes;
 *   - saved summaries (written under older rules) are cleared, to be written again when shown;
 *   - the demo's leftovers that have no `userId` (its resume lines, its sample companies, its chat messages).
 *
 * Runs on every app open (MeetingNotesAutoSync); the once-only part is recorded in `kv`.
 */
import type { Person, User } from '@orbit/core';
import { DEMO_ORGS, isRecruiter, looksLikeHeadline, roleFromHeadline } from '@orbit/core';
import { db } from '../db/schema';
import { isServerUser } from '../integrations/orbitApi';
import { recomputeAlumni } from './alumni';
import { regenerateDraft } from './brief';
import { DEMO_USER_ID } from './demo';
import { noteIsPlanOnly, noteSaysMet, refileNoteAsMention, unfileNote } from './notes';
import { upsertOrganization } from './people';

export const REPAIR_VERSION = '2026-10-23';
/**
 * Summaries saved before this moment follow older rules (a school string read as "went to", CCs and a note with its
 * meeting counted as separate touches): the Person page writes them again when shown. The repair clears every saved
 * summary once, for those written later the same day under the old rules.
 */
export const SUMMARY_RULES_AT = '2026-10-22T00:00:00.000Z';

const NOTETAKERS = new Set(['granola_api', 'granola_email', 'fathom', 'fireflies', 'wispr_notetaker']);
const ALUM_TEXT = /\b(alum|alumni|alumna|alumnus|fellow|went to)\b/i;

export interface RepairStats {
  alumniLost: number;
  alumniGained: number;
  notesRefiled: number;
  notesUnfiled: number;
  events: number;
  titles: number;
  summaries: number;
  demoRows: number;
}

export async function repairClaims(user: User, now = new Date()): Promise<RepairStats | undefined> {
  // the demo is made up on purpose; in account mode the server keeps the record, and a local edit would go up as
  // the student's own
  if (user.id === DEMO_USER_ID || isServerUser(user.id)) return undefined;
  const stats: RepairStats = {
    alumniLost: 0,
    alumniGained: 0,
    notesRefiled: 0,
    notesUnfiled: 0,
    events: 0,
    titles: 0,
    summaries: 0,
    demoRows: 0,
  };
  const key = `repair:${REPAIR_VERSION}:${user.id}`;
  const once = !(await db.kv.get(key));

  if (once) {
    stats.titles = await repairHeadlineTitles(user.id);
    stats.notesRefiled = await refileMentions(user, now);
    stats.notesUnfiled = await unfileCrowdedNotes(user, now);
    stats.events = await repairCoffeeChatFlags(user.id);
    stats.demoRows = await clearDemoLeftovers();
  }

  // every visit: the alum label from evidence, and what was said because of it
  const { lost, gained } = await recomputeAlumni(user, now);
  stats.alumniLost = lost.length;
  stats.alumniGained = gained.length;
  await retractAlumniClaims(user, once ? undefined : lost, now);
  if (gained.length) await clearSummaries(gained);

  if (once) {
    // every summary saved under the older rules is written again when it is shown
    const stale = await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => !!p.summary)
      .primaryKeys();
    stats.summaries = await clearSummaries(stale);
    await db.kv.put({ key, value: { at: now.toISOString(), ...stats } });
  } else if (lost.length) await clearSummaries(lost);
  return stats;
}

async function clearSummaries(ids: string[]): Promise<number> {
  for (const id of ids)
    await db.people.update(id, { summary: undefined, summaryUpdatedAt: undefined, talkingPoints: undefined });
  return ids.length;
}

/**
 * For people who are not alumni (all of them, or `onlyIds`): no "alum" reason on a recommendation, no pending card
 * that calls them one, and no untouched draft that says so. A draft the student edited is theirs and stays.
 */
export async function retractAlumniClaims(user: User, onlyIds: string[] | undefined, now = new Date()) {
  if (onlyIds && !onlyIds.length) return;
  const people = await db.people.where('userId').equals(user.id).toArray();
  const notAlum = new Set(
    people.filter((p) => !p.isAlumni && (!onlyIds || onlyIds.includes(p.id))).map((p) => p.id),
  );
  if (!notAlum.size) return;
  const recs = await db.recommendations
    .where('userId')
    .equals(user.id)
    .filter((r) => notAlum.has(r.personId) && r.reasons.some((x) => x.code === 'alumni'))
    .toArray();
  for (const r of recs)
    await db.recommendations.update(r.id, { reasons: r.reasons.filter((x) => x.code !== 'alumni') });
  const at = now.toISOString();
  await db.suggestions
    .where('userId')
    .equals(user.id)
    .filter(
      (s) =>
        !!s.personId &&
        notAlum.has(s.personId) &&
        (s.status === 'pending' || s.status === 'snoozed') &&
        ALUM_TEXT.test(s.reasonText ?? ''),
    )
    .modify({ status: 'expired', expiredReason: 'not_alum', decidedAt: at });
  const drafts = await db.outbound
    .where('userId')
    .equals(user.id)
    .filter(
      (m) =>
        m.status === 'draft' &&
        notAlum.has(m.personId) &&
        m.bodyFinal === undefined &&
        (ALUM_TEXT.test(m.bodyDraft ?? '') ||
          ALUM_TEXT.test(m.subject ?? '') ||
          (m.claims ?? []).some((c) => ALUM_TEXT.test(c.text))),
    )
    .toArray();
  for (const d of drafts) await regenerateDraft(user, d.id, {}, now).catch(() => undefined);
}

/** Notes older versions filed as meetings from a name in the text alone, or from a plan the student picked a person for. */
async function refileMentions(user: User, now: Date): Promise<number> {
  const notes = await db.notes
    .where('userId')
    .equals(user.id)
    .filter(
      (n) =>
        n.noteKind === undefined &&
        n.matchStatus === 'auto' &&
        n.personIds.length > 0 &&
        !n.calendarEventId &&
        !n.attendees.length &&
        !NOTETAKERS.has(n.source) &&
        ((n.matchConfidence ?? 0) < 1 ? !noteSaysMet(n.rawText) : noteIsPlanOnly(n.rawText)),
    )
    .toArray();
  let n = 0;
  for (const note of notes) if (await refileNoteAsMention(user, note.id, now)) n++;
  // the rest were conversations: say so, so a later repair does not read them again
  await db.notes
    .where('userId')
    .equals(user.id)
    .filter((x) => x.noteKind === undefined && x.matchStatus !== 'unmatched' && x.personIds.length > 0)
    .modify({ noteKind: 'meeting' });
  return n;
}

/** Notes filed with everyone at a nearby meeting of several people, none of whom the note names. */
async function unfileCrowdedNotes(user: User, now: Date): Promise<number> {
  const notes = await db.notes
    .where('userId')
    .equals(user.id)
    .filter((x) => x.matchStatus === 'auto' && !!x.calendarEventId && (x.matchConfidence ?? 0) < 0.95)
    .toArray();
  let n = 0;
  for (const note of notes) {
    const ev = await db.events.get(note.calendarEventId!);
    if (!ev || ev.attendeePersonIds.length < 2) continue;
    const people = (await db.people.bulkGet(ev.attendeePersonIds)).filter((p): p is Person => !!p);
    const text = note.rawText.toLowerCase();
    const named = people.some(
      (p) =>
        text.includes(p.displayName.toLowerCase()) ||
        (p.firstName.length >= 3 && new RegExp(`\\b${p.firstName.toLowerCase()}\\b`).test(text)),
    );
    if (named) continue;
    if (await unfileNote(user, note.id, now)) n++;
  }
  return n;
}

/**
 * A meeting older versions called a coffee chat because nobody's school domain was set (every attendee looked
 * "external"): with nobody in the pipeline, only a one-on-one called a chat or a call keeps the label.
 */
async function repairCoffeeChatFlags(userId: string): Promise<number> {
  const COFFEE =
    /\b(coffee|chat|call|catch[ -]?up|intro|informational|connect|zoom|meet(?:ing)? with|1:1|one[- ]on[- ]one)\b|<>|\s[x/]\s/i;
  const events = await db.events
    .where('userId')
    .equals(userId)
    .filter((e) => !!e.isCoffeeChat && !e.chatId && (e.coffeeChatConfidence ?? 0) < 0.8)
    .toArray();
  let n = 0;
  for (const e of events) {
    const others = e.attendees.filter((a) => !a.self).length;
    if (others === 1 && COFFEE.test(e.title ?? '')) continue;
    await db.events.update(e.id, { isCoffeeChat: false, coffeeChatConfidence: 0 });
    n++;
  }
  return n;
}

/** Titles copied whole from a live LinkedIn headline: the role its first part names, or none for a past one. */
async function repairHeadlineTitles(userId: string): Promise<number> {
  const people = await db.people
    .where('userId')
    .equals(userId)
    .filter(
      (p) =>
        !!p.currentTitle &&
        looksLikeHeadline(p.currentTitle) &&
        (!p.fieldSources?.currentTitle || p.fieldSources.currentTitle === 'linkedin_csv') &&
        p.sources.includes('linkedin_csv'),
    )
    .toArray();
  let n = 0;
  for (const p of people) {
    const headline = p.currentTitle!;
    const role = roleFromHeadline(headline);
    const patch: Partial<Person> = { currentTitle: role.title, headline: p.headline ?? headline };
    if (!p.currentOrganizationId && role.org) {
      const org = await upsertOrganization(role.org);
      if (org) {
        patch.currentOrganizationId = org.id;
        patch.currentOrganizationRaw = org.name;
      }
    }
    if (p.relationshipType === 'recruiter' && !isRecruiter(role.title)) patch.relationshipType = 'unknown';
    if (p.relationshipType === 'unknown' && isRecruiter(role.title)) patch.relationshipType = 'recruiter';
    await db.people.update(p.id, { ...patch, summary: undefined, summaryUpdatedAt: undefined });
    n++;
  }
  return n;
}

/**
 * The demo's rows that have no `userId` to find them by: its resume lines (their resume is gone), the messages of its
 * chat conversations, its writing style, and its sample companies. A sample company a real person now points at
 * keeps its name and loses what the demo made up about it (domains, industry, size).
 */
async function clearDemoLeftovers(): Promise<number> {
  let n = 0;
  if (await db.users.get(DEMO_USER_ID)) {
    for (const table of db.tables) {
      if (!table.schema.indexes.some((i) => i.name === 'userId')) continue;
      n += await table.where('userId').equals(DEMO_USER_ID).delete();
    }
    await db.users.delete(DEMO_USER_ID);
    await db.settings.delete(DEMO_USER_ID);
    await db.goals.delete(DEMO_USER_ID);
  }
  if (await db.styles.get(DEMO_USER_ID)) {
    await db.styles.delete(DEMO_USER_ID);
    n++;
  }
  const resumes = new Set(await db.resumes.toCollection().primaryKeys());
  n += await db.resumeFacets.filter((f) => !resumes.has(f.resumeId)).delete();
  const conversations = new Set(await db.chatConversations.toCollection().primaryKeys());
  n += await db.chatMessages.filter((m) => !conversations.has(m.conversationId)).delete();
  n += await db.chatActions.filter((a) => !conversations.has(a.conversationId)).delete();
  const demoOrgs = new Set(DEMO_ORGS.map((o) => `org_${o.slug}`));
  const used = new Set<string>();
  for (const p of await db.people.toArray()) if (p.currentOrganizationId) used.add(p.currentOrganizationId);
  for (const a of await db.affiliations.toArray()) if (a.organizationId) used.add(a.organizationId);
  for (const t of await db.targetCompanies.toArray()) if (t.organizationId) used.add(t.organizationId);
  for (const c of await db.chats.toArray()) if (c.organizationId) used.add(c.organizationId);
  for (const id of demoOrgs) {
    const org = await db.organizations.get(id);
    if (!org) continue;
    if (used.has(id))
      await db.organizations.update(id, {
        domains: [],
        industry: undefined,
        sizeBucket: undefined,
        linkedinSlug: undefined,
      });
    else await db.organizations.delete(id);
    n++;
  }
  return n;
}
