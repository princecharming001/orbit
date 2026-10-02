import type {
  Brief,
  CoffeeChat,
  DraftContext,
  EmailMessage,
  MessageKind,
  OutboundMessage,
  Person,
  PersonFact,
  Suggestion,
  SuggestionKind,
  User,
} from '@orbit/core';
import {
  buildWarmUpPlan,
  type Candidate,
  defaultStyleCard,
  generateCandidates,
  generateDraft,
  linkedinMessageUrl,
  newId,
  selectForBrief,
  suggestionFromCandidate,
  todayKey,
  validateDraft,
  warmUpProgress,
} from '@orbit/core';
import { feedback, notify, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmDraft, llmSummary } from '../integrations/anthropic';
import { bestPathStrength, buildReachGraph } from './graph';
import { runTimedStageRules } from './stages';

const DAY = 86_400_000;

async function ruleInput(userId: string, now: Date, scope?: { chatId?: string; personId?: string }) {
  const [
    settings,
    people,
    allChats,
    events,
    actionItems,
    facts,
    targetCompanies,
    recommendations,
    outbound,
    feedbackRows,
  ] = await Promise.all([
    db.settings.get(userId),
    db.people.where('userId').equals(userId).toArray(),
    db.chats.where('userId').equals(userId).toArray(),
    db.events.where('userId').equals(userId).toArray(),
    db.actionItems.where('userId').equals(userId).toArray(),
    db.facts.where('userId').equals(userId).toArray(),
    db.targetCompanies.where('userId').equals(userId).toArray(),
    db.recommendations.where('userId').equals(userId).toArray(),
    db.outbound.where('userId').equals(userId).toArray(),
    db.feedback.where('userId').equals(userId).toArray(),
  ]);
  const chats = scope?.chatId
    ? allChats.filter((c) => c.id === scope.chatId)
    : scope?.personId
      ? allChats.filter((c) => c.personId === scope.personId)
      : allChats;
  const lastInboundByChat = new Map<string, EmailMessage>();
  for (const c of chats) {
    if (!c.threadId) continue;
    const msgs = await db.messages.where('threadId').equals(c.threadId).toArray();
    const last = msgs
      .filter((m) => m.direction === 'inbound' && !m.isAutomated)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    if (last) lastInboundByChat.set(c.id, last);
  }
  const factsByPerson = new Map<string, PersonFact[]>();
  for (const f of facts) {
    if (f.deletedAt) continue;
    const arr = factsByPerson.get(f.personId) ?? [];
    arr.push(f);
    factsByPerson.set(f.personId, arr);
  }
  const dismissCounts = new Map<string, number>();
  const cutoff = now.getTime() - 60 * DAY;
  for (const fb of feedbackRows) {
    if (fb.kind !== 'dismiss' || new Date(fb.createdAt).getTime() < cutoff || !fb.suggestionId) continue;
    const key = (fb.reason ?? '').split('|')[1] ?? '';
    if (key) dismissCounts.set(key, (dismissCounts.get(key) ?? 0) + 1);
  }
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const outreachSentThisWeek = outbound.filter(
    (o) => o.status === 'sent' && o.kind === 'outreach' && o.sentAt && new Date(o.sentAt) >= weekStart,
  ).length;
  const recentlyContacted = new Set(
    outbound
      .filter(
        (o) => o.status === 'sent' && o.sentAt && now.getTime() - new Date(o.sentAt).getTime() < 30 * DAY,
      )
      .map((o) => o.personId),
  );
  const s = settings ?? {
    userId,
    briefTimeLocal: '07:00',
    briefChannels: ['in_app' as const],
    quietDays: [],
    weeklyOutreachTarget: 4,
    dailySendCapGmail: 15,
    dailySendCapLinkedin: 10,
    perPersonCooldownHours: 72,
    maxBumps: 2,
    tonePreset: 'warm' as const,
    warmUpEnabled: true,
    warmUpDays: 4,
  };
  return {
    userId,
    now,
    settings: s,
    people: new Map(people.map((p) => [p.id, p])),
    chats: scope ? chats : allChats,
    lastInboundByChat,
    events: scope
      ? events.filter((e) => !scope.personId || e.attendeePersonIds.includes(scope.personId))
      : events,
    actionItems,
    factsByPerson,
    targetCompanies,
    recommendations,
    dismissCounts,
    outreachSentThisWeek,
    freeSlotsIso: freeSlots(events, now),
    recentlyContacted,
  };
}

/** Two free 30-minute windows in the next 5 working days, 10:00–17:00 local, avoiding existing events. */
export function freeSlots(events: { startAt: string; endAt: string; status: string }[], now: Date): string[] {
  const out: string[] = [];
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 10 && out.length < 2; i++) {
    if (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() + 1);
      continue;
    }
    for (const hour of [10, 14, 16]) {
      const s = new Date(d);
      s.setHours(hour, 0, 0, 0);
      const e = new Date(s.getTime() + 30 * 60_000);
      const busy = events.some(
        (ev) => ev.status !== 'cancelled' && new Date(ev.startAt) < e && new Date(ev.endAt) > s,
      );
      if (!busy) {
        out.push(s.toISOString());
        break;
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export async function upsertSuggestions(
  userId: string,
  cands: (Candidate & { priorityScore: number })[],
  now: Date,
  briefId?: string,
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  for (const c of cands) {
    const existing = await db.suggestions.where('dedupeKey').equals(c.dedupeKey).first();
    if (existing) {
      if (['pending', 'snoozed'].includes(existing.status)) {
        if (existing.status === 'snoozed' && existing.snoozedUntil && new Date(existing.snoozedUntil) > now)
          continue;
        await db.suggestions.update(existing.id, {
          status: 'pending',
          priorityScore: c.priorityScore,
          reasonText: c.reasonText,
          signals: c.signals,
          payload: { ...existing.payload, ...c.payload },
          briefId: briefId ?? existing.briefId,
          expiresAt: new Date(now.getTime() + 2 * DAY).toISOString(),
        });
        out.push({
          ...existing,
          status: 'pending',
          priorityScore: c.priorityScore,
          briefId: briefId ?? existing.briefId,
        });
      }
      continue; // decided ones are never recreated
    }
    const s = suggestionFromCandidate(c, userId, now, newId('s'));
    s.briefId = briefId;
    await db.suggestions.add(s);
    out.push(s);
  }
  return out;
}

const DRAFT_KIND: Partial<Record<SuggestionKind, MessageKind>> = {
  new_outreach: 'outreach',
  follow_up_bump: 'bump',
  schedule_propose: 'schedule',
  schedule_confirm: 'reply',
  thank_you: 'thank_you',
  nurture_checkin: 'nurture',
  reconnect: 'nurture',
  congratulate: 'congratulate',
  ask_referral: 'referral_ask',
  intro_request: 'intro_request',
};

export async function buildDraftContext(
  user: User,
  person: Person,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  s?: Suggestion,
): Promise<DraftContext> {
  const [goals, settings, style, facts, resumeFacets, chat] = await Promise.all([
    db.goals.get(user.id),
    db.settings.get(user.id),
    db.styles.get(user.id),
    db.facts
      .where('personId')
      .equals(person.id)
      .filter((f) => !f.deletedAt)
      .toArray(),
    db.resumeFacets.toArray(),
    s?.chatId
      ? db.chats.get(s.chatId)
      : db.chats
          .where('personId')
          .equals(person.id)
          .filter((c) => !['archived'].includes(c.stage))
          .first(),
  ]);
  const summary = resumeFacets.find((f) => f.kind === 'summary')?.text;
  let thread: DraftContext['thread'];
  if (chat?.threadId) {
    const msgs = await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt');
    const lastIn = [...msgs].reverse().find((m) => m.direction === 'inbound');
    const firstOut = msgs.find((m) => m.direction === 'outbound');
    thread = {
      lastInboundBody: lastIn?.bodyText,
      lastInboundAt: lastIn?.sentAt,
      firstOutboundAt: firstOut?.sentAt ?? chat.firstOutreachAt,
      asksOfUser: lastIn?.extraction?.asksOfUser,
      proposedTimes: lastIn?.extraction?.proposedTimes.map((t) => ({ startIso: t.startIso, raw: t.raw })),
    };
  }
  const tcId = s?.payload.targetCompanyId as string | undefined;
  const tc = tcId ? await db.targetCompanies.get(tcId) : undefined;
  const target = s?.payload.target as DraftContext['target'] | undefined;
  const windows = (s?.payload.windows as string[] | undefined)?.map((w) => ({ startIso: w }));
  const warm = chat?.warmUp ? warmUpProgress(chat.warmUp, new Date()) : undefined;
  return {
    user: {
      firstName: user.firstName,
      fullName: user.fullName,
      school: user.school,
      gradYear: user.graduationYear,
      majors: user.majors,
      cycleLabel: goals?.cycleLabel ?? 'this recruiting cycle',
      targetFunctions: goals?.targetFunctions ?? [],
      oneLiner: summary
        ? summary
            .replace(/^.*? is /, `${user.firstName} is `)
            .replace(/\.$/, '')
            .replace(new RegExp(`^${user.firstName} is `), '')
        : undefined,
      schedulingLink: settings?.schedulingLink,
      timezone: user.timezone,
    },
    styleCard: style?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName),
    person: {
      firstName: person.firstName,
      fullName: person.displayName,
      title: person.currentTitle,
      org: person.currentOrganizationRaw,
      isAlumni: person.isAlumni,
      relationshipType: person.relationshipType,
      strength: person.strength,
    },
    facts: facts.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '')).slice(0, 15),
    kind,
    channel,
    proposedWindows: windows,
    thread,
    target,
    reason: s?.reasonText,
    warmUpContext: warm && warm.done >= 2 ? "I've enjoyed your recent posts." : undefined,
    targetCompany: tc ? { name: tc.nameRaw, roleLabel: goals?.targetRoles[0] } : undefined,
  };
}

export async function draftForSuggestion(
  user: User,
  s: Suggestion,
  now = new Date(),
): Promise<OutboundMessage | undefined> {
  const kind = DRAFT_KIND[s.kind];
  if (!kind || !s.personId) return undefined;
  const person = await db.people.get(s.personId);
  if (!person) return undefined;
  const channel: 'gmail' | 'linkedin' =
    (s.payload.channel as 'gmail' | 'linkedin' | undefined) ?? (person.primaryEmail ? 'gmail' : 'linkedin');
  const ctx = await buildDraftContext(user, person, kind, channel, s);
  const template = generateDraft(ctx);
  let out = template;
  let generatedBy: OutboundMessage['generatedBy'] = 'template';
  if (hasLlm()) {
    const llm = await llmDraft(ctx, template).catch(() => undefined);
    if (llm) {
      const issues = validateDraft(llm, {
        kind,
        facts: ctx.facts,
        allowedUrls: [ctx.user.schedulingLink ?? '', user.linkedinUrl ?? ''].filter(Boolean),
        recipientEmail: person.primaryEmail,
        recipientFirstName: person.firstName,
      });
      if (!issues.length) {
        out = llm;
        generatedBy = 'llm';
      }
    }
  }
  const chat = s.chatId ? await db.chats.get(s.chatId) : undefined;
  let externalThreadId: string | undefined;
  let inReplyTo: string | undefined;
  if (chat?.threadId && kind !== 'outreach') {
    const th = await db.threads.get(chat.threadId);
    externalThreadId = th?.externalThreadId;
    const last = (await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt')).pop();
    inReplyTo = last?.headers['message-id'];
  }
  const msg: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId: person.id,
    chatId: s.chatId,
    suggestionId: s.id,
    channel,
    kind,
    externalThreadId,
    inReplyToMessageId: inReplyTo,
    toEmail: person.primaryEmail,
    toLinkedinUrl: person.linkedinUrl,
    subject: out.subject ?? (externalThreadId ? undefined : `Quick question`),
    bodyDraft: channel === 'linkedin' && kind === 'outreach' && out.bodyShort ? out.bodyShort : out.body,
    status: 'draft',
    generatedBy,
    claims: out.claims,
    createdAt: now.toISOString(),
  };
  await db.outbound.add(msg);
  await db.suggestions.update(s.id, { outboundMessageId: msg.id });
  return msg;
}

export async function draftMessage(
  user: User,
  personId: string,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  chatId?: string,
): Promise<OutboundMessage> {
  const person = (await db.people.get(personId))!;
  const ctx = await buildDraftContext(user, person, kind, channel);
  const template = generateDraft(ctx);
  let out = template;
  let generatedBy: OutboundMessage['generatedBy'] = 'template';
  if (hasLlm()) {
    const llm = await llmDraft(ctx, template).catch(() => undefined);
    if (
      llm &&
      !validateDraft(llm, {
        kind,
        facts: ctx.facts,
        allowedUrls: [ctx.user.schedulingLink ?? ''],
        recipientEmail: person.primaryEmail,
        recipientFirstName: person.firstName,
      }).length
    ) {
      out = llm;
      generatedBy = 'llm';
    }
  }
  const chat = chatId
    ? await db.chats.get(chatId)
    : await db.chats
        .where('personId')
        .equals(personId)
        .filter((c) => c.stage !== 'archived')
        .first();
  const th = chat?.threadId ? await db.threads.get(chat.threadId) : undefined;
  const msg: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId,
    chatId: chat?.id,
    channel,
    kind,
    externalThreadId: kind === 'outreach' ? undefined : th?.externalThreadId,
    toEmail: person.primaryEmail,
    toLinkedinUrl: person.linkedinUrl,
    subject: out.subject,
    bodyDraft: channel === 'linkedin' && kind === 'outreach' && out.bodyShort ? out.bodyShort : out.body,
    status: 'draft',
    generatedBy,
    claims: out.claims,
    createdAt: new Date().toISOString(),
  };
  await db.outbound.add(msg);
  return msg;
}

/** ⚡ rules: run the rule engine for one chat/person right away (reply received, note ingested, event changed). */
export async function evaluateImmediateSuggestions(
  userId: string,
  scope: { chatId?: string; personId?: string },
  now = new Date(),
): Promise<void> {
  const user = await db.users.get(userId);
  if (!user || !user.onboardingCompletedAt) return;
  const inp = await ruleInput(userId, now, scope);
  const cands = generateCandidates(inp).filter((c) =>
    [
      'thank_you',
      'schedule_propose',
      'schedule_confirm',
      'prep_brief',
      'warm_up_engage',
      'ask_referral',
    ].includes(c.kind),
  );
  const scored = selectForBrief(cands, inp.dismissCounts, 5);
  const created = await upsertSuggestions(userId, scored, now);
  for (const s of created)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  await addConfirmationCards(userId, now);
}

async function addConfirmationCards(userId: string, now: Date): Promise<void> {
  const proposed = await db.stageEvents
    .where('userId')
    .equals(userId)
    .filter((e) => e.status === 'proposed')
    .toArray();
  for (const e of proposed) {
    const chat = await db.chats.get(e.chatId);
    const person = chat ? await db.people.get(chat.personId) : undefined;
    if (!chat || !person) continue;
    await upsertSuggestions(
      userId,
      [
        {
          kind: 'confirm_stage',
          personId: person.id,
          chatId: chat.id,
          dedupeKey: `stage:${e.id}`,
          reasonText: `Looks like ${person.firstName} ${describeStage(e.toStage)}. Move to ${e.toStage.replace('_', ' ')}?`,
          signals: { confidence: e.confidence },
          payload: { stageEventId: e.id, toStage: e.toStage },
          urgency: 0.85,
          goalRelevance: 0.5,
          confidence: e.confidence ?? 0.7,
          priorityScore: 0.6,
        },
      ],
      now,
    );
  }
  const merges = await db.merges
    .where('userId')
    .equals(userId)
    .filter((m) => m.status === 'pending')
    .toArray();
  for (const m of merges) {
    const [a, b] = await Promise.all([db.people.get(m.personAId), db.people.get(m.personBId)]);
    if (!a || !b) continue;
    await upsertSuggestions(
      userId,
      [
        {
          kind: 'confirm_merge',
          personId: a.id,
          dedupeKey: `merge:${m.id}`,
          reasonText: `Are ${a.displayName} and ${b.displayName} the same person?`,
          signals: { score: m.score },
          payload: { mergeId: m.id, otherPersonId: b.id },
          urgency: 0.4,
          goalRelevance: 0.3,
          confidence: m.score,
          priorityScore: 0.25,
        },
      ],
      now,
    );
  }
  const unmatched = await db.notes
    .where('userId')
    .equals(userId)
    .filter((n) => n.matchStatus === 'unmatched')
    .toArray();
  for (const n of unmatched) {
    await upsertSuggestions(
      userId,
      [
        {
          kind: 'confirm_note_match',
          dedupeKey: `note:${n.id}`,
          reasonText: `Who was "${n.title ?? 'this note'}" with?`,
          signals: {},
          payload: { noteId: n.id },
          urgency: 0.5,
          goalRelevance: 0.3,
          confidence: 1,
          priorityScore: 0.3,
        },
      ],
      now,
    );
  }
}

function describeStage(stage: string): string {
  return (
    {
      replied: 'replied',
      scheduling: 'wants to schedule',
      scheduled: 'is booked',
      completed: 'met with you',
      declined: 'declined',
      no_response: 'went quiet',
    }[stage] ?? `moved to ${stage}`
  );
}

export async function generateBrief(user: User, kind: Brief['kind'], now = new Date()): Promise<Brief> {
  const briefDate = todayKey(now, user.timezone);
  const existing = await db.briefs
    .where('[userId+kind+briefDate]')
    .equals([user.id, kind, briefDate])
    .first();
  const settings = await db.settings.get(user.id);
  await runTimedStageRules(user.id, settings?.maxBumps ?? 2, now);
  await recomputeAllStrengths(user.id, now);
  const inp = await ruleInput(user.id, now);
  const cands = generateCandidates(inp);
  const selected = selectForBrief(cands, inp.dismissCounts, 7);
  const briefId = existing?.id ?? newId('b');
  const sugg = await upsertSuggestions(user.id, selected, now, briefId);
  await addConfirmationCards(user.id, now);
  for (const s of sugg)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  // carry-over / expiry of older pending suggestions
  const pending = await db.suggestions
    .where('userId')
    .equals(user.id)
    .filter((s) => s.status === 'pending' && s.briefId !== briefId && !!s.briefId)
    .toArray();
  for (const s of pending) {
    if (s.carriedOver >= 1) {
      await db.suggestions.update(s.id, { status: 'expired', decidedAt: now.toISOString() });
      await feedback(user.id, 'expire', { suggestionId: s.id });
    } else await db.suggestions.update(s.id, { carriedOver: s.carriedOver + 1 });
  }
  const upcoming = inp.events.filter(
    (e) =>
      e.status !== 'cancelled' &&
      e.isCoffeeChat &&
      new Date(e.startAt) > now &&
      new Date(e.startAt).getTime() - now.getTime() < 7 * DAY,
  );
  const counts = new Map<string, number>();
  for (const s of sugg) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts: string[] = [];
  const label = (k: string, n: number) =>
    ({
      follow_up_bump: `${n} follow-up${n > 1 ? 's' : ''}`,
      thank_you: `${n} thank-you${n > 1 ? 's' : ''}`,
      schedule_propose: `${n} to schedule`,
      schedule_confirm: `${n} time to confirm`,
      prep_brief: `${n} chat to prep`,
      warm_up_engage: `${n} LinkedIn warm-up${n > 1 ? 's' : ''}`,
      new_outreach: `${n} new ${n > 1 ? 'people' : 'person'} to message`,
      nurture_checkin: `${n} check-in`,
      reconnect: `${n} reconnect`,
      ask_referral: `${n} referral ask`,
      action_item_reminder: `${n} promise to keep`,
      intro_request: `${n} intro ask`,
      confirm_stage: `${n} to confirm`,
    })[k] ?? `${n} ${k.replace(/_/g, ' ')}`;
  for (const [k, n] of counts) parts.push(label(k, n));
  const summaryText = sugg.length
    ? `${parts.join(', ')}${upcoming.length ? `; ${upcoming.length} chat${upcoming.length > 1 ? 's' : ''} coming up this week` : ''}.`
    : upcoming.length
      ? `Nothing to send today. ${upcoming.length} chat${upcoming.length > 1 ? 's' : ''} coming up this week.`
      : 'Nothing to do today — your network is in good shape.';
  const brief: Brief = {
    id: briefId,
    userId: user.id,
    kind,
    briefDate,
    generatedAt: now.toISOString(),
    suggestionIds: sugg.map((s) => s.id),
    summaryText,
    stats: { candidates: cands.length, shown: sugg.length, upcoming: upcoming.length },
  };
  await db.briefs.put(brief);
  if (!existing)
    await notify(
      user.id,
      'brief',
      kind === 'welcome' ? 'Your first brief is ready' : `Today: ${summaryText}`,
      undefined,
      '/today',
    );
  return brief;
}

export async function refreshPersonSummary(user: User, personId: string): Promise<void> {
  const person = await db.people.get(personId);
  if (!person) return;
  const facts = (await db.facts.where('personId').equals(personId).toArray()).filter((f) => !f.deletedAt);
  const tps = (await db.touchpoints.where('personId').equals(personId).toArray())
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 10);
  const goals = await db.goals.get(user.id);
  let summary: string | undefined;
  let talkingPoints: string[] | undefined;
  if (hasLlm() && (facts.length || tps.length)) {
    const r = await llmSummary(
      person.displayName,
      facts.map((f) => ({ type: f.type, text: f.text })),
      tps.map((t) => `${t.occurredAt.slice(0, 10)}: ${t.summary ?? t.kind}`),
      goals?.cycleLabel ?? '',
    ).catch(() => undefined);
    if (r) {
      summary = r.summary;
      talkingPoints = r.talkingPoints;
    }
  }
  if (!summary) {
    const role =
      person.currentTitle && person.currentOrganizationRaw
        ? `${person.currentTitle} at ${person.currentOrganizationRaw}`
        : (person.headline ?? 'a contact');
    const adv = facts.find((f) => f.type === 'advice');
    const off = facts.find((f) => f.type === 'offer');
    const hook = facts.find((f) => f.type === 'hook');
    const n = tps.length;
    summary = `${person.firstName} is ${role}${person.isAlumni ? ` and a ${user.school} alum` : ''}. ${n ? `You have ${n} recent interaction${n === 1 ? '' : 's'}, most recently ${tps[0]!.occurredAt.slice(0, 10)}.` : 'No interactions yet.'}${adv ? ` Advice: ${adv.text.replace(/\.$/, '')}.` : ''}${off ? ` They offered: ${off.text.replace(/\.$/, '')}.` : ''}`;
    talkingPoints = [
      hook ? `Ask about: ${hook.text}` : undefined,
      off ? `Follow up on their offer: ${off.text}` : undefined,
      adv ? `Report back on their advice: ${adv.text}` : undefined,
      person.currentOrganizationRaw
        ? `What's changed at ${person.currentOrganizationRaw} recently`
        : undefined,
    ]
      .filter((x): x is string => !!x)
      .slice(0, 5);
  }
  await db.people.update(personId, { summary, summaryUpdatedAt: new Date().toISOString(), talkingPoints });
}

export async function startWarmUpOrOutreach(
  user: User,
  personId: string,
  channel: 'gmail' | 'linkedin',
  source: CoffeeChat['source'] = 'manual',
): Promise<{ chat: CoffeeChat; draft?: OutboundMessage }> {
  const settings = await db.settings.get(user.id);
  const person = (await db.people.get(personId))!;
  const now = new Date();
  let chat = await db.chats
    .where('personId')
    .equals(personId)
    .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
    .first();
  const cold =
    person.strength < 0.2 &&
    channel === 'linkedin' &&
    !!person.linkedinSlug &&
    (settings?.warmUpEnabled ?? true);
  if (!chat) {
    chat = {
      id: newId('c'),
      userId: user.id,
      personId,
      organizationId: person.currentOrganizationId,
      stage: cold ? 'warming' : 'identified',
      stageEnteredAt: now.toISOString(),
      source,
      goalTags: [],
      outreachChannel: channel,
      bumpCount: 0,
      priority: 2,
      warmUp: cold ? buildWarmUpPlan(person.linkedinSlug!, now, settings?.warmUpDays ?? 4) : undefined,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await db.chats.add(chat);
    await db.stageEvents.add({
      id: newId('se'),
      userId: user.id,
      chatId: chat.id,
      toStage: chat.stage,
      status: 'applied',
      actor: 'user',
      reason: cold ? 'warmup:started' : 'user:start',
      createdAt: now.toISOString(),
      decidedAt: now.toISOString(),
    });
  }
  await db.recommendations.where('personId').equals(personId).modify({ status: 'converted' });
  if (chat.stage === 'warming') {
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId }, now);
    return { chat };
  }
  const draft = await draftMessage(user, personId, 'outreach', channel, chat.id);
  return { chat, draft };
}

export async function markWarmUpAction(
  userId: string,
  chatId: string,
  actionId: string,
  done: boolean,
): Promise<void> {
  const chat = await db.chats.get(chatId);
  if (!chat?.warmUp) return;
  const now = new Date().toISOString();
  const actions = chat.warmUp.actions.map((a) =>
    a.id === actionId ? { ...a, doneAt: done ? now : a.doneAt, skippedAt: done ? a.skippedAt : now } : a,
  );
  await db.chats.update(chatId, { warmUp: { ...chat.warmUp, actions }, updatedAt: now });
  if (done) {
    await db.touchpoints.add({
      id: newId('tp'),
      userId,
      personId: chat.personId,
      kind: 'linkedin_engaged',
      occurredAt: now,
      refTable: 'warmup',
      refId: `${chatId}:${actionId}`,
      summary: 'Engaged with their LinkedIn activity',
      weight: 0.15,
    });
  }
  await feedback(userId, done ? 'warmup_done' : 'warmup_skip', {
    refTable: 'chats',
    refId: chatId,
    reason: actionId,
  });
  await db.suggestions
    .where('dedupeKey')
    .equals(`warm:${chatId}:${actionId}`)
    .modify({ status: 'done', decidedAt: now });
  const user = await db.users.get(userId);
  if (user) await evaluateImmediateSuggestions(userId, { chatId, personId: chat.personId });
}

export async function recommendationsRefresh(user: User, now = new Date()): Promise<number> {
  const { recommendPeople } = await import('@orbit/core');
  const [goals, targetCompanies, resumeFacets, people, chats, existing] = await Promise.all([
    db.goals.get(user.id),
    db.targetCompanies.where('userId').equals(user.id).toArray(),
    db.resumeFacets.toArray(),
    db.people.where('userId').equals(user.id).toArray(),
    db.chats.where('userId').equals(user.id).toArray(),
    db.recommendations.where('userId').equals(user.id).toArray(),
  ]);
  if (!goals) return 0;
  const { g } = await buildReachGraph(user.id);
  const recent = new Set(
    existing
      .filter(
        (r) =>
          r.status === 'dismissed' ||
          (r.status === 'new' && now.getTime() - new Date(r.batchDate).getTime() < 14 * DAY),
      )
      .map((r) => r.personId),
  );
  const recs = recommendPeople({
    userId: user.id,
    user: { school: user.school, majors: user.majors, gradYear: user.graduationYear },
    goals,
    targetCompanies,
    resumeFacets,
    people,
    chats,
    pathStrength: (id) => bestPathStrength(g, id),
    recentlyRecommended: recent,
    now,
  });
  for (const r of recs) {
    r.bestPath = undefined;
    const prev = existing.find((e) => e.personId === r.personId && e.status === 'saved');
    if (prev) continue;
    await db.recommendations
      .where('personId')
      .equals(r.personId)
      .filter((e) => e.status === 'new')
      .delete();
    await db.recommendations.put(r);
  }
  return recs.length;
}
