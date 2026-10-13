/** Read tools: a few broad lookups with filters, never one per page. Nothing here changes data. */
import type { CalendarEvent, CoffeeChat, OutboundMessage, Person, Suggestion } from '@orbit/core';
import {
  ACTIVE_STAGES,
  buildIntroWeb,
  CLOSED_STAGES,
  conflictingFacts,
  describeIntroChain,
  draftWarmUpComment,
  FACT_TYPE_LABELS,
  FUNCTION_LABELS,
  introStories,
  MAX_WORDS,
  MESSAGE_KIND_LABELS,
  normalizeCompany,
  promiseText,
  REACH_BAND_LABELS,
  RELATIONSHIP_LABELS,
  STAGE_HELP,
  STAGE_LABELS,
  STAGE_ORDER,
  TARGET_STATUS_LABELS,
  TOUCHPOINT_LABELS,
  warmUpProgress,
  wordsIn,
} from '@orbit/core';
import { db } from '../../db/schema';
import { DEMO_USER_ID } from '../../engine/demo';
import { lastInboundOf, liveChatOf, nextMessageKind } from '../../engine/drafts';
import {
  type CompanyReach,
  isColdDirect,
  isUnambiguous,
  rankReachTargets,
  reachCompany,
  reachPerson,
  WARMER_ROUTES_WHY,
} from '../../engine/graph';
import { linkedInLiveStatus } from '../../engine/linkedinLive';
import { namedPeopleLabel, previewNoteMatch } from '../../engine/notes';
import { wentQuiet } from '../../engine/pipeline';
import { buildPrep, personSummary } from '../../engine/prep';
import { introducerIdFor, isColdRecommendation } from '../../engine/recommend';
import { currentResumeFacets } from '../../engine/resume';
import { filterPeople, lastTouch, rankPeople } from '../../engine/search';
import {
  checkSendAllowed,
  draftEnvelope,
  googleSendActive,
  handoffLink,
  isConnectionNote,
  reviewDraft,
} from '../../engine/send';
import {
  draftLists,
  notYetWritten,
  SUGGESTION_KIND_LABELS,
  startedDrafts,
  todayCards,
  todaySummaryText,
  weekStats,
} from '../../engine/today';
import { villageAvailable, villageOffered, type WarmIntro, warmIntrosFor } from '../../engine/warmIntros';
import { hasLlm, MODEL } from '../../integrations/anthropic';
import { currentGoogleToken, googleClientId } from '../../integrations/google';
import {
  DEFAULT_DAILY_REQUEST_CAP,
  DEFAULT_DAILY_TOKEN_CAP,
  llmFeatures,
  readPrefs,
  todaysLlmUsage,
} from '../../integrations/prefs';
import { sharedClaudeAvailable } from '../../integrations/shared-claude';
import { z } from '../../zod';
import type { ToolContext } from '../types';
import {
  type AnyTool,
  autoOpen,
  cardRef,
  chatRef,
  clip,
  defineTool,
  draftRef,
  fmtDay,
  fmtWhen,
  ok,
  peopleById,
  personRef,
  plural,
  requireDraft,
  requirePerson,
  requireSuggestion,
  toModel,
  wrapped,
} from './_shared';

const STAGES = STAGE_ORDER as [CoffeeChat['stage'], ...CoffeeChat['stage'][]];
const DAY = 86_400_000;

async function userRows<T>(
  table: { where: (k: string) => { equals: (v: string) => { toArray: () => Promise<T[]> } } },
  userId: string,
): Promise<T[]> {
  return table.where('userId').equals(userId).toArray();
}

// ---------- get_today_brief ----------

async function cardDetail(ctx: ToolContext, s: Suggestion, people: Map<string, Person>) {
  const person = s.personId ? people.get(s.personId) : undefined;
  const base = {
    ...cardRef(s, person),
    kindLabel: SUGGESTION_KIND_LABELS[s.kind].label,
    deferred: !!s.deferred,
    snoozedUntil: s.snoozedUntil,
  };
  const extra: Record<string, unknown> = {};
  if (s.kind === 'confirm_stage') {
    const ev =
      typeof s.payload.stageEventId === 'string'
        ? await db.stageEvents.get(s.payload.stageEventId)
        : undefined;
    extra.toStage = s.payload.toStage;
    extra.toStageLabel =
      typeof s.payload.toStage === 'string'
        ? STAGE_LABELS[s.payload.toStage as CoffeeChat['stage']]
        : undefined;
    if (ev?.evidenceRefTable === 'messages' && ev.evidenceRefId) {
      const m = await db.messages.get(ev.evidenceRefId);
      if (m) extra.evidence = wrapped(ctx, 'email', m.bodyText, 600);
    }
  }
  if (s.kind === 'confirm_intro' && typeof s.payload.messageId === 'string') {
    const m = await db.messages.get(s.payload.messageId);
    if (m) extra.evidence = wrapped(ctx, 'email', m.bodyText, 600);
    extra.threadId = s.payload.threadId;
    const intro = typeof s.payload.introducerId === 'string' ? people.get(s.payload.introducerId) : undefined;
    extra.introducer = intro?.displayName;
  }
  if (s.kind === 'confirm_merge') {
    extra.mergeId = s.payload.mergeId;
    const other =
      typeof s.payload.otherPersonId === 'string' ? people.get(s.payload.otherPersonId) : undefined;
    extra.otherPerson = other ? personRef(other) : undefined;
  }
  if (s.kind === 'warm_up_engage' && s.chatId) {
    const chat = await db.chats.get(s.chatId);
    const action = chat?.warmUp?.actions.find((a) => a.id === s.payload.actionId);
    if (action)
      extra.warmUpStep = {
        actionId: action.id,
        kind: action.kind,
        label: action.label,
        url: action.url,
        dueAt: action.dueAt,
      };
  }
  if (s.kind === 'action_item_reminder' && typeof s.payload.actionItemId === 'string') {
    const item = await db.actionItems.get(s.payload.actionItemId);
    if (item)
      extra.promise = {
        actionItemId: item.id,
        text: wrapped(ctx, 'promise', item.text, 200),
        dueAt: item.dueAt,
      };
  }
  if (s.kind === 'confirm_note_match') extra.noteId = s.payload.noteId;
  return { ...base, ...extra };
}

export const getTodayBrief = defineTool({
  name: 'get_today_brief',
  kind: 'read',
  description:
    "Call this when the student asks what is on their plate, what they should do today, who is waiting on them, how their week is going, or opens the chat with no question. Returns today's cards (with ids for the other tools), the cards that can wait, chats coming up this week, chats that went quiet, messages opened but not confirmed sent, drafts they started, people they added but never wrote to, this week's numbers and any integration problem. Pass cardId to read one card in detail (its evidence email, the merge candidates, the warm-up step).",
  input: z.object({
    cardId: z
      .string()
      .optional()
      .describe(
        'Read one card in detail instead of the whole brief (a suggestion id from a previous result).',
      ),
  }),
  capabilities: [
    'badge_pending_count',
    'daily_maintenance_auto',
    'card_review_draft',
    'card_warmup_open_linkedin',
    'today_write_to_added_person',
    'today_continue_draft',
    'today_open_prep',
    'pipeline_next_chip',
    'integration_fix_link',
    'card_note_match_pick',
    'demo_banner_keep_exploring',
    'demo_back_to_demo',
  ],
  progress: 'Looking at your day',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const now = ctx.now;
    const [suggestions, briefs, events, people, outbound, chats, settings, integrations] = await Promise.all([
      userRows<Suggestion>(db.suggestions, userId),
      db.briefs.where('userId').equals(userId).toArray(),
      userRows<CalendarEvent>(db.events, userId),
      userRows<Person>(db.people, userId),
      userRows<OutboundMessage>(db.outbound, userId),
      userRows<CoffeeChat>(db.chats, userId),
      db.settings.get(userId),
      db.integrations.where('userId').equals(userId).toArray(),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    if (input.cardId) {
      const s = await requireSuggestion(ctx, input.cardId);
      const detail = await cardDetail(ctx, s, byId);
      const draft = s.outboundMessageId ? await db.outbound.get(s.outboundMessageId) : undefined;
      const ui = { card: detail, draft };
      const model = {
        card: detail,
        draft: draft
          ? {
              ...draftRef(draft, s.personId ? byId.get(s.personId) : undefined),
              body: draft.bodyFinal ?? draft.bodyDraft,
            }
          : undefined,
      };
      return ok(
        'suggestion',
        ui,
        model,
        `${detail.kindLabel}${detail.person ? ` for ${detail.person}` : ''}: ${detail.reason}`,
        detail.href,
      );
    }
    const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
    const live = suggestions.filter(
      (s) =>
        s.status === 'pending' ||
        (s.status === 'snoozed' && !!s.snoozedUntil && new Date(s.snoozedUntil) <= now),
    );
    const { cards, more } = todayCards(live, latest, now);
    const upcoming = events
      .filter(
        (e) =>
          e.status !== 'cancelled' &&
          new Date(e.startAt).getTime() > now.getTime() - 3_600_000 &&
          new Date(e.startAt).getTime() - now.getTime() < 7 * DAY &&
          e.attendeePersonIds.length > 0,
      )
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const visiblePeople = people.filter((p) => p.isHuman && !p.hiddenAt).length;
    const summary = latest
      ? todaySummaryText(cards, events, visiblePeople, now)
      : 'Your first brief will appear here.';
    const onToday = new Set([...cards, ...more].map((x) => x.chatId).filter(Boolean));
    const quiet = chats
      .filter(
        (c) =>
          wentQuiet(c, now) && !onToday.has(c.id) && byId.get(c.personId) && !byId.get(c.personId)!.hiddenAt,
      )
      .sort((a, b) => (a.lastOutboundAt ?? '').localeCompare(b.lastOutboundAt ?? ''));
    const shownDrafts = new Set([...cards, ...more].map((x) => x.outboundMessageId));
    const handedOff = outbound.filter((o) => o.status === 'handed_off' && !shownDrafts.has(o.id));
    const started = startedDrafts(outbound).filter((o) => !byId.get(o.personId)?.hiddenAt);
    const toWrite = notYetWritten(people, chats, outbound, suggestions, now).slice(0, 3);
    const warming = chats
      .filter((c) => c.stage === 'warming' && c.warmUp && !byId.get(c.personId)?.hiddenAt)
      .map((c) => {
        const prog = warmUpProgress(c.warmUp!, now, ctx.user.timezone);
        const next = prog.ready ? undefined : c.warmUp!.actions.find((a) => !a.doneAt && !a.skippedAt);
        return {
          chatId: c.id,
          person: byId.get(c.personId)?.displayName,
          personId: c.personId,
          done: prog.done,
          total: prog.total,
          ready: prog.ready,
          readyFrom: fmtDay(prog.readyFrom, ctx),
          nextStep: next
            ? { actionId: next.id, label: next.label, url: next.url, dueAt: fmtDay(next.dueAt, ctx) }
            : undefined,
        };
      });
    const week = weekStats(outbound, chats, people, settings?.weeklyOutreachTarget ?? 4, now);
    const problems = integrations
      .filter((i) => i.status === 'needs_reauth' || i.status === 'error')
      .map((i) => ({ provider: i.provider, error: i.lastError, href: '/settings/integrations' }));
    const { forToday } = draftLists(suggestions, outbound, latest, now);
    const badge = forToday.length + started.length + outbound.filter((o) => o.status === 'handed_off').length;
    const cardsOut = await Promise.all(cards.map((s) => cardDetail(ctx, s, byId)));
    const moreOut = more.map((s) => ({
      ...cardRef(s, s.personId ? byId.get(s.personId) : undefined),
      kindLabel: SUGGESTION_KIND_LABELS[s.kind].label,
    }));
    const ui = {
      summary,
      briefDate: latest?.briefDate,
      cards: cardsOut,
      more: moreOut,
      upcoming,
      // the brief card's "Coming up" line: the next chat and who it is with
      nextUp: upcoming[0]
        ? {
            startAt: upcoming[0].startAt,
            title: upcoming[0].title,
            person: byId.get(upcoming[0].attendeePersonIds[0]!)?.displayName,
          }
        : undefined,
      quiet,
      handedOff,
      started,
      toWrite,
      warming,
      week,
      problems,
      badge,
      isDemo: ctx.user.id === DEMO_USER_ID,
    };
    const model = {
      summary,
      briefDate: latest?.briefDate,
      cards: cardsOut,
      canWait: moreOut,
      comingUp: upcoming.slice(0, 8).map((e) => ({
        when: fmtWhen(e.startAt, ctx),
        title: e.title,
        people: e.attendeePersonIds.map((id) => byId.get(id)?.displayName).filter(Boolean),
        personIds: e.attendeePersonIds,
      })),
      waitingOnReply: quiet.slice(0, 6).map((c) => ({
        chatId: c.id,
        personId: c.personId,
        person: byId.get(c.personId)?.displayName,
        stage: STAGE_LABELS[c.stage],
        youWroteOn: fmtDay(c.lastOutboundAt, ctx),
      })),
      openedNotMarkedSent: handedOff.map((o) => draftRef(o, byId.get(o.personId))),
      draftsYouStarted: started.slice(0, 5).map((o) => draftRef(o, byId.get(o.personId))),
      peopleToWriteTo: toWrite.map((p) => personRef(p)),
      warmUps: warming,
      thisWeek: week,
      problems,
      draftsBadge: badge,
      isDemo: ui.isDemo,
    };
    return ok('brief', ui, model, summary, '/inbox');
  },
  toModel,
});

// ---------- list_pipeline ----------

export const listPipeline = defineTool({
  name: 'list_pipeline',
  kind: 'read',
  description:
    'Call this when the student asks where a chat stands, who is in a stage, which chats went quiet, how many people at a company are in the pipeline, or wants the board, table or companies view. Returns the chats with their person, stage, time in stage, next card and booked time. Filter by stage, company, target companies or quiet chats; closed stages (declined, no response, archived) only with includeClosed.',
  input: z.object({
    stage: z.enum(STAGES).optional().describe('Only chats in this stage.'),
    query: z.string().optional().describe('Only chats whose person name or company contains this text.'),
    targetsOnly: z.boolean().optional().describe('Only people at target companies.'),
    quietOnly: z
      .boolean()
      .optional()
      .describe("Only chats waiting a week or more for a reply to the student's last message."),
    includeClosed: z
      .boolean()
      .optional()
      .describe('Include declined, no response and archived chats (left out by default).'),
    view: z
      .enum(['board', 'table', 'companies'])
      .optional()
      .describe(
        'How to group the answer: by stage (board), as a flat sorted list (table), or by company (companies).',
      ),
    sortBy: z
      .enum(['stage', 'person', 'inStage', 'lastSent', 'lastReply', 'closeness'])
      .optional()
      .describe('Table order.'),
    limit: z.number().int().min(1).max(100).optional().describe('At most this many chats (default 40).'),
  }),
  capabilities: ['pipeline_view_switch', 'pipeline_filter', 'pipeline_sort', 'pipeline_open_company'],
  progress: 'Looking at your pipeline',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const [chats, people, suggestions, targets, events] = await Promise.all([
      userRows<CoffeeChat>(db.chats, userId),
      userRows<Person>(db.people, userId),
      userRows<Suggestion>(db.suggestions, userId),
      db.targetCompanies.where('userId').equals(userId).toArray(),
      userRows<CalendarEvent>(db.events, userId),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const targetNames = new Set(targets.map((t) => normalizeCompany(t.nameRaw)));
    const q = input.query?.trim().toLowerCase();
    const closed = new Set(CLOSED_STAGES);
    let rows = chats
      .map((chat) => ({ chat, person: byId.get(chat.personId) }))
      .filter(
        (r): r is { chat: CoffeeChat; person: Person } =>
          !!r.person && r.person.isHuman && !r.person.hiddenAt,
      )
      .filter((r) => (input.includeClosed || input.stage ? true : !closed.has(r.chat.stage)))
      .filter((r) => !input.stage || r.chat.stage === input.stage)
      .filter(
        (r) =>
          !q ||
          r.person.displayName.toLowerCase().includes(q) ||
          (r.person.currentOrganizationRaw ?? '').toLowerCase().includes(q),
      )
      .filter((r) => !input.targetsOnly || targetNames.has(normalizeCompany(r.person.currentOrganizationRaw)))
      .filter((r) => !input.quietOnly || wentQuiet(r.chat, ctx.now));
    const order = new Map(STAGE_ORDER.map((s, i) => [s, i]));
    const key = input.sortBy ?? 'stage';
    rows = rows.sort((a, b) => {
      switch (key) {
        case 'person':
          return a.person.displayName.localeCompare(b.person.displayName);
        case 'inStage':
          return a.chat.stageEnteredAt.localeCompare(b.chat.stageEnteredAt);
        case 'lastSent':
          return (b.chat.lastOutboundAt ?? '').localeCompare(a.chat.lastOutboundAt ?? '');
        case 'lastReply':
          return (b.chat.lastInboundAt ?? '').localeCompare(a.chat.lastInboundAt ?? '');
        case 'closeness':
          return b.person.strength - a.person.strength;
        default:
          return (
            (order.get(a.chat.stage) ?? 99) - (order.get(b.chat.stage) ?? 99) ||
            b.chat.updatedAt.localeCompare(a.chat.updatedAt)
          );
      }
    });
    const total = rows.length;
    rows = rows.slice(0, input.limit ?? 40);
    const meetingFor = (c: CoffeeChat) =>
      events
        .filter(
          (e) =>
            e.status !== 'cancelled' &&
            (e.chatId === c.id || e.attendeePersonIds.includes(c.personId)) &&
            new Date(e.endAt) > ctx.now,
        )
        .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    const list = rows.map(({ chat, person }) => {
      const next = suggestions.find(
        (s) => s.status === 'pending' && (s.chatId === chat.id || (s.personId === person.id && !s.chatId)),
      );
      const meeting = chat.stage === 'scheduled' ? meetingFor(chat) : undefined;
      return {
        ...chatRef(chat),
        person: person.displayName,
        title: person.currentTitle,
        company: person.currentOrganizationRaw,
        isTarget: targetNames.has(normalizeCompany(person.currentOrganizationRaw)),
        daysInStage: Math.max(
          0,
          Math.round((ctx.now.getTime() - new Date(chat.stageEnteredAt).getTime()) / DAY),
        ),
        quiet: wentQuiet(chat, ctx.now),
        youWroteOn: fmtDay(chat.lastOutboundAt, ctx),
        theyWroteOn: fmtDay(chat.lastInboundAt, ctx),
        meetingAt: meeting
          ? fmtWhen(meeting.startAt, ctx)
          : chat.stage === 'scheduled'
            ? 'time not set'
            : undefined,
        warmUp: chat.warmUp
          ? `${chat.warmUp.actions.filter((a) => a.doneAt).length} of ${chat.warmUp.actions.length} steps`
          : undefined,
        nextCard: next
          ? { id: next.id, kind: SUGGESTION_KIND_LABELS[next.kind].label, href: `/inbox?card=${next.id}` }
          : undefined,
        href: `/people/${person.id}`,
      };
    });
    const counts: Record<string, number> = {};
    for (const c of chats)
      if (byId.get(c.personId) && !byId.get(c.personId)!.hiddenAt)
        counts[c.stage] = (counts[c.stage] ?? 0) + 1;
    const byCompany =
      input.view === 'companies'
        ? Object.values(
            list.reduce<Record<string, { company: string; isTarget: boolean; chats: typeof list }>>(
              (acc, r) => {
                const k = normalizeCompany(r.company) || 'other';
                acc[k] ??= { company: r.company ?? 'No company', isTarget: r.isTarget, chats: [] };
                acc[k].chats.push(r);
                return acc;
              },
              {},
            ),
          )
        : undefined;
    const view = input.view ?? 'board';
    // the People page: its board, or its list for the table (companies has its own view there too)
    const href = `/people?view=${view === 'table' ? 'list' : view}${input.quietOnly ? '&quiet=1' : ''}`;
    const summary = total
      ? `${plural(total, 'chat')} in your pipeline${input.stage ? ` in ${STAGE_LABELS[input.stage]}` : ''}${input.quietOnly ? ' went quiet' : ''}${total > list.length ? `, showing ${list.length}` : ''}.`
      : 'No chats match that in your pipeline.';
    const ui = { rows: list, counts, byCompany, view, total };
    const model = {
      total,
      counts: Object.fromEntries(
        Object.entries(counts).map(([k, v]) => [STAGE_LABELS[k as CoffeeChat['stage']], v]),
      ),
      activeStages: ACTIVE_STAGES.map((s) => STAGE_LABELS[s]),
      chats: byCompany ?? list,
    };
    return ok('pipeline', ui, model, summary, href);
  },
  toModel,
});

// ---------- search_people ----------

export const searchPeople = defineTool({
  name: 'search_people',
  kind: 'read',
  description:
    'Call this first whenever the student names a person, so you have their id for the other tools, and when they ask who they know at a company, who their closest ties are, their alumni, people with a chat, people at target companies, or hidden people. Returns ranked matches (exact name first, then prefix, then company or title). If several people match a name, ask the student which one before writing anything.',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('A name, first name, company or title. Empty lists the closest people.'),
    filter: z
      .enum(['all', 'alumni', 'strong', 'chats', 'targets', 'hidden'])
      .optional()
      .describe(
        "Everyone, alumni of the student's school, close ties (closeness at least 0.6), people with a chat, people at target companies, or hidden people.",
      ),
    sort: z
      .enum(['strength', 'recent', 'name'])
      .optional()
      .describe('By closeness (default), most recent touch, or name.'),
    limit: z.number().int().min(1).max(50).optional().describe('At most this many people (default 8).'),
  }),
  capabilities: ['palette_search', 'nav_go', 'map_select_person'],
  progress: 'Searching your people',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const [people, chats, targets] = await Promise.all([
      userRows<Person>(db.people, userId),
      userRows<CoffeeChat>(db.chats, userId),
      db.targetCompanies.where('userId').equals(userId).toArray(),
    ]);
    const limit = input.limit ?? 8;
    const activeChat = new Map(chats.filter((c) => c.stage !== 'archived').map((c) => [c.personId, c]));
    const filter = input.filter ?? 'all';
    const list =
      filter === 'all' && !input.sort
        ? rankPeople(people, input.query ?? '', limit)
        : filterPeople(people, {
            query: input.query,
            filter,
            sort: input.sort,
            activeChat: new Set(activeChat.keys()),
            targetNames: new Set(targets.map((t) => t.nameRaw.toLowerCase())),
          }).slice(0, limit);
    const rows = list.map((p) => {
      const chat = activeChat.get(p.id);
      return {
        ...personRef(p),
        relationship: p.relationshipType === 'unknown' ? undefined : RELATIONSHIP_LABELS[p.relationshipType],
        alum: !!p.isAlumni,
        closeness: Math.round(p.strength * 100) / 100,
        lastTouch: fmtDay(lastTouch(p), ctx),
        stage: chat ? STAGE_LABELS[chat.stage] : undefined,
        chatId: chat?.id,
        hidden: !!p.hiddenAt,
      };
    });
    const q = input.query?.trim();
    const summary = rows.length
      ? `${plural(rows.length, 'person', 'people')} match${rows.length === 1 ? 'es' : ''}${q ? ` "${q}"` : ''}${rows.length > 1 && q ? '. Check which one is meant before acting.' : '.'}`
      : q
        ? `Nobody named or at "${q}" is in Orbit yet.`
        : 'Nobody is in Orbit yet.';
    return ok(
      'people',
      { people: rows, query: q, filter },
      { people: rows, ambiguous: rows.length > 1 },
      summary,
      '/people?view=list',
    );
  },
  toModel,
});

// ---------- get_person ----------

const PERSON_SECTIONS = ['facts', 'timeline', 'prep', 'drafts', 'connections', 'notes', 'promises'] as const;

export const getPerson = defineTool({
  name: 'get_person',
  kind: 'read',
  description:
    'Call this when the student asks about one person: who they are, what Orbit knows about them, when they last talked, their chat stage and booked time, their drafts, who they know, their warm-up, their promises, or prep for a chat with them (goal, ask, questions, logistics, a 30 second intro). Needs a personId from search_people. Choose the sections you need; facts and prep are the most useful for writing.',
  input: z.object({
    personId: z.string().describe('The person id (from search_people).'),
    include: z
      .array(z.enum(PERSON_SECTIONS))
      .optional()
      .describe(
        'Sections to include: facts, timeline, prep, drafts, connections (who they know), notes, promises. Default: facts and drafts.',
      ),
  }),
  capabilities: [
    'person_prep_view',
    'person_open_linkedin',
    'person_email_link',
    'person_continue_draft',
    'map_hover',
  ],
  progress: 'Reading their page',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    const want = new Set(input.include ?? ['facts', 'drafts']);
    const [chats, facts, tps, items, drafts, events, notes, waiting] = await Promise.all([
      db.chats.where('personId').equals(person.id).toArray(),
      db.facts
        .where('personId')
        .equals(person.id)
        .filter((f) => !f.deletedAt)
        .toArray(),
      db.touchpoints.where('personId').equals(person.id).toArray(),
      db.actionItems.where('personId').equals(person.id).toArray(),
      db.outbound.where('personId').equals(person.id).toArray(),
      db.events
        .where('userId')
        .equals(ctx.user.id)
        .filter((e) => e.attendeePersonIds.includes(person.id) && e.status !== 'cancelled')
        .toArray(),
      db.notes
        .where('userId')
        .equals(ctx.user.id)
        .filter((n) => n.personIds.includes(person.id))
        .toArray(),
      db.suggestions
        .where('personId')
        .equals(person.id)
        .filter((s) => s.status === 'pending')
        .toArray(),
    ]);
    const chat = chats.find((c) => c.stage !== 'archived') ?? chats[0];
    const nextEvent = events
      .filter((e) => new Date(e.endAt) > ctx.now)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    const live = person.summary
      ? undefined
      : personSummary({ user: ctx.user, person, facts, touchpoints: tps, now: ctx.now });
    const header = {
      ...personRef(person),
      headline: person.headline,
      location: person.location,
      school: person.school,
      alum: !!person.isAlumni,
      email: person.primaryEmailAsWritten ?? person.primaryEmail,
      mailto: person.primaryEmail ? `mailto:${person.primaryEmail}` : undefined,
      linkedinUrl: person.linkedinUrl,
      relationship: RELATIONSHIP_LABELS[person.relationshipType],
      closeness: Math.round(person.strength * 100) / 100,
      lastTouch: fmtDay(lastTouch(person), ctx),
      hidden: !!person.hiddenAt,
      tags: person.tags,
      stage: chat ? STAGE_LABELS[chat.stage] : undefined,
      chat: chat ? chatRef(chat) : undefined,
      nextMeeting: nextEvent
        ? fmtWhen(nextEvent.startAt, ctx)
        : chat?.stage === 'scheduled'
          ? 'booked, time not set'
          : undefined,
      summary: wrapped(ctx, 'summary', person.summary ?? live?.summary, 600),
      talkingPoints: (person.summary ? person.talkingPoints : live?.talkingPoints)?.map((t) =>
        wrapped(ctx, 'talking_point', t, 200),
      ),
      warmUp: chat?.warmUp
        ? {
            chatId: chat.id,
            readyAt: fmtDay(chat.warmUp.readyAt, ctx),
            steps: chat.warmUp.actions.map((a) => ({
              actionId: a.id,
              kind: a.kind,
              label: a.label,
              url: a.url,
              dueAt: fmtDay(a.dueAt, ctx),
              done: !!a.doneAt,
              skipped: !!a.skippedAt,
            })),
          }
        : undefined,
      cards: waiting.map((s) => ({ ...cardRef(s, person), kindLabel: SUGGESTION_KIND_LABELS[s.kind].label })),
    };
    const out: Record<string, unknown> = { ...header };
    if (want.has('facts')) {
      const conflicts = conflictingFacts(facts);
      out.facts = facts.map((f) => ({
        id: f.id,
        type: f.type,
        typeLabel: FACT_TYPE_LABELS[f.type],
        text: wrapped(ctx, 'fact', f.text, 300),
        source: f.sourceTable,
        when: fmtDay(f.occurredAt, ctx),
        conflictsWith: conflicts.get(f.id) ? wrapped(ctx, 'fact', conflicts.get(f.id), 200) : undefined,
      }));
    }
    if (want.has('timeline')) {
      const tl = [
        ...tps.map((t) => ({
          at: t.occurredAt,
          kind: t.kind,
          text: wrapped(ctx, 'touchpoint', t.summary ?? TOUCHPOINT_LABELS[t.kind], 200),
        })),
        ...drafts
          .filter(
            (d) => d.status === 'sent' && !tps.some((t) => t.refTable === 'outbound' && t.refId === d.id),
          )
          .map((d) => ({ at: d.sentAt!, kind: 'sent', text: `${MESSAGE_KIND_LABELS[d.kind]} sent` })),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 30)
        .map((t) => ({ ...t, when: fmtWhen(t.at, ctx) }));
      out.timeline = tl;
    }
    if (want.has('drafts'))
      out.drafts = drafts
        .filter((d) => d.status !== 'cancelled')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
        .map((d) => draftRef(d, person));
    if (want.has('promises'))
      out.promises = items
        .filter((i) => i.status === 'open')
        .map((i) => ({
          actionItemId: i.id,
          text: wrapped(ctx, 'promise', promiseText(i.text, person.firstName), 200),
          dueAt: fmtDay(i.dueAt, ctx),
        }));
    if (want.has('notes'))
      out.notes = notes
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, 5)
        .map((n) => ({
          noteId: n.id,
          when: fmtDay(n.occurredAt, ctx),
          source: n.source,
          summary: wrapped(ctx, 'note', n.summary ?? n.rawText, 500),
        }));
    if (want.has('connections')) {
      const edges = await db.edges
        .where('personAId')
        .equals(person.id)
        .or('personBId')
        .equals(person.id)
        .toArray();
      const ids = edges.map((e) => (e.personAId === person.id ? e.personBId : e.personAId));
      const others = await peopleById(ids);
      out.connections = edges
        .map((e) => ({ edge: e, other: others.get(e.personAId === person.id ? e.personBId : e.personAId) }))
        .filter((x) => x.other && !x.other.hiddenAt)
        .sort((a, b) => b.edge.weight - a.edge.weight)
        .slice(0, 15)
        .map((x) => ({
          ...personRef(x.other!),
          tie: Math.round(x.edge.weight * 100) / 100,
          how: wrapped(ctx, 'edge', x.edge.evidence.text, 160),
        }));
    }
    if (want.has('prep')) {
      const goals = await db.goals.get(ctx.user.id);
      const plan = buildPrep({
        user: ctx.user,
        goals: goals ?? undefined,
        person,
        facts,
        chats,
        event: nextEvent,
        resumeFacets: await currentResumeFacets(ctx.user.id),
        now: ctx.now,
      });
      out.prep = {
        ...plan,
        picked: chat?.prepQuestions ?? [],
        chatId: chat?.id,
        canPick: !!chat,
        suggestedNamesWelcome: !!(
          chat?.completedAt || ['completed', 'followed_up', 'nurturing'].includes(chat?.stage ?? '')
        ),
      };
    }
    const next = await nextMessageKind(ctx.user, person.id, ctx.now);
    out.nextMessage =
      'kind' in next ? { kind: next.kind, label: MESSAGE_KIND_LABELS[next.kind] } : { wait: next.wait };
    const summary = `${person.displayName}${person.currentTitle ? `, ${person.currentTitle}` : ''}${person.currentOrganizationRaw ? ` at ${person.currentOrganizationRaw}` : ''}. ${chat ? `Chat stage: ${STAGE_LABELS[chat.stage]}.` : 'No chat yet.'} ${plural(facts.length, 'fact')} on record.`;
    return ok(
      'person',
      { ...out, person, chat, facts, drafts, events },
      out,
      summary,
      `/people/${person.id}`,
    );
  },
  toModel,
});

// ---------- list_drafts / get_draft ----------

const DRAFT_LISTS = ['to_send', 'can_wait', 'started', 'opened', 'snoozed', 'sent', 'all'] as const;

export const listDrafts = defineTool({
  name: 'list_drafts',
  kind: 'read',
  description:
    'Call this when the student asks what drafts they have to send, what is waiting on an "I sent it", what is snoozed, what they sent, or for the drafts of one person. Returns compact draft references with ids for get_draft, update_draft_body and send_draft. to_send is what is worth sending today, can_wait the rest, started the drafts the student began themselves, opened the messages handed to the mail app or LinkedIn and not yet confirmed sent (plus failed sends), snoozed the snoozed cards, sent the sent messages.',
  input: z.object({
    list: z.enum(DRAFT_LISTS).optional().describe('Which list (default to_send plus started).'),
    personId: z.string().optional().describe('Only drafts to this person.'),
    limit: z.number().int().min(1).max(50).optional().describe('At most this many (default 20).'),
  }),
  capabilities: ['drafts_read_lists', 'badge_pending_count', 'draft_unsnooze'],
  progress: 'Looking at your drafts',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const [suggestions, outbound, briefs, people] = await Promise.all([
      userRows<Suggestion>(db.suggestions, userId),
      userRows<OutboundMessage>(db.outbound, userId),
      db.briefs.where('userId').equals(userId).toArray(),
      userRows<Person>(db.people, userId),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
    const { forToday, later } = draftLists(suggestions, outbound, latest, ctx.now);
    const started = startedDrafts(outbound);
    const inFlight = outbound
      .filter((o) => ['queued', 'sending', 'handed_off', 'failed'].includes(o.status))
      .sort((a, b) => (b.queuedAt ?? b.createdAt).localeCompare(a.queuedAt ?? a.createdAt));
    const snoozed = suggestions
      .filter((s) => s.status === 'snoozed')
      .sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
    const sent = outbound
      .filter((o) => o.status === 'sent')
      .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
    const limit = input.limit ?? 20;
    const pid = input.personId;
    const byPerson = <T extends { personId?: string }>(xs: T[]) =>
      pid ? xs.filter((x) => x.personId === pid) : xs;
    const cardRow = (s: Suggestion) => {
      const d = s.outboundMessageId ? outbound.find((o) => o.id === s.outboundMessageId) : undefined;
      return {
        card: {
          ...cardRef(s, s.personId ? byId.get(s.personId) : undefined),
          kindLabel: SUGGESTION_KIND_LABELS[s.kind].label,
          snoozedUntil: fmtDay(s.snoozedUntil, ctx),
        },
        draft: d ? draftRef(d, byId.get(d.personId)) : undefined,
      };
    };
    const draftRow = (o: OutboundMessage) => ({
      ...draftRef(o, byId.get(o.personId)),
      sentAt: fmtWhen(o.sentAt, ctx),
      handoffVia: o.handoffVia,
      error: o.error,
      startedAt: fmtDay(o.createdAt, ctx),
    });
    const list = input.list ?? 'to_send';
    const sections: Record<string, unknown[]> = {};
    if (list === 'to_send' || list === 'all') {
      sections.toSend = byPerson(forToday).slice(0, limit).map(cardRow);
      sections.started = byPerson(started).slice(0, limit).map(draftRow);
    }
    if (list === 'can_wait' || list === 'all')
      sections.canWait = byPerson(later).slice(0, limit).map(cardRow);
    if (list === 'started') sections.started = byPerson(started).slice(0, limit).map(draftRow);
    if (list === 'opened' || list === 'all')
      sections.opened = byPerson(inFlight).slice(0, limit).map(draftRow);
    if (list === 'snoozed' || list === 'all')
      sections.snoozed = byPerson(snoozed).slice(0, limit).map(cardRow);
    if (list === 'sent' || list === 'all') sections.sent = byPerson(sent).slice(0, limit).map(draftRow);
    const counts = {
      toSend: forToday.length,
      canWait: later.length,
      started: started.length,
      opened: inFlight.length,
      snoozed: snoozed.length,
      sent: sent.length,
      badge: forToday.length + started.length + outbound.filter((o) => o.status === 'handed_off').length,
    };
    const parts = Object.entries(sections).map(
      ([k, v]) => `${v.length} ${k === 'toSend' ? 'to send' : k === 'canWait' ? 'that can wait' : k}`,
    );
    const summary = parts.length ? `Drafts: ${parts.join(', ')}.` : 'No drafts in that list.';
    return ok('drafts', { ...sections, counts }, { ...sections, counts }, summary, '/inbox');
  },
  toModel,
});

export const getDraft = defineTool({
  name: 'get_draft',
  kind: 'read',
  description:
    'Call this when the student wants to read a draft, asks what a message says, wants the subject or the text to copy, asks whether it goes as a reply or a new email, why it cannot be sent, what the draft check flags, or where a handed-off message opens again. Returns the full text, the envelope, the review issues, the send rule verdict, the needs-input prompts and the hand-off link.',
  input: z.object({
    draftId: z.string().describe('The draft id (from list_drafts, get_person or a card).'),
  }),
  capabilities: [
    'card_review_draft',
    'draft_open_again',
    'draft_copy_again',
    'draft_copy_subject',
    'draft_read_envelope',
    'draft_read_review_issues',
    'draft_read_send_rules',
    'draft_attach_resume_ack',
  ],
  progress: 'Reading the draft',
  async execute(input, ctx) {
    const draft = await requireDraft(ctx, input.draftId);
    const person = await db.people.get(draft.personId);
    const body = draft.bodyFinal ?? draft.bodyDraft;
    const [env, issues, allowed, chats, direct, link] = await Promise.all([
      draftEnvelope(draft),
      reviewDraft(ctx.user, draft, body, draft.subject),
      checkSendAllowed(ctx.user.id, draft.personId, draft.channel, draft.kind, ctx.now, {
        chatId: draft.chatId,
        excludeMessageId: draft.id,
      }),
      db.chats.where('personId').equals(draft.personId).toArray(),
      googleSendActive(ctx.user.id),
      handoffLink(ctx.user, draft.id),
    ]);
    const connectionNote = isConnectionNote(draft, person, chats);
    const card = draft.suggestionId ? await db.suggestions.get(draft.suggestionId) : undefined;
    const detail = {
      ...draftRef(draft, person),
      body,
      suggestedBody: draft.bodyFinal ? draft.bodyDraft : undefined,
      words: wordsIn(body),
      maxWords: MAX_WORDS[draft.kind],
      chars: body.length,
      linkedinConnectionNote: connectionNote,
      to: draft.toEmail,
      bcc: draft.bccEmails,
      envelope: env.threaded
        ? `Goes as a reply in your email thread${env.subject ? ` (${env.subject})` : ''}.`
        : draft.channel === 'gmail'
          ? `Opens as a new email${env.subject ? ` with the subject "${env.subject}"` : ', subject still needed'}.`
          : connectionNote
            ? 'Goes as a LinkedIn connection note (300 characters at most).'
            : 'Goes as a LinkedIn message.',
      threaded: env.threaded,
      sendsDirectly: draft.channel === 'gmail' && direct,
      howItSends:
        draft.channel === 'gmail'
          ? direct
            ? 'Gmail sends it after a 60 second undo window.'
            : 'Opens in the mail app; the student confirms with I sent it.'
          : 'Copied and opened on LinkedIn; the student confirms with I sent it.',
      issues: issues.map((i) => ({ code: i.code, text: i.text, blocking: i.blocking })),
      sendAllowed: allowed.allowed,
      sendBlockedBecause: allowed.reason,
      needsInput: draft.needsInput,
      mentionsAttachment: draft.needsInput?.includes('resume') ?? false,
      holdUntil: fmtDay(draft.holdUntil, ctx),
      generatedBy: draft.generatedBy,
      card: card ? { id: card.id, kind: card.kind, reason: card.reasonText } : undefined,
      handoffUrl: link?.url,
      handoffVia: link?.via ?? draft.handoffVia,
      error: draft.error,
    };
    const who = person?.displayName ?? 'them';
    const summary = `${MESSAGE_KIND_LABELS[draft.kind]} to ${who}, ${detail.status}${detail.needsInput?.length ? `, still needs ${detail.needsInput.join(', ')}` : ''}${!allowed.allowed ? `. Sending is blocked: ${allowed.reason}` : ''}.`;
    return ok('draft', { ...detail, draft, person }, detail, summary, `/inbox?draft=${draft.id}`);
  },
  toModel,
});

// ---------- find_routes ----------

function pathView(
  path: {
    hops: { fromId: string; toId: string; weight: number; type: string; text: string }[];
    score: number;
    band: 'strong' | 'possible' | 'long_shot';
  },
  people: Map<string, Person>,
  ctx: ToolContext,
) {
  return {
    band: path.band,
    bandLabel: REACH_BAND_LABELS[path.band],
    score: Math.round(path.score * 100) / 100,
    cold: isColdDirect(path as never),
    hops: path.hops.map((h) => ({
      from: h.fromId === 'user' ? 'you' : people.get(h.fromId)?.displayName,
      to: people.get(h.toId)?.displayName,
      toId: h.toId,
      tie: Math.round(h.weight * 100) / 100,
      how: wrapped(ctx, 'edge', h.text, 160),
    })),
    firstHopId: path.hops[0]?.toId,
    firstHop: path.hops[0] ? people.get(path.hops[0].toId)?.displayName : undefined,
  };
}

/** One sentence on the warm intros found, naming the warmest: empty when there are none. */
function warmIntroLine(intros: WarmIntro[]): string {
  const best = intros[0];
  if (!best) return '';
  return ` ${intros.length === 1 ? 'One warm intro' : `${plural(intros.length, 'warm intro')}`} too, the best through ${best.introducer.name} (${best.warmthWord}).`;
}

/** A warm intro as the model reads it: warmth in a word, and Village's text wrapped as third-party content. */
function warmIntroForModel(w: WarmIntro, ctx: ToolContext) {
  return {
    introducer: wrapped(ctx, 'village', w.introducer.name, 120),
    introducerId: w.introducer.personId,
    warmth: w.warmthWord,
    hops: wrapped(ctx, 'village', w.hops.join(' > '), 300),
    note: wrapped(ctx, 'village', w.note, 240),
    targetPersonId: w.targetPersonId,
  };
}

export const findRoutes = defineTool({
  name: 'find_routes',
  kind: 'read',
  description:
    'Call this when the student asks how to reach someone, who could introduce them to a person, for a warm intro to a person or a company, who they know at a company, which former employees of a company are in their network, or wants a company page. Give a personId for routes to a person (each route names the first hop to ask for an intro) or a company name for the people there now, former employees and two-hop routes. Both include warm intro paths from Village when the student has it (warmth in a word, and the hops). A query that is not a clear person or company returns candidates to choose from.',
  input: z.object({
    personId: z.string().optional().describe('Routes to this person (from search_people).'),
    company: z
      .string()
      .optional()
      .describe('A company name (or organization id): who the student knows there.'),
    query: z
      .string()
      .optional()
      .describe('Free text when it is unclear whether a person or a company is meant; returns candidates.'),
  }),
  capabilities: [
    'map_search',
    'map_reach_person',
    'map_reach_company',
    'map_pick_route',
    'company_page',
    'map_open_target_company',
    'map_open_cluster',
    'discover_see_intro',
    'discover_find_intro_on_map',
    'person_find_intro',
    'map_find_path_button',
    'map_exit_reach',
    'map_escape',
    'warm_intro_paths',
    'warm_intros_company',
  ],
  progress: 'Finding routes',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    let personId = input.personId;
    let company = input.company;
    if (!personId && !company) {
      const q = input.query?.trim();
      if (!q) throw new Error('Say who or which company to reach.');
      const [people, orgs] = await Promise.all([
        userRows<Person>(db.people, userId),
        db.organizations.toArray(),
      ]);
      const cands = rankReachTargets(q, people, orgs);
      if (!cands.length)
        return ok(
          'routes',
          { candidates: [] },
          { candidates: [] },
          `No one by that name or company in your network yet.`,
          '/map?reach=1',
        );
      if (!isUnambiguous(cands))
        return ok(
          'routes',
          { candidates: cands },
          { candidates: cands, ambiguous: true },
          `Several things match "${q}". Ask which one is meant.`,
          '/map?reach=1',
        );
      if (cands[0]!.kind === 'person') personId = cands[0]!.id;
      else company = cands[0]!.id;
    }
    if (personId) {
      const target = await requirePerson(ctx, personId);
      const paths = await reachPerson(userId, personId, 3);
      const people = await peopleById(paths.flatMap((p) => p.hops.map((h) => h.toId)));
      people.set(target.id, target);
      const routes = paths.map((p) => pathView(p, people, ctx));
      const direct = routes.find((r) => r.hops.length === 1);
      // Village's warm intro paths (the sample student's come from the demo graph) next to Orbit's own routes
      const warmIntros = await warmIntrosFor(ctx.user, { person: target }, { signal: ctx.signal });
      const summary = `${
        routes.length
          ? `${plural(routes.length, 'route')} to ${target.displayName}${direct?.cold ? '. You know them only slightly, so an intro through someone who knows them is likelier to get a reply' : ''}.`
          : `No route to ${target.displayName} through people you know yet.`
      }${warmIntroLine(warmIntros)}`;
      return ok(
        'routes',
        { target: personRef(target), routes, warmIntros, why: WARMER_ROUTES_WHY },
        {
          target: personRef(target),
          routes,
          warmIntros: warmIntros.length ? warmIntros.map((w) => warmIntroForModel(w, ctx)) : undefined,
          note: direct?.cold ? WARMER_ROUTES_WHY : undefined,
        },
        summary,
        `/map?reach=${target.id}`,
      );
    }
    const reach: CompanyReach = await reachCompany(userId, company!, ctx.now);
    const tc = reach.org
      ? await db.targetCompanies
          .where('userId')
          .equals(userId)
          .filter(
            (t) =>
              t.organizationId === reach.org!.id || normalizeCompany(t.nameRaw) === reach.org!.nameNormalized,
          )
          .first()
      : undefined;
    const all = new Map<string, Person>();
    for (const d of reach.direct) all.set(d.person.id, d.person);
    for (const f of reach.former) all.set(f.person.id, f.person);
    for (const t of reach.twoHop)
      for (const h of t.path.hops) {
        const p = await db.people.get(h.toId);
        if (p) all.set(p.id, p);
      }
    const name = reach.org?.name ?? company!;
    const warmIntros = await warmIntrosFor(ctx.user, { company: name }, { signal: ctx.signal });
    const view = {
      company: name,
      organizationId: reach.org?.id,
      industry: reach.org?.industry,
      target: tc ? { id: tc.id, status: TARGET_STATUS_LABELS[tc.status], priority: tc.priority } : undefined,
      thereNow: reach.direct.slice(0, 15).map((d) => ({
        ...personRef(d.person),
        closeness: Math.round(d.strength * 100) / 100,
        alum: !!d.person.isAlumni,
      })),
      former: reach.former.slice(0, 10).map((f) => ({ ...personRef(f.person), leftOn: f.endedAt })),
      viaSomeoneYouKnow: reach.twoHop.map((t) => ({
        target: personRef(t.target),
        route: pathView(t.path, all, ctx),
      })),
    };
    const summary = `${name}: ${plural(reach.direct.length, 'person', 'people')} there now, ${plural(reach.former.length, 'former employee')} you know${reach.twoHop.length ? `, ${plural(reach.twoHop.length, 'route')} through someone closer` : ''}.${warmIntroLine(warmIntros)}`;
    return ok(
      'company',
      { ...view, warmIntros },
      {
        ...view,
        warmIntros: warmIntros.length ? warmIntros.map((w) => warmIntroForModel(w, ctx)) : undefined,
      },
      summary,
      reach.org ? `/companies/${reach.org.id}` : `/map?reach=1&company=${encodeURIComponent(name)}`,
    );
  },
  toModel,
});

// ---------- get_intro_web ----------

export const getIntroWeb = defineTool({
  name: 'get_intro_web',
  kind: 'read',
  description:
    'Call this when the student asks who introduced them to whom, which chats came from introductions or referrals, or wants the introductions around one person or company. Returns the recorded introduction chains as sentences, built only from real records (email introductions, referrers, people someone suggested).',
  input: z.object({
    query: z.string().optional().describe('A person name or company to narrow the chains to.'),
  }),
  capabilities: [
    'map_intro_web',
    'map_web_search',
    'map_story_hover',
    'map_story_open',
    'map_filter',
    'map_drag_turn',
    'map_keyboard',
  ],
  progress: 'Reading your introductions',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const [people, edges, threads, chats, facts] = await Promise.all([
      userRows<Person>(db.people, userId),
      db.edges.where('userId').equals(userId).toArray(),
      db.threads.where('userId').equals(userId).toArray(),
      userRows<CoffeeChat>(db.chats, userId),
      db.facts
        .where('userId')
        .equals(userId)
        .filter((f) => f.sourceTable === 'suggested_by')
        .toArray(),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const web = buildIntroWeb({ people, edges, threads, chats, facts });
    const nameOf = (id: string) => byId.get(id)?.displayName ?? 'someone';
    let stories = introStories(web, nameOf);
    const q = input.query?.trim().toLowerCase();
    if (q) {
      const match = (id: string) => {
        const p = byId.get(id);
        return (
          !!p &&
          (p.displayName.toLowerCase().includes(q) ||
            (p.currentOrganizationRaw ?? '').toLowerCase().includes(q))
        );
      };
      const ids = [...web.members].filter(match);
      stories = stories.filter((s) => ids.some((id) => s.text.includes(nameOf(id))));
      if (!stories.length && ids.length)
        stories = ids
          .map((id) => ({
            rootId: web.root.get(id) ?? id,
            focusId: id,
            text: describeIntroChain(web, id, nameOf),
          }))
          .filter((s) => s.text);
    }
    const out = stories.map((s) => ({
      text: s.text,
      focusPersonId: s.focusId,
      href: `/people/${s.focusId}`,
    }));
    const summary = out.length
      ? `${plural(out.length, 'introduction chain')} on record.`
      : q
        ? `No introductions on record around "${input.query}".`
        : 'No introductions on record yet.';
    return ok(
      'routes',
      { stories: out, members: web.members.size },
      { chains: out, people: web.members.size },
      summary,
      '/map',
    );
  },
  toModel,
});

// ---------- list_recommendations ----------

export const listRecommendations = defineTool({
  name: 'list_recommendations',
  kind: 'read',
  description:
    "Call this when the student asks who they should meet next, why someone is recommended, for their saved recommendations, the match or reach score of a person, or to search their network for someone to write to. Returns Discover's list: person, reasons, match and reach out of 100, whether a warm-up is advised and who could introduce them.",
  input: z.object({
    status: z
      .enum(['new', 'saved', 'dismissed', 'all'])
      .optional()
      .describe('Which recommendations (default new and saved, saved first).'),
    query: z
      .string()
      .optional()
      .describe('Search the whole network by name, company or title instead of the ranked list.'),
    limit: z.number().int().min(1).max(50).optional().describe('At most this many (default 12).'),
  }),
  capabilities: ['discover_start'],
  progress: 'Looking at Discover',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const [recs, people] = await Promise.all([
      db.recommendations.where('userId').equals(userId).toArray(),
      userRows<Person>(db.people, userId),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const limit = input.limit ?? 12;
    if (input.query?.trim()) {
      const s = input.query.trim().toLowerCase();
      const hits = people
        .filter(
          (p) =>
            p.isHuman &&
            !p.hiddenAt &&
            (p.displayName.toLowerCase().includes(s) ||
              (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
              (p.currentTitle ?? '').toLowerCase().includes(s)),
        )
        .slice(0, limit)
        .map((p) => ({ ...personRef(p), closeness: Math.round(p.strength * 100) / 100 }));
      return ok(
        'people',
        { people: hits },
        { people: hits },
        hits.length
          ? `${plural(hits.length, 'person', 'people')} in your network match "${input.query}".`
          : `Nobody in your network matches "${input.query}".`,
        '/discover',
      );
    }
    const status = input.status ?? 'all';
    const list = recs
      .filter((r) => (status === 'all' ? r.status === 'new' || r.status === 'saved' : r.status === status))
      .sort((a, b) => (b.status === 'saved' ? 1 : 0) - (a.status === 'saved' ? 1 : 0) || b.score - a.score)
      .slice(0, limit)
      .map((r) => {
        const p = byId.get(r.personId);
        if (!p) return undefined;
        const cold = isColdRecommendation(p, r);
        const introId = introducerIdFor(r);
        return {
          recommendationId: r.id,
          ...personRef(p),
          alum: !!p.isAlumni,
          status: r.status,
          reasons: r.reasons.slice(0, 3).map((x) => x.text),
          match: Math.round(r.fitScore * 100),
          reach: Math.round(r.reachScore * 100),
          cold,
          warmUpAdvised: cold && !introId,
          introducer: introId ? byId.get(introId)?.displayName : undefined,
          introducerId: introId,
          dismissedReason: r.dismissedReason,
        };
      })
      .filter(Boolean);
    const summary = list.length
      ? `${plural(list.length, 'recommendation')}${status !== 'all' ? ` (${status})` : ''} on Discover.`
      : 'No recommendations in that list.';
    return ok('people', { recommendations: list }, { recommendations: list }, summary, '/discover');
  },
  toModel,
});

// ---------- notes ----------

export const listNotes = defineTool({
  name: 'list_notes',
  kind: 'read',
  description:
    'Call this when the student asks what someone said last time, for their notes from a chat, or to read one note. Returns notes with who they were filed with, when, their summary and (for one note) the full text and what Orbit took from it.',
  input: z.object({
    personId: z.string().optional().describe('Notes filed with this person.'),
    noteId: z.string().optional().describe('One note in full.'),
    limit: z.number().int().min(1).max(50).optional().describe('At most this many (default 10).'),
  }),
  capabilities: ['note_set_person', 'note_set_when', 'note_set_source'],
  progress: 'Reading your notes',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const people = await peopleById(
      (await db.notes.where('userId').equals(userId).toArray()).flatMap((n) => n.personIds),
    );
    if (input.noteId) {
      const n = await db.notes.get(input.noteId);
      if (!n || n.userId !== userId) throw new Error('Orbit has no note with that id.');
      const [facts, items] = await Promise.all([
        db.facts
          .where('userId')
          .equals(userId)
          .filter((f) => f.sourceId === n.id && !f.deletedAt)
          .toArray(),
        db.actionItems
          .where('userId')
          .equals(userId)
          .filter((a) => a.sourceId === n.id)
          .toArray(),
      ]);
      const view = {
        noteId: n.id,
        when: fmtWhen(n.occurredAt, ctx),
        source: n.source,
        matchStatus: n.matchStatus,
        people: n.personIds
          .map((id) => people.get(id))
          .filter(Boolean)
          .map((p) => personRef(p!)),
        summary: wrapped(ctx, 'note', n.summary, 600),
        text: wrapped(ctx, 'note', n.rawText, 3000),
        facts: facts.map((f) => ({ id: f.id, type: f.type, text: wrapped(ctx, 'fact', f.text, 200) })),
        promises: items.map((a) => ({
          actionItemId: a.id,
          text: wrapped(ctx, 'promise', a.text, 200),
          dueAt: fmtDay(a.dueAt, ctx),
          status: a.status,
        })),
      };
      return ok(
        'note',
        view,
        view,
        `Note from ${view.when}${view.people.length ? ` with ${view.people.map((p) => p.name).join(', ')}` : ''}: ${plural(facts.length, 'fact')} and ${plural(items.length, 'promise')} taken from it.`,
        n.personIds[0] ? `/people/${n.personIds[0]}?tab=facts` : '/inbox',
      );
    }
    let notes = await db.notes.where('userId').equals(userId).toArray();
    if (input.personId) notes = notes.filter((n) => n.personIds.includes(input.personId!));
    notes = notes.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, input.limit ?? 10);
    const rows = notes.map((n) => ({
      noteId: n.id,
      when: fmtWhen(n.occurredAt, ctx),
      source: n.source,
      matchStatus: n.matchStatus,
      people: n.personIds.map((id) => people.get(id)?.displayName).filter(Boolean),
      summary: wrapped(ctx, 'note', n.summary ?? n.rawText, 300),
    }));
    return ok(
      'note',
      { notes: rows },
      { notes: rows },
      rows.length ? `${plural(rows.length, 'note')} on record.` : 'No notes yet.',
      input.personId ? `/people/${input.personId}?tab=facts` : '/notes/new',
    );
  },
  toModel,
});

export const previewNoteMatchTool = defineTool({
  name: 'preview_note_match',
  kind: 'read',
  description:
    "Call this before add_note when the student has not said who a note is about, to see who Orbit would file it with from the names in the text and the recent calendar. Returns one person, several candidates (ask the student which), or none. Pass the result's personId to add_note.",
  input: z.object({
    text: z.string().min(1).describe('The note text as the student gave it.'),
    when: z.string().optional().describe('When the conversation happened, ISO 8601; default now.'),
  }),
  capabilities: ['note_match_preview'],
  progress: 'Checking who this note is about',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const people = await userRows<Person>(db.people, userId);
    const at = input.when ? new Date(input.when) : ctx.now;
    const recentEvents = await db.events
      .where('userId')
      .equals(userId)
      .filter(
        (e) =>
          e.status !== 'cancelled' &&
          e.attendeePersonIds.length > 0 &&
          new Date(e.startAt) <= ctx.now &&
          ctx.now.getTime() - new Date(e.startAt).getTime() < 3 * DAY,
      )
      .toArray();
    const byId = new Map(people.map((p) => [p.id, p]));
    const nearby = recentEvents
      .filter((e) => Math.abs(new Date(e.startAt).getTime() - at.getTime()) < 3 * 3_600_000)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    const calendarPerson = nearby ? byId.get(nearby.attendeePersonIds[0]!) : undefined;
    const recent = recentEvents
      .flatMap((e) => e.attendeePersonIds.map((id) => byId.get(id)))
      .filter((p): p is Person => !!p);
    const preview = previewNoteMatch(input.text, people, ctx.user, calendarPerson, recent);
    const view =
      preview.kind === 'person'
        ? { match: 'person' as const, person: personRef(preview.person), why: preview.why }
        : preview.kind === 'several'
          ? {
              match: 'several' as const,
              candidates: preview.people.map(personRef),
              label: namedPeopleLabel(preview.people),
            }
          : { match: 'none' as const };
    const summary =
      preview.kind === 'person'
        ? `This note would be filed with ${preview.person.displayName} (${preview.why === 'named' ? 'named in it' : preview.why === 'calendar' ? 'on the calendar then' : 'a recent chat'}).`
        : preview.kind === 'several'
          ? `It could be with ${namedPeopleLabel(preview.people)}. Ask which.`
          : 'Orbit cannot tell who this note is with. Ask the student.';
    return ok('note', view, view, summary, '/notes/new');
  },
  toModel,
});

// ---------- settings, usage, stages, pages ----------

const SETTINGS_SECTIONS = [
  'profile',
  'goals',
  'integrations',
  'style',
  'limits',
  'privacy',
  'onboarding',
  'all',
] as const;

export const getSettings = defineTool({
  name: 'get_settings',
  kind: 'read',
  description:
    'Call this when the student asks about their profile, goals, target companies, writing style, weekly goal, cooldown, daily limits, scheduling link, warm-up settings, which integrations are connected (Google, LinkedIn import, resume on file, Claude key), what Orbit stores, their setup progress, or whether they are in the demo. Returns the current values by section.',
  input: z.object({
    section: z.enum(SETTINGS_SECTIONS).optional().describe('One section, or all (default).'),
  }),
  capabilities: ['settings_read', 'settings_section_nav', 'resume_facet_toggle'],
  progress: 'Reading your settings',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const section = input.section ?? 'all';
    const want = (s: string) => section === 'all' || section === s;
    const out: Record<string, unknown> = {};
    const user = (await db.users.get(userId)) ?? ctx.user;
    if (want('profile'))
      out.profile = {
        fullName: user.fullName,
        email: user.email,
        school: user.school,
        schoolDomain: user.schoolDomain,
        graduationYear: user.graduationYear,
        degree: user.degree,
        majors: user.majors,
        currentCity: user.currentCity,
        linkedinUrl: user.linkedinUrl,
        timezone: user.timezone,
        href: '/settings/profile',
      };
    if (want('goals')) {
      const [goals, targets] = await Promise.all([
        db.goals.get(userId),
        db.targetCompanies.where('userId').equals(userId).toArray(),
      ]);
      out.goals = goals
        ? {
            cycleLabel: goals.cycleLabel,
            functions: goals.targetFunctions.map((f) => ({ code: f, label: FUNCTION_LABELS[f] ?? f })),
            targetRoles: goals.targetRoles,
            targetIndustries: goals.targetIndustries,
            targetLocations: goals.targetLocations,
            freeText: goals.freeText,
            ambition: goals.ambition,
            href: '/settings/goals',
          }
        : undefined;
      out.targetCompanies = targets.map((t) => ({
        id: t.id,
        name: t.nameRaw,
        priority: t.priority,
        priorityLabel: t.priority === 1 ? 'Top priority' : t.priority === 2 ? 'Normal' : 'Low',
        status: t.status,
        statusLabel: TARGET_STATUS_LABELS[t.status],
        deadline: t.deadline,
      }));
    }
    if (want('style')) {
      const [settings, style] = await Promise.all([db.settings.get(userId), db.styles.get(userId)]);
      out.style = {
        tonePreset: settings?.tonePreset ?? 'warm',
        learnedFromSentMail: style ? style.card.builtFromCount : 0,
        href: '/settings/style',
      };
    }
    if (want('limits')) {
      const settings = await db.settings.get(userId);
      out.limits = settings
        ? {
            weeklyOutreachTarget: settings.weeklyOutreachTarget,
            perPersonCooldownHours: settings.perPersonCooldownHours,
            dailySendCapGmail: settings.dailySendCapGmail,
            dailySendCapLinkedin: settings.dailySendCapLinkedin,
            maxBumps: settings.maxBumps,
            warmUpEnabled: settings.warmUpEnabled,
            warmUpDays: settings.warmUpDays,
            schedulingLink: settings.schedulingLink,
            briefTimeLocal: settings.briefTimeLocal,
            dismissedHints: settings.dismissedHints ?? [],
            href: '/settings/limits',
          }
        : undefined;
    }
    if (want('integrations')) {
      const [accounts, resumes] = await Promise.all([
        db.integrations.where('userId').equals(userId).toArray(),
        db.resumes.where('userId').equals(userId).toArray(),
      ]);
      const google = accounts.find((a) => a.provider === 'google');
      const li = accounts.find((a) => a.provider === 'linkedin_csv');
      const live = await linkedInLiveStatus(ctx.user, ctx.now);
      const resume = resumes
        .filter((r) => r.isCurrent)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const facets = resume ? await db.resumeFacets.where('resumeId').equals(resume.id).toArray() : [];
      const prefs = readPrefs();
      out.integrations = {
        googleAvailable: !!googleClientId(),
        google: google
          ? {
              status: google.status,
              account: google.externalAccountId,
              lastSync: fmtWhen(google.lastSyncedAt, ctx),
              signedIn: !!currentGoogleToken(),
              error: google.lastError,
            }
          : undefined,
        linkedinImport: li
          ? {
              connections: (li.syncState as { rows?: number }).rows ?? 0,
              importedOn: fmtDay(li.lastSyncedAt ?? li.connectedAt, ctx),
            }
          : undefined,
        linkedinLive: {
          available: live.available,
          connected: live.connected,
          status: live.status,
          connections: live.rows,
          lastSync: fmtWhen(live.lastSyncedAt, ctx),
          error: live.error,
        },
        warmIntros: { on: villageAvailable(ctx.user), offered: villageOffered(ctx.user), from: 'Village' },
        resume: resume
          ? {
              filename: resume.filename,
              addedOn: fmtDay(resume.createdAt, ctx),
              facets: facets.map((f) => ({
                id: f.id,
                kind: f.kind,
                title: f.title,
                organization: f.organizationName,
                used: !f.excluded,
              })),
            }
          : undefined,
        claude: {
          keySaved: !!prefs.anthropicApiKey,
          sharedAccess: sharedClaudeAvailable(),
          model: MODEL,
          features: llmFeatures(prefs),
        },
        problems: accounts
          .filter((a) => a.status === 'needs_reauth' || a.status === 'error')
          .map((a) => ({ provider: a.provider, error: a.lastError })),
        href: '/settings/integrations',
      };
    }
    if (want('privacy'))
      out.privacy = {
        exportIncludes:
          'people, chats, notes, facts, drafts, what you sent, and any synced email text and calendar events; never the Anthropic key',
        href: '/settings/privacy',
      };
    if (want('onboarding'))
      out.onboarding = {
        step: user.onboardingStep,
        completed: !!user.onboardingCompletedAt,
        href: user.onboardingCompletedAt ? '/' : `/onboarding/${Math.max(1, user.onboardingStep - 1)}`,
      };
    out.isDemo = userId === DEMO_USER_ID;
    const summary = section === 'all' ? 'Your settings, by section.' : `Your ${section} settings.`;
    return ok(
      'settings',
      out,
      out,
      summary,
      section === 'all' ? '/settings' : `/settings/${section === 'onboarding' ? 'profile' : section}`,
    );
  },
  toModel,
});

export const getUsage = defineTool({
  name: 'get_usage',
  kind: 'read',
  description:
    'Call this when the student asks how much of their daily Claude budget is used, what the limits are, whether a key is saved, what Claude may read, or about the last Claude error.',
  input: z.object({}),
  capabilities: ['claude_caps_set'],
  progress: 'Checking Claude usage',
  async execute(_input, ctx) {
    const prefs = readPrefs();
    const usage = todaysLlmUsage(prefs, ctx.now);
    const view = {
      keySaved: hasLlm(),
      model: MODEL,
      features: llmFeatures(prefs),
      today: { requests: usage.requests, tokens: usage.inputTokens + usage.outputTokens },
      caps: {
        requestsPerDay: prefs.llmDailyRequestCap ?? DEFAULT_DAILY_REQUEST_CAP,
        tokensPerDay: prefs.llmDailyTokenCap ?? DEFAULT_DAILY_TOKEN_CAP,
      },
      lastError: prefs.lastLlmError
        ? { at: fmtWhen(prefs.lastLlmError.at, ctx), message: prefs.lastLlmError.message }
        : undefined,
    };
    const summary = view.keySaved
      ? `Today: ${view.today.requests} of ${view.caps.requestsPerDay} requests and ${view.today.tokens.toLocaleString('en-US')} of ${view.caps.tokensPerDay.toLocaleString('en-US')} tokens.`
      : 'No Claude key is saved. Orbit writes every draft on its own.';
    return ok('settings', view, view, summary, '/settings/integrations');
  },
  toModel,
});

export const explainStage = defineTool({
  name: 'explain_stage',
  kind: 'read',
  description:
    'Call this when the student asks what a pipeline stage means, what the stages are, what "Thanked" or "Staying in touch" is, or what happens after a move. Returns each stage with its one-sentence meaning and whether it is active or closed.',
  input: z.object({
    stage: z.enum(STAGES).optional().describe('One stage; all of them when left out.'),
  }),
  capabilities: ['nav_go'],
  progress: 'Explaining the stages',
  async execute(input) {
    const list = (input.stage ? [input.stage] : STAGE_ORDER).map((s) => ({
      stage: s,
      label: STAGE_LABELS[s],
      meaning: STAGE_HELP[s],
      closed: CLOSED_STAGES.includes(s),
    }));
    const summary = input.stage
      ? `${STAGE_LABELS[input.stage]}: ${STAGE_HELP[input.stage]}`
      : `The pipeline has ${ACTIVE_STAGES.length} active stages and ${CLOSED_STAGES.length} closed ones.`;
    return ok('text', { stages: list }, { stages: list }, summary, '/people?view=board');
  },
  toModel,
});

const PAGES = {
  people: '/people',
  person: '/people/:id',
  company: '/companies/:id',
  map: '/map',
  reach: '/map?reach=1',
  discover: '/discover',
  drafts: '/inbox',
  add_note: '/notes/new',
  settings: '/settings',
  settings_profile: '/settings/profile',
  settings_goals: '/settings/goals',
  settings_integrations: '/settings/integrations',
  settings_style: '/settings/style',
  settings_limits: '/settings/limits',
  settings_privacy: '/settings/privacy',
  landing: '/',
  // older names a model or a saved chat may still use: Today's cards are in Drafts, the Pipeline is the People board
  today: '/inbox',
  pipeline: '/people?view=board',
} as const;

export const openPage = defineTool({
  name: 'open_page',
  kind: 'read',
  description:
    'Call this when the student asks to go to, open or show a page of the app (People with its board, list and companies views, a person, a company, the Map, reach mode, Discover, Drafts, Add note, a Settings section, the landing page), or to change a view the page itself holds (a People view, a Map filter). Returns the in-app link the UI offers as "Open in app"; nothing else changes.',
  input: z.object({
    page: z.enum(Object.keys(PAGES) as [keyof typeof PAGES, ...(keyof typeof PAGES)[]]).describe('The page.'),
    id: z.string().optional().describe('The person or organization id for a person or company page.'),
    tab: z.enum(['timeline', 'facts', 'connections', 'prep']).optional().describe('A person page tab.'),
    view: z
      .enum(['board', 'list', 'companies', 'table'])
      .optional()
      .describe('A People view: board (chats by stage), list (everyone), companies. table means list.'),
    filter: z
      .enum(['everyone', 'targets', 'alumni', 'pipeline', 'recent', 'introductions'])
      .optional()
      .describe('A Map filter. For quiet chats on People, use quiet.'),
    quiet: z.boolean().optional().describe('People: only chats that went quiet.'),
    personId: z
      .string()
      .optional()
      .describe(
        "Map reach mode for this person, or Drafts focused on this person's newest card, or Add note for this person.",
      ),
    cardId: z.string().optional().describe('Drafts focused on this card.'),
    company: z.string().optional().describe('Map reach mode for this company name.'),
  }),
  capabilities: [
    'nav_go',
    'settings_section_nav',
    'pipeline_view_switch',
    'map_filter',
    'map_find_path_button',
    'person_add_note',
    'person_find_intro',
    'discover_find_intro_on_map',
    'demo_back_to_demo',
    'demo_banner_keep_exploring',
    'map_exit_reach',
    'map_escape',
    'landing_get_started',
  ],
  progress: 'Opening the page',
  async execute(input) {
    let href: string = PAGES[input.page];
    if (input.page === 'person')
      href = `/people/${input.id ?? input.personId ?? ''}${input.tab ? `?tab=${input.tab}` : ''}`;
    if (input.page === 'company') href = `/companies/${input.id ?? ''}`;
    // "today" and "pipeline" are the older names of Drafts and the People board
    const page = input.page === 'today' ? 'drafts' : input.page === 'pipeline' ? 'people' : input.page;
    if (page === 'people' && (input.view || input.quiet || input.page === 'pipeline')) {
      const params = new URLSearchParams();
      const view =
        input.view === 'table' ? 'list' : (input.view ?? (input.page === 'pipeline' ? 'board' : undefined));
      if (view) params.set('view', view);
      if (input.quiet) params.set('quiet', '1');
      href = `/people${params.size ? `?${params}` : ''}`;
    }
    if (input.page === 'map' || input.page === 'reach') {
      const params = new URLSearchParams();
      if (input.personId) params.set('reach', input.personId);
      else if (input.company || input.page === 'reach') params.set('reach', '1');
      if (input.company) params.set('company', input.company);
      if (input.filter && input.filter !== 'everyone') params.set('filter', input.filter);
      href = `/map${params.size ? `?${params}` : ''}`;
    }
    if (page === 'drafts' && (input.cardId || input.personId))
      href = `/inbox?${input.cardId ? `card=${input.cardId}` : `person=${input.personId}`}`;
    if (page === 'add_note' && input.personId) href = `/notes/new?person=${input.personId}`;
    const label = page.replace(/_/g, ' ');
    return autoOpen(ok('text', { href, page }, { href, page }, `Open ${label} in the app.`, href));
  },
  toModel,
});

export const draftWarmupComment = defineTool({
  name: 'draft_warmup_comment',
  kind: 'read',
  description:
    "Call this when the student asks for a LinkedIn comment for a warm-up step, or help commenting on someone's post. Needs what the post says (at least a short clause); an optional line of the student's own experience makes it specific. Returns the comment text to copy; nothing is posted.",
  input: z.object({
    postClaim: z
      .string()
      .min(8)
      .describe('What the post said, in a clause ("new analysts should ship something in week one").'),
    ownExperience: z
      .string()
      .optional()
      .describe("One line of the student's own related experience, optional."),
    seed: z.string().optional().describe('Any string: a different seed gives a different wording.'),
  }),
  capabilities: ['card_warmup_comment_draft'],
  progress: 'Writing a comment',
  async execute(input) {
    const r = draftWarmUpComment(input.postClaim, {
      seed: input.seed ?? input.postClaim.length.toString(),
      ownExperience: input.ownExperience || undefined,
    });
    return ok(
      'text',
      { comment: r.text },
      { comment: r.text },
      r.text
        ? 'A comment to paste under their post. Read it once before posting.'
        : 'Say what the post is about first.',
      '/inbox',
    );
  },
  toModel,
});

export const readTools: AnyTool[] = [
  getTodayBrief,
  listPipeline,
  searchPeople,
  getPerson,
  listDrafts,
  getDraft,
  findRoutes,
  getIntroWeb,
  listRecommendations,
  listNotes,
  previewNoteMatchTool,
  getSettings,
  getUsage,
  explainStage,
  openPage,
  draftWarmupComment,
];

// re-exported for the write tools' summaries
export { clip, lastInboundOf, liveChatOf };
