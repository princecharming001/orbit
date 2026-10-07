import type { CoffeeChat, MessageKind, OutboundMessage, Person, Suggestion, User } from '@orbit/core';
import {
  composeKindFor,
  contextText,
  fmtWindows,
  generateDraft,
  newId,
  sectorOf,
  validateDraft,
} from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import {
  buildDraftContext,
  draftForSuggestion,
  draftMessage,
  evaluateImmediateSuggestions,
  generateBrief,
  markWarmUpAction,
  regenerateDraft,
} from './brief';
import { loadDemo } from './demo';
import { importConnectionsCsv } from './linkedin';
import { ingestNote } from './notes';
import { approveAndSend, checkSendAllowed, confirmHandoff } from './send';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 60_000);

/** Validate a stored draft exactly as the app would, against everything Orbit knows about the person. */
async function validateStored(d: OutboundMessage, s?: Suggestion) {
  const p = (await db.people.get(d.personId))!;
  const ctx = await buildDraftContext(user, p, d.kind, d.channel as 'gmail' | 'linkedin', s);
  return validateDraft(
    {
      body: d.bodyDraft,
      claims: d.claims ?? [],
      needsInput: d.needsInput,
      subject: d.subject,
      opening: undefined,
    },
    {
      kind: d.kind,
      facts: ctx.facts,
      allowedUrls: [ctx.user.schedulingLink ?? '', user.linkedinUrl ?? ''].filter(Boolean),
      recipientEmail: p.primaryEmail,
      recipientFirstName: p.firstName,
      recipientFullName: p.displayName,
      hadConversation: d.kind === 'referral_ask' ? !!ctx.chat?.completedAt : undefined,
      channel: d.channel,
      context: contextText(ctx),
    },
  );
}

/** What a student would type into the needs-input prompt. */
const SAMPLE_INPUTS = {
  connection: 'We were both on the Cornell Hyperloop team, a few years apart',
  takeaway: 'to lead every interview answer with one project story',
  update: 'I moved my summer search toward payments teams',
  answer: 'Mostly payments infrastructure, since that is what I worked on last summer',
  news: 'your promotion to team lead',
  target: 'Lucas Fischer, Engineering Manager at Ramp',
  role: 'Software Engineering Intern at Ramp',
};

async function people(filter: (p: Person) => boolean): Promise<Person[]> {
  return db.people.where('userId').equals(user.id).filter(filter).toArray();
}

async function chattedIds(): Promise<Set<string>> {
  return new Set((await db.chats.where('userId').equals(user.id).toArray()).map((c) => c.personId));
}

async function newChat(personId: string, over: Partial<CoffeeChat> = {}): Promise<CoffeeChat> {
  const now = new Date().toISOString();
  const chat: CoffeeChat = {
    id: newId('c'),
    userId: user.id,
    personId,
    stage: 'outreach_sent',
    stageEnteredAt: now,
    source: 'manual',
    goalTags: [],
    bumpCount: 0,
    priority: 2,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  await db.chats.add(chat);
  return chat;
}

describe('drafting against the demo data', () => {
  it('the welcome brief is true when it loads: thank-yous quote the notes, nothing is stale (UI-10)', async () => {
    const pending = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending')
      .toArray();
    const thanks = pending.filter((s) => s.kind === 'thank_you');
    expect(thanks.length).toBeGreaterThan(0);
    for (const s of thanks) {
      // the stored card, exactly as Today shows it, not a regenerated one
      const d = (await db.outbound.get(s.outboundMessageId!))!;
      const facts = await db.facts.where('personId').equals(s.personId!).toArray();
      expect(facts.length).toBeGreaterThan(0);
      expect(d.needsInput, d.bodyDraft).toBeUndefined();
      expect(d.bodyDraft).not.toMatch(/\[/);
      expect(d.claims?.some((c) => !!c.factId && facts.some((f) => f.id === c.factId))).toBe(true);
      const chat = (await db.chats.get(s.chatId!))!;
      expect(Date.now() - new Date(chat.completedAt!).getTime()).toBeLessThan(3 * 86_400_000);
    }
    // the mentor chat was in August and the thank-you went out the next day: no thank-you card seven weeks later
    const mentor = (await people((p) => p.relationshipType === 'mentor'))[0]!;
    const mentorChat = (await db.chats.where('personId').equals(mentor.id).first())!;
    expect(['followed_up', 'nurturing']).toContain(mentorChat.stage);
    expect(Date.now() - new Date(mentorChat.completedAt!).getTime()).toBeGreaterThan(30 * 86_400_000);
    expect(pending.some((s) => s.kind === 'thank_you' && s.personId === mentor.id)).toBe(false);
    // a booked chat has no "confirm the time" card, and windows in stored drafts are the current free slots
    for (const s of pending.filter((x) => x.kind === 'schedule_confirm' || x.kind === 'schedule_propose')) {
      const chat = (await db.chats.get(s.chatId!))!;
      expect(['replied', 'scheduling']).toContain(chat.stage);
      const d = (await db.outbound.get(s.outboundMessageId!))!;
      expect(d.bodyDraft).not.toMatch(/has already passed|come and gone/);
      if (s.kind === 'schedule_propose') {
        const p = (await db.people.get(s.personId!))!;
        const ctx = await buildDraftContext(user, p, 'schedule', 'gmail', s);
        expect(d.bodyDraft).toContain(fmtWindows(ctx.proposedWindows!.slice(0, 2), user.timezone));
      }
    }
  });

  it('every draft for every pending suggestion passes the validator with no blocking issue', async () => {
    const pending = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending' && !!s.outboundMessageId)
      .toArray();
    expect(pending.length).toBeGreaterThan(3);
    const NEED_CODES = ['needs_connection', 'needs_update', 'needs_input', 'placeholder', 'no_specific_line'];
    for (const s of pending) {
      let d = (await db.outbound.get(s.outboundMessageId!))!;
      if (d.needsInput?.length) {
        // a draft that asks the student for something is gated by exactly that, and passes once it is given
        const gated = (await validateStored(d, s)).filter((i) => i.blocking);
        expect(gated.length).toBeGreaterThan(0);
        expect(
          gated.filter((i) => !NEED_CODES.includes(i.code)),
          d.bodyDraft,
        ).toEqual([]);
        d = (await regenerateDraft(user, d.id, SAMPLE_INPUTS))!;
        expect(d.needsInput, d.bodyDraft).toBeUndefined();
      }
      const issues = await validateStored(d, s);
      expect(
        issues.filter((i) => i.blocking),
        `${s.kind} -> ${d.kind}: ${d.bodyDraft}`,
      ).toEqual([]);
      expect(d.subject ?? '').not.toMatch(/^quick question$/i);
      expect(d.bodyDraft).not.toMatch(/\bundefined\b|\{first\}|this cycle recruiting|[—–]/);
    }
  });

  it('cold outreach without a connection is gated; a connection line is stored and the redraft passes', async () => {
    const chatted = await chattedIds();
    let cold: Person | undefined;
    for (const p of await people((x) => !!x.primaryEmail && !x.isAlumni && !chatted.has(x.id))) {
      const ctx = await buildDraftContext(user, p, 'outreach', 'gmail');
      if (generateDraft(ctx).needsInput.includes('connection')) {
        cold = p;
        break;
      }
    }
    expect(cold, 'demo has a cold contact with no checkable link').toBeDefined();
    const d = await draftMessage(user, cold!.id, 'outreach', 'gmail');
    expect(d.needsInput).toEqual(['connection']);
    expect(d.bodyDraft).toMatch(/\[Your link to/);
    const gated = await validateStored(d);
    expect(gated.some((i) => i.code === 'needs_connection' && i.blocking)).toBe(true);
    const line = 'We were both on the Cornell Hyperloop team, a few years apart';
    const re = (await regenerateDraft(user, d.id, { connection: line }))!;
    const fact = await db.facts
      .where('personId')
      .equals(cold!.id)
      .filter((f) => f.type === 'connection')
      .first();
    expect(fact?.text).toBe(line);
    expect(re.needsInput).toBeUndefined();
    expect(re.bodyDraft).toMatch(/We were both on the Cornell Hyperloop team/);
    expect(re.bodyDraft).not.toMatch(/\[/);
    const issues = await validateStored((await db.outbound.get(d.id))!);
    expect(issues.filter((i) => i.blocking)).toEqual([]);
  });

  it('alumni outreach passes the validator and names the school the way students do', async () => {
    const chatted = await chattedIds();
    const alum = (await people((p) => !!p.isAlumni && !!p.primaryEmail && !chatted.has(p.id)))[0]!;
    const d = await draftMessage(user, alum.id, 'outreach', 'gmail');
    expect(d.needsInput).toBeUndefined();
    const issues = await validateStored(d);
    expect(
      issues.filter((i) => i.blocking),
      d.bodyDraft,
    ).toEqual([]);
    expect(d.bodyDraft).toMatch(/\bCornell\b/);
    expect(d.bodyDraft).not.toMatch(/Cornell University|is a junior studying|interested in payments/);
    expect(d.subject).toMatch(/Cornell/);
  });

  it('finance gets the formal register and two bumps; tech gets one', async () => {
    const chatted = await chattedIds();
    const all = await people((p) => !chatted.has(p.id) && !p.hiddenAt);
    const sector = (p: Person) => sectorOf({ title: p.currentTitle, org: p.currentOrganizationRaw });
    const fin = all.find((p) => sector(p) === 'finance')!;
    // a recruiter at a tech company is written to formally, so the tech example is someone on the team
    const tech = all.find((p) => sector(p) === 'tech' && !/recruit/i.test(p.currentTitle ?? ''))!;
    expect(fin && tech).toBeTruthy();
    const finCtx = await buildDraftContext(user, fin, 'outreach', 'gmail');
    const finDraft = generateDraft(finCtx);
    expect(finDraft.register).toBe('formal');
    expect(finDraft.body).toMatch(/\nAlex Rivera\nCornell '\d\d$/);
    expect(generateDraft(await buildDraftContext(user, tech, 'outreach', 'gmail')).register).toBe('warm');
    await newChat(fin.id, { bumpCount: 1 });
    await newChat(tech.id, { bumpCount: 1 });
    expect((await checkSendAllowed(user.id, fin.id, 'gmail', 'bump')).allowed).toBe(true);
    const t = await checkSendAllowed(user.id, tech.id, 'gmail', 'bump');
    expect(t.allowed).toBe(false);
    expect(t.reason).toMatch(/followed up once/);
    await db.chats.where('personId').equals(fin.id).modify({ bumpCount: 2 });
    expect((await checkSendAllowed(user.id, fin.id, 'gmail', 'bump')).allowed).toBe(false);
  });

  it('the warm-up note flows into the outreach after the warm-up', async () => {
    const chat = (await db.chats
      .where('userId')
      .equals(user.id)
      .filter((c) => c.stage === 'warming')
      .first())!;
    const note = 'junior engineers should own a metric in their first quarter';
    for (const a of chat.warmUp!.actions) await markWarmUpAction(user.id, chat.id, a.id, true, note);
    await generateBrief(user, 'daily');
    const s = (await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((x) => x.personId === chat.personId && x.kind === 'new_outreach' && x.status === 'pending')
      .first())!;
    expect(s).toBeDefined();
    const d = s.outboundMessageId
      ? (await db.outbound.get(s.outboundMessageId))!
      : (await draftForSuggestion(user, s))!;
    const text = `${d.bodyDraft}`;
    expect(text).toMatch(/making the point that junior engineers should own a metric in their first quarter/);
    expect(text).not.toMatch(/thanks for connecting/);
    expect((await validateStored(d, s)).filter((i) => i.blocking)).toEqual([]);
  });

  it('a completed chat with a referrer yields a report-back that names the target', async () => {
    const chatted = await chattedIds();
    const [referrer, target] = await people((p) => !!p.primaryEmail && !chatted.has(p.id) && !p.hiddenAt);
    const now = new Date();
    const chat = await newChat(target!.id, {
      stage: 'completed',
      completedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      referrerPersonId: referrer!.id,
    });
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: target!.id }, now);
    const s = (await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((x) => x.kind === 'report_back' && x.chatId === chat.id)
      .first())!;
    expect(s?.personId).toBe(referrer!.id);
    const d = s.outboundMessageId
      ? (await db.outbound.get(s.outboundMessageId))!
      : (await draftForSuggestion(user, s))!;
    expect(d.personId).toBe(referrer!.id);
    expect(d.bodyDraft).toMatch(new RegExp(`thank you for the intro to ${target!.displayName}`));
    expect(d.bodyDraft).toMatch(/We spoke yesterday\./);
    expect((await validateStored(d, s)).filter((i) => i.blocking)).toEqual([]);
  });

  it('thank-you and nurture splice facts grammatically, located by the real meeting date', async () => {
    // the demo's chat that just ended, with a Granola note: Lena at Ramp
    const lena = (await people((p) => p.displayName === 'Lena Novak'))[0]!;
    const ty = await draftMessage(user, lena.id, 'thank_you', 'gmail');
    expect(ty.bodyDraft).toMatch(
      /your point that the key is one concrete project story that shows how I handled/i,
    );
    expect(ty.bodyDraft).toMatch(
      /Thanks also for offering to pass my name to the recruiter who owns the software engineering intern req/,
    );
    expect(ty.bodyDraft).not.toMatch(/Lena offered|She offered|point that recommended|how you handled/);
    // with no hook on record the check-in asks for the student's update first
    const asked = await draftMessage(user, lena.id, 'nurture', 'gmail');
    expect(asked.needsInput).toEqual(['update']);
    const n = (await regenerateDraft(user, asked.id, { update: SAMPLE_INPUTS.update }))!;
    expect(n.needsInput).toBeUndefined();
    expect(n.bodyDraft).not.toMatch(/mentioned Lena|It's been a little while/);
    for (const d of [ty, n]) expect((await validateStored(d)).filter((i) => i.blocking)).toEqual([]);
  });

  it('a question in the thread is never answered for the student; congratulate and intro ask for what is missing', async () => {
    const lena = (await people((p) => p.displayName === 'Lena Novak'))[0]!;
    const c = await draftMessage(user, lena.id, 'congratulate', 'gmail');
    expect(c.needsInput).toEqual(['news']);
    const c2 = (await regenerateDraft(user, c.id, { news: 'your promotion to team lead' }))!;
    expect(c2.needsInput).toBeUndefined();
    expect(c2.bodyDraft).toMatch(/Just saw the news about your promotion to team lead/);
    const i = await draftMessage(user, lena.id, 'intro_request', 'gmail');
    expect(i.needsInput).toEqual(['target']);
    const i2 = (await regenerateDraft(user, i.id, { target: 'Lucas Fischer, Engineering Manager at Ramp' }))!;
    expect(i2.bodyDraft).toMatch(/talk with Lucas Fischer \(Engineering Manager at Ramp\)/);
    expect(i2.subject).toBe('Small ask: intro to Lucas Fischer?');
  });

  it('proposed windows are free, on different days and times, and dated in the user timezone', async () => {
    const s = (await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((x) => x.kind === 'schedule_propose' && !!x.outboundMessageId)
      .first())!;
    const d = (await db.outbound.get(s.outboundMessageId!))!;
    const m = d.bodyDraft.match(
      /(\w+day), (\w{3} \d+) at (\d+(?::\d\d)?[ap]m) or (\w+day), (\w{3} \d+) at (\d+(?::\d\d)?[ap]m)/,
    );
    expect(m, d.bodyDraft).toBeTruthy();
    expect(m![1]).not.toBe(m![4]);
    expect(m![3]).not.toBe(m![6]);
    const ctx = await buildDraftContext(user, (await db.people.get(d.personId))!, 'schedule', 'gmail', s);
    const events = await db.events.where('userId').equals(user.id).toArray();
    for (const w of ctx.proposedWindows ?? []) {
      expect(new Date(w.startIso).getTime()).toBeGreaterThan(Date.now());
      const st = new Date(w.startIso).getTime();
      expect(
        events.some(
          (e) =>
            e.status !== 'cancelled' &&
            new Date(e.startAt).getTime() < st + 30 * 60_000 &&
            new Date(e.endAt).getTime() > st,
        ),
      ).toBe(false);
    }
  });

  it('quality pass: 40 drafts across sectors, kinds and channels read clean', async () => {
    const all = await people((p) => !p.hiddenAt && !!p.currentTitle);
    const bySector = new Map<string, Person[]>();
    for (const p of all) {
      const k = `${sectorOf({ title: p.currentTitle, org: p.currentOrganizationRaw })}:${p.isAlumni}`;
      bySector.set(k, [...(bySector.get(k) ?? []), p]);
    }
    const picks = [...bySector.values()].flatMap((ps) => ps.slice(0, 2));
    const kinds: MessageKind[] = [
      'outreach',
      'bump',
      'thank_you',
      'nurture',
      'referral_ask',
      'reply',
      'schedule',
    ];
    const out: string[] = [];
    let n = 0;
    for (let i = 0; n < 40; i++) {
      const p = picks[i % picks.length]!;
      const kind = kinds[i % kinds.length]!;
      const channel = i % 3 === 0 ? 'linkedin' : 'gmail';
      const d = await draftMessage(user, p.id, kind, channel);
      n++;
      out.push(
        `## ${kind}/${channel} :: ${p.displayName} (${p.currentTitle} @ ${p.currentOrganizationRaw})\n${d.subject ?? ''}\n${d.bodyDraft}`,
      );
      const issues = (await validateStored(d)).filter((x) => x.blocking && !(d.needsInput ?? []).length);
      expect(issues, d.bodyDraft).toEqual([]);
      expect(d.bodyDraft).not.toMatch(
        /\b(they|he|she) (recommended|offered|said)\b|\byou mentioned (they|he|she)\b|\bundefined\b| {2,}|this cycle recruiting|Cornell University|[—–!]/,
      );
      if (channel === 'linkedin' && kind === 'outreach' && !p.linkedinConnectedOn)
        expect(d.bodyDraft.length).toBeLessThanOrEqual(300);
    }
    if (process.env.DUMP_DRAFTS) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.DUMP_DRAFTS, out.join('\n\n'));
    }
  }, 60_000);

  it('outreach to someone the student already emailed with replies in that thread, not as a stranger (EG-06)', async () => {
    // the demo's recruiter: she sent the process email, the student answered last week, and there is no chat
    const chloe = (await people((p) => p.displayName === 'Chloe Dubois'))[0]!;
    const th = (await db.threads
      .where('userId')
      .equals(user.id)
      .filter((t) => t.participantPersonIds.includes(chloe.id))
      .first())!;
    const d = await draftMessage(user, chloe.id, 'outreach', 'gmail');
    expect(d.externalThreadId).toBe(th.externalThreadId);
    expect(d.inReplyToMessageId).toBeDefined();
    expect(d.subject).toBe(`Re: ${th.subject}`);
    expect(d.bodyDraft).toMatch(
      /^Dear Chloe,\n\nWe traded emails [^,]+, and I wanted to pick that conversation back up\./,
    );
    expect(d.bodyDraft).toMatch(/As a quick reminder, I'm a junior at Cornell/);
    expect((await validateStored(d)).filter((i) => i.blocking)).toEqual([]);
    // on LinkedIn: no subject, and a short note (not the letter) when they are not connected yet
    const li = await draftMessage(user, chloe.id, 'outreach', 'linkedin');
    expect(li.subject).toBeUndefined();
    expect(li.externalThreadId).toBeUndefined();
    await db.people.update(chloe.id, { linkedinConnectedOn: undefined });
    const note = await draftMessage(user, chloe.id, 'outreach', 'linkedin');
    expect(note.bodyDraft.length).toBeLessThanOrEqual(300);
    expect(note.bodyDraft).toMatch(/^Hi Chloe, we traded emails/);
  });

  it('a reply asking for the resume and the teams gets both before any times (EG-03)', async () => {
    const chatted = await chattedIds();
    const p = (await people((x) => !!x.primaryEmail && !chatted.has(x.id) && !x.hiddenAt)).find(
      (x) => !/recruit/i.test(x.currentTitle ?? ''),
    )!;
    const now = Date.now();
    const thId = newId('th');
    await db.threads.add({
      id: thId,
      userId: user.id,
      externalThreadId: `ext-${thId}`,
      subject: 'Quick question',
      messageCount: 2,
      participantEmails: [p.primaryEmail!],
      participantPersonIds: [p.id],
      isNetworking: true,
      lastMessageAt: new Date(now - 3_600_000).toISOString(),
    });
    await db.messages.add({
      id: newId('m'),
      userId: user.id,
      threadId: thId,
      externalMessageId: `x-${thId}`,
      direction: 'inbound',
      fromEmail: p.primaryEmail!,
      toEmails: [],
      ccEmails: [],
      fromPersonId: p.id,
      sentAt: new Date(now - 3_600_000).toISOString(),
      bodyText:
        "Hi Alex, happy to chat! Could you send over your resume and let me know which teams you're most interested in?",
      headers: { 'message-id': `<${thId}@x>` },
      isAutomated: false,
      signal: 'reply_positive',
      extraction: {
        proposedTimes: [],
        asksOfUser: ['Could you send over your resume', "let me know which teams you're most interested in"],
        offers: [],
        factsAboutSender: [],
        sentiment: 'warm',
      },
    });
    const chat = await newChat(p.id, { stage: 'replied', threadId: thId });
    const d = await draftMessage(user, p.id, 'schedule', 'gmail', chat.id);
    expect(d.externalThreadId).toBe(`ext-${thId}`);
    expect(d.bodyDraft).toMatch(/resume/);
    expect(d.needsInput).toEqual(['answer']);
    const re = (await regenerateDraft(user, d.id, { answer: SAMPLE_INPUTS.answer }))!;
    expect(re.bodyDraft).toMatch(/Mostly payments infrastructure/);
    expect(re.bodyDraft).toMatch(/Would either of these work for a quick call\?/);
    const ctx = await buildDraftContext(user, p, 'schedule', 'gmail', undefined, {}, chat);
    const issues = validateDraft(
      { body: re.bodyDraft, claims: re.claims ?? [] },
      {
        kind: 'schedule',
        facts: ctx.facts,
        allowedUrls: [],
        recipientFirstName: p.firstName,
        context: contextText(ctx),
        asks: ctx.thread?.asksOfUser,
      },
    );
    expect(issues.filter((i) => i.blocking)).toEqual([]);
  });

  it('a thank-you keeps the promise from the notes, and asks for a takeaway when there are no notes (EG-15)', async () => {
    const lena = (await people((p) => p.displayName === 'Lena Novak'))[0]!;
    const ty = await draftMessage(user, lena.id, 'thank_you', 'gmail');
    expect(ty.bodyDraft).toMatch(
      /As promised, I'll send my resume and the marketplace project link by Friday/,
    );
    expect((await validateStored(ty)).filter((i) => i.blocking)).toEqual([]);
    const chatted = await chattedIds();
    const p = (await people((x) => !!x.primaryEmail && !chatted.has(x.id) && !x.hiddenAt))[2]!;
    await newChat(p.id, { stage: 'completed', completedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const bare = await draftMessage(user, p.id, 'thank_you', 'gmail');
    expect(bare.needsInput).toEqual(['takeaway']);
    const re = (await regenerateDraft(user, bare.id, { takeaway: SAMPLE_INPUTS.takeaway }))!;
    expect(re.needsInput).toBeUndefined();
    expect(re.bodyDraft).toMatch(/your advice to lead every interview answer with one project story/i);
    expect((await validateStored((await db.outbound.get(bare.id))!)).filter((i) => i.blocking)).toEqual([]);
  });

  it('notes that arrive after a thank-you was drafted update the stored draft (DQ-03)', async () => {
    const chatted = await chattedIds();
    const p = (await people((x) => !!x.primaryEmail && !chatted.has(x.id) && !x.hiddenAt))[5]!;
    const chat = await newChat(p.id, {
      stage: 'completed',
      completedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId: p.id });
    const s = (await db.suggestions.where('dedupeKey').equals(`thank:${chat.id}`).first())!;
    const before = (await db.outbound.get(s.outboundMessageId!))!;
    expect(before.needsInput).toEqual(['takeaway']);
    await ingestNote(user, {
      text: `Coffee with ${p.displayName}. They recommended practicing system design with a friend before onsites.`,
      source: 'manual',
      personIds: [p.id],
    });
    const after = (await db.outbound.get(s.outboundMessageId!))!;
    expect(after.id).toBe(before.id);
    expect(after.needsInput).toBeUndefined();
    expect(after.bodyDraft).toMatch(/practicing system design with a friend/);
    expect((await validateStored(after, s)).filter((i) => i.blocking)).toEqual([]);
  });

  it('after a thank-you goes out, "Write to" waits instead of drafting a check-in (UI-04)', async () => {
    const chatted = await chattedIds();
    const p = (await people((x) => !!x.primaryEmail && !chatted.has(x.id) && !x.hiddenAt))[6]!;
    const chat = await newChat(p.id, {
      stage: 'completed',
      completedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const d = await draftMessage(user, p.id, 'thank_you', 'gmail', chat.id, {
      takeaway: SAMPLE_INPUTS.takeaway,
    });
    // without Gmail the thank-you is handed off to the mail app; it counts once the student says they sent it
    expect((await approveAndSend(user, d.id, d.bodyDraft)).ok).toBe(true);
    expect((await confirmHandoff(user, d.id)).ok).toBe(true);
    const fresh = (await db.chats.get(chat.id))!;
    expect(fresh.stage).toBe('followed_up');
    expect(composeKindFor(fresh, new Date())).toMatchObject({ wait: { since: fresh.lastOutboundAt } });
    const later = new Date(Date.now() + 20 * 86_400_000);
    expect(composeKindFor(fresh, later)).toEqual({ kind: 'nurture' });
    const blocked = await checkSendAllowed(user.id, p.id, 'gmail', 'nurture');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(new RegExp(`You wrote to ${p.firstName} just now`));
    expect(blocked.reason).not.toMatch(/\b0 hours/);
  });

  it('a LinkedIn re-import records a job change only when there is one, and says it right (DQ-13)', {
    timeout: 30_000,
  }, async () => {
    const chatted = await chattedIds();
    const cands = await people(
      (x) =>
        !!x.linkedinUrl &&
        !!x.currentTitle &&
        !!x.currentOrganizationRaw &&
        !chatted.has(x.id) &&
        !x.hiddenAt,
    );
    const [a, b] = [cands[0]!, cands[1]!];
    const affs = async (id: string) =>
      (await db.affiliations.where('personId').equals(id).toArray()).filter((x) => x.kind === 'employment');
    const beforeA = await affs(a.id);
    const row = (p: Person, company: string, title: string) =>
      `${p.firstName},${p.lastName ?? ''},${p.linkedinUrl},,${company},${title},01 Jan 2024`;
    const csv = `First Name,Last Name,URL,Email Address,Company,Position,Connected On\n${row(
      a,
      ` ${a.currentOrganizationRaw!.toUpperCase()} `,
      `${a.currentTitle!.toLowerCase()}  II`,
    )}\n${row(b, b.currentOrganizationRaw!, `Staff ${b.currentTitle}`)}\n`;
    await importConnectionsCsv(user, csv);
    // case, spacing and a level suffix are not news
    const afterA = await affs(a.id);
    expect(afterA.length).toBe(beforeA.length);
    expect(afterA.filter((x) => x.isCurrent).every((x) => !x.endDate)).toBe(true);
    const ca = await draftMessage(user, a.id, 'congratulate', 'gmail');
    expect(ca.needsInput).toEqual(['news']);
    // a new title at the same company is a new role, not a move, and its start date is not assumed
    const cb = await draftMessage(user, b.id, 'congratulate', 'gmail');
    expect(cb.needsInput).toBeUndefined();
    expect(cb.bodyDraft).toMatch(
      new RegExp(`your new role as an? staff .* at ${b.currentOrganizationRaw}`, 'i'),
    );
    expect(cb.bodyDraft).not.toMatch(/your move to|first few weeks/);
  });
});

describe('the "who I am" clause (resume one-liner)', () => {
  it('is composed from school, year and major, and a resume summary only fills in when those are missing', async () => {
    const someone = (await people((p) => !!p.primaryEmail && !p.hiddenAt))[0]!;
    const summary = (await db.resumeFacets.toArray()).find((f) => f.kind === 'summary')!;
    // with the structured fields set, the summary never reaches the draft
    const ctx = await buildDraftContext(user, someone, 'outreach', 'gmail');
    expect(ctx.user.oneLiner).toBeUndefined();
    const noYear = { ...user, graduationYear: undefined } as unknown as User;
    await db.resumeFacets.update(summary.id, {
      text: 'Alex Rivera is a junior studying Computer Science at Cornell University, interested in payments infrastructure.',
    });
    // a clean clause: cut at the first comma, the school's short name
    expect((await buildDraftContext(noYear, someone, 'outreach', 'gmail')).user.oneLiner).toBe(
      'a junior studying Computer Science at Cornell',
    );
    // contact details never pass
    await db.resumeFacets.update(summary.id, {
      text: 'Alex Rivera is a junior at Cornell. alex.rivera@cornell.edu | (607) 555-0100',
    });
    const withContact = (await buildDraftContext(noYear, someone, 'outreach', 'gmail')).user.oneLiner;
    expect(withContact ?? '').not.toMatch(/@|\d{3}/);
    await db.resumeFacets.update(summary.id, { text: summary.text });
  });
});
