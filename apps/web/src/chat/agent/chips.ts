import { db } from '../../db/schema';
import type { ChipSpec, ToolSpec } from '../types';

/**
 * Suggestion chips under the composer on the home page. Each one runs a tool directly through `execute()`: no
 * parsing, no model call, the same in both modes, so the first click costs nothing. A chip whose best target depends
 * on the student's data (who is owed a thank-you, which chat is next) has a resolver that picks the tool input when
 * it is clicked; the chip's own `tool` and `input` are what runs when the resolver finds nothing better.
 */
export const CHIPS: ChipSpec[] = [
  {
    id: 'who-today',
    label: 'Who should I message today',
    tool: 'get_today_brief',
    input: {},
    asUser: 'Who should I message today?',
  },
  {
    id: 'thank-you',
    label: 'Draft a thank-you',
    tool: 'list_pipeline',
    input: { stage: 'completed' },
    asUser: 'Draft a thank-you.',
  },
  {
    id: 'route',
    label: 'Find a route to a company',
    tool: 'open_page',
    input: { page: 'reach' },
    asUser: 'Find a route to a company.',
  },
  {
    id: 'add-note',
    label: 'Add a note from a chat',
    tool: 'open_page',
    input: { page: 'add_note' },
    asUser: 'Add a note from a chat.',
  },
  {
    id: 'quiet',
    label: 'Who went quiet',
    tool: 'list_pipeline',
    input: { quietOnly: true },
    asUser: 'Who went quiet?',
  },
  {
    id: 'prep',
    label: 'Prep for my next chat',
    tool: 'list_pipeline',
    input: { stage: 'scheduled' },
    asUser: 'Prep me for my next chat.',
  },
  {
    // the home page opens the file picker for this one and hands the file to attach(); run on its own it asks for
    // the file
    id: 'linkedin',
    label: 'Import my LinkedIn',
    tool: 'import_linkedin',
    input: {},
    asUser: 'Import my LinkedIn connections.',
  },
  {
    id: 'pipeline',
    label: 'Show my pipeline',
    tool: 'list_pipeline',
    input: {},
    asUser: 'Show my pipeline.',
  },
];

/** What a chip runs once its resolver looked at the data. `lead` is said before the result. */
export interface ChipRun {
  tool: string;
  input: Record<string, unknown>;
  lead?: string;
}

type Resolver = (userId: string, now: Date) => Promise<ChipRun | undefined>;

const DAY = 86_400_000;

/** The person with the newest open thank-you card, else the most recent finished chat. */
const thankYou: Resolver = async (userId) => {
  const card = (
    await db.suggestions
      .where('userId')
      .equals(userId)
      .filter((s) => s.kind === 'thank_you' && s.status === 'pending' && !!s.personId)
      .toArray()
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const personId =
    card?.personId ??
    (
      await db.chats
        .where('userId')
        .equals(userId)
        .filter((c) => c.stage === 'completed')
        .toArray()
    ).sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))[0]?.personId;
  if (personId) return { tool: 'create_draft', input: { personId, kind: 'thank_you' } };
  return {
    tool: 'list_pipeline',
    input: { stage: 'completed' },
    lead: 'Nobody is waiting on a thank-you from you right now.',
  };
};

/** The top-priority target company that is still open. */
const route: Resolver = async (userId) => {
  const target = (
    await db.targetCompanies
      .where('userId')
      .equals(userId)
      .filter((t) => t.status !== 'closed')
      .toArray()
  ).sort((a, b) => a.priority - b.priority || a.nameRaw.localeCompare(b.nameRaw))[0];
  if (target) return { tool: 'find_routes', input: { company: target.nameRaw } };
  return {
    tool: 'open_page',
    input: { page: 'reach' },
    lead: 'Name a company, like: who do I know at Stripe. Or add target companies in Settings, Goals.',
  };
};

const NOTE_HOW = 'Or use the + button to attach a notes file.';

/** The person from the most recent chat that already happened, so the note page opens on them. */
const addNote: Resolver = async (userId, now) => {
  const recent = (
    await db.events
      .where('userId')
      .equals(userId)
      .filter(
        (e) =>
          e.status !== 'cancelled' &&
          !!e.chatId &&
          new Date(e.startAt).getTime() <= now.getTime() &&
          new Date(e.startAt).getTime() > now.getTime() - 7 * DAY,
      )
      .toArray()
  ).sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
  const chat = recent?.chatId ? await db.chats.get(recent.chatId) : undefined;
  const person = chat ? await db.people.get(chat.personId) : undefined;
  if (person)
    return {
      tool: 'open_page',
      input: { page: 'add_note', personId: person.id },
      lead: `Type what you talked about here, like: note about ${person.firstName}: she suggested the platform team. ${NOTE_HOW}`,
    };
  return {
    tool: 'open_page',
    input: { page: 'add_note' },
    lead: `Type what you talked about here, like: note about Priya: she suggested the platform team. ${NOTE_HOW}`,
  };
};

/** The person of the next booked chat. */
const prep: Resolver = async (userId, now) => {
  const next = (
    await db.events
      .where('userId')
      .equals(userId)
      .filter((e) => e.status !== 'cancelled' && !!e.chatId && new Date(e.startAt).getTime() > now.getTime())
      .toArray()
  ).sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  const chat = next?.chatId ? await db.chats.get(next.chatId) : undefined;
  if (chat) return { tool: 'get_person', input: { personId: chat.personId, include: ['prep', 'facts'] } };
  return {
    tool: 'list_pipeline',
    input: { stage: 'scheduled' },
    lead: 'No chat is booked yet, so there is nothing to prep. These are the chats already scheduled.',
  };
};

export const CHIP_RESOLVERS: Record<string, Resolver> = {
  'thank-you': thankYou,
  route,
  'add-note': addNote,
  prep,
};

/** The chips whose tool exists in this registry and accepts the chip's input. */
export function chipsFor(registry: ReadonlyMap<string, ToolSpec>): ChipSpec[] {
  return CHIPS.filter((c) => {
    const spec = registry.get(c.tool);
    return !!spec && spec.input.safeParse(c.input).success;
  });
}

/**
 * What a chip runs right now: the resolver's pick when it names a tool the registry has and an input that tool
 * accepts, else the chip's own tool and input.
 */
export async function resolveChip(
  chip: ChipSpec,
  registry: ReadonlyMap<string, ToolSpec>,
  userId: string,
  now: Date,
): Promise<ChipRun> {
  const fallback: ChipRun = { tool: chip.tool, input: chip.input };
  const resolver = CHIP_RESOLVERS[chip.id];
  if (!resolver) return fallback;
  try {
    const run = await resolver(userId, now);
    const spec = run && registry.get(run.tool);
    if (run && spec?.input.safeParse(run.input).success) return run;
  } catch {
    // a lookup failed: the chip still runs its own tool
  }
  return fallback;
}
