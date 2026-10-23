import { z } from '../../zod';
import type { ResultEnvelope, ToolContext, ToolSpec } from '../types';

/**
 * A small fake registry for the engine tests: read, write and risky tools that exercise every path of the loop and
 * the router (parallel reads, a tool that throws, a risky tool that needs confirmation, attachment imports). Names and
 * input schemas mirror the real registry's (chat/registry.ts) for the tools they share, so a test that passes here
 * calls the real tool the same way; chat/__tests__/integration.test.ts drives the real registry end to end.
 */

export interface StubCall {
  name: string;
  input: unknown;
  ctx: ToolContext;
}

export interface StubRegistry {
  registry: ReadonlyMap<string, ToolSpec>;
  execute: (name: string, input: unknown, ctx: ToolContext) => Promise<ResultEnvelope>;
  calls: StubCall[];
  /** confirmation tokens handed out by risky tools, with their bound tool and input */
  confirmations: Map<string, { toolName: string; input: unknown; used: boolean }>;
  /** make a tool slow (resolve after `ms`) so abort paths can be tested */
  delays: Map<string, number>;
}

const STAGES = [
  'identified',
  'warming',
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
  'declined',
  'no_response',
  'archived',
] as const;

const KINDS = [
  'outreach',
  'bump',
  'schedule',
  'thank_you',
  'nurture',
  'congratulate',
  'referral_ask',
  'intro_request',
  'reply',
  'report_back',
] as const;

// biome-ignore lint/suspicious/noExplicitAny: the stub registry erases each tool's generics like the real one
type AnySpec = ToolSpec<any, any>;

function tool<I extends z.ZodObject>(
  spec: Omit<AnySpec, 'execute' | 'input' | 'capabilities'> & {
    input: I;
    execute: (input: z.infer<I>, ctx: ToolContext) => Promise<ResultEnvelope>;
    toModel?: (data: unknown) => unknown;
  },
): AnySpec {
  return { capabilities: [spec.name], ...spec } as AnySpec;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeStubRegistry(): StubRegistry {
  const calls: StubCall[] = [];
  const confirmations = new Map<string, { toolName: string; input: unknown; used: boolean }>();
  const delays = new Map<string, number>();
  let confirmationCount = 0;
  const specs: AnySpec[] = [
    tool({
      name: 'get_today_brief',
      kind: 'read',
      description:
        "Call this when the student asks what is on today, what they should do, or opens the chat with no question. Returns today's cards.",
      input: z.object({}),
      progress: 'Looking at your day',
      execute: async () => ({
        kind: 'brief',
        data: { cards: [{ id: 's_1', kind: 'thank_you', person: 'Priya Patel' }] },
        summary: 'One card today: thank Priya Patel.',
        href: '/inbox',
      }),
      toModel: (d) => ({ cards: (d as { cards: unknown[] }).cards.length }),
    }),
    tool({
      name: 'list_pipeline',
      kind: 'read',
      description:
        'Call this when the student asks about their pipeline, a stage, or who went quiet. Lists chats, optionally filtered by stage.',
      input: z.object({
        stage: z.enum(STAGES).optional().describe('only chats in this stage'),
        quietOnly: z.boolean().optional().describe('only chats waiting a week or more for a reply'),
      }),
      progress: 'Looking at your pipeline',
      execute: async (input) => ({
        kind: 'pipeline',
        data: { stage: input.stage, rows: [] },
        summary: input.stage
          ? `No chats in ${input.stage}.`
          : input.quietOnly
            ? 'No chat went quiet.'
            : 'Your pipeline is empty.',
        href: '/people?view=board',
      }),
    }),
    tool({
      name: 'search_people',
      kind: 'read',
      description:
        'Call this when the student names a person or asks who they know somewhere. Searches people by name, company or title.',
      input: z.object({ query: z.string().describe('name, company or title to search') }),
      execute: async (input) => ({
        kind: 'people',
        data: { query: input.query, people: [] },
        summary: `Nobody matches "${input.query}".`,
      }),
    }),
    tool({
      name: 'get_person',
      kind: 'read',
      description:
        'Call this when the student asks about one known person. Returns their profile, stage and facts.',
      input: z.object({ personId: z.string().describe('the person id') }),
      execute: async (input) => ({
        kind: 'person',
        data: { id: input.personId },
        summary: 'Here is what Orbit knows about them.',
        href: `/people/${input.personId}`,
      }),
    }),
    tool({
      name: 'list_drafts',
      kind: 'read',
      description:
        'Call this when the student asks about drafts or unsent messages. Lists outbound messages by status.',
      input: z.object({
        list: z
          .enum(['to_send', 'can_wait', 'started', 'opened', 'snoozed', 'sent', 'all'])
          .optional()
          .describe('which list'),
        personId: z.string().optional().describe('only this person'),
      }),
      execute: async (input) => ({
        kind: 'drafts',
        data: { list: input.list, drafts: [] },
        summary: 'No drafts waiting.',
        href: '/inbox',
      }),
    }),
    tool({
      name: 'find_routes',
      kind: 'read',
      description:
        'Call this when the student asks who can introduce them to a person, or how to reach a company. Ranks warm routes.',
      input: z.object({
        personId: z.string().optional().describe('the target person id'),
        company: z.string().optional().describe('company name'),
      }),
      execute: async (input) =>
        input.company
          ? {
              kind: 'company',
              data: { company: input.company, thereNow: [] },
              summary: `No one at ${input.company} yet.`,
            }
          : {
              kind: 'routes',
              data: { target: input.personId, routes: [] },
              summary: 'No warm route yet.',
              href: `/map?reach=${input.personId}`,
            },
    }),
    tool({
      name: 'create_draft',
      kind: 'write',
      description: 'Call this only when the student asks to write or draft a message to a known person.',
      input: z.object({
        kind: z.enum(KINDS).describe('message kind'),
        personId: z.string().describe('recipient'),
      }),
      progress: 'Writing a draft',
      execute: async (input) => ({
        kind: 'draft',
        data: { id: 'out_1', kind: input.kind, personId: input.personId },
        summary: `A ${input.kind} draft is ready for review.`,
        href: '/inbox?draft=out_1',
      }),
    }),
    tool({
      name: 'add_note',
      kind: 'write',
      description: 'Call this only when the student asks to save a note about a conversation or a person.',
      input: z.object({
        text: z.string().describe('the note text'),
        personId: z.string().optional().describe('who it is about'),
        source: z
          .enum(['manual', 'wispr_capture', 'granola_email', 'upload'])
          .optional()
          .describe('where it came from'),
        title: z.string().optional().describe('a title'),
      }),
      execute: async (input) => ({
        kind: 'note',
        data: { id: 'note_1', text: input.text, personId: input.personId, source: input.source },
        summary: 'Note saved.',
      }),
    }),
    tool({
      name: 'move_pipeline_stage',
      kind: 'write',
      description: 'Call this only when the student explicitly asks to move a chat to a stage.',
      input: z.object({
        personId: z.string().describe('whose chat'),
        stage: z.enum(STAGES).describe('the new stage'),
      }),
      execute: async (input) => ({
        kind: 'pipeline',
        data: { personId: input.personId, stage: input.stage },
        summary: `Moved to ${input.stage}.`,
        href: '/people?view=board',
      }),
    }),
    tool({
      name: 'send_draft',
      kind: 'risky',
      description: 'Call this only when the student asks to send a draft. It always asks for approval first.',
      input: z.object({ draftId: z.string().describe('the draft to send') }),
      summarizeIntent: async (input) => ({ text: `Send draft ${input.draftId} by email.` }),
      execute: async (input) => ({
        kind: 'draft',
        data: { id: input.draftId, status: 'queued' },
        summary: 'Queued. It sends in 10 seconds unless you undo.',
        href: `/inbox?draft=${input.draftId}`,
      }),
    }),
    tool({
      name: 'save_resume',
      kind: 'risky',
      description: 'Call this only when the student attaches a resume file to read.',
      input: z.object({
        filename: z.string().min(1).describe('the file name'),
        base64: z.string().min(1).describe('the file contents, base64'),
        mimeType: z.string().optional().describe('the file type'),
      }),
      execute: async (input) => ({
        kind: 'import',
        data: { fileName: input.filename },
        summary: 'Resume read.',
        href: '/settings/integrations',
      }),
    }),
    tool({
      name: 'import_linkedin',
      kind: 'risky',
      description: 'Call this only when the student attaches a LinkedIn export to import.',
      input: z.object({
        csvText: z.string().optional().describe('Connections.csv as text'),
        base64: z.string().optional().describe('the ZIP as base64'),
        filename: z.string().optional().describe('the file name'),
      }),
      execute: async (input) => ({
        kind: 'import',
        data: { fileName: input.filename, imported: 0 },
        summary: 'Imported 0 connections.',
      }),
    }),
    tool({
      name: 'explode',
      kind: 'read',
      description: 'A tool that always fails (test only). Call this when asked to explode.',
      input: z.object({ why: z.string().optional().describe('why') }),
      execute: async () => {
        throw new Error('boom: internal detail');
      },
    }),
  ];
  const registry = new Map<string, ToolSpec>(specs.map((s) => [s.name, s as ToolSpec]));

  const execute = async (name: string, input: unknown, ctx: ToolContext): Promise<ResultEnvelope> => {
    const spec = registry.get(name) as AnySpec | undefined;
    if (!spec) return { kind: 'error', data: undefined, summary: `Orbit has no tool called ${name}.` };
    const parsed = spec.input.safeParse(input);
    if (!parsed.success)
      return { kind: 'error', data: undefined, summary: 'The tool was given the wrong input.' };
    calls.push({ name, input: parsed.data, ctx });
    const delay = delays.get(name);
    if (delay) {
      await Promise.race([
        sleep(delay),
        new Promise<void>((_, reject) =>
          ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        ),
      ]);
    }
    if (ctx.signal?.aborted) throw new Error('aborted');
    if (spec.kind === 'risky') {
      if (!ctx.confirmation) {
        const id = `conf_${++confirmationCount}`;
        confirmations.set(id, { toolName: name, input: parsed.data, used: false });
        const intent = spec.summarizeIntent
          ? (await spec.summarizeIntent(parsed.data, ctx)).text
          : `Run ${name}.`;
        return {
          kind: 'needs_confirmation',
          data: { toolName: name, input: parsed.data },
          summary: intent,
          confirmationId: id,
        };
      }
      const token = confirmations.get(ctx.confirmation);
      if (!token || token.used || token.toolName !== name)
        return { kind: 'error', data: undefined, summary: 'That approval is not valid any more.' };
      token.used = true;
    }
    try {
      return await spec.execute(parsed.data, ctx);
    } catch (e) {
      return {
        kind: 'error',
        data: { detail: e instanceof Error ? e.message : String(e) },
        summary: 'The tool could not finish.',
      };
    }
  };
  return { registry, execute, calls, confirmations, delays };
}
