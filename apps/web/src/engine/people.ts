import type { IncomingIdentity, Organization, Person, PersonSource } from '@orbit/core';
import {
  linkedInSlug,
  newId,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedInUrl,
  parseName,
  resolveIdentity,
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

/** Resolve an incoming identity against the user's people and create/update a Person. Returns the person and whether it was created. */
export async function upsertPerson(
  inp: UpsertPersonInput,
  cache?: PeopleCache,
): Promise<{ person: Person; created: boolean; merged?: boolean }> {
  const c = cache ?? (await loadPeopleCache(inp.userId));
  const people = c.people;
  const orgDomains = c.orgDomains;
  const decision = resolveIdentity(inp, { people, orgDomains });
  const now = new Date().toISOString();
  const email = inp.email ? normalizeEmail(inp.email) : undefined;
  const liUrl = normalizeLinkedInUrl(inp.linkedinUrl);
  const name = parseName(inp.displayName);
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
  // update by precedence
  const changes: Partial<Person> = {};
  const incomingRank = PRECEDENCE[inp.source];
  const fieldSources =
    (target.strengthBreakdown as unknown as { fieldSources?: Record<string, PersonSource> } | undefined)
      ?.fieldSources ?? {};
  const canWrite = (field: string, current: unknown) =>
    current === undefined || current === '' || incomingRank >= PRECEDENCE[fieldSources[field] ?? 'demo'];
  if (email && !target.emails.includes(email)) {
    changes.emails = [...target.emails, email];
    if (!target.primaryEmail) changes.primaryEmail = email;
  }
  if (liUrl && !target.linkedinUrl) {
    changes.linkedinUrl = liUrl;
    changes.linkedinSlug = linkedInSlug(liUrl);
  }
  if (title && canWrite('currentTitle', target.currentTitle)) changes.currentTitle = title;
  if (org && canWrite('currentOrganizationId', target.currentOrganizationId)) {
    changes.currentOrganizationId = org.id;
    changes.currentOrganizationRaw = org.name;
  }
  if (inp.headline && canWrite('headline', target.headline)) changes.headline = inp.headline;
  if (inp.location && canWrite('location', target.location)) changes.location = inp.location;
  if (inp.photoUrl && !target.photoUrl) changes.photoUrl = inp.photoUrl;
  if (inp.school && canWrite('school', target.school)) {
    changes.school = inp.school;
    changes.isAlumni = !!inp.userSchool && normalizeCompany(inp.userSchool) === normalizeCompany(inp.school);
  }
  if (
    name.full &&
    (!target.displayName || /^[\w.+-]+@/.test(target.displayName)) &&
    canWrite('displayName', undefined)
  ) {
    changes.displayName = name.full;
    changes.firstName = name.first;
    changes.lastName = name.last;
    changes.nameNormalized = name.normalized;
  }
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
    const display = name.full || (email ? email.split('@')[0]!.replace(/[._]/g, ' ') : 'Unknown');
    const n = name.full ? name : parseName(display);
    const p: Person = {
      id: newId('p'),
      userId: inp.userId,
      displayName: n.full || display,
      firstName: n.first,
      lastName: n.last,
      nameNormalized: n.normalized,
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
