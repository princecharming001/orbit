import type { CoffeeChat, EmailMessage, EmailThread, Introduction, Person, User } from '@orbit/core';
import { knownSizeBucket, newId, readIntroduction } from '@orbit/core';
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
 *
 * Answers inside an intro thread ("Thanks for the intro, Lena", "moving Lena to bcc") are never read as new
 * introductions. When the intro itself is older than the sync and only the answer arrives, the answer still names
 * who made it ("Thanks for the warm intro, Lena"): the intro is recorded from it, so the person who answered gets
 * their card.
 *
 * `repliesReadLater`: the networking pass runs right after this on the same new messages (a small thread), so the
 * answers among them are left to it. Applying them here too would count the student's reply twice (once as the
 * card's start, once as a bump) and would lose the person's answer, which only the networking pass reads.
 */
export async function processIntroductions(
  user: User,
  thread: EmailThread,
  newMessages: EmailMessage[],
  userEmails: string[],
  now: Date,
  opts: { repliesReadLater?: boolean } = {},
): Promise<number> {
  if (thread.participantPersonIds.length < 2) return 0;
  const people = (await db.people.bulkGet(thread.participantPersonIds)).filter((p): p is Person => !!p);
  const studentNames = [user.firstName, user.fullName].filter((n): n is string => !!n?.trim());
  const fresh = new Set(newMessages.map((m) => m.id));
  let opened = 0;
  for (const m of [...newMessages].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    const reading = readIntroduction(m, people, userEmails, { studentNames, prior: thread.introduction });
    let intro: Introduction | undefined;
    if (reading.kind === 'introduction' && m.fromPersonId)
      intro = {
        introducerId: m.fromPersonId,
        introducedIds: reading.introducedIds,
        messageId: m.id,
        at: m.sentAt,
      };
    else if (
      reading.kind === 'intro_reply' &&
      !thread.introduction &&
      m.direction === 'inbound' &&
      m.fromPersonId &&
      reading.introThankedIds.length === 1 &&
      reading.introThankedIds[0] !== m.fromPersonId
    )
      // "Thanks for the warm intro, Lena. Alex, happy to chat": the intro predates what was synced
      intro = {
        introducerId: reading.introThankedIds[0]!,
        introducedIds: [m.fromPersonId],
        messageId: m.id,
        at: m.sentAt,
      };
    if (!intro) continue;
    if (!thread.introduction) {
      thread.introduction = intro;
      await db.threads.update(thread.id, { introduction: intro });
    }
    const introducer = people.find((p) => p.id === intro.introducerId);
    if (!introducer) continue;
    const at = intro.at;
    const later = (await db.messages.where('threadId').equals(thread.id).sortBy('sentAt')).filter(
      (x) => x.sentAt > at && !x.isAutomated && !(opts.repliesReadLater && fresh.has(x.id)),
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
        // a card with no thread yet learns the intro thread, so the replies in it reach the card
        if (!open.threadId) await db.chats.update(open.id, { threadId: thread.id });
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
        // the intro thread is where the student answers ("moving Lena to bcc") and where the person replies: the
        // networking pass reads later messages in it into this chat
        threadId: thread.id,
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

/** Lowercase name particles that sit inside a name ("Ana de la Cruz", "Pieter van der Berg"). */
const PARTICLES = new Set([
  'de',
  'la',
  'le',
  'del',
  'della',
  'da',
  'das',
  'dos',
  'di',
  'du',
  'van',
  'von',
  'der',
  'den',
  'ter',
  'bin',
  'al',
  'el',
  'y',
]);
/**
 * Words that make a phrase a description or an answer, not a name: "someone in sales", "her manager", and the usual
 * non-answers ("not sure", "no one", "not really", "I don't know", "he runs sales"). A name typed in lowercase is
 * accepted, so these must never be title-cased into a person.
 */
const NOT_NAME = new Set(
  [
    'someone somebody anyone anybody everyone noone nobody none nothing people person team teams guy guys folks',
    'recruiter recruiters manager managers colleague colleagues coworker coworkers boss friend friends',
    'in on the a an of for with who whom what which that this these those there here to or and at from by about',
    'i me my mine you your yours he him his she her hers it its we us our they them their',
    'no not nope nah none yes yeah yep ok okay sure unsure really idk dunno know knows knew think thought',
    'is are was were be been am do does did done have has had can could would should will might may must',
    'runs run works work worked leads lead manages said says say told tell ask asked mentioned suggested',
    'maybe definitely probably perhaps possibly also too just only still yet else other others more any all some',
    'one ones later soon sometime next time week thanks thank sorry tbd na hmm lol',
    'good great fine sounds question check look search find linkedin google email call text',
  ]
    .join(' ')
    .split(' '),
);
/** Words on that list that are also first names, when typed with a capital ("Will Park", "May Chen"). */
const ALSO_FIRST_NAME = new Set(['will', 'may']);
/** "don't", "she'll", "they're": a contraction is never part of a name ("O'Neil" and "D'Souza" are). */
const CONTRACTION = /(?:n't|'(?:s|re|ve|ll|d|m))$/i;
/** Hedges and lead-ins people type before a name: "definitely Tom Lee", "maybe Priya", "she said to talk to Ana". */
const LEAD_IN =
  /^(?:(?:definitely|maybe|probably|perhaps|possibly|also|especially|and|or|plus|try|ask|contact|email|ping|talk(?:ing)? (?:to|with)|reach out to|speak (?:to|with)|(?:she|he|they) (?:said|mentioned|suggested)(?: to (?:talk|speak) (?:to|with))?|you should (?:talk|speak) (?:to|with))\s+)+/i;
const WORD = /^\p{L}[\p{L}'.-]*$/u;

/** "priya" -> "Priya", "o'neil" -> "O'Neil"; words with capitals of their own ("McKay") are kept as typed. */
const titleWord = (w: string) =>
  w === w.toLowerCase()
    ? w.replace(/(^|['-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
    : w;

/**
 * A person's name from a typed fragment, or undefined when it is not one: one to four words plus particles, no
 * description words, title-cased when typed in lowercase. A single word is a name only with a company ("Tom at
 * Stripe"): "Definitely Tom" alone is not enough to save someone.
 */
function cleanName(raw: string, hasOrg: boolean): string | undefined {
  const words = raw
    .replace(LEAD_IN, '')
    .replace(/[.:!?]+$/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return undefined;
  const core = words.filter((w, i) => !(i > 0 && i < words.length - 1 && PARTICLES.has(w.toLowerCase())));
  if (core.length > 4 || (core.length < 2 && !hasOrg)) return undefined;
  if (PARTICLES.has(words[0]!.toLowerCase()) || PARTICLES.has(words[words.length - 1]!.toLowerCase()))
    return undefined;
  if (words.some((w) => !WORD.test(w))) return undefined;
  const notName = (w: string) => {
    const lower = w.toLowerCase().replace(/\.$/, '');
    // "Will Park" or "May Chen" typed with a capital is a name; "will" or "may" is a word
    return NOT_NAME.has(lower) && !(ALSO_FIRST_NAME.has(lower) && w[0] !== w[0]!.toLowerCase());
  };
  if (core.some((w) => notName(w) || CONTRACTION.test(w))) return undefined;
  return words
    .map((w, i) => (i > 0 && PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : titleWord(w)))
    .join(' ');
}

const ORG_AT = /\s+(?:at|from|on the .+? team at)\s+/i;

/**
 * The names in the prep tab's "anyone else I should talk to?" answer, and the parts that could not be read as a
 * name (so the field can say which ones were not saved instead of dropping them silently). Commas, semicolons and
 * new lines separate people; "and" separates people only between names, never inside a company ("Priya Shah at
 * Procter and Gamble" is one person). "Priya Shah (Stripe)" names the company in brackets.
 */
export function readSuggestedNames(text: string): {
  names: { name: string; org?: string }[];
  skipped: string[];
} {
  const names: { name: string; org?: string }[] = [];
  const skipped: string[] = [];
  for (const chunk of text.split(/[,;\n]/)) {
    let part = chunk.trim().replace(/[.]+$/, '').trim();
    if (!part) continue;
    let org: string | undefined;
    const paren = /^(.*?)\s*\(([^)]+)\)$/.exec(part);
    if (paren) {
      part = paren[1]!.trim();
      org = paren[2]!.trim();
    }
    const at = ORG_AT.exec(part);
    let people: string[];
    if (at && !org) {
      people = part.slice(0, at.index).split(/\s+(?:and|&)\s+/i);
      // "at Stripe and Tom Lee": another person after the company only when it reads as a full name (or has its own
      // "at"), taken from the end. A company with "and" in its name stays whole ("at Procter and Gamble"); a second
      // company ("at Goldman Sachs and Morgan Stanley") or a lone first name after a company ("at Stripe and Tom") is
      // neither part of the company nor a person, so it is reported as not saved
      let rest = part.slice(at.index + at[0].length);
      const tail: string[] = [];
      const notPeople: string[] = [];
      for (;;) {
        const m = /^(.+)\s+(?:and|&)\s+(.+?)$/i.exec(rest);
        if (!m || knownSizeBucket(rest)) break;
        const [, head, after] = m as unknown as [string, string, string];
        const afterAt = ORG_AT.exec(after);
        const afterName = afterAt ? after.slice(0, afterAt.index) : after;
        if (afterAt || (!knownSizeBucket(after) && cleanName(afterName, false))) tail.push(after);
        else if (knownSizeBucket(after) || knownSizeBucket(head)) notPeople.push(after);
        else break;
        rest = head;
      }
      org = rest.trim();
      for (const name of people) {
        const n = cleanName(name, true);
        if (n && org) names.push({ name: n, org });
        else skipped.push(name.trim());
      }
      skipped.push(...notPeople.reverse());
      for (const t of tail.reverse()) {
        const r = readSuggestedNames(t);
        names.push(...r.names);
        skipped.push(...r.skipped);
      }
      continue;
    }
    for (const name of part.split(/\s+(?:and|&)\s+/i)) {
      const n = cleanName(name, !!org);
      if (n) names.push(org ? { name: n, org } : { name: n });
      else skipped.push(name.trim());
    }
  }
  return { names, skipped: skipped.filter(Boolean) };
}

/**
 * Names the person suggested the student talk to ("Priya Shah at Stripe, Tom Lee"), from the prep tab's
 * "anyone else I should talk to?" answer. Each becomes a person (matched by name when already known) with a saved
 * recommendation "Suggested by {first}" and a connection fact the outreach draft opens with; the chat that follows
 * records the suggester as referrer, so the report-back closes the loop.
 */
export function parseSuggestedNames(text: string): { name: string; org?: string }[] {
  return readSuggestedNames(text).names;
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
