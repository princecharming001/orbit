import type { CoffeeChat, EmailMessage, EmailThread, Person, User } from '@orbit/core';
import { detectIntroduction, newId } from '@orbit/core';
import { addTouchpoint } from '../db/repo';
import { db } from '../db/schema';
import { evaluateImmediateSuggestions } from './brief';
import { upsertPerson } from './people';

const ENDED: CoffeeChat['stage'][] = ['declined', 'no_response', 'archived'];

/**
 * An inbound group email that introduces the student to someone ("Alex, meet Sana", Sana on CC): record the intro on
 * the thread (the graph turns it into an `introduced_by` edge), open a pipeline card for the person introduced with
 * the introducer as referrer, and let the rules suggest a reply while the intro is fresh. If the student already
 * answered in the thread, the card starts at outreach_sent.
 */
export async function processIntroductions(
  user: User,
  thread: EmailThread,
  newMessages: EmailMessage[],
  userEmails: string[],
  now: Date,
): Promise<number> {
  if (thread.participantPersonIds.length < 2) return 0;
  const people = (await db.people.bulkGet(thread.participantPersonIds)).filter((p): p is Person => !!p);
  let opened = 0;
  for (const m of [...newMessages].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    const intro = detectIntroduction(m, people, userEmails);
    if (!intro) continue;
    if (!thread.introduction) {
      thread.introduction = intro;
      await db.threads.update(thread.id, { introduction: intro });
    }
    const introducer = people.find((p) => p.id === intro.introducerId);
    if (!introducer) continue;
    const later = (await db.messages.where('threadId').equals(thread.id).sortBy('sentAt')).filter(
      (x) => x.sentAt > intro.at && !x.isAutomated,
    );
    const answered = later.find((x) => x.direction === 'outbound');
    for (const pid of intro.introducedIds) {
      const person = people.find((p) => p.id === pid);
      if (!person) continue;
      await addTouchpoint({
        userId: user.id,
        personId: pid,
        kind: 'intro_observed',
        occurredAt: intro.at,
        refTable: 'messages',
        refId: intro.messageId,
        summary: `${introducer.firstName} introduced you to ${person.firstName}`,
        weight: 0.3,
      });
      const open = await db.chats
        .where('personId')
        .equals(pid)
        .filter((c) => !ENDED.includes(c.stage))
        .first();
      if (open) {
        // a card already exists: just remember who made the intro, for the opener and the report-back
        if (!open.referrerPersonId)
          await db.chats.update(open.id, {
            referrerPersonId: introducer.id,
            referrerName: introducer.firstName,
            introducedAt: intro.at,
            updatedAt: now.toISOString(),
          });
        else if (open.referrerPersonId === introducer.id && !open.introducedAt)
          await db.chats.update(open.id, { introducedAt: intro.at, updatedAt: now.toISOString() });
        continue;
      }
      const chat: CoffeeChat = {
        id: newId('c'),
        userId: user.id,
        personId: pid,
        organizationId: person.currentOrganizationId,
        stage: answered ? 'outreach_sent' : 'identified',
        stageEnteredAt: answered?.sentAt ?? intro.at,
        source: 'reach',
        goalTags: [],
        outreachChannel: 'gmail',
        firstOutreachAt: answered?.sentAt,
        lastOutboundAt: later.filter((x) => x.direction === 'outbound').pop()?.sentAt,
        lastInboundAt: later.filter((x) => x.direction === 'inbound' && x.fromPersonId === pid).pop()?.sentAt,
        bumpCount: 0,
        priority: 2,
        referrerPersonId: introducer.id,
        referrerName: introducer.firstName,
        introducedAt: intro.at,
        createdAt: intro.at,
        updatedAt: now.toISOString(),
      };
      await db.chats.add(chat);
      await db.stageEvents.add({
        id: newId('se'),
        userId: user.id,
        chatId: chat.id,
        toStage: chat.stage,
        status: 'applied',
        actor: 'system',
        reason: answered ? 'intro:answered' : 'intro:received',
        evidenceRefTable: 'messages',
        evidenceRefId: intro.messageId,
        createdAt: chat.stageEnteredAt,
        decidedAt: now.toISOString(),
      });
      await db.recommendations.where('personId').equals(pid).modify({ status: 'converted' });
      opened++;
      await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: pid }, now);
    }
  }
  return opened;
}

const NAME = /^[A-Z][\p{L}'.-]*(?: [A-Z][\p{L}'.-]*){0,3}$/u;

/**
 * Names the person suggested the student talk to ("Priya Shah at Stripe, Tom Lee"), from the prep tab's
 * "anyone else I should talk to?" answer. Each becomes a person (matched by name when already known) with a saved
 * recommendation "Suggested by {first}" and a connection fact the outreach draft opens with; the chat that follows
 * records the suggester as referrer, so the report-back closes the loop.
 */
export function parseSuggestedNames(text: string): { name: string; org?: string }[] {
  return text
    .split(/[,;\n]|\band\b/)
    .map((x) => x.trim().replace(/[.]+$/, ''))
    .filter(Boolean)
    .map((x) => {
      const m = /^(.+?)\s+(?:at|from|on the .+? team at)\s+(.+)$/i.exec(x);
      return m ? { name: m[1]!.trim(), org: m[2]!.trim() } : { name: x };
    })
    .filter((x) => NAME.test(x.name));
}

export async function addSuggestedContacts(
  userId: string,
  fromPersonId: string,
  text: string,
  now = new Date(),
): Promise<Person[]> {
  const from = await db.people.get(fromPersonId);
  if (!from) return [];
  const out: Person[] = [];
  const people = await db.people.where('userId').equals(userId).toArray();
  for (const s of parseSuggestedNames(text)) {
    const known = people.find(
      (p) =>
        p.id !== from.id &&
        !p.hiddenAt &&
        p.displayName.toLowerCase() === s.name.toLowerCase() &&
        (!s.org ||
          !p.currentOrganizationRaw ||
          p.currentOrganizationRaw.toLowerCase() === s.org.toLowerCase()),
    );
    const person =
      known ??
      (await upsertPerson({ userId, displayName: s.name, companyRaw: s.org, source: 'manual' })).person;
    if (person.id === from.id) continue;
    const already = await db.facts
      .where('personId')
      .equals(person.id)
      .filter((f) => f.type === 'connection' && f.sourceTable === 'suggested_by' && f.sourceId === from.id)
      .first();
    if (!already)
      await db.facts.add({
        id: newId('f'),
        userId,
        personId: person.id,
        type: 'connection',
        text: `${from.displayName} suggested I talk with you`,
        sourceTable: 'suggested_by',
        sourceId: from.id,
        occurredAt: now.toISOString(),
        confidence: 1,
        createdAt: now.toISOString(),
      });
    const hasChat = await db.chats
      .where('personId')
      .equals(person.id)
      .filter((c) => c.stage !== 'archived')
      .first();
    if (!hasChat) {
      await db.recommendations
        .where('personId')
        .equals(person.id)
        .filter((r) => r.status === 'new' || r.status === 'saved')
        .delete();
      await db.recommendations.put({
        id: newId('r'),
        userId,
        personId: person.id,
        score: 0.9,
        fitScore: 0.8,
        reachScore: Math.max(0.5, from.strength),
        responsePrior: 0.6,
        reasons: [{ code: 'suggested_by', text: `Suggested by ${from.firstName}` }],
        status: 'saved',
        batchDate: now.toISOString(),
      });
    }
    out.push(person);
  }
  return out;
}
