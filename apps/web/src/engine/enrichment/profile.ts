/**
 * Writing a LinkedIn profile into Orbit (plan 17 E, step 2). LinkedIn is the source of truth for someone's current
 * position (the student's rule 1): its current experience entry sets their title and company over a Gmail signature,
 * a headline read as a title, notes and the calendar; only the student's own edit wins (people.ts precedence:
 * manual > linkedin_profile > enrichment > ...). A position that differs from what Orbit had is a real job change,
 * dated by LinkedIn. The company's LinkedIn id and logo go on the organisation (rule 2); the experience and education
 * sections become the person's affiliations, which is what alumni status rests on (education.ts). The email addresses
 * and phone numbers a 1st-degree connection shares join the same person's mail and texts exactly, and are kept only
 * for that: never as the address Orbit writes to.
 *
 * Sections LinkedIn held back (`throttled`) are left as they were, not emptied.
 */
import type { Affiliation, Person, PersonField, User } from '@orbit/core';
import { linkedInSlug, newId, normalizeCompany, normalizeEmail, sameSchool } from '@orbit/core';
import { db } from '../../db/schema';
import {
  type LinkedInPosition,
  type LinkedInProfile,
  personRecommendations,
} from '../../integrations/enrichmentProxy';
import { sameTitleKey } from '../linkedin';
import { mayOverwrite, mergePeople, upsertOrganization } from '../people';
import { freshPhoto } from '../photos';
import type { SchoolAlias } from './education';
import { adoptCompany } from './logos';
import { phoneKey } from './match';
import { deleteRecord, type EnrichmentRecord, type JobChange, noteField } from './store';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** A LinkedIn date as Orbit stores dates: "2021-06-01", "2021-06" or "2021". */
export function linkedInDate(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(t);
  if (m) return `${m[1]}-${pad(Number(m[2]))}${m[3] ? `-${pad(Number(m[3]))}` : ''}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[2]}-${pad(Number(m[1]))}`;
  m = /^(\d{4})$/.exec(t);
  if (m) return m[1];
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{4})$/i.exec(t);
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  if (m && month >= 0) return `${m[2]}-${pad(month + 1)}`;
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

/** Roles people hold beside their main one: advising, ambassador and campus roles, boards, volunteering, scouting. */
const SIDE_ROLE =
  /\b(advis[eo]r|ambassador|mentor|board (member|of)|board|volunteer|teaching assistant|learning assistant|tutor|grader|reader|scout|venture partner|investor|angel|member|fellow|judge|moderator|contributor|campus|club|chapter|alumni)\b/i;

/**
 * Their main current role, as a person reading the profile would tell it, when LinkedIn lists several at once: the one
 * at the company their own headline names, then a real role over a side one (advisor, ambassador, board seat,
 * teaching assistant, scout), then the latest started.
 */
export function currentPosition(
  experience: LinkedInPosition[],
  headline?: string,
): LinkedInPosition | undefined {
  const current = experience.filter((x) => x.current && x.company);
  if (current.length <= 1) return current[0];
  const head = normalizeCompany(headline ?? '').replace(/\s+/g, ' ');
  const named = (x: LinkedInPosition) => {
    const c = normalizeCompany(x.company);
    return !!c && c.length >= 2 && ` ${head} `.includes(` ${c} `);
  };
  const score = (x: LinkedInPosition) => (named(x) ? 4 : 0) + (SIDE_ROLE.test(x.title ?? '') ? -2 : 0);
  return [...current].sort(
    (a, b) => score(b) - score(a) || (linkedInDate(b.start) ?? '').localeCompare(linkedInDate(a.start) ?? ''),
  )[0];
}

/** A title as a job change would alter it: "Strategy & Ops" and "strategy and ops" are one title. */
const titleKey = (t: string) => sameTitleKey(t.replace(/&/g, ' and ').replace(/\bops\b/gi, 'operations'));

const held = (profile: LinkedInProfile, section: 'experience' | 'education') =>
  profile.throttled.some((t) => t.startsWith(section) || t === '*');

export interface ApplyResult {
  /** the person the profile landed on (a different id when their mail or texts were merged into an older record) */
  personId: string;
  wrote: PersonField[];
  jobChange?: JobChange;
  /** people merged into this one because the profile shares their email or number */
  merged: string[];
  logo: boolean;
}

/**
 * Write one person's LinkedIn profile into Orbit. `confidence` is how sure Orbit is that the profile is theirs (1 for
 * a profile read by their own LinkedIn id; the match's for one found by searching).
 */
export async function applyLinkedInProfile(
  user: Pick<User, 'id'>,
  personId: string,
  profile: LinkedInProfile,
  opts: {
    now?: Date;
    confidence?: number;
    rec?: EnrichmentRecord;
    alias?: SchoolAlias;
    /** join their mail and texts by a shared address (off for an Orbit account, whose server owns merges) */
    merge?: boolean;
  } = {},
): Promise<ApplyResult | undefined> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const confidence = opts.confidence ?? 1;
  const found = await db.people.get(personId);
  if (!found || found.userId !== user.id) return undefined;
  let person: Person = found;
  const merged: string[] = [];

  // 1. their mail and texts, by the address or number LinkedIn shares: the same person, joined exactly
  const emails = [...new Set((profile.contact?.emails ?? []).map((e) => normalizeEmail(e)))];
  const phones = [...new Set((profile.contact?.phones ?? []).map(phoneKey).filter((p): p is string => !!p))];
  if (opts.merge !== false && (emails.length || phones.length)) {
    const others = await db.people
      .where('userId')
      .equals(user.id)
      .filter(
        (p) =>
          p.id !== found.id &&
          (emails.some((e) => p.primaryEmail === e || p.emails.includes(e)) ||
            phones.some((n) => (p.phones ?? []).includes(n))),
      )
      .toArray();
    for (const other of others) {
      // a record with another LinkedIn profile is someone else (rule 4), whatever address they share
      if (other.linkedinSlug && person.linkedinSlug && other.linkedinSlug !== person.linkedinSlug) continue;
      if (
        other.linkedinMemberId &&
        person.linkedinMemberId &&
        other.linkedinMemberId !== person.linkedinMemberId
      )
        continue;
      if (await rejectedPair(user.id, person.id, other.id)) continue;
      const [survivor, gone]: [Person, Person] =
        other.createdAt <= person.createdAt ? [other, person] : [person, other];
      await mergePeople(user.id, survivor.id, gone.id);
      await deleteRecord(gone.id);
      merged.push(gone.id);
      const kept: Person | undefined = await db.people.get(survivor.id);
      person = kept ?? survivor;
    }
  }
  const p = person;
  // the caller's record goes with the person into the record that survived a merge
  if (opts.rec) opts.rec.personId = p.id;
  const rec = opts.rec;

  const patch: Partial<Person> = {};
  const fieldSources = { ...(p.fieldSources ?? {}) };
  const wrote: PersonField[] = [];
  const write = <K extends PersonField & keyof Person>(field: K, value: Person[K] | undefined) => {
    if (value === undefined || value === '' || value === p[field]) return;
    if (!mayOverwrite(p, field, 'linkedin_profile', p[field])) return;
    (patch as Record<string, unknown>)[field] = value;
    fieldSources[field] = 'linkedin_profile';
    wrote.push(field);
  };

  // 2. who they are on LinkedIn
  if (profile.providerId && !p.linkedinMemberId) patch.linkedinMemberId = profile.providerId;
  if (profile.publicIdentifier && !p.linkedinSlug) {
    const url = `https://www.linkedin.com/in/${profile.publicIdentifier}`;
    patch.linkedinSlug = linkedInSlug(url) ?? profile.publicIdentifier;
    if (!p.linkedinUrl) patch.linkedinUrl = url;
  }
  const newEmails = emails.filter((e) => e !== p.primaryEmail && !p.emails.includes(e));
  if (newEmails.length) patch.emails = [...p.emails, ...newEmails];
  const newPhones = phones.filter((n) => !(p.phones ?? []).includes(n));
  if (newPhones.length) patch.phones = [...(p.phones ?? []), ...newPhones];

  // 3. their current position, and its company's LinkedIn id and logo
  let jobChange: JobChange | undefined;
  let logo = false;
  const cur = held(profile, 'experience') ? undefined : currentPosition(profile.experience, profile.headline);
  if (cur?.company) {
    const org = await upsertOrganization(cur.company);
    if (org) {
      const adopted = await adoptCompany(
        org,
        { companyId: cur.companyId, companySlug: cur.companySlug, logoUrl: cur.logoUrl },
        now,
      );
      logo = !!adopted?.logoUrl;
      const before = { title: p.currentTitle, company: p.currentOrganizationRaw };
      const companyFree = mayOverwrite(
        p,
        'currentOrganizationId',
        'linkedin_profile',
        p.currentOrganizationId ?? p.currentOrganizationRaw,
      );
      const titleFree = mayOverwrite(p, 'currentTitle', 'linkedin_profile', p.currentTitle);
      if (companyFree && org.id !== p.currentOrganizationId) {
        patch.currentOrganizationId = org.id;
        patch.currentOrganizationRaw = org.name;
        fieldSources.currentOrganizationId = 'linkedin_profile';
        wrote.push('currentOrganizationId');
      } else if (companyFree) fieldSources.currentOrganizationId = 'linkedin_profile';
      if (titleFree && cur.title) {
        if (cur.title !== p.currentTitle) {
          patch.currentTitle = cur.title;
          wrote.push('currentTitle');
        }
        fieldSources.currentTitle = 'linkedin_profile';
      }
      const companyMoved =
        companyFree && !!before.company && normalizeCompany(before.company) !== normalizeCompany(org.name);
      // a new title at the same company is a change only when LinkedIn itself said otherwise before (a signature or a
      // headline worded differently is not a promotion)
      const titleMoved =
        titleFree &&
        p.fieldSources?.currentTitle === 'linkedin_profile' &&
        !!before.title &&
        !!cur.title &&
        titleKey(before.title) !== titleKey(cur.title);
      if (companyMoved || titleMoved)
        jobChange = {
          from: before,
          to: { title: cur.title, company: org.name },
          observedAt: at,
          startedAt: linkedInDate(cur.start),
        };
      if (rec) {
        if (companyFree)
          noteField(
            rec,
            'currentOrganizationId',
            { source: 'linkedin_profile', confidence, value: org.name },
            now,
            true,
          );
        if (titleFree && cur.title)
          noteField(
            rec,
            'currentTitle',
            { source: 'linkedin_profile', confidence, value: cur.title },
            now,
            true,
          );
      }
    }
  }
  write('headline', profile.headline);
  write('location', profile.location);
  // followers and recommendations, from a read that asked for them (the route's evidence then reads nothing more)
  if (profile.recommendations) {
    if (profile.followerCount !== undefined && profile.followerCount !== p.linkedinFollowers)
      patch.linkedinFollowers = profile.followerCount;
    patch.linkedinRecommendations = personRecommendations(profile.recommendations);
  }
  if (rec && profile.headline)
    noteField(
      rec,
      'headline',
      { source: 'linkedin_profile', confidence, value: profile.headline },
      now,
      true,
    );

  // 4. their photo: LinkedIn's over a Gravatar or an older LinkedIn link; a photo the student set stays
  const photo = freshPhoto(p.photoUrl, profile.pictureUrl);
  if (photo !== p.photoUrl) {
    patch.photoUrl = photo;
    if (rec) noteField(rec, 'photoUrl', { source: 'linkedin_profile', confidence }, now, true);
  }

  // 4b. every company and school on the profile, as LinkedIn names them: their LinkedIn id and logo on the
  // organisation, so a past employer or a school shows its real logo too (logos come from LinkedIn only)
  for (const x of [
    ...(held(profile, 'experience') ? [] : profile.experience.filter((e) => e !== cur)),
    ...(held(profile, 'education') ? [] : profile.education),
  ]) {
    const name = 'school' in x ? x.school : x.company;
    const facts =
      'school' in x
        ? { companyId: x.schoolId, logoUrl: x.logoUrl }
        : { companyId: x.companyId, companySlug: x.companySlug, logoUrl: x.logoUrl };
    if (!name || (!facts.logoUrl && !facts.companyId)) continue;
    const org = await upsertOrganization(name);
    if (org && (await adoptCompany(org, facts, now))?.logoUrl) logo = true;
  }

  // 5. experience and education as affiliations
  if (!held(profile, 'experience') && profile.experience.length)
    await replaceEmployment(
      user.id,
      p.id,
      profile.experience,
      patch.currentOrganizationId ?? p.currentOrganizationId,
      now,
      profile.headline,
    );
  if (!held(profile, 'education') && profile.education.length)
    await replaceEducation(user.id, p.id, profile, now, opts.alias);

  const claimed = JSON.stringify(fieldSources) !== JSON.stringify(p.fieldSources ?? {});
  if (Object.keys(patch).length || claimed) {
    patch.fieldSources = fieldSources;
    if (!p.sources.includes('linkedin_profile')) patch.sources = [...p.sources, 'linkedin_profile'];
    patch.updatedAt = at;
    await db.people.update(p.id, patch);
  }
  if (rec) {
    // who they are on LinkedIn: kept as found (a search notes how it matched them)
    if (!rec.fields.linkedin)
      noteField(
        rec,
        'linkedin',
        { source: 'linkedin_profile', confidence, value: profile.publicIdentifier },
        now,
      );
    if (!held(profile, 'experience') && profile.experience.length)
      noteField(rec, 'experience', { source: 'linkedin_profile', confidence }, now, true);
    if (!held(profile, 'education') && profile.education.length)
      noteField(rec, 'education', { source: 'linkedin_profile', confidence }, now, true);
    if (profile.about) {
      rec.about = profile.about;
      noteField(rec, 'about', { source: 'linkedin_profile', confidence }, now, true);
    }
    if (emails.length || phones.length) {
      rec.contact = { emails, phones };
      noteField(rec, 'contact', { source: 'linkedin_profile', confidence: 1 }, now, true);
    }
    if (jobChange) rec.jobChange = jobChange;
  }
  return { personId: p.id, wrote, jobChange, merged, logo };
}

async function rejectedPair(userId: string, a: string, b: string): Promise<boolean> {
  return (
    (await db.merges
      .where('userId')
      .equals(userId)
      .filter(
        (m) =>
          m.status === 'rejected' &&
          ((m.personAId === a && m.personBId === b) || (m.personAId === b && m.personBId === a)),
      )
      .count()) > 0
  );
}

/**
 * Their positions from LinkedIn replace the ones read from it before. A role another source recorded at the same
 * company is the same role (dropped: LinkedIn's has the dates); another source's "current" role somewhere else ended
 * when LinkedIn says the new one began.
 */
async function replaceEmployment(
  userId: string,
  personId: string,
  experience: LinkedInPosition[],
  currentOrgId: string | undefined,
  now: Date,
  headline?: string,
): Promise<void> {
  const existing = await db.affiliations.where('personId').equals(personId).toArray();
  const work = existing.filter((a) => a.kind === 'employment');
  await db.affiliations.bulkDelete(work.filter((a) => a.source === 'linkedin_profile').map((a) => a.id));
  const cur = currentPosition(experience, headline);
  const curStart = linkedInDate(cur?.start);
  for (const a of work.filter((x) => x.source !== 'linkedin_profile')) {
    const same = experience.find(
      (x) =>
        !!x.company &&
        normalizeCompany(x.company) === normalizeCompany(a.nameRaw) &&
        (!a.title || !x.title || titleKey(a.title) === titleKey(x.title) || (a.isCurrent && x.current)),
    );
    if (same) await db.affiliations.delete(a.id);
    else if (a.isCurrent && cur)
      await db.affiliations.update(a.id, {
        isCurrent: false,
        endDate: a.endDate ?? curStart ?? now.toISOString().slice(0, 10),
      });
  }
  const rows: Affiliation[] = experience
    .filter((x) => x.company)
    .map((x) => ({
      id: newId('aff'),
      userId,
      personId,
      kind: 'employment',
      organizationId: x === cur ? currentOrgId : undefined,
      nameRaw: x.company!,
      title: x.title,
      startDate: linkedInDate(x.start),
      endDate: x.current ? undefined : linkedInDate(x.end),
      isCurrent:
        x === cur || (x.current && !!cur && normalizeCompany(x.company) === normalizeCompany(cur.company)),
      source: 'linkedin_profile',
    }));
  await db.affiliations.bulkAdd(rows);
}

/** Their schools from LinkedIn replace the ones read from it before, and any other record of the same school. */
async function replaceEducation(
  userId: string,
  personId: string,
  profile: LinkedInProfile,
  now: Date,
  alias?: SchoolAlias,
): Promise<void> {
  const existing = await db.affiliations.where('personId').equals(personId).toArray();
  const schools = existing.filter((a) => a.kind === 'education');
  const drop = schools.filter(
    (a) =>
      a.source === 'linkedin_profile' ||
      profile.education.some((e) => sameSchool(e.school, a.nameRaw, alias)),
  );
  await db.affiliations.bulkDelete(drop.map((a) => a.id));
  const today = now.toISOString().slice(0, 10);
  await db.affiliations.bulkAdd(
    profile.education.map((e) => {
      const end = linkedInDate(e.end);
      return {
        id: newId('aff'),
        userId,
        personId,
        kind: 'education' as const,
        nameRaw: e.school,
        degree: e.degree,
        field: e.field,
        startDate: linkedInDate(e.start),
        endDate: end,
        isCurrent: !!end && end > today,
        source: 'linkedin_profile' as const,
      };
    }),
  );
}
