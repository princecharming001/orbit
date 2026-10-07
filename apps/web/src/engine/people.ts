import type { IncomingIdentity, Organization, Person, PersonField, PersonSource } from '@orbit/core';
import {
  findDuplicatePairs,
  incomingName,
  isPlaceholderName,
  linkedInSlug,
  nameFromEmailLocal,
  newId,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedInUrl,
  parseName,
  resolveIdentity,
  SUGGEST_THRESHOLD,
} from '@orbit/core';
import { db } from '../db/schema';

export async function upsertOrganization(
  nameRaw: string | undefined,
  extra: Partial<Organization> = {},
): Promise<Organization | undefined> {
  const norm = normalizeCompany(nameRaw);
  if (!norm) return undefined;
  const existing = await db.organizations.where('nameNormalized').equals(norm).first();
  if (existing) return existing;
  // rows keyed before the normalisation learned "& Company" / aliases: match on the name and re-key them
  const legacy = (await db.organizations.toArray()).find((o) => normalizeCompany(o.name) === norm);
  if (legacy) {
    await db.organizations.update(legacy.id, { nameNormalized: norm });
    return { ...legacy, nameNormalized: norm };
  }
  const org: Organization = {
    id: newId('org'),
    name: nameRaw!.trim(),
    nameNormalized: norm,
    domains: [],
    ...extra,
  };
  await db.organizations.add(org);
  return org;
}

export interface UpsertPersonInput extends IncomingIdentity {
  userId: string;
  position?: string;
  connectedOn?: string;
  photoUrl?: string;
  location?: string;
  headline?: string;
  userSchool?: string;
  firstSeenAt?: string;
}

const PRECEDENCE: Record<PersonSource, number> = {
  manual: 100,
  enrichment: 80,
  linkedin_csv: 70,
  tracker_import: 60,
  note: 50,
  gmail: 40,
  calendar: 30,
  recommendation: 20,
  demo: 10,
};

export interface PeopleCache {
  people: Person[];
  orgDomains: Map<string, string[]>;
}
export async function loadPeopleCache(userId: string): Promise<PeopleCache> {
  const [people, orgs] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.organizations.toArray(),
  ]);
  return { people, orgDomains: new Map(orgs.map((o) => [o.id, o.domains])) };
}

/**
 * True when a display name is an address handle rather than a name: one token joined by dots or
 * underscores in any case ("priya.patel", "Priya.Patel", "priya_patel"), or by dashes in lower case, or a
 * lower-case form of the address ("erodriguez" for erodriguez@bain.com, "jdoe" or "john" for john.doe@).
 */
export function isHandleName(displayName: string | undefined, email: string | undefined): boolean {
  const t = (displayName ?? '').trim();
  if (!t || /\s/.test(t)) return false;
  // a capitalised single token joined by a dash is a real name ("Mary-Jane"); a dot or underscore is not
  if (/^[\p{L}\d]+(?:[._][\p{L}\d]+)+$/u.test(t)) return true;
  if (t !== t.toLowerCase()) return false;
  if (/^[\p{Ll}\d]+(?:[._-][\p{Ll}\d]+)+$/u.test(t)) return true;
  const local = localPart(email);
  if (!local) return false;
  const squash = (x: string) => x.toLowerCase().replace(/[._+-]/g, '');
  if (squash(t) === squash(local)) return true;
  // the short forms of the name the address spells out
  const parts = nameFromEmailLocal(local).toLowerCase().split(' ');
  if (parts.length < 2) return false;
  const f = parts[0]!;
  const l = parts[parts.length - 1]!;
  return [f, `${f}${l}`, `${f[0]}${l}`, `${l}${f}`, `${f}${l[0]}`].includes(squash(t));
}

function localPart(email: string | undefined): string {
  const addr = (email?.match(/<([^>]+)>/)?.[1] ?? email ?? '').trim();
  return addr.includes('@') ? addr.slice(0, addr.lastIndexOf('@')).replace(/\+.*$/, '') : '';
}

/** The name a handle spells out ("priya_patel" -> "Priya Patel"), or undefined when it does not split into one. */
export function nameFromHandle(handle: string | undefined): string | undefined {
  if (!handle) return undefined;
  const n = nameFromEmailLocal(handle.trim().toLowerCase());
  return n.includes(' ') ? n : undefined;
}

/** Resolve an incoming identity against the user's people and create/update a Person. Returns the person and whether it was created. */
export async function upsertPerson(
  raw: UpsertPersonInput,
  cache?: PeopleCache,
): Promise<{ person: Person; created: boolean; merged?: boolean }> {
  // a header "name" that is only the address handle ("priya.patel", "erodriguez") is no name at all
  // (it is not name evidence for matching, but the name it spells out can stand in until a real one arrives)
  const handle = isHandleName(raw.displayName, raw.email) ? raw.displayName : undefined;
  const inp = handle ? { ...raw, displayName: undefined } : raw;
  const c = cache ?? (await loadPeopleCache(inp.userId));
  const people = c.people;
  const orgDomains = c.orgDomains;
  const decision = resolveIdentity(inp, { people, orgDomains });
  const now = new Date().toISOString();
  const email = inp.email ? normalizeEmail(inp.email) : undefined;
  const liUrl = normalizeLinkedInUrl(inp.linkedinUrl);
  const name = incomingName(inp);
  const title = inp.title ?? inp.position;
  const org = inp.companyRaw ? await upsertOrganization(inp.companyRaw) : undefined;
  let target: Person | undefined;
  if (decision.kind === 'match' || decision.kind === 'probable')
    target = people.find((p) => p.id === decision.personId);
  if (decision.kind === 'suggest') {
    // create new, and record a merge suggestion for the user
    const other = people.find((p) => p.id === decision.personId);
    const created = await createPerson();
    if (other) {
      const existing = await db.merges
        .where('userId')
        .equals(inp.userId)
        .filter(
          (m) =>
            (m.personAId === other.id && m.personBId === created.id) ||
            (m.personAId === created.id && m.personBId === other.id),
        )
        .first();
      if (!existing)
        await db.merges.add({
          id: newId('mrg'),
          userId: inp.userId,
          personAId: other.id,
          personBId: created.id,
          score: decision.score,
          features: decision.features as unknown as Record<string, number>,
          status: 'pending',
          createdAt: now,
        });
    }
    return { person: created, created: true };
  }
  if (!target) {
    const created = await createPerson();
    return { person: created, created: true };
  }
  // update by precedence: a field is only overwritten by a source at least as trusted as the one that wrote it
  const changes: Partial<Person> = {};
  const incomingRank = PRECEDENCE[inp.source];
  const fieldSources: Partial<Record<PersonField, PersonSource>> = { ...(target.fieldSources ?? {}) };
  // people stored before fieldSources existed: assume their most trusted source wrote every field
  const legacyRank = Math.max(...target.sources.map((x) => PRECEDENCE[x] ?? 0), 0);
  const canWrite = (field: PersonField, current: unknown) => {
    if (current === undefined || current === '' || current === null) return true;
    const writer = fieldSources[field];
    return incomingRank >= (writer ? PRECEDENCE[writer] : legacyRank);
  };
  const wrote = (field: PersonField) => {
    fieldSources[field] = inp.source;
  };
  if (email && !target.emails.includes(email)) {
    changes.emails = [...target.emails, email];
    if (!target.primaryEmail) changes.primaryEmail = email;
  }
  if (liUrl && !target.linkedinUrl) {
    changes.linkedinUrl = liUrl;
    changes.linkedinSlug = linkedInSlug(liUrl);
  }
  if (title && title !== target.currentTitle && canWrite('currentTitle', target.currentTitle)) {
    changes.currentTitle = title;
    wrote('currentTitle');
  }
  if (
    org &&
    org.id !== target.currentOrganizationId &&
    canWrite('currentOrganizationId', target.currentOrganizationId)
  ) {
    changes.currentOrganizationId = org.id;
    changes.currentOrganizationRaw = org.name;
    wrote('currentOrganizationId');
  }
  if (inp.headline && inp.headline !== target.headline && canWrite('headline', target.headline)) {
    changes.headline = inp.headline;
    wrote('headline');
  }
  if (inp.location && inp.location !== target.location && canWrite('location', target.location)) {
    changes.location = inp.location;
    wrote('location');
  }
  if (inp.photoUrl && !target.photoUrl) changes.photoUrl = inp.photoUrl;
  if (inp.school && inp.school !== target.school && canWrite('school', target.school)) {
    changes.school = inp.school;
    changes.isAlumni = !!inp.userSchool && normalizeCompany(inp.userSchool) === normalizeCompany(inp.school);
    wrote('school');
  }
  // a stand-in name derived from the address ("erodriguez") gives way to the first real name we see
  if (name.full && isPlaceholderName(target)) {
    changes.displayName = name.full;
    changes.firstName = name.first;
    changes.lastName = name.last;
    changes.nameNormalized = name.normalized;
    changes.namePlaceholder = false;
    wrote('displayName');
  }
  if (Object.keys(changes).some((k) => k !== 'emails' && k !== 'primaryEmail' && k !== 'linkedinUrl'))
    changes.fieldSources = fieldSources;
  if (inp.connectedOn && !target.linkedinConnectedOn) changes.linkedinConnectedOn = inp.connectedOn;
  if (!target.sources.includes(inp.source)) changes.sources = [...target.sources, inp.source];
  if (inp.firstSeenAt && (!target.firstSeenAt || inp.firstSeenAt < target.firstSeenAt))
    changes.firstSeenAt = inp.firstSeenAt;
  if (Object.keys(changes).length) {
    changes.updatedAt = now;
    await db.people.update(target.id, changes);
    Object.assign(target, changes);
  }
  return { person: target, created: false };

  async function createPerson(): Promise<Person> {
    const placeholder = !name.full;
    // the raw address keeps the dots that gmail normalisation drops ("tom.wu" -> "Tom Wu")
    const rawAddr = (inp.email?.match(/<([^>]+)>/)?.[1] ?? inp.email ?? '').trim().toLowerCase();
    // a stand-in name: the one the address spells out, else the one the handle spells out, else the address
    const fromAddress = email ? nameFromEmailLocal(rawAddr || email) : undefined;
    const display =
      name.full ||
      (fromAddress?.includes(' ') ? fromAddress : undefined) ||
      nameFromHandle(handle) ||
      fromAddress ||
      'Unknown';
    const n = name.full ? name : parseName(display);
    const fieldSources: Partial<Record<PersonField, PersonSource>> = {};
    if (!placeholder) fieldSources.displayName = inp.source;
    if (title) fieldSources.currentTitle = inp.source;
    if (org) fieldSources.currentOrganizationId = inp.source;
    if (inp.headline) fieldSources.headline = inp.source;
    if (inp.location) fieldSources.location = inp.source;
    if (inp.school) fieldSources.school = inp.source;
    const p: Person = {
      id: newId('p'),
      userId: inp.userId,
      displayName: display,
      firstName: placeholder && !display.includes(' ') ? display : n.first,
      lastName: placeholder && !display.includes(' ') ? '' : n.last,
      nameNormalized: n.normalized,
      namePlaceholder: placeholder || undefined,
      fieldSources,
      primaryEmail: email,
      emails: email ? [email] : [],
      linkedinUrl: liUrl,
      linkedinSlug: linkedInSlug(liUrl),
      headline: inp.headline ?? (title && org ? `${title} at ${org.name}` : title),
      currentTitle: title,
      currentOrganizationId: org?.id,
      currentOrganizationRaw: org?.name,
      location: inp.location,
      photoUrl: inp.photoUrl,
      school: inp.school,
      isAlumni:
        !!inp.school && !!inp.userSchool && normalizeCompany(inp.school) === normalizeCompany(inp.userSchool),
      relationshipType: /recruit/i.test(title ?? '') ? 'recruiter' : 'unknown',
      strength: 0,
      interactionCount: 0,
      sources: [inp.source],
      linkedinConnectedOn: inp.connectedOn,
      firstSeenAt: inp.firstSeenAt ?? now,
      isHuman: true,
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.people.add(p);
    people.push(p);
    return p;
  }
}

export async function mergePeople(userId: string, survivorId: string, mergedId: string): Promise<void> {
  const [s, m] = await Promise.all([db.people.get(survivorId), db.people.get(mergedId)]);
  if (!s || !m || s.userId !== userId || m.userId !== userId) return;
  await db.transaction(
    'rw',
    [
      db.people,
      db.touchpoints,
      db.facts,
      db.chats,
      db.affiliations,
      db.edges,
      db.threads,
      db.events,
      db.messages,
      db.outbound,
      db.suggestions,
      db.notes,
      db.actionItems,
      db.recommendations,
      db.merges,
    ],
    async () => {
      await db.touchpoints.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.facts.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.chats.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.affiliations.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.edges.where('personAId').equals(mergedId).delete();
      await db.edges.where('personBId').equals(mergedId).delete();
      await db.messages.where('fromPersonId').equals(mergedId).modify({ fromPersonId: survivorId });
      await db.outbound.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.suggestions.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.actionItems.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.recommendations.where('personId').equals(mergedId).delete();
      const threads = await db.threads
        .where('userId')
        .equals(userId)
        .filter((t) => t.participantPersonIds.includes(mergedId))
        .toArray();
      for (const t of threads)
        await db.threads.update(t.id, {
          participantPersonIds: [
            ...new Set(t.participantPersonIds.map((x) => (x === mergedId ? survivorId : x))),
          ],
        });
      const events = await db.events
        .where('userId')
        .equals(userId)
        .filter((e) => e.attendeePersonIds.includes(mergedId))
        .toArray();
      for (const e of events)
        await db.events.update(e.id, {
          attendeePersonIds: [...new Set(e.attendeePersonIds.map((x) => (x === mergedId ? survivorId : x)))],
        });
      const notes = await db.notes
        .where('userId')
        .equals(userId)
        .filter((n) => n.personIds.includes(mergedId))
        .toArray();
      for (const n of notes)
        await db.notes.update(n.id, {
          personIds: [...new Set(n.personIds.map((x) => (x === mergedId ? survivorId : x)))],
        });
      await db.people.update(survivorId, {
        emails: [...new Set([...s.emails, ...m.emails])],
        primaryEmail: s.primaryEmail ?? m.primaryEmail,
        linkedinUrl: s.linkedinUrl ?? m.linkedinUrl,
        linkedinSlug: s.linkedinSlug ?? m.linkedinSlug,
        currentTitle: s.currentTitle ?? m.currentTitle,
        currentOrganizationId: s.currentOrganizationId ?? m.currentOrganizationId,
        currentOrganizationRaw: s.currentOrganizationRaw ?? m.currentOrganizationRaw,
        headline: s.headline ?? m.headline,
        school: s.school ?? m.school,
        isAlumni: s.isAlumni || m.isAlumni,
        photoUrl: s.photoUrl ?? m.photoUrl,
        sources: [...new Set([...s.sources, ...m.sources])],
        linkedinConnectedOn: s.linkedinConnectedOn ?? m.linkedinConnectedOn,
        updatedAt: new Date().toISOString(),
      });
      await db.merges
        .where('userId')
        .equals(userId)
        .filter((x) => x.personAId === mergedId || x.personBId === mergedId)
        .modify({ status: 'stale' });
      await db.people.delete(mergedId);
    },
  );
}

/**
 * Look for people who are probably the same person across the whole list (run after every import) and
 * record a merge suggestion for each pair the student has not already decided on. Returns how many were added.
 */
export async function suggestDuplicateMerges(userId: string, now = new Date()): Promise<number> {
  const { people, orgDomains } = await loadPeopleCache(userId);
  const visible = people.filter((p) => !p.hiddenAt);
  const pairs = findDuplicatePairs(visible, { orgDomains });
  if (!pairs.length) return 0;
  const known = new Set(
    (await db.merges.where('userId').equals(userId).toArray()).map((m) =>
      [m.personAId, m.personBId].sort().join('|'),
    ),
  );
  let added = 0;
  for (const { a, b, score, features } of pairs) {
    if (score < SUGGEST_THRESHOLD) continue;
    const key = [a.id, b.id].sort().join('|');
    if (known.has(key)) continue;
    known.add(key);
    // the older record survives a merge, so it is shown first
    const [first, second] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    await db.merges.add({
      id: newId('mrg'),
      userId,
      personAId: first.id,
      personBId: second.id,
      score,
      features: features as unknown as Record<string, number>,
      status: 'pending',
      createdAt: now.toISOString(),
    });
    added++;
  }
  return added;
}

export interface ManualPersonInput {
  name: string;
  company?: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
  school?: string;
}

/**
 * Add someone the student wants to talk to by hand (no Google, no LinkedIn export needed). An existing record with the
 * same email or LinkedIn profile is updated instead of duplicated. Returns undefined when the name is missing.
 */
export async function addPersonByHand(
  userId: string,
  inp: ManualPersonInput,
  userSchool?: string,
): Promise<{ person: Person; created: boolean } | undefined> {
  const name = inp.name.trim().replace(/\s+/g, ' ');
  if (!name) return undefined;
  const clean = (x?: string) => x?.trim() || undefined;
  const r = await upsertPerson({
    userId,
    displayName: name,
    email: clean(inp.email),
    linkedinUrl: clean(inp.linkedinUrl),
    companyRaw: clean(inp.company),
    title: clean(inp.title),
    school: clean(inp.school),
    userSchool,
    source: 'manual',
  });
  return { person: r.person, created: r.created };
}
