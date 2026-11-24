/**
 * Plan 44 §2.6: Roles in the chat. "What roles fit me?", "internships I should apply to" and "roles at Stripe" run
 * the same search the Roles tab runs and show the same table in a card. Only while Roles is on for the student (the
 * owner's switch, or the demo): otherwise the tool says so and the model never sees it (agent/loop.ts).
 */
import { normalizeCompany, type RoleMatch, type User } from '@orbit/core';
import { featureOn } from '../../engine/features';
import {
  BAND_WORDS,
  keptMatches,
  keptProfile,
  keptSearch,
  pathOf,
  pathsFor,
  readProfile,
  rolesMode,
  runSearch,
  saveProfile,
  sortMatches,
  tableMatches,
  whereWords,
} from '../../engine/roles';
import { z } from '../../zod';
import { defineTool, ok, plural, toModel, wrapped } from './_shared';

/** How long the tool waits for the search to be read before it answers with what is read so far. */
const WAIT_MS = 45_000;
/** The rows the card keeps. */
const CARD_ROWS = 25;

/** The demo student's profile, read from the sample resume and LinkedIn the first time it is asked for. */
async function ensureProfile(user: User): Promise<boolean> {
  if (await keptProfile(user.id)) return true;
  if (rolesMode(user.id) !== 'demo') return false;
  const r = await readProfile(user, { resume: true, linkedin: true });
  if (!r.ok) return false;
  const saved = await saveProfile(user, r.proposed, { note: r.note, search: false });
  return saved.ok;
}

export const findRoles = defineTool({
  name: 'find_roles',
  kind: 'read',
  description:
    'Call this when the student asks which jobs, roles or internships fit them, which ones to apply to, or for open roles at a company ("What roles fit me?", "internships I should apply to", "new grad roles", "roles at Stripe"). Orbit searches open roles against the profile read from their resume and LinkedIn, scores each out of 10 on paper with the reasons and the gaps, and says who they know at each company. A job link they paste goes to plan_for_posting instead.',
  input: z.object({
    company: z
      .string()
      .max(120)
      .optional()
      .describe('The company named in the ask ("Stripe"), when there is one: only its roles are listed.'),
    level: z
      .enum(['internship', 'new_grad', 'any'])
      .optional()
      .describe('internship or new_grad when the ask names one; any otherwise.'),
    query: z.string().max(200).optional().describe("The ask in the student's words."),
  }),
  capabilities: ['roles_find'],
  progress: 'Reading roles against your profile',
  async execute(input, ctx) {
    const user = ctx.user;
    if (!featureOn('roles', user.id) || rolesMode(user.id) === 'off')
      throw new Error('Roles is not on for you yet. Orbit turns it on for everyone at once.');
    if (!(await ensureProfile(user)))
      return ok(
        'text',
        { text: 'Orbit reads your resume or LinkedIn first.' },
        { needsProfile: true },
        'Roles reads your resume or LinkedIn profile first, then lists roles that fit. Open Roles to start.',
        '/roles',
      );
    // the same search the tab runs, read to the end (or as far as it gets in a while)
    const done = runSearch(user);
    await Promise.race([done, new Promise((res) => setTimeout(res, WAIT_MS))]);
    const [rows, search, kept] = await Promise.all([
      keptMatches(user.id),
      keptSearch(user.id),
      keptProfile(user.id),
    ]);
    let matches = sortMatches(tableMatches(rows, search), 'fit');
    const company = input.company?.trim();
    if (company)
      matches = matches.filter((m) => normalizeCompany(m.job.companyName) === normalizeCompany(company));
    if (input.level === 'internship')
      matches = matches.filter((m) => m.job.level === 'intern' || !m.job.level);
    if (input.level === 'new_grad') matches = matches.filter((m) => m.job.level === 'entry' || !m.job.level);
    const fits = matches.filter((m) => (m.fit?.score ?? 0) >= 6 || !m.fit);
    const shown = (fits.length ? fits : matches).slice(0, CARD_ROWS);
    const paths = await pathsFor(
      user.id,
      shown.map((m) => m.job.companyName),
    );
    const line = (m: RoleMatch) => `${m.job.title} at ${m.job.companyName}`;
    const top = shown.slice(0, 10);
    const still = search && !search.done;
    const best = shown[0];
    const summary = !shown.length
      ? company
        ? `No open roles at ${company} fit your profile right now. On Roles you can watch ${company}, and Orbit says when one appears.`
        : 'No open roles fit your profile yet. On Roles you can tick more kinds of role or add a place.'
      : `${fits.length ? `Found ${plural(fits.length, 'role')} that fit` : 'Nothing fits 6 or more yet; these are the closest'}${
          best?.fit ? `. The best is ${line(best)}, ${best.fit.score}/10` : ''
        }.${still ? ' More are being read on Roles.' : ''}`;
    return ok(
      'roles',
      {
        query: input.query ?? (company ? `Roles at ${company}` : 'Roles that fit you'),
        matches: shown,
        coverage: search?.coverage,
        stretch: !fits.length,
      },
      {
        roles: top.map((m) => {
          const p = pathOf(paths, m.job.companyName);
          return {
            matchId: m.id,
            role: wrapped(ctx, 'posting', line(m), 200),
            fit: m.fit
              ? `${m.fit.score}/10, ${BAND_WORDS[m.fit.band]?.toLowerCase()}`
              : 'not read closely yet',
            why: m.reason ? wrapped(ctx, 'posting', m.reason, 200) : undefined,
            capped: m.fit?.caps.map((c) => c.label),
            where: whereWords(m.job).all,
            youKnowThere: p.known.slice(0, 2).map((k) => k.name),
            alumniThere: p.alumni.length || undefined,
          };
        }),
        more: Math.max(0, shown.length - top.length),
        stillReading: still || undefined,
        profileKinds: kept?.profile.kinds.filter((k) => k.on).map((k) => k.title),
        howToAnswer:
          'The student sees these roles in a table with the score, the reason, who they know there and where. Do not list them again. Name the best two or three with their score and the strongest reason, and who they know there when they know someone. A score is fit on paper, not a chance of an offer. Offer "Find a way in" for the best one.',
      },
      summary,
      '/roles',
    );
  },
  toModel,
});

export const roleTools = [findRoles];
