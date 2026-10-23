import type {
  Edge,
  IncomingIdentity,
  Organization,
  Person,
  PersonField,
  PersonSource,
  Touchpoint,
} from '@orbit/core';
import {
  compareNames,
  differentLinkedInProfiles,
  doNotMergeKey,
  findDuplicatePairs,
  incomingName,
  isPlaceholderName,
  isRecruiter,
  linkedInSlug,
  nameFromEmailLocal,
  newId,
  normalizeCompany,
  normalizeEmail,
  normalizeLinkedInUrl,
  parseName,
  resolveIdentity,
  roleFromHeadline,
  SUGGEST_THRESHOLD,
  sharePhone,
} from '@orbit/core';
import { feedback, recomputePersonStrength } from '../db/repo';
import { db, type TextThread } from '../db/schema';

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
  // their own LinkedIn profile, read live: the truth about their current position, under only the student's own edit
  linkedin_profile: 90,
  enrichment: 80,
  linkedin_csv: 70,
  // a name from the student's own Contacts
  imessage: 65,
  tracker_import: 60,
  note: 50,
  gmail: 40,
  calendar: 30,
  recommendation: 20,
  demo: 10,
};

/**
 * Whether `source` may write `field` on this person: an empty field always; otherwise only a source at least as
 * trusted as the one that wrote it (people stored before fieldSources existed: their most trusted source), the rule
 * upsertPerson applies.
 */
export function mayOverwrite(
  person: Pick<Person, 'fieldSources' | 'sources'>,
  field: PersonField,
  source: PersonSource,
  current: unknown,
): boolean {
  if (current === undefined || current === '' || current === null) return true;
  const writer = person.fieldSources?.[field];
  const legacyRank = Math.max(...person.sources.map((x) => PRECEDENCE[x] ?? 0), 0);
  return PRECEDENCE[source] >= (writer ? PRECEDENCE[writer] : legacyRank);
}

export interface PeopleCache {
  people: Person[];
  orgDomains: Map<string, string[]>;
  /** pairs the student said are two people (a rejected "Possible duplicate"): never merged or suggested again */
  doNotMerge?: Set<string>;
}
export async function loadPeopleCache(userId: string): Promise<PeopleCache> {
  const [people, orgs, doNotMerge] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.organizations.toArray(),
    loadDoNotMerge(userId),
  ]);
  return { people, orgDomains: new Map(orgs.map((o) => [o.id, o.domains])), doNotMerge };
}

/**
 * The pairs the student said are not the same person: in this browser, the "Possible duplicate" cards they answered
 * no to (the server keeps the same thing as orbit.do_not_merge).
 */
export async function loadDoNotMerge(userId: string): Promise<Set<string>> {
  const rows = await db.merges
    .where('userId')
    .equals(userId)
    .filter((m) => m.status === 'rejected')
    .toArray();
  return new Set(rows.map((m) => doNotMergeKey(m.personAId, m.personBId)));
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
  c.doNotMerge ??= await loadDoNotMerge(inp.userId);
  // the same rules as the server (supabase/functions/_shared/ingest/people.ts): pairs the student rejected are never
  // matched, and an address that proves a LinkedIn-only namesake is its owner merges the two
  const decision = resolveIdentity(inp, { people, orgDomains, doNotMerge: c.doNotMerge });
  const now = new Date().toISOString();
  const email = inp.email ? normalizeEmail(inp.email) : undefined;
  // shown as written: Gmail ignores dots, but a student checking "marcus.bell@gmail.com" expects to see the dot
  const asWritten =
    inp.email && email ? (inp.email.match(/<([^>]+)>/)?.[1] ?? inp.email).trim().toLowerCase() : undefined;
  const writtenField = asWritten && asWritten !== email ? asWritten : undefined;
  const liUrl = normalizeLinkedInUrl(inp.linkedinUrl);
  const name = incomingName(inp);
  const title = inp.title ?? inp.position;
  const phones = [...new Set((inp.phones ?? []).filter(Boolean))];
  const org = inp.companyRaw ? await upsertOrganization(inp.companyRaw) : undefined;
  let target: Person | undefined;
  if (decision.kind === 'match' || decision.kind === 'probable')
    target = people.find((p) => p.id === decision.personId);
  if (target && decision.kind === 'match' && decision.mergeWith?.length) {
    // the same mailbox under a LinkedIn-only person's name: that person is this one
    for (const other of decision.mergeWith) {
      await mergePeople(inp.userId, target.id, other);
      const i = people.findIndex((p) => p.id === other);
      if (i >= 0) people.splice(i, 1);
    }
    const fresh = await db.people.get(target.id);
    if (fresh) Object.assign(target, fresh);
  }
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
    if (!target.primaryEmail) {
      changes.primaryEmail = email;
      if (writtenField) changes.primaryEmailAsWritten = writtenField;
    }
  }
  if (liUrl && !target.linkedinUrl) {
    changes.linkedinUrl = liUrl;
    changes.linkedinSlug = linkedInSlug(liUrl);
  }
  if (
    inp.linkedinMemberId &&
    !target.linkedinMemberId &&
    !differentLinkedInProfiles({ linkedinSlug: linkedInSlug(liUrl) }, target)
  )
    changes.linkedinMemberId = inp.linkedinMemberId;
  if (phones.some((ph) => !(target.phones ?? []).includes(ph)))
    changes.phones = [...new Set([...(target.phones ?? []), ...phones])];
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
    // the same school is not evidence they graduated from it (a classmate, a professor): engine/alumni.ts decides
    changes.school = inp.school;
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
  const identityOnly = new Set([
    'emails',
    'primaryEmail',
    'linkedinUrl',
    'linkedinSlug',
    'linkedinMemberId',
    'phones',
  ]);
  if (Object.keys(changes).some((k) => !identityOnly.has(k))) changes.fieldSources = fieldSources;
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
      primaryEmailAsWritten: writtenField,
      emails: email ? [email] : [],
      phones: phones.length ? phones : undefined,
      linkedinUrl: liUrl,
      linkedinSlug: linkedInSlug(liUrl),
      linkedinMemberId: inp.linkedinMemberId,
      headline: inp.headline ?? (title && org ? `${title} at ${org.name}` : title),
      currentTitle: title,
      currentOrganizationId: org?.id,
      currentOrganizationRaw: org?.name,
      location: inp.location,
      photoUrl: inp.photoUrl,
      school: inp.school,
      // alumni only from evidence they studied there (engine/alumni.ts), never from the same school string
      isAlumni: false,
      relationshipType: isRecruiter(title) ? 'recruiter' : 'unknown',
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

/** Which source wrote a field, as a rank (people stored before fieldSources: their most trusted source). */
function fieldRank(p: Person, field: PersonField): number {
  const writer = p.fieldSources?.[field];
  return writer ? PRECEDENCE[writer] : Math.max(0, ...p.sources.map((x) => PRECEDENCE[x] ?? 0));
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/**
 * What the survivor of a merge keeps: its own name (unless it is only a stand-in from an address), every address,
 * number and source of both, and for each profile field the value from the more trusted source (the student's own
 * edit over LinkedIn over an email signature). The LinkedIn profile, its member id and its photo stay together: they
 * are one profile, so they come from the same side.
 */
export function mergedFields(s: Person, m: Person, now: string): Partial<Person> {
  const out: Partial<Person> = { updatedAt: now };
  const fieldSources: Partial<Record<PersonField, PersonSource>> = { ...(s.fieldSources ?? {}) };
  const take = (field: PersonField, keys: (keyof Person)[]) => {
    const has = (p: Person) => keys.some((k) => !blank(p[k]));
    const fromM = has(m) && (!has(s) || fieldRank(m, field) > fieldRank(s, field));
    if (!fromM) return;
    for (const k of keys) (out as Record<string, unknown>)[k] = m[k];
    const w = m.fieldSources?.[field];
    if (w) fieldSources[field] = w;
    else delete fieldSources[field];
  };
  take('currentTitle', ['currentTitle']);
  take('currentOrganizationId', ['currentOrganizationId', 'currentOrganizationRaw']);
  take('headline', ['headline']);
  take('location', ['location']);
  take('school', ['school']);
  if (isPlaceholderName(s) && !isPlaceholderName(m)) {
    out.displayName = m.displayName;
    out.firstName = m.firstName;
    out.lastName = m.lastName;
    out.nameNormalized = m.nameNormalized;
    out.namePlaceholder = undefined;
    if (m.fieldSources?.displayName) fieldSources.displayName = m.fieldSources.displayName;
  }
  out.fieldSources = fieldSources;
  out.emails = [...new Set([...s.emails, ...m.emails])];
  if (!s.primaryEmail && m.primaryEmail) {
    out.primaryEmail = m.primaryEmail;
    out.primaryEmailAsWritten = m.primaryEmailAsWritten;
  }
  const phones = [...new Set([...(s.phones ?? []), ...(m.phones ?? [])])];
  if (phones.length) out.phones = phones;
  const sHasProfile = !!(s.linkedinSlug || s.linkedinUrl || s.linkedinMemberId);
  if (!sHasProfile && (m.linkedinSlug || m.linkedinUrl || m.linkedinMemberId)) {
    out.linkedinUrl = m.linkedinUrl;
    out.linkedinSlug = m.linkedinSlug;
    out.linkedinMemberId = m.linkedinMemberId;
    out.linkedinConnectedOn = s.linkedinConnectedOn ?? m.linkedinConnectedOn;
    // the photo goes with the profile it came from
    out.photoUrl = m.photoUrl ?? s.photoUrl;
  } else {
    // the same profile seen twice may carry the member id on one side only
    if (!s.linkedinMemberId && m.linkedinMemberId && !differentLinkedInProfiles(s, m))
      out.linkedinMemberId = m.linkedinMemberId;
    out.linkedinConnectedOn = s.linkedinConnectedOn ?? m.linkedinConnectedOn;
    out.photoUrl = s.photoUrl ?? m.photoUrl;
  }
  out.isAlumni = !!(s.isAlumni || m.isAlumni);
  out.sources = [...new Set([...s.sources, ...m.sources])];
  out.tags = [...new Set([...(s.tags ?? []), ...(m.tags ?? [])])];
  if (m.notes && m.notes !== s.notes) out.notes = s.notes ? `${s.notes}\n\n${m.notes}` : m.notes;
  if (s.relationshipType === 'unknown' && m.relationshipType !== 'unknown')
    out.relationshipType = m.relationshipType;
  const first = [s.firstSeenAt, m.firstSeenAt].filter(Boolean).sort()[0];
  if (first) out.firstSeenAt = first;
  const last = [s.lastInteractionAt, m.lastInteractionAt].filter(Boolean).sort().at(-1);
  if (last) out.lastInteractionAt = last;
  out.interactionCount = (s.interactionCount ?? 0) + (m.interactionCount ?? 0);
  if (m.doNotContact) out.doNotContact = true;
  // shown if either was shown: the student hid one record, not the person
  if (s.hiddenAt && !m.hiddenAt) out.hiddenAt = undefined;
  if (!s.summary && m.summary) {
    out.summary = m.summary;
    out.summaryUpdatedAt = m.summaryUpdatedAt;
    out.talkingPoints = m.talkingPoints;
  }
  return out;
}

/**
 * `mergedId` → `survivorId` anywhere in a row: its own fields, lists of people, and inside nested parts (a thread's
 * introduction, the facts a note read, a card's payload). A list of ids that ends up naming the survivor twice keeps
 * it once.
 */
function repoint<T>(row: T, mergedId: string, survivorId: string): { row: T; changed: boolean } {
  let changed = false;
  const fix = (v: unknown, depth: number): unknown => {
    if (v === mergedId) {
      changed = true;
      return survivorId;
    }
    if (depth > 6) return v;
    if (Array.isArray(v)) {
      const before = changed;
      changed = false;
      const mapped = v.map((x) => fix(x, depth + 1));
      const here = changed;
      changed = before || here;
      if (!here) return v;
      return mapped.every((x) => typeof x === 'string') ? [...new Set(mapped)] : mapped;
    }
    // plain objects only: a Date or a Blob is kept as it is
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const o = v as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) next[k] = fix(x, depth + 1);
      return next;
    }
    return v;
  };
  const next = fix(row, 0) as T;
  return { row: changed ? next : row, changed };
}

/**
 * Merge `mergedId` into `survivorId`: everything kept about the merged person moves to the survivor (touches, facts,
 * chats, drafts, cards, notes, threads, events, text history, affiliations, ties, the student's closeness rating,
 * research, identities, intro requests, recommendations, merge cards), duplicates are dropped, and the merged
 * record is deleted. Pairs the student rejected with the merged person stay rejected for the survivor. Ties and the
 * score are worked out again from what the survivor now has.
 */
export async function mergePeople(userId: string, survivorId: string, mergedId: string): Promise<void> {
  if (survivorId === mergedId) return;
  const [s, m] = await Promise.all([db.people.get(survivorId), db.people.get(mergedId)]);
  if (!s || !m || s.userId !== userId || m.userId !== userId) return;
  const now = new Date().toISOString();
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
      db.dossiers,
      db.personIdentities,
      db.introRequests,
      db.tieLabels,
      db.tieScores,
      db.textThreads,
    ],
    async () => {
      // touches: one per source item and person, so a touch both records have is kept once
      const tpKey = (t: Touchpoint) => `${t.refTable}|${t.refId}`;
      const had = new Set((await db.touchpoints.where('personId').equals(survivorId).toArray()).map(tpKey));
      const moving = await db.touchpoints.where('personId').equals(mergedId).toArray();
      await db.touchpoints.bulkDelete(moving.filter((t) => had.has(tpKey(t))).map((t) => t.id));
      await db.touchpoints.where('personId').equals(mergedId).modify({ personId: survivorId });
      // rows that belong to one person move as they are
      await db.facts.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.chats.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.outbound.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.actionItems.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.personIdentities.where('personId').equals(mergedId).modify({ personId: survivorId });
      await db.messages.where('fromPersonId').equals(mergedId).modify({ fromPersonId: survivorId });
      // affiliations: the same employer or school on both is kept once
      const affKey = (a: { kind: string; organizationId?: string; nameRaw: string; title?: string }) =>
        `${a.kind}|${a.organizationId ?? normalizeCompany(a.nameRaw)}|${(a.title ?? '').toLowerCase()}`;
      const affs = new Set(
        (await db.affiliations.where('personId').equals(survivorId).toArray()).map(affKey),
      );
      const movingAffs = await db.affiliations.where('personId').equals(mergedId).toArray();
      await db.affiliations.bulkDelete(movingAffs.filter((a) => affs.has(affKey(a))).map((a) => a.id));
      await db.affiliations.where('personId').equals(mergedId).modify({ personId: survivorId });
      // one recommendation and one research dossier per person: the survivor's wins
      if (await db.recommendations.where('personId').equals(survivorId).count())
        await db.recommendations.where('personId').equals(mergedId).delete();
      else await db.recommendations.where('personId').equals(mergedId).modify({ personId: survivorId });
      if (await db.dossiers.where('personId').equals(survivorId).count())
        await db.dossiers.where('personId').equals(mergedId).delete();
      else await db.dossiers.where('personId').equals(mergedId).modify({ personId: survivorId });
      // the student's closeness rating moves unless the survivor has one; the model's score is worked out again
      const label = await db.tieLabels.get(mergedId);
      if (label && !(await db.tieLabels.get(survivorId)))
        await db.tieLabels.put({ ...label, personId: survivorId, updatedAt: now });
      await db.tieLabels.delete(mergedId);
      await db.tieScores.delete(mergedId);
      // text history (one row per person): the two histories become one
      const mt = await db.textThreads.get(mergedId);
      if (mt) {
        const st = await db.textThreads.get(survivorId);
        const joined: TextThread = st
          ? {
              ...st,
              handles: [...new Set([...st.handles, ...mt.handles])],
              inCount: st.inCount + mt.inCount,
              outCount: st.outCount + mt.outCount,
              firstAt: st.firstAt < mt.firstAt ? st.firstAt : mt.firstAt,
              lastAt: st.lastAt > mt.lastAt ? st.lastAt : mt.lastAt,
              recent: [...st.recent, ...mt.recent].sort((a, b) => a.at.localeCompare(b.at)).slice(-8),
            }
          : { ...mt, id: survivorId, personId: survivorId };
        await db.textThreads.put(joined);
        await db.textThreads.delete(mergedId);
      }
      // ties: pointed at the survivor; a tie between the two is gone, and a tie both had is kept once (the stronger)
      const edgeKey = (e: Pick<Edge, 'personAId' | 'personBId' | 'type'>) =>
        `${[e.personAId, e.personBId].sort().join('|')}|${e.type}`;
      const edges = [
        ...(await db.edges.where('personAId').anyOf(survivorId, mergedId).toArray()),
        ...(await db.edges.where('personBId').anyOf(survivorId, mergedId).toArray()),
      ];
      const byKey = new Map<string, Edge>();
      const drop = new Set<string>();
      for (const e of [...new Map(edges.map((x) => [x.id, x])).values()]) {
        const a = e.personAId === mergedId ? survivorId : e.personAId;
        const b = e.personBId === mergedId ? survivorId : e.personBId;
        if (a === b) {
          drop.add(e.id);
          continue;
        }
        const next = { ...e, personAId: a, personBId: b };
        const k = edgeKey(next);
        const prev = byKey.get(k);
        if (prev) {
          const [keep, lose] = prev.weight >= next.weight ? [prev, next] : [next, prev];
          drop.add(lose.id);
          byKey.set(k, keep);
        } else byKey.set(k, next);
      }
      await db.edges.bulkDelete([...drop]);
      await db.edges.bulkPut([...byKey.values()].filter((e) => !drop.has(e.id)));
      // merge cards: the card about these two is done; the merged person's other cards and the student's "not the
      // same" answers carry over to the survivor (a rejected pair stays rejected)
      const merges = await db.merges.where('userId').equals(userId).toArray();
      const pairKey = (a: string, b: string) => [a, b].sort().join('|');
      const taken = new Set(
        merges
          .filter((x) => x.personAId !== mergedId && x.personBId !== mergedId)
          .map((x) => pairKey(x.personAId, x.personBId)),
      );
      for (const x of merges) {
        if (x.personAId !== mergedId && x.personBId !== mergedId) continue;
        const other = x.personAId === mergedId ? x.personBId : x.personAId;
        if (other === survivorId) {
          if (x.status === 'pending') await db.merges.update(x.id, { status: 'stale' });
          continue;
        }
        const k = pairKey(survivorId, other);
        const a = x.personAId === mergedId ? survivorId : x.personAId;
        const b = x.personBId === mergedId ? survivorId : x.personBId;
        const status = x.status === 'pending' && taken.has(k) ? 'stale' : x.status;
        await db.merges.update(x.id, { personAId: a, personBId: b, status });
        taken.add(k);
      }
      // rows that list people: threads (and the introductions in them), events, notes (and the facts they read),
      // chats' referrer, intro requests, cards' payloads
      const lists = [
        db.threads.where('userId').equals(userId),
        db.events.where('userId').equals(userId),
        db.notes.where('userId').equals(userId),
        db.chats.where('userId').equals(userId),
        db.introRequests.where('userId').equals(userId),
        db.suggestions.where('userId').equals(userId),
      ] as const;
      const tables = [db.threads, db.events, db.notes, db.chats, db.introRequests, db.suggestions] as const;
      for (let i = 0; i < lists.length; i++) {
        const rows = (await lists[i]!.toArray()) as unknown as { id: string }[];
        const table = tables[i]! as unknown as { put: (r: unknown) => Promise<unknown> };
        for (const r of rows) {
          const { row, changed } = repoint(r, mergedId, survivorId);
          if (changed) await table.put(row);
        }
      }
      await db.people.update(survivorId, mergedFields(s, m, now));
      await db.people.delete(mergedId);
    },
  );
  // the survivor's closeness, from the touches it now has
  await recomputePersonStrength(survivorId).catch(() => undefined);
}

/**
 * Look for people who are probably the same person across the whole list (run after every import) and
 * record a merge suggestion for each pair the student has not already decided on. Returns how many were added.
 */
export async function suggestDuplicateMerges(userId: string, now = new Date()): Promise<number> {
  const { people, orgDomains } = await loadPeopleCache(userId);
  const visible = people.filter((p) => !p.hiddenAt);
  const pairs = findDuplicatePairs(visible, { orgDomains, doNotMerge: await loadDoNotMerge(userId) });
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

// ---------- the student's edits to a person ----------

/** "How you know them": Orbit adjusts the tone of drafts and its suggestions to it. */
export async function setRelationshipType(
  personId: string,
  relationshipType: Person['relationshipType'],
  now = new Date(),
): Promise<boolean> {
  return (await db.people.update(personId, { relationshipType, updatedAt: now.toISOString() })) > 0;
}

/** Hide a person from People, Today, the Map and Discover; sending to them is refused until they are shown again. */
export async function hidePerson(personId: string, now = new Date()): Promise<boolean> {
  return (await db.people.update(personId, { hiddenAt: now.toISOString() })) > 0;
}

export async function unhidePerson(personId: string): Promise<boolean> {
  return (await db.people.update(personId, { hiddenAt: undefined })) > 0;
}

/** The student's own tags and private note on a person. */
export async function updatePersonDetails(
  personId: string,
  changes: { tags?: string[]; notes?: string },
  now = new Date(),
): Promise<boolean> {
  const patch: Partial<Person> = { updatedAt: now.toISOString() };
  if (changes.tags) patch.tags = [...new Set(changes.tags.map((t) => t.trim()).filter(Boolean))];
  if (changes.notes !== undefined) patch.notes = changes.notes.trim() || undefined;
  return (await db.people.update(personId, patch)) > 0;
}

/** What two records have in common and where they differ, in plain words, so the student can judge a merge. */
export function mergeEvidence(a: Person, b: Person): { same: string[]; differ: string[] } {
  const same: string[] = [];
  const differ: string[] = [];
  const eq = (x?: string, y?: string) => !!x && !!y && x.trim().toLowerCase() === y.trim().toLowerCase();
  const emailsA = new Set([a.primaryEmail, ...a.emails].filter(Boolean).map((e) => e!.toLowerCase()));
  if ([b.primaryEmail, ...b.emails].some((e) => e && emailsA.has(e.toLowerCase())))
    same.push('the same email address');
  // the shared name matcher: "José"/"Jose", "Bill"/"William" and "王伟"/"Wei Wang" are not different first names
  const names = compareNames(a.displayName, b.displayName);
  if (eq(a.firstName, b.firstName) || names.given === 'same') same.push('the same first name');
  else if (names.given === 'nickname' || names.given === 'variant')
    same.push('first names that are one name and its nickname');
  else if (a.firstName && b.firstName) differ.push('different first names');
  if (eq(a.lastName, b.lastName)) same.push('the same last name');
  if (eq(a.currentOrganizationRaw, b.currentOrganizationRaw)) same.push('the same company');
  else if (a.currentOrganizationRaw && b.currentOrganizationRaw) differ.push('different companies');
  if (eq(a.school, b.school)) same.push('the same school');
  if (eq(a.linkedinSlug, b.linkedinSlug) || eq(a.linkedinMemberId, b.linkedinMemberId))
    same.push('the same LinkedIn profile');
  else if (differentLinkedInProfiles(a, b)) differ.push('different LinkedIn profiles');
  if (sharePhone(a, b)) same.push('the same phone number');
  return { same, differ };
}

/**
 * The student's answer to "Possible duplicate": yes merges B into A (the older record) and deletes B; no keeps them
 * as two people and Orbit never asks about the pair again. The card, if any, is closed either way.
 */
export async function decideMerge(
  userId: string,
  mergeId: string,
  accept: boolean,
  opts: { suggestionId?: string; now?: Date } = {},
): Promise<'merged' | 'kept' | 'missing'> {
  const m = await db.merges.get(mergeId);
  if (!m || m.userId !== userId) return 'missing';
  const now = (opts.now ?? new Date()).toISOString();
  if (accept) {
    await mergePeople(userId, m.personAId, m.personBId);
    await db.merges.update(mergeId, { status: 'accepted' });
    await feedback(userId, 'merge_accept', { refTable: 'merges', refId: mergeId });
  } else {
    await db.merges.update(mergeId, { status: 'rejected' });
    await feedback(userId, 'merge_reject', { refTable: 'merges', refId: mergeId });
  }
  const cards = opts.suggestionId
    ? [await db.suggestions.get(opts.suggestionId)]
    : await db.suggestions
        .where('userId')
        .equals(userId)
        .filter((s) => s.kind === 'confirm_merge' && s.payload.mergeId === mergeId)
        .toArray();
  for (const s of cards) if (s) await db.suggestions.update(s.id, { status: 'done', decidedAt: now });
  return accept ? 'merged' : 'kept';
}

/**
 * People added from a LinkedIn search by older versions took their company from the headline's last " at ": "Product
 * @ Google | Growing Ads for SMBs at scale" was filed at "scale". Their company is read again from the headline's
 * first part. Only a company that came from that misreading is changed.
 */
export async function repairHeadlineCompanies(userId: string): Promise<number> {
  const people = await db.people
    .where('userId')
    .equals(userId)
    .filter((p) => !!p.headline && !!p.currentOrganizationRaw)
    .toArray();
  let fixed = 0;
  for (const p of people) {
    const parts = p.headline!.split(/\s+at\s+/i);
    const misread = parts.length > 1 ? parts.slice(1).join(' at ').trim().toLowerCase() : undefined;
    if (!misread || misread !== p.currentOrganizationRaw!.trim().toLowerCase()) continue;
    const { title, org } = roleFromHeadline(p.headline);
    if (org?.toLowerCase() === misread) continue;
    const o = org ? await upsertOrganization(org) : undefined;
    await db.people.update(p.id, {
      currentOrganizationId: o?.id,
      currentOrganizationRaw: o?.name,
      currentTitle: title ?? p.currentTitle,
      // the summary said where they work: it is written again from the corrected company
      summary: undefined,
      summaryUpdatedAt: undefined,
      talkingPoints: undefined,
    });
    fixed++;
  }
  return fixed;
}
