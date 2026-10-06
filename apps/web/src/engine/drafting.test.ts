import type { CoffeeChat, MessageKind, OutboundMessage, Person, Suggestion, User } from '@orbit/core';
import { contextText, generateDraft, newId, sectorOf, validateDraft } from '@orbit/core';
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
import { checkSendAllowed } from './send';

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
  it('every draft for every pending suggestion passes the validator with no blocking issue', async () => {
    const pending = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending' && !!s.outboundMessageId)
      .toArray();
    expect(pending.length).toBeGreaterThan(3);
    for (const s of pending) {
      const d = (await db.outbound.get(s.outboundMessageId!))!;
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
    const tech = all.find((p) => sector(p) === 'tech')!;
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
    const alina = (await people((p) => p.displayName === 'Alina Rossi'))[0]!;
    const ty = await draftMessage(user, alina.id, 'thank_you', 'gmail');
    expect(ty.bodyDraft).toMatch(/What you said about focusing on one concrete project story/);
    expect(ty.bodyDraft).toMatch(/Thanks also for offering to refer me when the posting goes up/);
    expect(ty.bodyDraft).not.toMatch(/Alina offered|point that recommended/);
    const n = await draftMessage(user, alina.id, 'nurture', 'gmail');
    expect(n.bodyDraft).not.toMatch(/mentioned Alina|It's been a little while/);
    for (const d of [ty, n]) expect((await validateStored(d)).filter((i) => i.blocking)).toEqual([]);
  });

  it('a question in the thread is never answered for the student; congratulate and intro ask for what is missing', async () => {
    const alina = (await people((p) => p.displayName === 'Alina Rossi'))[0]!;
    const c = await draftMessage(user, alina.id, 'congratulate', 'gmail');
    expect(c.needsInput).toEqual(['news']);
    const c2 = (await regenerateDraft(user, c.id, { news: 'your promotion to team lead' }))!;
    expect(c2.needsInput).toBeUndefined();
    expect(c2.bodyDraft).toMatch(/Just saw the news about your promotion to team lead/);
    const i = await draftMessage(user, alina.id, 'intro_request', 'gmail');
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
});
