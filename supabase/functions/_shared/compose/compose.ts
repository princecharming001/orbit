/**
 * The compose service (§7.3, §8.3): builds the inputs, asks Opus 5.5 for one message in the user's voice, checks it
 * with `validateDraft` + `validateComposed` (plus: every hook cites a research id), retries once with the issues
 * listed, and falls back to the template engine (`generated_by = 'template'`). `[ASK USER: …]` markers become
 * `needsInput` and keep the draft from being sent. Refuses do-not-contact people, unsubscribe replies, a fourth
 * unanswered message, a new first touch within 180 days of a decline, and a sales first touch to a new recipient
 * before a postal address is set (CAN-SPAM, §14.3); such a first touch carries the opt-out line (§7.7).
 */

import {
  cleanSubject,
  FIRST_TOUCH_KINDS,
  plainPhrases,
  validateComposed,
  wordRange,
} from '@orbit/core/drafts/compose';
import { draftPlaybook, type Niche } from '@orbit/core/drafts/niche';
import {
  COMPOSE_KINDS,
  type ComposeKind,
  type ComposeTemplateInput,
  composeFallback,
} from '@orbit/core/drafts/templates';
import type { ReplyClass } from '@orbit/core/email/replyClass';
import { extractProposedTimes } from '@orbit/core/email/triage';
import { messageHash, unansweredBefore } from '@orbit/core/safety/rules';
import type { Slot } from '@orbit/core/server/api';
import { stripQuotedReply } from '@orbit/core/text/email';
import type { ComposedMessage, GoalKind, MessageKind } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { firstNameOf, iso, lastNameOf } from '../rows.ts';
import type { Services } from '../services.ts';
import { slotsFor } from '../slots/slots.ts';
import { validZone } from '../zones.ts';
import {
  buildUserContext,
  exemplars,
  loadPerson,
  loadResearch,
  loadUserRow,
  type PersonRow,
  personOrg,
  type Research,
  recipientText,
  styleCardOf,
  type UserRow,
  userFirstName,
  voiceText,
} from './context.ts';
import type { DraftMeta, DraftRow } from './drafts.ts';
import {
  ASK_USER,
  askKindFor,
  askUserMarkers,
  type ComposeOutput,
  composeSchema,
  composeSystem,
  composeUser,
  PROMPT_VERSION,
  retryNote,
} from './prompts.ts';
import { nextSendWindow } from './window.ts';

export const OPT_OUT_LINE = "If this isn't relevant, just say so and I won't follow up.";
export const DECLINE_COOLDOWN_DAYS = 180;
const DAY = 86_400_000;

export interface ComposeRequest {
  userId: string;
  personId: string;
  kind: MessageKind;
  channel: 'gmail' | 'linkedin';
  goalId?: string | null;
  chatId?: string | null;
  /** a reply answers this inbound message */
  replyToMessageId?: string;
  /** an intro request or blurb is about meeting this person */
  targetPersonId?: string;
  via?: { introducerId: string; pathScore: number; introRequestId?: string };
  /** the role, question, event, paper or news the message is about */
  topic?: string;
  /** why cadence drafted it */
  reason?: string;
  actor?: 'user' | 'agent';
  /** a reply that confirms a call the funnel just booked (plan 29 §B2.3): that time, and no other */
  confirmSlot?: { start: string; label: string };
}

export interface ComposeResult {
  draft: DraftRow;
  composed: ComposedMessage;
  /** LLM attempts made (0 without a key) */
  attempts: number;
}

/** The composed message as a stored draft. Throws HttpError for the refusals above. */
export async function composeDraft(s: Services, req: ComposeRequest): Promise<ComposeResult> {
  const db = s.db;
  const now = s.now();
  const user = await loadUserRow(db, req.userId);
  const person = await loadPerson(db, req.userId, req.personId);
  if (person.is_self) throw new HttpError(400, 'bad_request', 'that is you');
  if (person.do_not_contact)
    throw new HttpError(
      409,
      'do_not_contact',
      'they asked not to be contacted, so Orbit will not write to them',
    );

  // the inbound message a reply answers
  let replyTo: ReplyMessage | undefined;
  if (req.kind === 'reply') {
    if (!req.replyToMessageId) throw new HttpError(400, 'bad_request', 'a reply needs replyToMessageId');
    replyTo = await loadReplyMessage(db, req.userId, req.replyToMessageId);
    if (replyTo.reply_class === 'unsubscribe')
      throw new HttpError(409, 'unsubscribe', 'they asked not to be contacted; no reply is drafted');
  }

  const goal = await resolveGoal(db, req.userId, req.goalId ?? null, req.chatId ?? null, person.id);
  const goalKind: GoalKind = (goal?.kind as GoalKind) ?? 'advice';
  const chatId = req.chatId ?? (await chatFor(db, req.userId, person.id, goal?.id ?? null));
  // the niche playbook this message follows (plan 30): one resolver shared with the browser's drafts
  const goalTargets = (goal?.targets ?? {}) as Record<string, string[]>;
  const goalCriteria = (goal?.criteria ?? {}) as Record<string, unknown>;
  const aim = (user.settings.about as { aim?: unknown } | undefined)?.aim;
  const playbook = draftPlaybook({
    goalKind,
    goalText: [goal?.title, goal?.description, typeof aim === 'string' ? aim : '', req.topic]
      .filter(Boolean)
      .join('. '),
    recipient: { title: person.title ?? undefined, org: personOrg(person) },
    targetFunctions: goalTargets.roles ?? [],
    degree: user.degree ?? undefined,
    kind: req.kind,
    goalBrief: typeof goalCriteria.playbook === 'string' ? goalCriteria.playbook : undefined,
  });

  const history = await historyWith(db, req.userId, person.id);
  const sendsToThem = req.kind !== 'forwardable_blurb';
  if (sendsToThem && req.kind !== 'reply' && unansweredBefore(history) >= 3)
    throw new HttpError(409, 'unanswered_limit', 'three messages already went unanswered');
  const firstTouch = FIRST_TOUCH_KINDS.has(req.kind);
  if (firstTouch) {
    const [declined] = await db.sql<{ n: number }>`
      select count(*)::int as n from orbit.chats
       where user_id = ${req.userId}::uuid and person_id = ${person.id}::uuid and stage = 'declined'
         and stage_entered_at > ${new Date(now.getTime() - DECLINE_COOLDOWN_DAYS * DAY)}::timestamptz`;
    if ((declined?.n ?? 0) > 0)
      throw new HttpError(409, 'declined_recently', 'they declined in the last 180 days');
  }
  const newRecipient = !history.some((m) => m.direction === 'out');
  const salesFirstTouch = goalKind === 'sales' && firstTouch && req.channel === 'gmail' && newRecipient;
  const postal = typeof user.settings.postal_address === 'string' ? user.settings.postal_address.trim() : '';
  if (salesFirstTouch && !postal)
    throw new HttpError(
      409,
      'needs_postal_address',
      'add a postal address in Settings before the first sales email (CAN-SPAM)',
    );

  const target = req.targetPersonId ? await loadPerson(db, req.userId, req.targetPersonId) : undefined;
  const introducer =
    req.via && req.via.introducerId !== person.id
      ? await loadPerson(db, req.userId, req.via.introducerId).catch(() => undefined)
      : req.via
        ? person
        : undefined;

  const research = await loadResearch(db, req.userId, person.id);
  const userContext = await buildUserContext(db, user);
  // what the student told Orbit about this person (chat memories tied to them)
  const aboutThem = await db.sql<{ text: string }>`
    select text from orbit.memories
     where user_id = ${req.userId}::uuid and person_id = ${person.id}::uuid and deleted_at is null
     order by importance desc, last_seen_at desc limit 5`;
  const recipient = [
    recipientText(person),
    aboutThem.length
      ? `What ${userFirstName(user)} told Orbit about them: ${aboutThem.map((m) => m.text).join(' | ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const card = styleCardOf(user);
  const meFirst = userFirstName(user);
  const tz = validZone(person.timezone) ?? validZone(user.timezone) ?? 'America/New_York';
  const window = nextSendWindow(now, tz, req.channel, s.random);

  // thread
  const thread = await threadContext(db, req.userId, person.id, req.kind, replyTo, req.channel);
  const replyClass = (replyTo?.reply_class ?? undefined) as ReplyClass | undefined;
  const schedulingLink =
    typeof user.settings.scheduling_link === 'string' ? user.settings.scheduling_link : undefined;
  let slots: Slot[] = [];
  let windows: string[] = [];
  let slotTz: string | undefined;
  // the student's answer to a question the reply asked (plan 29 §B2.3), and a booked time to confirm
  const answer = replyTo?.answer?.trim() || undefined;
  const confirms = req.kind === 'reply' ? req.confirmSlot : undefined;
  const wantsTimes = !confirms && (replyClass === 'interested' || replyClass === 'scheduling');
  if (req.kind === 'reply' && wantsTimes) {
    try {
      const free = await slotsFor(s, req.userId, { personId: person.id, count: 3 });
      slots = free.slots;
      windows = free.windows;
      slotTz = free.tz;
    } catch {
      slots = [];
    }
  }

  const askKind = askKindFor(req.kind, goalKind, wantsTimes, playbook.form.ask);
  const range =
    req.channel === 'linkedin'
      ? 'At most 400 characters,'
      : wordRangeText(req.kind, goalKind, playbook.niche);
  const viaText = introducer
    ? `${introducer.display_name}${req.via?.pathScore !== undefined ? ` (path score ${req.via.pathScore.toFixed(2)})` : ''}`
    : '';
  const goalText = goal
    ? `${goal.kind}: ${goal.title}${goal.description ? `. ${goal.description}` : ''} (${playbook.label})`
    : playbook.label;
  const topic = req.topic ?? goalTopic(goal);
  const task = [
    `kind: ${req.kind}; channel: ${req.channel}; ask: ${askKind}`,
    target
      ? `the introduction is to: ${target.display_name}${personOrg(target) ? ` at ${personOrg(target)}` : ''}`
      : '',
    req.kind === 'forwardable_blurb' ? `the intermediary reading it first: ${person.display_name}` : '',
    topic ? `about: ${topic}` : '',
    req.reason ? `why now: ${req.reason}` : '',
    schedulingLink && wantsTimes ? `scheduling link: ${schedulingLink}` : '',
    answer ? `${meFirst}'s answer to what they asked, in ${meFirst}'s words: ${answer}` : '',
    confirms
      ? `the call is booked for ${confirms.label} and the invite is sent: confirm that time in one line, offer no other times, ask nothing`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const examples = await exemplars(
    s,
    req.userId,
    person.id,
    [req.kind, goalKind, person.title ?? '', thread.lastInbound ?? '', topic ?? ''].join(' '),
    { replies: req.kind === 'reply' },
  );
  // a slot is offered as its start: the call runs as long as they asked, not the calendar hold's 30 minutes
  const slotText = [
    ...slots.map((x) => `${x.start} = ${x.label.replace(/ to \d{1,2}:\d{2}( ?[ap]m)?/i, '')}`),
    windows.length
      ? `Free hours by day over the next two weeks (any start inside one is free):\n${windows.join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const userBlocks = composeUser({
    task,
    userContext,
    goal: goalText,
    recipient,
    research: research.text,
    thread: thread.text,
    via: viaText,
    voice: voiceText(card),
    examples: examples.map((e, i) => `Example ${i + 1}:\n${e}`).join('\n\n'),
    ...(req.kind === 'reply' ? { freeSlots: slotText } : {}),
  });
  const system = `${composeSystem({
    userFirstName: meFirst,
    wordRange: range,
    askKind,
    kind: req.kind,
    blurb:
      req.kind === 'forwardable_blurb'
        ? { intermediary: person.display_name, target: target?.display_name ?? 'them' }
        : undefined,
    gradeMax: playbook.form.gradeMax,
  })}${playbook.lines.map((l, i) => `\n${13 + i}. ${l}`).join('')}`;

  // what a message may draw on, for the invented-name check
  const inputs = [
    userContext,
    goalText,
    recipient,
    research.text,
    thread.text,
    viaText,
    task,
    slots.map((x) => x.label).join('\n'),
    target ? recipientText(target) : '',
    meFirst,
    user.full_name ?? '',
    answer ?? '',
    confirms?.label ?? '',
  ].join('\n');
  const ctx = {
    goal: goalKind,
    niche: playbook.niche,
    recipientFirstName: firstNameOf(person),
    recipientFullName: person.display_name,
    recipientEmail: person.primary_email ?? undefined,
    inputs,
    allowedUrls: [...(schedulingLink ? [schedulingLink] : []), ...linksIn(userContext)],
    style: card,
    userFirstName: meFirst,
  };
  const check = (out: ComposeOutput) => checkComposed(out, req, ctx, research);

  let output: ComposeOutput | undefined;
  let attempts = 0;
  let generatedBy: 'llm' | 'template' = 'template';
  let lastIssues: string[] = [];
  if (s.claude.configured) {
    let turn = userBlocks;
    for (let i = 0; i < 2; i++) {
      attempts++;
      const r = await s.claude.structured({
        task: req.kind === 'reply' ? 'reply' : 'compose',
        system,
        user: turn,
        schema: composeSchema,
        userId: req.userId,
      });
      if (!r.ok) break;
      r.data.body = plainPhrases(r.data.body);
      if (r.data.subject) r.data.subject = plainPhrases(r.data.subject);
      const issues = check(r.data);
      if (!issues.length) {
        output = r.data;
        generatedBy = 'llm';
        break;
      }
      lastIssues = issues;
      turn = userBlocks + retryNote(issues);
    }
  }

  let composed: Omit<ComposedMessage, 'validator'>;
  let promptVersion = PROMPT_VERSION;
  if (output) {
    composed = {
      id: '',
      goalId: goal?.id ?? null,
      personId: person.id,
      kind: req.kind,
      channel: req.channel,
      subject:
        req.channel === 'gmail' && req.kind !== 'reply' ? cleanSubject(output.subject ?? '') || null : null,
      body: output.body.trim(),
      ask: output.ask,
      hooks: output.hooks.filter((h) => h.text.trim() && h.sourceId.trim()),
      ...(req.via ? { via: { introducerId: req.via.introducerId, pathScore: req.via.pathScore } } : {}),
      sendWindow: window,
      promptVersion,
      variant: null,
    };
  } else {
    const t = templateMessage({
      req,
      user,
      person,
      target,
      introducer,
      goalKind,
      niche: playbook.niche,
      goalId: goal?.id ?? null,
      research,
      topic,
      window,
      replyClass,
      slots,
      answer,
      confirms,
      links: userContext.match(/^Links: (.+)$/m)?.[1]?.split(/\s+/) ?? [],
    });
    composed = t;
    promptVersion = t.promptVersion;
  }
  // an answer the student gave fills any marker the model still left; the reply never asks what was answered
  if (answer && askUserMarkers(composed.body).length)
    composed = { ...composed, body: composed.body.replace(ASK_USER, answer) };

  // the compliance footer on a sales first touch (§7.7, §14.3), outside what the validator counts
  let footer: string | undefined;
  if (salesFirstTouch) {
    const company = typeof user.settings.company === 'string' ? user.settings.company.trim() : '';
    footer = [[user.full_name ?? meFirst, company].filter(Boolean).join(', '), postal, OPT_OUT_LINE]
      .filter(Boolean)
      .join('\n');
  }
  const forCheck = composed.body.replace(ASK_USER, '').trim();
  const v = validateComposed({ ...composed, body: forCheck }, ctx);
  const markers = askUserMarkers(composed.body);
  const needs = markers.length ? ['answer'] : [];
  const issues = v.issues
    .filter((i) => i.blocking)
    .map((i) => `${i.code}: ${i.detail}`)
    .concat(markers.map((m) => `needs_input: ${m}`));
  const validator = { ok: v.ok && markers.length === 0, issues, words: v.words, grade: v.grade };
  const body = footer ? `${composed.body}\n\n${footer}` : composed.body;
  // times the model offered from the free hours count as offered too, so a "Tuesday at 2 works" books the call
  if (generatedBy === 'llm' && windows.length && !confirms) {
    const named = extractProposedTimes(composed.body, now, slotTz)
      .map((t) => new Date(t.startIso))
      .filter((d) => d.getTime() > now.getTime())
      .map((d) => ({
        start: d.toISOString(),
        end: new Date(d.getTime() + 30 * 60_000).toISOString(),
        label: '',
      }));
    for (const n of named) if (!slots.some((x) => x.start === n.start)) slots.push(n);
  }
  const meta: DraftMeta = {
    kind: composed.ask.kind,
    text: composed.ask.text,
    ...(replyTo ? { replyToMessageId: replyTo.id } : {}),
    ...(slots.length ? { slots: slots.map((x) => x.start) } : {}),
    ...(confirms ? { slots: [confirms.start], confirms } : {}),
    ...(req.reason ? { reason: req.reason } : {}),
    ...(footer ? { footer } : {}),
    ...(markers.length ? { question: markers[0] } : {}),
    ...(answer ? { answer } : {}),
  };
  const offeredSlots = confirms ? [confirms.start] : slots.length ? slots.map((x) => x.start) : null;
  const level = goal?.autonomy_level ?? user.autonomy_level ?? 0;
  const via = req.via ? { ...req.via } : null;
  const [row] = await db.sql<DraftRow>`
    insert into orbit.drafts (user_id, person_id, chat_id, goal_id, channel, kind, subject, body, ask, hooks, via,
                              thread_external_id, in_reply_to, status, autonomy_level, validator, generated_by,
                              prompt_version, variant, offered_slots, needs)
    values (${req.userId}::uuid, ${person.id}::uuid, ${chatId}::uuid, ${goal?.id ?? null}::uuid, ${req.channel},
            ${req.kind}, ${composed.subject}, ${body}, ${meta}::jsonb, ${JSON.stringify(composed.hooks)}::jsonb,
            ${via}::jsonb, ${thread.externalId}, ${replyTo?.rfc_message_id ?? replyTo?.external_id ?? null}, 'draft',
            ${level}::smallint, ${validator}::jsonb, ${generatedBy}, ${promptVersion}, null,
            ${offeredSlots ? JSON.stringify(offeredSlots) : null}::jsonb, ${needs}::text[])
    returning *`;
  await db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${req.userId}::uuid, ${req.actor ?? 'user'}, 'draft.compose', 'drafts', ${row!.id},
            ${{ kind: req.kind, channel: req.channel, generated_by: generatedBy, attempts, issues: lastIssues.length, codes: [...new Set(lastIssues.map((i) => i.split(':')[0]))], detail: lastIssues.slice(0, 4).map((i) => i.slice(0, 140)), niche: playbook.niche, hash: messageHash({ channel: req.channel, subject: composed.subject, body }) }}::jsonb)`;
  return {
    draft: row!,
    composed: { ...composed, id: row!.id, body, validator },
    attempts,
  };
}

/** The student's own links (GitHub, a portfolio, LinkedIn) in their context, which a message may use. */
export function linksIn(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s,;)|]+/g) ?? [])].map((u) => u.replace(/[.]+$/, ''));
}

function wordRangeText(kind: MessageKind, goal: GoalKind, niche: Niche): string {
  const [min, max] = wordRange(kind, goal, niche);
  return `${min}–${max}`;
}

/** What the message is about when the caller does not say: the goal's role, its topic, else (for goals about a
 * subject rather than a role) its title. */
function goalTopic(goal: GoalRow | undefined): string | undefined {
  if (!goal) return undefined;
  const t = (goal.targets ?? {}) as Record<string, string[]>;
  const c = (goal.criteria ?? {}) as Record<string, unknown>;
  if (t.roles?.[0]) return t.roles[0];
  if (typeof c.topic === 'string' && c.topic.trim()) return c.topic.trim();
  return ['collaboration', 'community', 'cofounder', 'advice'].includes(goal.kind) ? goal.title : undefined;
}

/** Goals where the user writes on behalf of their company (the template's company, pitch and traction lines). */
const BUSINESS_GOALS = new Set(['sales', 'fundraising', 'hiring', 'cofounder']);

/** Every blocking issue in a model answer, as text for the retry turn; empty when it can be stored. */
export function checkComposed(
  out: ComposeOutput,
  req: Pick<ComposeRequest, 'kind' | 'channel'>,
  ctx: Parameters<typeof validateComposed>[1],
  research: Pick<Research, 'ids'>,
): string[] {
  const body = out.body.replace(ASK_USER, '').trim();
  const v = validateComposed(
    {
      kind: req.kind,
      channel: req.channel,
      subject: req.channel === 'gmail' && req.kind !== 'reply' ? out.subject : null,
      body,
      hooks: out.hooks,
      ask: out.ask,
    },
    ctx,
  );
  const issues = v.issues.filter((i) => i.blocking).map((i) => `${i.code}: ${i.detail}`);
  const known = new Set(research.ids);
  for (const h of out.hooks)
    if (h.sourceId.trim() && !known.has(h.sourceId.trim()))
      issues.push(`hook_source: ${h.sourceId} is not a source id in <research>`);
  return issues;
}

// ---- inputs ----------------------------------------------------------------------------------------------------

type GoalRow = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  targets: unknown;
  criteria?: unknown;
  autonomy_level: number | null;
};

async function resolveGoal(
  db: Db,
  userId: string,
  goalId: string | null,
  chatId: string | null,
  personId: string,
): Promise<GoalRow | undefined> {
  if (goalId) {
    const [g] = await db.sql<GoalRow>`
      select id, kind, title, description, targets, criteria, autonomy_level from orbit.goals
       where id = ${goalId}::uuid and user_id = ${userId}::uuid and deleted_at is null`;
    if (!g) throw new HttpError(404, 'not_found', 'no such goal');
    return g;
  }
  const [g] = await db.sql<GoalRow>`
    select g.id, g.kind, g.title, g.description, g.targets, g.criteria, g.autonomy_level
      from orbit.chats c join orbit.goals g on g.id = c.goal_id
     where c.user_id = ${userId}::uuid and g.deleted_at is null
       and (c.id = ${chatId}::uuid or (${chatId}::uuid is null and c.person_id = ${personId}::uuid))
     order by c.updated_at desc limit 1`;
  return g;
}

async function chatFor(
  db: Db,
  userId: string,
  personId: string,
  goalId: string | null,
): Promise<string | null> {
  const [c] = await db.sql<{ id: string }>`
    select id from orbit.chats
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and archived_at is null
     order by (goal_id is not distinct from ${goalId}::uuid) desc, updated_at desc limit 1`;
  return c?.id ?? null;
}

/** Messages with the person on any channel, plus sent drafts sync has not seen yet: the unanswered count. */
export async function historyWith(
  db: Db,
  userId: string,
  personId: string,
): Promise<{ direction: 'in' | 'out'; at: string }[]> {
  const rows = await db.sql<{ direction: 'in' | 'out'; at: Date; external_id: string | null }>`
    select direction, sent_at as at, external_id from orbit.messages
     where user_id = ${userId}::uuid
       and (from_person_id = ${personId}::uuid or ${personId}::uuid = any(to_person_ids))
       and not is_automated
    union all
    select 'out' as direction, d.sent_at as at, d.provider_message_id as external_id from orbit.drafts d
     where d.user_id = ${userId}::uuid and d.person_id = ${personId}::uuid and d.status = 'sent'
       and d.kind <> 'forwardable_blurb' and d.sent_at is not null
       and not exists (select 1 from orbit.messages m where m.user_id = d.user_id
                        and m.external_id = d.provider_message_id)`;
  return rows.map((r) => ({ direction: r.direction, at: iso(r.at)! }));
}

type ReplyMessage = {
  id: string;
  thread_id: string;
  provider: 'gmail' | 'linkedin';
  external_id: string;
  rfc_message_id: string | null;
  from_person_id: string | null;
  reply_class: string | null;
  sent_at: Date;
  /** the student's answer to what the reply asked (plan 29 §B2.3) */
  answer: string | null;
};

export async function loadReplyMessage(db: Db, userId: string, messageId: string): Promise<ReplyMessage> {
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) throw new HttpError(400, 'bad_request', 'messageId is required');
  const [m] = await db.sql<ReplyMessage>`
    select id, thread_id, provider, external_id, rfc_message_id, from_person_id, reply_class, sent_at, answer
      from orbit.messages
     where id = ${messageId}::uuid and user_id = ${userId}::uuid and direction = 'in'`;
  if (!m) throw new HttpError(404, 'not_found', 'no such reply');
  return m;
}

/**
 * The thread as context: a reply sees the whole thread (≤ 8 messages, oldest first, quotes stripped); a bump sees the
 * message it follows up. Also the provider thread id the draft goes out on.
 */
async function threadContext(
  db: Db,
  userId: string,
  personId: string,
  kind: MessageKind,
  replyTo: ReplyMessage | undefined,
  channel: 'gmail' | 'linkedin',
): Promise<{ text: string; lastInbound?: string; externalId: string | null }> {
  let threadId = replyTo?.thread_id;
  if (
    !threadId &&
    (kind === 'bump' || kind === 'thank_you' || kind === 'schedule' || kind === 'report_back')
  ) {
    const [t] = await db.sql<{ id: string }>`
      select t.id from orbit.threads t
       where t.user_id = ${userId}::uuid and t.provider = ${channel}
         and ${personId}::uuid = any(t.participant_person_ids)
       order by t.last_at desc nulls last limit 1`;
    threadId = t?.id;
  }
  if (!threadId) return { text: '', externalId: null };
  const [t] = await db.sql<{ external_id: string; subject: string | null }>`
    select external_id, subject from orbit.threads where id = ${threadId}::uuid`;
  const msgs = await db.sql<{
    direction: 'in' | 'out';
    sent_at: Date;
    body_text: string | null;
    snippet: string | null;
  }>`
    select direction, sent_at, body_text, snippet from orbit.messages
     where thread_id = ${threadId}::uuid order by sent_at desc limit ${kind === 'reply' ? 8 : 2}::int`;
  const ordered = msgs.reverse();
  const lines = ordered.map(
    (m) =>
      `${iso(m.sent_at)!.slice(0, 16).replace('T', ' ')} ${m.direction === 'in' ? 'them' : 'user'}: ${stripQuotedReply(m.body_text ?? m.snippet ?? '').slice(0, 1500)}`,
  );
  const lastIn = [...ordered].reverse().find((m) => m.direction === 'in');
  return {
    text: [t?.subject ? `subject: ${t.subject}` : '', ...lines].filter(Boolean).join('\n'),
    lastInbound: lastIn
      ? stripQuotedReply(lastIn.body_text ?? lastIn.snippet ?? '').slice(0, 500)
      : undefined,
    externalId: t?.external_id ?? null,
  };
}

// ---- template fallback ---------------------------------------------------------------------------------------

const TEMPLATE_KIND: Partial<Record<MessageKind, ComposeKind>> = {
  outreach: 'first_touch',
  referral_ask: 'intro_request',
  nurture: 'reengage',
  congratulate: 'reengage',
  report_back: 'reengage',
  schedule: 'bump',
};

/** Niches whose template leads with the student's proof of work. */
const PROOF_NICHES: ReadonlySet<Niche> = new Set(['startup_job', 'research_position', 'tech_recruiting']);

/** "your point about X" from an opener sentence, for the template's hook slot. */
function hookPhrase(text: string): string {
  const t = text
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/\s+(stuck with me|caught my eye|resonated with me)$/i, '');
  return /^(Your|The|A|An|I)\b/.test(t) && !/^I\b/.test(t) ? t[0]!.toLowerCase() + t.slice(1) : t;
}

function templateMessage(p: {
  req: ComposeRequest;
  user: UserRow;
  person: PersonRow;
  target?: PersonRow;
  introducer?: PersonRow;
  goalKind: GoalKind;
  niche: Niche;
  goalId: string | null;
  research: Research;
  topic?: string;
  window: { notBefore: string; tz: string };
  replyClass?: ReplyClass;
  slots: Slot[];
  answer?: string;
  confirms?: { start: string; label: string };
  /** the student's own links from their resume (GitHub first) */
  links?: string[];
}): Omit<ComposedMessage, 'validator'> {
  const { req, user, person } = p;
  const me = userFirstName(user);
  if (req.kind === 'reply') return replyTemplate(p, me);
  const kind: ComposeKind = (COMPOSE_KINDS as readonly string[]).includes(req.kind)
    ? (req.kind as ComposeKind)
    : (TEMPLATE_KIND[req.kind] ?? 'first_touch');
  const opener = p.research.openers[0];
  const s = user.settings;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const about =
    user.current_title && user.current_org
      ? `${user.current_title} at ${user.current_org}`
      : user.school
        ? `a student at ${user.school}`
        : undefined;
  const input: ComposeTemplateInput = {
    kind,
    goal: p.goalKind,
    channel: req.channel,
    personId: person.id,
    goalId: p.goalId,
    user: {
      firstName: me,
      school: user.school ?? undefined,
      about,
      company: BUSINESS_GOALS.has(p.goalKind) ? str(s.company) : undefined,
      pitch: BUSINESS_GOALS.has(p.goalKind)
        ? str(s.pitch)
        : p.goalKind === 'collaboration'
          ? str(s.research_topic)
          : undefined,
      traction: p.goalKind === 'fundraising' ? str(s.traction) : undefined,
      // the proof of work a startup or a lab note leads with, in the student's own words
      ...(PROOF_NICHES.has(p.niche)
        ? {
            proof: str((s.about as { proudOf?: unknown } | undefined)?.proudOf),
            link:
              p.links?.find((l) => /github\.com/i.test(l)) ?? p.links?.find((l) => !/linkedin\.com/i.test(l)),
          }
        : {}),
    },
    recipient: {
      firstName: firstNameOf(person),
      lastName: lastNameOf(person),
      org: personOrg(person),
      title: person.title ?? undefined,
    },
    niche: p.niche,
    hook: opener ? { text: hookPhrase(opener.text), sourceId: opener.id } : undefined,
    topic: p.topic,
    via:
      p.introducer && p.req.via
        ? {
            introducerId: p.introducer.id,
            introducerFirstName: firstNameOf(p.introducer),
            pathScore: p.req.via.pathScore,
          }
        : undefined,
    target: p.target ? { firstName: firstNameOf(p.target), org: personOrg(p.target) } : undefined,
    sendWindow: p.window,
  };
  const out = composeFallback(input);
  return { ...out, kind: req.kind, goalId: p.goalId };
}

/** A reply without a model: offer the free slots, thank, or ask the user for the answer (§8.6 fallback). */
function replyTemplate(
  p: {
    req: ComposeRequest;
    person: PersonRow;
    goalId: string | null;
    window: { notBefore: string; tz: string };
    niche?: Niche;
    replyClass?: ReplyClass;
    slots: Slot[];
    answer?: string;
    confirms?: { start: string; label: string };
  },
  me: string,
): Omit<ComposedMessage, 'validator'> {
  // a professor keeps the title the first note used (the niche's greeting rule)
  const academic = p.niche === 'research_position' || p.niche === 'research_collaboration';
  const last = lastNameOf(p.person);
  const hi =
    academic && last && /\bprofessor\b/i.test(p.person.title ?? '')
      ? `Dear Professor ${last},`
      : `${academic ? 'Dear' : 'Hi'} ${firstNameOf(p.person)},`;
  const sign = `Best,\n${me}`;
  let middle: string;
  let ask: ComposedMessage['ask'] = { kind: 'none', text: '' };
  if (p.confirms) {
    // the call is booked: confirm that time and nothing else
    middle = `${p.confirms.label} works for me, and the calendar invite is on its way. Looking forward to it.`;
    return {
      id: '',
      goalId: p.goalId,
      personId: p.person.id,
      kind: 'reply',
      channel: p.req.channel,
      subject: null,
      body: [hi, middle, sign].join('\n\n'),
      ask,
      hooks: [],
      sendWindow: p.window,
      promptVersion: 'template-v2',
      variant: null,
    };
  }
  if (p.answer) {
    // the student answered what was asked: their words carry the reply
    middle = `Thanks for asking. ${p.answer.replace(/[.!?]*$/, '')}. Happy to say more whenever works for you.`;
    return {
      id: '',
      goalId: p.goalId,
      personId: p.person.id,
      kind: 'reply',
      channel: p.req.channel,
      subject: null,
      body: [hi, middle, sign].join('\n\n'),
      ask,
      hooks: [],
      sendWindow: p.window,
      promptVersion: 'template-v2',
      variant: null,
    };
  }
  switch (p.replyClass) {
    case 'interested':
    case 'scheduling':
      if (p.slots.length) {
        ask = { kind: 'call', text: 'Would any of these times work for you?' };
        middle = `Thanks for getting back to me. ${ask.text}\n\n${p.slots
          .slice(0, 3)
          .map((x) => `- ${x.label}`)
          .join('\n')}`;
      } else {
        ask = { kind: 'call', text: 'What times work best for you over the next week or so?' };
        middle = `Thanks for getting back to me. ${ask.text} I'm happy to work around your schedule.`;
      }
      break;
    case 'thanks':
    case 'out_of_office':
      middle = 'Thank you, I really appreciate it. I will keep you posted on how things go.';
      break;
    case 'decline':
    case 'not_now':
    case 'objection':
      middle = 'Thanks for letting me know, I understand. I appreciate you taking the time to reply.';
      break;
    case 'referral':
      middle =
        "Thank you for pointing me in the right direction. I'll reach out to them, and I'll let you know how it goes.";
      break;
    default:
      middle =
        'Thanks for your note, I really appreciate it. Happy to go into more detail whenever works for you.';
  }
  return {
    id: '',
    goalId: p.goalId,
    personId: p.person.id,
    kind: 'reply',
    channel: p.req.channel,
    subject: null,
    body: [hi, middle, sign].join('\n\n'),
    ask,
    hooks: [],
    sendWindow: p.window,
    promptVersion: 'template-v2',
    variant: null,
  };
}
