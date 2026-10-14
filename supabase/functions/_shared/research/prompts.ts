/**
 * The dossier synthesis prompt and its structured-output schema, exactly as §5.4 specifies. Length limits that JSON
 * schema for structured outputs cannot carry (≤ 3 recent items, exactly 3 openers of ≤ 25 words) are enforced after
 * parsing, in dossier.ts.
 */
import { z } from '../providers/zod';

export const PROMPT_VERSION = 'dossier-v1.0';

export function dossierSystem(userFirstName: string, goalSentence: string): string {
  return [
    `You write a research brief about one person for ${userFirstName}, who wants to ${goalSentence}.`,
    'Use only the sources provided. Every claim needs the id of the source it came from.',
    'If sources disagree or might be about a different person with the same name, say so in "careful" and leave the claim out.',
    'Never guess age, ethnicity, religion, health, family, sexuality or politics, and never include them even if a source mentions them.',
    'Openers must be specific, true, and something a thoughtful person would mention; never flattery.',
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
}

export function dossierUser(input: DossierPromptInput): string {
  const sources = input.sources
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
    `<sources>${sources}</sources>`,
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
  careful: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type DossierContent = z.infer<typeof dossierSchema>;

/** The note added to the user turn when the first answer cited ids that were not in the input (§5.4). */
export function retryNote(bad: string[], allowed: string[]): string {
  return `\n\nYour previous answer cited source ids that do not exist (${bad.join(', ')}). Cite only these ids: ${allowed.join(', ') || '(none)'}. Leave out any claim you cannot cite.`;
}
