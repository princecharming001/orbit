/**
 * The note an introducer can forward (plan 23 §4.3). An intro ask is two texts: the ask to the person who knows the
 * target, in the student's voice, and a short note about the student in the third person that the introducer can
 * pass on unchanged. The note's first lines (who the student is, the one thing that makes them worth 15 minutes) are
 * the student's, written once from their profile and their resume and saved in settings, so editing it once changes
 * every ask after; the last line is written for each ask, from the target's role and the posting when there is one.
 *
 * The note travels beyond the student's control, so it is checked harder than a message: third person, at most 90
 * words, no dashes, and nothing from the never-write list (home, pay, health, family and the rest).
 */
import {
  functionPhrase,
  isInternCycle,
  type RecruitingGoals,
  type ResumeFacet,
  roleNoun,
  schoolShort,
  shortOrg,
  type User,
  yearLabel,
} from '@orbit/core';
import { sensitiveCategory } from '../../../../supabase/functions/_shared/research/guards';
import { db } from '../db/schema';
import { credibilityLine } from './brief';
import { currentResumeFacets } from './resume';

/** The server's limit for a forwardable note, kept the same here. */
export const INTRO_NOTE_MAX_WORDS = 90;

const words = (s: string) => s.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0;

/** "a junior at Michigan studying computer science" */
function who(user: User, now: Date): string {
  const year = yearLabel(user.graduationYear, user.degree, now);
  const school = schoolShort(user.school);
  const major = user.majors[0] ? ` studying ${user.majors[0].toLowerCase()}` : '';
  const a = /^[aeiou]/i.test(year) ? 'an' : 'a';
  return `${a} ${year}${school ? ` at ${school}` : ''}${major}`;
}

/** "software engineering internships" */
function goingFor(goals: Pick<RecruitingGoals, 'targetFunctions' | 'cycleLabel'> | undefined): string {
  const fns = (goals?.targetFunctions ?? [])
    .slice(0, 2)
    .map((f) => functionPhrase(f))
    .filter(Boolean);
  const intern = isInternCycle(goals?.cycleLabel);
  const what = intern ? 'internships' : 'roles';
  return fns.length ? `${fns.join(' and ')} ${what}` : intern ? 'internships' : 'full-time roles';
}

/**
 * The student's part of the note, written from their profile and resume: who they are and what they are going for,
 * then the one concrete thing they have done, when the resume has one.
 */
export function buildIntroNote(
  user: User,
  facets: Pick<ResumeFacet, 'kind' | 'text' | 'title' | 'organizationName'>[],
  goals: Pick<RecruitingGoals, 'targetFunctions' | 'cycleLabel'> | undefined,
  now = new Date(),
): string {
  const name = user.fullName || user.firstName;
  const first = user.firstName || name;
  const lines = [`${name} is ${who(user, now)}, recruiting for ${goingFor(goals)}.`];
  const cred = credibilityLine(facets);
  if (cred) lines.push(`${first} ${cred.charAt(0).toLowerCase()}${cred.slice(1)}.`);
  return lines.join(' ');
}

/** The note as the student last saved it, or the first version Orbit writes for them. */
export async function introNoteBase(user: User, now = new Date()): Promise<{ text: string; saved: boolean }> {
  const s = await db.settings.get(user.id);
  if (s?.introNote?.text.trim()) return { text: s.introNote.text.trim(), saved: true };
  const [facets, goals] = await Promise.all([currentResumeFacets(user.id), db.goals.get(user.id)]);
  return { text: buildIntroNote(user, facets, goals, now), saved: false };
}

export interface AskTarget {
  firstName: string;
  title?: string;
  org?: string;
}

export interface AskPosting {
  role?: string;
  team?: string;
}

/** The last line, written for this ask: why this person, and the 15 minutes. */
export function askLine(
  user: Pick<User, 'firstName' | 'fullName'>,
  t: AskTarget,
  posting?: AskPosting,
): string {
  const first = user.firstName || user.fullName;
  const org = shortOrg(t.org);
  if (posting?.role)
    return `${first} is applying for the ${posting.role} role${org ? ` at ${org}` : ''} and would love 15 minutes with ${t.firstName} to hear how ${posting.team ? `the ${posting.team} team` : 'the team'} works.`;
  const role = roleNoun(t.title);
  if (role)
    return `${first} would love 15 minutes with ${t.firstName} to hear about ${t.firstName}'s path to ${role}${org ? ` at ${org}` : ''}.`;
  return `${first} would love 15 minutes with ${t.firstName} to hear about ${t.firstName}'s work${org ? ` at ${org}` : ''}.`;
}

/** The whole note for one ask: the student's lines, then the line for this ask. */
export function noteForAsk(
  base: string,
  user: Pick<User, 'firstName' | 'fullName'>,
  t: AskTarget,
  posting?: AskPosting,
) {
  return `${base.trim()} ${askLine(user, t, posting)}`;
}

/**
 * What is wrong with a note, in words the student can act on; empty when it is fine to send. The same rules hold
 * for the version Orbit writes and the one the student edits.
 */
export function checkIntroNote(text: string, user: Pick<User, 'firstName' | 'fullName'>): string[] {
  const out: string[] = [];
  const n = words(text);
  if (n > INTRO_NOTE_MAX_WORDS) out.push(`It is ${n} words; keep it to ${INTRO_NOTE_MAX_WORDS} or fewer.`);
  // it is forwarded as it is, so it is about the student, never written as them
  if (/\b(I|I'm|I've|I'd|I'll|me|my|mine)\b/.test(text))
    out.push('Write it about yourself in the third person, with your name, not "I".');
  const first = user.firstName || user.fullName;
  if (first && !text.includes(first)) out.push(`Name yourself (${first}) so it reads on its own.`);
  if (/[–—]/.test(text)) out.push('Use a comma or a period instead of a dash.');
  const cat = sensitiveCategory(text);
  if (cat) out.push(NEVER[cat] ?? 'Leave out anything personal: it travels beyond you.');
  return out;
}

const NEVER: Record<string, string> = {
  home: 'Leave out where you live: it travels beyond you.',
  pay: 'Leave out pay: it travels beyond you.',
  health: 'Leave out health: it travels beyond you.',
  family: 'Leave out family: it travels beyond you.',
  religion: 'Leave out religion: it travels beyond you.',
  politics: 'Leave out politics: it travels beyond you.',
  legal: 'Leave out legal matters: it travels beyond you.',
  immigration: 'Leave out visa status: it travels beyond you.',
};

/** Save the student's own version; an empty one goes back to the version Orbit writes. */
export async function saveIntroNote(userId: string, text: string, now = new Date()): Promise<void> {
  const t = text.trim().replace(/\s+/g, ' ');
  await db.settings.update(userId, { introNote: t ? { text: t, editedAt: now.toISOString() } : undefined });
}
