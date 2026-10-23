/**
 * The dossier synthesis prompt and its structured-output schema, exactly as §5.4 specifies. Length limits that JSON
 * schema for structured outputs cannot carry (≤ 3 recent items, exactly 3 openers of ≤ 25 words) are enforced after
 * parsing, in dossier.ts.
 */
import { z } from '../providers/zod';

export const PROMPT_VERSION = 'dossier-v2';

export function dossierSystem(userFirstName: string, goalSentence: string): string {
  return [
    `You write a research brief about one person for ${userFirstName}, who wants to ${goalSentence}.`,
    'Use only the sources provided, and write from what each source actually says: "joined" stays "joined", never "led". Every claim needs the id of the source it came from.',
    'If sources disagree or might be about a different person with the same name, leave the claim out.',
    'Never write, even if a source says it: age, ethnicity, religion, health, family or relationships, sexuality, politics or donations, where they live (a city is the finest you may say), salary or pay, their personality or "communication style", legal matters, immigration, or that they lost a job or took leave.',
    '"careful" is about their company only (recent layoffs, a reorganization, a product shut down, a hiring freeze), each item with its source ids; never anything about the person\'s own life. Leave it empty when there is nothing.',
    '"company" is what is happening at their company that matters to the student (team news, launches, hiring), from company sources, each with its source ids. Leave it empty when there are no company sources.',
    'Openers: up to three single sentences the student could open a first message with, each a statement (not a question) of at most 25 words about something they made, said or did. Each rests on one cited source and uses only details that source states, in its words where you can (a title, a claim, a number); the student\'s reaction may be added ("stuck with me"). Never flattery, never about their private life.',
    'Most people have little online beyond LinkedIn. When the only sources are their LinkedIn and the student\'s own history, say so plainly in "who" (for example "Not much is public about Dana beyond LinkedIn.") and keep to what LinkedIn says; do not pad.',
    'Also lay out who they are in full, from the sources only: "career" (every role you can source, newest first, with start and end as written, e.g. "2021" or "Mar 2022"), "education", "profiles" (their own pages: LinkedIn, X, GitHub, a personal site, Google Scholar; only URLs that appear in the sources), "highlights" (up to 8 things they made or said that matter: posts, articles, talks, podcasts, projects, papers, news, awards, each with the URL of its source) and "topics" (up to 6 short phrases for what they work on or talk about).',
  ].join('\n');
}

export interface DossierPromptInput {
  userContext: string;
  person: {
    name: string;
    title?: string;
    org?: string;
    location?: string;
    identities?: Record<string, string | string[] | undefined>;
  };
  internalHistory: string;
  linkedin: string;
  sources: { id: string; url: string; title?: string; published?: string | null; text: string }[];
  /** pages about their company (team news, hiring), for "company" and "careful" only */
  companySources?: { id: string; url: string; title?: string; published?: string | null; text: string }[];
}

export function dossierUser(input: DossierPromptInput): string {
  const block = (list: DossierPromptInput['sources']) =>
    list
      .map((s) =>
        [
          `<source id="${s.id}">`,
          `url: ${s.url}`,
          s.title ? `title: ${s.title}` : '',
          s.published ? `published: ${s.published}` : '',
          s.text,
          '</source>',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
  return [
    `<user_context>${input.userContext}</user_context>`,
    `<person>${JSON.stringify(input.person)}</person>`,
    `<internal_history>${input.internalHistory}</internal_history>`,
    `<linkedin>${input.linkedin}</linkedin>`,
    `<sources>${block(input.sources)}</sources>`,
    ...(input.companySources?.length
      ? [`<company_sources>${block(input.companySources)}</company_sources>`]
      : []),
  ].join('\n');
}

const sourceIds = z.array(z.string());

export const dossierSchema = z.object({
  who: z.string(),
  now: z.object({
    role: z.string(),
    org: z.string(),
    since: z.string().nullable(),
    source_ids: sourceIds,
  }),
  recently: z.array(z.object({ date: z.string().nullable(), text: z.string(), source_ids: sourceIds })),
  in_common: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['school', 'employer', 'person', 'interest', 'place']),
      source_ids: sourceIds,
    }),
  ),
  history: z.object({
    first_contact: z.string().nullable(),
    last_contact: z.string().nullable(),
    summary: z.string().nullable(),
  }),
  openers: z.array(z.object({ text: z.string(), source_ids: sourceIds })),
  // v2: each item cited like every other line (v1 wrote plain strings; readers accept both)
  careful: z.array(z.object({ text: z.string(), source_ids: sourceIds })),
  confidence: z.enum(['high', 'medium', 'low']),
  // the full picture (v1.1); optional so a dossier written before them still reads
  career: z
    .array(
      z.object({
        role: z.string(),
        org: z.string(),
        start: z.string().nullable(),
        end: z.string().nullable(),
        source_ids: sourceIds,
      }),
    )
    .optional(),
  education: z
    .array(
      z.object({
        school: z.string(),
        degree: z.string().nullable(),
        years: z.string().nullable(),
        source_ids: sourceIds,
      }),
    )
    .optional(),
  profiles: z
    .array(
      z.object({ kind: z.enum(['linkedin', 'x', 'github', 'website', 'scholar', 'other']), url: z.string() }),
    )
    .optional(),
  highlights: z
    .array(
      z.object({
        kind: z.enum(['post', 'article', 'talk', 'podcast', 'project', 'paper', 'news', 'award', 'other']),
        title: z.string(),
        date: z.string().nullable(),
        url: z.string().nullable(),
        summary: z.string().nullable(),
        source_ids: sourceIds,
      }),
    )
    .optional(),
  topics: z.array(z.string()).optional(),
  // v2: what is happening at their company, from company pages (Go deeper)
  company: z.array(z.object({ text: z.string(), source_ids: sourceIds })).optional(),
});

export type DossierContent = z.infer<typeof dossierSchema>;

/** The note added to the user turn when the first answer cited ids that were not in the input (§5.4). */
export function retryNote(bad: string[], allowed: string[]): string {
  return `\n\nYour previous answer cited source ids that do not exist (${bad.join(', ')}). Cite only these ids: ${allowed.join(', ') || '(none)'}. Leave out any claim you cannot cite.`;
}

// ---- the support check ----------------------------------------------------------------------------------------

export const SUPPORT_VERSION = 'support-v3';

export const supportSystem = [
  'You check a research brief against its sources. For each numbered claim, read the sources it cites and give one verdict:',
  '"supported": the cited sources state it, or it is a fair summary or paraphrase of what they state.',
  '"partial": the sources back only part of it, or it says more than they do: a stronger verb ("led" where they say "joined"), a different date or number, or a role, place or detail they do not give.',
  '"unsupported": the cited sources do not say it, or say something else.',
  'Each claim says what kind it is. An opener is a line the student would say to them: judge only what it states about them or their work; the student\'s own reaction ("stuck with me", "I liked") is not a claim. A highlight names something of theirs (a post, talk, article, project): supported when the cited source is that item or describes it.',
  'Judge only against the cited source text given here, never what you know.',
].join('\n');

export interface SupportClaim {
  id: string;
  text: string;
  sourceIds: string[];
  /** what kind of line it is (opener, highlight, recent item…), so the checker judges it the right way */
  kind?: string;
}

export function supportUser(
  claims: SupportClaim[],
  sources: { id: string; text: string; url?: string; title?: string }[],
): string {
  const used = new Set(claims.flatMap((c) => c.sourceIds));
  const src = sources
    .filter((s) => used.has(s.id))
    .map((s) => `<source id="${s.id}">${s.title ? `\ntitle: ${s.title}` : ''}\n${s.text}\n</source>`)
    .join('\n');
  const list = claims
    .map((c) => `${c.id}. ${c.kind ? `(${c.kind}) ` : ''}[${c.sourceIds.join(', ')}] ${c.text}`)
    .join('\n');
  return `<sources>\n${src}\n</sources>\n<claims>\n${list}\n</claims>`;
}

export const supportSchema = z.object({
  verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(['supported', 'partial', 'unsupported']) })),
});
export type SupportVerdicts = z.infer<typeof supportSchema>;
