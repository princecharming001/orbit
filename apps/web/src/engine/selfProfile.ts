/**
 * What Orbit knows about the student themselves, from their own LinkedIn profile, read in full: headline, place,
 * About, every job and school (the high school too), skills, languages, certifications, projects and volunteering.
 * Read once LinkedIn is connected and again every two weeks, kept in this browser (kv), and used by the chat (its
 * picture of the student) and by the network search ("people who went to my high school"). Before this, Orbit knew
 * only the one school typed at setup.
 */
import type { User } from '@orbit/core';
import { db } from '../db/schema';
import { type LinkedInProfile, linkedInProfile } from '../integrations/enrichmentProxy';
import { linkedInMe } from '../integrations/unipile';
import { liveAccountFor } from './enrichment/sources';

/** engine/demo DEMO_USER_ID (not imported: demo.ts imports most of the engine) */
const DEMO_ID = 'demo-user';
const KEY = (userId: string) => `self:linkedin:${userId}`;
const TRIED = (userId: string) => `self:linkedin:tried:${userId}`;
/** A read this young is used as it is. */
export const SELF_FRESH_MS = 14 * 86_400_000;
/** After a read that failed, the next try waits this long. */
const RETRY_MS = 86_400_000;
/** Every section of a profile: the student's own is read in full. */
export const SELF_SECTIONS = [
  'experience',
  'education',
  'about',
  'skills',
  'languages',
  'certifications',
  'volunteering_experience',
  'projects',
];

export interface SelfProfile {
  readAt: string;
  profile: LinkedInProfile;
}

export type SchoolLevel = 'high_school' | 'college' | 'graduate' | 'other';

/** Which kind of school an education entry is, from its name and degree. */
export function schoolLevel(s: { school: string; degree?: string; field?: string }): SchoolLevel {
  const name = s.school.toLowerCase();
  const degree = (s.degree ?? '').toLowerCase();
  if (/\b(high school|secondary|hs diploma|igcse|a[- ]levels?|gcse|ib diploma)\b/.test(degree))
    return 'high_school';
  if (/\b(mba|m\.?s\.?|m\.?a\.?|master|ph\.?d|doctor|j\.?d\.?|m\.?d\.?|meng|mphil|llm)\b/.test(degree))
    return 'graduate';
  if (/\b(b\.?s\.?|b\.?a\.?|bachelor|bsc|beng|associate|undergrad)\b/.test(degree)) return 'college';
  if (
    /\b(high school|secondary school|senior high|junior high|preparatory|prep school|lyc[eé]e|gymnasium|grammar school|hs)\b/.test(
      name,
    )
  )
    return 'high_school';
  if (
    /\b(school of (business|law|medicine|engineering)|graduate school|law school|business school)\b/.test(
      name,
    )
  )
    return 'graduate';
  if (/\b(university|college|institute of technology|polytechnic|universidad|universit[eé])\b/.test(name))
    return 'college';
  if (/\b(academy|school)\b/.test(name)) return 'high_school';
  return 'other';
}

export async function ownProfile(userId: string): Promise<SelfProfile | undefined> {
  return (await db.kv.get(KEY(userId)))?.value as SelfProfile | undefined;
}

/** The student's own profile as the demo's mock LinkedIn would answer: their school, a high school, what they do. */
function demoSelf(
  user: Pick<User, 'firstName' | 'lastName' | 'school' | 'graduationYear' | 'majors'>,
): LinkedInProfile {
  const grad = user.graduationYear ?? new Date().getFullYear() + 2;
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    headline: `${user.majors?.[0] ?? 'Computer Science'} at ${user.school || 'Cornell University'}`,
    location: 'Ithaca, New York',
    about:
      'Student who likes building marketplaces and search. Looking for a software engineering internship.',
    experience: [
      {
        title: 'Software Engineering Intern',
        company: 'Brex',
        current: false,
        start: `${grad - 2}-06`,
        end: `${grad - 2}-08`,
      },
      {
        title: 'Teaching Assistant, CS 2110',
        company: user.school || 'Cornell University',
        current: true,
        start: `${grad - 3}-08`,
      },
    ],
    education: [
      {
        school: user.school || 'Cornell University',
        degree: 'Bachelor of Science',
        field: user.majors?.[0] ?? 'Computer Science',
        start: String(grad - 4),
        end: String(grad),
      },
      { school: 'Lincoln High School', start: String(grad - 8), end: String(grad - 4) },
    ],
    skills: ['TypeScript', 'Python', 'PostgreSQL', 'React', 'Distributed systems'],
    languages: [
      { name: 'English', proficiency: 'Native' },
      { name: 'Spanish', proficiency: 'Professional' },
    ],
    certifications: [],
    projects: [
      {
        name: 'Campus marketplace',
        description: 'A marketplace for used textbooks with Postgres full text search',
      },
    ],
    volunteering: [{ role: 'Mentor', organization: 'Girls Who Code' }],
    throttled: [],
  };
}

/**
 * Read the student's own LinkedIn profile in full when the kept one is older than two weeks (or `force`). Answers
 * what happened: read, still fresh, LinkedIn not connected, or a failed read (tried again after a day).
 */
export async function readOwnProfile(
  user: User,
  opts: { now?: Date; force?: boolean } = {},
): Promise<'read' | 'fresh' | 'off' | 'failed'> {
  const now = opts.now ?? new Date();
  const kept = await ownProfile(user.id);
  if (!opts.force && kept && now.getTime() - Date.parse(kept.readAt) < SELF_FRESH_MS) return 'fresh';
  const tried = (await db.kv.get(TRIED(user.id)))?.value as string | undefined;
  if (!opts.force && tried && now.getTime() - Date.parse(tried) < RETRY_MS) return 'failed';
  // the demo student has a sample profile whether or not the demo's LinkedIn is connected
  const live = user.id === DEMO_ID ? 'mock' : await liveAccountFor(user, { anyToken: true });
  if (!live) return 'off';
  let profile: LinkedInProfile | undefined;
  if (live === 'mock') profile = demoSelf(user);
  else {
    const me = await linkedInMe(live.accountId, { token: live.token });
    const id = me.ok ? (me.value.providerId ?? me.value.publicIdentifier) : undefined;
    if (id) {
      const r = await linkedInProfile(live.accountId, id, SELF_SECTIONS, { token: live.token });
      if (r.ok) profile = r.value;
    }
  }
  if (!profile) {
    await db.kv.put({ key: TRIED(user.id), value: now.toISOString() });
    return 'failed';
  }
  await db.kv.put({ key: KEY(user.id), value: { readAt: now.toISOString(), profile } satisfies SelfProfile });
  return 'read';
}

export interface AboutMe {
  headline?: string;
  location?: string;
  about?: string;
  schools: {
    name: string;
    level: SchoolLevel;
    degree?: string;
    field?: string;
    start?: string;
    end?: string;
  }[];
  jobs: { title?: string; company?: string; current: boolean; start?: string; end?: string }[];
  skills: string[];
  languages: string[];
  certifications: string[];
  projects: string[];
  volunteering: string[];
  /** when the LinkedIn profile was read; undefined when only setup's answers are known */
  readAt?: string;
}

/** Everything known about the student: their LinkedIn profile, with the school from setup when it is not on it. */
export async function aboutMe(
  user: Pick<User, 'id' | 'school'> & Partial<Pick<User, 'graduationYear' | 'majors'>>,
): Promise<AboutMe> {
  const kept = await ownProfile(user.id);
  const p = kept?.profile;
  const schools: AboutMe['schools'] = (p?.education ?? []).map((e) => ({
    name: e.school,
    level: schoolLevel(e),
    degree: e.degree,
    field: e.field,
    start: e.start,
    end: e.end,
  }));
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  if (user.school && !schools.some((s) => norm(s.name) === norm(user.school)))
    schools.unshift({
      name: user.school,
      level: 'college',
      field: user.majors?.join(', ') || undefined,
      end: user.graduationYear ? String(user.graduationYear) : undefined,
    });
  return {
    headline: p?.headline,
    location: p?.location,
    about: p?.about,
    schools,
    jobs: (p?.experience ?? []).map((x) => ({
      title: x.title,
      company: x.company,
      current: x.current,
      start: x.start,
      end: x.end,
    })),
    skills: p?.skills ?? [],
    languages: (p?.languages ?? []).map((l) => (l.proficiency ? `${l.name} (${l.proficiency})` : l.name)),
    certifications: (p?.certifications ?? []).map((c) => [c.name, c.authority].filter(Boolean).join(', ')),
    projects: (p?.projects ?? []).map((x) => (x.description ? `${x.name}: ${x.description}` : x.name)),
    volunteering: (p?.volunteering ?? []).map((v) => [v.role, v.organization].filter(Boolean).join(' at ')),
    readAt: kept?.readAt,
  };
}

/** The student's schools of one kind (all when no kind), by name. */
export function schoolsOf(a: AboutMe, level?: SchoolLevel): string[] {
  return a.schools.filter((s) => !level || s.level === level).map((s) => s.name);
}

const LEVEL_WORD: Record<SchoolLevel, string> = {
  high_school: 'high school',
  college: 'college',
  graduate: 'graduate school',
  other: 'school',
};
const span = (a?: string, b?: string) => (a || b ? ` (${[a, b].filter(Boolean).join(' to ')})` : '');

/** The student, as lines the chat reads: who they are on LinkedIn, in full but short, the longest parts last. */
export function aboutMeLines(a: AboutMe, maxChars = 1600): string[] {
  const lines: string[] = [];
  if (a.headline) lines.push(`Headline: ${a.headline}`);
  if (a.location) lines.push(`Lives in: ${a.location}`);
  if (a.schools.length)
    lines.push(
      `Schools: ${a.schools
        .map(
          (s) =>
            `${s.name} (${LEVEL_WORD[s.level]}${s.degree || s.field ? `, ${[s.degree, s.field].filter(Boolean).join(' in ')}` : ''}${s.start || s.end ? `, ${[s.start, s.end].filter(Boolean).join(' to ')}` : ''})`,
        )
        .join('; ')}`,
    );
  if (a.jobs.length)
    lines.push(
      `Experience: ${a.jobs
        .slice(0, 8)
        .map(
          (j) =>
            `${[j.title, j.company].filter(Boolean).join(' at ')}${j.current ? ' (now)' : span(j.start, j.end)}`,
        )
        .join('; ')}`,
    );
  if (a.skills.length) lines.push(`Skills: ${a.skills.slice(0, 20).join(', ')}`);
  if (a.languages.length) lines.push(`Languages: ${a.languages.join(', ')}`);
  if (a.certifications.length) lines.push(`Certifications: ${a.certifications.slice(0, 6).join('; ')}`);
  if (a.projects.length) lines.push(`Projects: ${a.projects.slice(0, 5).join('; ')}`);
  if (a.volunteering.length) lines.push(`Volunteering: ${a.volunteering.slice(0, 4).join('; ')}`);
  if (a.about) lines.push(`About (their words): ${a.about.replace(/\s+/g, ' ')}`);
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const room = maxChars - used;
    if (room <= 40) break;
    const line = l.length > room ? `${l.slice(0, room - 1).trimEnd()}…` : l;
    out.push(line);
    used += line.length;
  }
  return out;
}
