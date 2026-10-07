import type { OutboundMessage, Suggestion, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openHandoff, runApproval } from '../components/approve';
import { db } from '../db/schema';
import {
  buildMimeMessage,
  CALENDAR_READ_SCOPE,
  connectGoogle as connectGoogleOAuth,
  disconnectGoogle,
  GMAIL_READ_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_SCOPES,
  gfetchRetry,
  gmailListIds,
  googleScopeWarning,
} from '../integrations/google';
import { writePrefs } from '../integrations/prefs';
import {
  draftForSuggestion,
  draftMessage,
  evaluateImmediateSuggestions,
  generateBrief,
  startWarmUpOrOutreach,
} from './brief';
import { loadDemo } from './demo';
import { ingestEmails } from './ingest';
import {
  approveAndSend,
  checkSendAllowed,
  confirmHandoff,
  handoffLink,
  revertHandoff,
  reviewDraft,
  sendDueQueued,
  UNDO_WINDOW_MS,
  undoQueued,
} from './send';

// ---------- fake Gmail ----------

interface Sent {
  raw: string;
  headers: Record<string, string>;
  body: string;
  threadId?: string;
  id: string;
}
let sent: Sent[] = [];
let failSends = 0;

function b64urlToUtf8(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), '='));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Parse our MIME: unfold headers, decode RFC 2047 words, decode the base64 body. */
function parseMime(raw: string): { headers: Record<string, string>; body: string } {
  const [head, b64] = raw.split('\r\n\r\n') as [string, string];
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    const v = line
      .slice(i + 1)
      .trim()
      .replace(/\?=\s+=\?/g, '?==?')
      .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, x: string) => b64urlToUtf8(x));
    headers[line.slice(0, i).toLowerCase()] = v.trim();
  }
  return { headers, body: b64urlToUtf8(b64.replace(/\r\n/g, '')) };
}

function fakeGmail() {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/messages/send')) {
      if (failSends > 0) {
        failSends--;
        return new Response('backend error', { status: 500 });
      }
      const req = JSON.parse(String(init.body)) as { raw: string; threadId?: string };
      const raw = b64urlToUtf8(req.raw);
      const id = `gm-${sent.length + 1}`;
      const threadId = req.threadId ?? `gth-${sent.length + 1}`;
      sent.push({ raw, ...parseMime(raw), threadId, id });
      return Response.json({ id, threadId });
    }
    const m = url.match(/\/messages\/(gm-\d+)\?/);
    if (m)
      return Response.json({
        id: m[1],
        threadId: 'x',
        payload: { headers: [{ name: 'Message-ID', value: `<${m[1]}@mail.gmail.com>` }] },
      });
    return new Response('not found', { status: 404 });
  });
}

async function connectGoogle(user: User) {
  await db.integrations.put({
    id: 'int_google',
    userId: user.id,
    provider: 'google',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: new Date().toISOString(),
  });
  sessionStorage.setItem(
    'orbit.google.token',
    JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 }),
  );
}

async function pendingDraft(user: User, kind: Suggestion['kind']) {
  const s = (await db.suggestions
    .where('userId')
    .equals(user.id)
    .filter((x) => x.kind === kind && x.status === 'pending' && !!x.outboundMessageId)
    .first())!;
  return { s, d: (await db.outbound.get(s.outboundMessageId!))! };
}

/**
 * A bump on the demo's oldest unanswered email outreach, drafted explicitly: whether the day's brief holds a pending
 * follow_up_bump depends on the weekday and the hour, and these tests must not.
 */
async function bumpDraft(user: User): Promise<OutboundMessage> {
  const chats = (
    await db.chats
      .where('userId')
      .equals(user.id)
      .filter((c) => c.stage === 'outreach_sent' && !!c.threadId)
      .toArray()
  ).sort((a, b) => (a.lastOutboundAt ?? '').localeCompare(b.lastOutboundAt ?? ''));
  for (const c of chats) {
    const p = await db.people.get(c.personId);
    if (p?.primaryEmail) return draftMessage(user, p.id, 'bump', 'gmail', c.id);
  }
  throw new Error('the demo has no unanswered email outreach');
}

async function freshPerson(user: User, opts: { email?: boolean; linkedin?: boolean; connected?: boolean }) {
  // nobody Orbit has a chat with or a message for, so two calls in one test never return the same person
  const chatted = new Set([
    ...(await db.chats.where('userId').equals(user.id).toArray()).map((c) => c.personId),
    ...(await db.outbound.where('userId').equals(user.id).toArray()).map((o) => o.personId),
    // nor anyone on an email thread: outreach to them picks that thread back up instead of starting one
    ...(await db.threads.where('userId').equals(user.id).toArray()).flatMap(
      (t) => t.participantPersonIds ?? [],
    ),
  ]);
  const p = (await db.people
    .where('userId')
    .equals(user.id)
    .filter(
      (x) =>
        x.isHuman &&
        !chatted.has(x.id) &&
        !x.hiddenAt &&
        (opts.email ? !!x.primaryEmail : !x.primaryEmail) &&
        (opts.linkedin === undefined || !!x.linkedinSlug === opts.linkedin),
    )
    .first())!;
  if (opts.connected !== undefined)
    await db.people.update(p.id, { linkedinConnectedOn: opts.connected ? '2025-01-01' : undefined });
  return (await db.people.get(p.id))!;
}

let user: User;
let fetchMock: ReturnType<typeof fakeGmail>;
beforeEach(async () => {
  // the demo is laid out on business days around "now"; pin a Tuesday afternoon so its cards exist whenever this runs
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-06T14:00:00'));
  user = await loadDemo({ reset: true });
  sent = [];
  failSends = 0;
  sessionStorage.clear();
  fetchMock = fakeGmail();
  vi.stubGlobal('fetch', fetchMock);
  gfetchRetry.sleep = async () => {};
}, 60_000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('threading (SND-01, IS-1, SND-18)', () => {
  it('a threaded reply goes out as Re: <thread subject> with In-Reply-To and the References chain', async () => {
    await connectGoogle(user);
    const { d } = await pendingDraft(user, 'schedule_confirm');
    const thread = (await db.threads.where('externalThreadId').equals(d.externalThreadId!).first())!;
    const msgs = await db.messages.where('threadId').equals(thread.id).sortBy('sentAt');
    const last = msgs[msgs.length - 1]!;
    await db.messages.update(last.id, { headers: { ...last.headers, references: '<root@demo> <mid@demo>' } });
    const r = await approveAndSend(user, d.id, d.bodyDraft, undefined, new Date(), { undoWindowMs: 0 });
    expect(r).toEqual({ ok: true, status: 'sent' });
    expect(sent).toHaveLength(1);
    const h = sent[0]!.headers;
    expect(h.subject).toBe(`Re: ${thread.subject!.replace(/^(re|fwd?):\s*/i, '')}`);
    expect(h.subject).not.toBe('Hello');
    expect(h['in-reply-to']).toBe(last.headers['message-id']);
    expect(h.references).toBe(`<root@demo> <mid@demo> ${last.headers['message-id']}`);
    expect(h['x-orbit-message-id']).toBe(d.id);
    expect(sent[0]!.threadId).toBe(d.externalThreadId);
  });

  it('a bump drafted from the profile (no In-Reply-To stored) still replies to the last message', async () => {
    await connectGoogle(user);
    const drafted = await bumpDraft(user);
    expect(drafted.externalThreadId).toBeTruthy();
    // drafts now store the message they answer; an older draft without it must still reply to the last message
    await db.outbound.update(drafted.id, { inReplyToMessageId: undefined });
    const bump = (await db.outbound.get(drafted.id))!;
    expect(bump.inReplyToMessageId).toBeUndefined();
    const r = await approveAndSend(user, bump.id, bump.bodyDraft, undefined, new Date(), { undoWindowMs: 0 });
    expect(r.ok).toBe(true);
    expect(sent[0]!.headers['in-reply-to']).toMatch(/^<.+@demo>$/);
    expect(sent[0]!.headers.subject).toMatch(/^Re: /);
  });

  it('headers are hygienic: CR/LF cannot inject, non-ASCII is RFC 2047 encoded, lines are folded', () => {
    const raw = buildMimeMessage({
      to: 'dana@example.com',
      fromEmail: 'sam@school.edu',
      fromName: 'Zoë Okafor, "Sam"',
      subject: 'Hi\r\nBcc: victim@example.com',
      body: 'Line one\nCafé chat, Zoë',
      orbitId: 'out_1',
      inReplyTo: '<a@x>',
      references: '<r1@x> <r2@x>',
    });
    const head = raw.split('\r\n\r\n')[0]!;
    expect(head).not.toMatch(/\r\nBcc:/i);
    expect(head).toContain('Subject: Hi Bcc: victim@example.com');
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    expect(head).toMatch(/From: =\?UTF-8\?B\?/);
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(head).toContain('References: <r1@x> <r2@x> <a@x>');
    const parsed = parseMime(raw);
    expect(parsed.headers.from).toBe('Zoë Okafor, "Sam" <sam@school.edu>');
    expect(parsed.body).toBe('Line one\r\nCafé chat, Zoë');
    const long = buildMimeMessage({
      to: 'dana@example.com',
      fromEmail: 'sam@school.edu',
      subject: `Café ${'é'.repeat(60)}`,
      body: 'x',
      orbitId: 'o',
    });
    const subj = long
      .split('\r\n')
      .filter((l, i, xs) => l.startsWith('Subject:') || xs[i - 1]?.startsWith('Subject:'));
    for (const l of subj) expect(l.length).toBeLessThanOrEqual(78);
    expect(parseMime(long).headers.subject).toBe(`Café ${'é'.repeat(60)}`);
    expect(() =>
      buildMimeMessage({
        to: 'a@b.c\r\nBcc: x@y.z',
        fromEmail: 's@x.y',
        subject: 's',
        body: 'b',
        orbitId: 'o',
      }),
    ).toThrow();
  });

  it('the mail-app hand-off for a threaded draft prefills Re: <thread subject> (SND-16)', async () => {
    const d = await bumpDraft(user);
    const thread = (await db.threads.where('externalThreadId').equals(d.externalThreadId!).first())!;
    const r = await approveAndSend(user, d.id, d.bodyDraft);
    expect(r.ok && r.status === 'handed_off' && r.threaded).toBe(true);
    const url = r.ok && r.status === 'handed_off' ? r.handoffUrl : '';
    expect(decodeURIComponent(url.split('subject=')[1]!.split('&')[0]!)).toBe(
      `Re: ${thread.subject!.replace(/^(re|fwd?):\s*/i, '')}`,
    );
  });
});

describe('recommendation outreach and Gmail threads (SND-02, SND-03, SND-11)', () => {
  async function recommendationOutreach(channel: 'gmail' | 'linkedin') {
    const p = await freshPerson(user, { email: channel === 'gmail', linkedin: true, connected: true });
    const recId = newId('rec');
    await db.recommendations.add({
      id: recId,
      userId: user.id,
      personId: p.id,
      score: 0.8,
      fitScore: 0.8,
      reachScore: 0.5,
      responsePrior: 0.3,
      reasons: [],
      status: 'new',
      batchDate: '2026-10-05',
    });
    const s: Suggestion = {
      id: newId('s'),
      userId: user.id,
      kind: 'new_outreach',
      personId: p.id,
      priorityScore: 0.9,
      reasonText: 'test',
      signals: {},
      payload: { recommendationId: recId, channel },
      status: 'pending',
      dedupeKey: `test:${p.id}`,
      carriedOver: 0,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    await db.suggestions.add(s);
    const d = (await draftForSuggestion(user, s))!;
    return { p, s, d, recId };
  }

  it('approving recommendation outreach opens the chat at outreach_sent and converts the recommendation', async () => {
    const { p, s, d, recId } = await recommendationOutreach('gmail');
    expect(await db.chats.where('personId').equals(p.id).count()).toBe(0);
    const body = d.bodyDraft.replace(/\[[^\]]+\]/g, 'we both studied at Michigan');
    const r = await approveAndSend(user, d.id, body, d.subject ?? 'Quick question');
    expect(r.ok && r.status).toBe('handed_off');
    // nothing is counted until the student says it went out
    expect((await db.suggestions.get(s.id))!.status).toBe('pending');
    expect(await db.chats.where('personId').equals(p.id).count()).toBe(0);
    expect((await confirmHandoff(user, d.id)).ok).toBe(true);
    const chats = await db.chats.where('personId').equals(p.id).toArray();
    expect(chats).toHaveLength(1);
    expect(chats[0]!.stage).toBe('outreach_sent');
    expect(chats[0]!.source).toBe('recommendation');
    expect(chats[0]!.firstOutreachAt).toBeTruthy();
    expect((await db.recommendations.get(recId))!.status).toBe('converted');
    expect((await db.outbound.get(d.id))!.chatId).toBe(chats[0]!.id);
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
  });

  it('a Gmail API send links the chat to its thread, follow-ups thread, and the next sync does not double count', async () => {
    await connectGoogle(user);
    const { p, d } = await recommendationOutreach('gmail');
    const body = d.bodyDraft.replace(/\[[^\]]+\]/g, 'we both studied at Michigan');
    const r = await approveAndSend(user, d.id, body, d.subject ?? 'Quick question', new Date(), {
      undoWindowMs: 0,
    });
    expect(r).toEqual({ ok: true, status: 'sent' });
    const out = (await db.outbound.get(d.id))!;
    expect(out.providerMessageId).toBe('gm-1');
    expect(out.externalThreadId).toBe('gth-1');
    const chat = (await db.chats.where('personId').equals(p.id).first())!;
    const thread = (await db.threads.get(chat.threadId!))!;
    expect(thread.externalThreadId).toBe('gth-1');
    expect(thread.chatId).toBe(chat.id);
    // the follow-up replies in the same thread with the original subject
    const bump = await draftMessage(user, p.id, 'bump', 'gmail', chat.id);
    expect(bump.externalThreadId).toBe('gth-1');
    // next sync: the sent message comes back from Gmail
    const tpsBefore = await db.touchpoints.where('personId').equals(p.id).count();
    const stageEventsBefore = await db.stageEvents.where('chatId').equals(chat.id).count();
    await ingestEmails(
      user,
      [
        {
          externalMessageId: 'gm-1',
          externalThreadId: 'gth-1',
          from: `${user.fullName} <${user.email}>`,
          to: [p.primaryEmail!],
          cc: [],
          subject: out.subject,
          sentAt: new Date().toISOString(),
          bodyText: body,
          headers: { 'message-id': '<gm-1@mail.gmail.com>', 'x-orbit-message-id': d.id },
          labels: ['SENT'],
        },
      ],
      { useLlm: false },
    );
    expect(await db.touchpoints.where('personId').equals(p.id).count()).toBe(tpsBefore);
    expect(await db.messages.where('externalMessageId').equals('gm-1').count()).toBe(1);
    expect(await db.stageEvents.where('chatId').equals(chat.id).count()).toBe(stageEventsBefore);
    // later reply threads with In-Reply-To the sent message
    await approveAndSend(user, bump.id, bump.bodyDraft, undefined, new Date(Date.now() + 5 * 86_400_000), {
      undoWindowMs: 0,
    });
    expect(sent[1]!.threadId).toBe('gth-1');
    expect(sent[1]!.headers.subject).toBe(`Re: ${out.subject}`);
    expect(sent[1]!.headers['in-reply-to']).toBe('<gm-1@mail.gmail.com>');
  });

  it('ingest recognises an Orbit send by X-Orbit-Message-Id even when the sent row was not recorded', async () => {
    await connectGoogle(user);
    const { p, d } = await recommendationOutreach('gmail');
    const body = d.bodyDraft.replace(/\[[^\]]+\]/g, 'we both studied at Michigan');
    await approveAndSend(user, d.id, body, d.subject ?? 'Quick question', new Date(), { undoWindowMs: 0 });
    await db.messages.where('externalMessageId').equals('gm-1').delete();
    const chat = (await db.chats.where('personId').equals(p.id).first())!;
    await db.chats.update(chat.id, { threadId: undefined });
    await db.threads.where('externalThreadId').equals('gth-1').delete();
    const before = await db.touchpoints.where('personId').equals(p.id).toArray();
    await ingestEmails(
      user,
      [
        {
          externalMessageId: 'gm-1',
          externalThreadId: 'gth-1',
          from: user.email,
          to: [p.primaryEmail!],
          cc: [],
          subject: 'Quick question',
          sentAt: new Date().toISOString(),
          bodyText: body,
          headers: { 'message-id': '<gm-1@mail.gmail.com>', 'x-orbit-message-id': d.id },
          labels: ['SENT'],
        },
      ],
      { useLlm: false },
    );
    const after = await db.touchpoints.where('personId').equals(p.id).toArray();
    expect(after.filter((t) => t.kind === 'email_out')).toHaveLength(
      before.filter((t) => t.kind === 'email_out').length,
    );
    const fresh = (await db.chats.get(chat.id))!;
    expect(fresh.threadId).toBeTruthy();
    expect((await db.threads.get(fresh.threadId!))!.externalThreadId).toBe('gth-1');
  });
});

describe('approval ordering and idempotency (SND-04, SND-06)', () => {
  it('a send blocked by the daily cap changes nothing: draft editable, suggestion pending, no feedback', async () => {
    await db.settings.update(user.id, { dailySendCapGmail: 0 });
    const { s, d } = await pendingDraft(user, 'schedule_confirm');
    const r = await approveAndSend(user, d.id, d.bodyDraft);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Daily limit reached: 0 emails today/);
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
    expect((await db.suggestions.get(s.id))!.status).toBe('pending');
    expect(
      await db.feedback
        .where('userId')
        .equals(user.id)
        .filter((f) => f.suggestionId === s.id)
        .count(),
    ).toBe(0);
  });

  it('a provider failure leaves the suggestion pending and the draft retryable', async () => {
    await connectGoogle(user);
    failSends = 1;
    const { s, d } = await pendingDraft(user, 'thank_you');
    const r = await approveAndSend(user, d.id, d.bodyDraft, undefined, new Date(), { undoWindowMs: 0 });
    expect(r.ok).toBe(false);
    const failed = (await db.outbound.get(d.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/500/);
    expect((await db.suggestions.get(s.id))!.status).toBe('pending');
    const chat = (await db.chats.get(s.chatId!))!;
    expect(chat.stage).toBe('completed');
    const retry = await approveAndSend(user, d.id, d.bodyDraft, undefined, new Date(), { undoWindowMs: 0 });
    expect(retry).toEqual({ ok: true, status: 'sent' });
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
    expect((await db.chats.get(s.chatId!))!.stage).toBe('followed_up');
  });

  it('two overlapping approvals send once', async () => {
    await connectGoogle(user);
    const d = await bumpDraft(user);
    const chatBefore = (await db.chats.get(d.chatId!))!;
    const rs = await Promise.all([
      approveAndSend(user, d.id, d.bodyDraft, undefined, new Date(), { undoWindowMs: 0 }),
      approveAndSend(user, d.id, d.bodyDraft, undefined, new Date(), { undoWindowMs: 0 }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const audits = await db.audit
      .where('userId')
      .equals(user.id)
      .filter((a) => a.action === 'message.sent' && a.objectId === d.id)
      .count();
    expect(audits).toBe(1);
    expect((await db.chats.get(d.chatId!))!.bumpCount).toBe(chatBefore.bumpCount + 1);
  });
});

describe('cooldown and declined rules (SND-05, SND-13)', () => {
  async function sentOutreach(hoursAgo: number) {
    const p = await freshPerson(user, { email: true });
    const { chat, draft } = await startWarmUpOrOutreach(user, p.id, 'gmail');
    const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    await db.outbound.update(draft!.id, { status: 'sent', sentAt: at, bodyFinal: draft!.bodyDraft });
    await db.chats.update(chat.id, { stage: 'outreach_sent', stageEnteredAt: at, firstOutreachAt: at });
    return { p, chat };
  }

  it('holds back every unanswered ask but never replies, scheduling, thank-yous or congratulations', async () => {
    const { p } = await sentOutreach(0.5);
    const bump = await checkSendAllowed(user.id, p.id, 'gmail', 'bump');
    expect(bump.allowed).toBe(false);
    expect(bump.reason).toMatch(/You wrote to \w+ 30 minutes ago and they have not replied yet\./);
    expect((await checkSendAllowed(user.id, p.id, 'gmail', 'outreach')).allowed).toBe(false);
    for (const kind of ['reply', 'thank_you', 'schedule', 'congratulate'] as const)
      expect((await checkSendAllowed(user.id, p.id, 'gmail', kind)).allowed).toBe(true);
    // every other ask waits too: a referral or intro ask, a check-in or an update minutes after a cold email
    for (const kind of ['referral_ask', 'intro_request', 'nurture', 'report_back'] as const)
      expect((await checkSendAllowed(user.id, p.id, 'gmail', kind)).allowed).toBe(false);
    const later = await checkSendAllowed(
      user.id,
      p.id,
      'gmail',
      'bump',
      new Date(Date.now() + 20 * 3_600_000),
    );
    expect(later.reason).toMatch(/21 hours ago/);
  });

  it('a chat moved to Replied by hand (no Gmail inbound) counts as an answer', async () => {
    const { p, chat } = await sentOutreach(20);
    await db.chats.update(chat.id, { stage: 'replied', stageEnteredAt: new Date().toISOString() });
    expect((await checkSendAllowed(user.id, p.id, 'gmail', 'bump')).allowed).toBe(true);
  });

  it('an old declined chat does not block a fresh outreach started later', async () => {
    const p = await freshPerson(user, { email: true });
    await db.chats.add({
      id: newId('c'),
      userId: user.id,
      personId: p.id,
      stage: 'declined',
      stageEnteredAt: '2025-03-01T10:00:00.000Z',
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: '2025-02-01T10:00:00.000Z',
      updatedAt: '2025-03-01T10:00:00.000Z',
    });
    const { chat, draft } = await startWarmUpOrOutreach(user, p.id, 'gmail');
    expect(chat.stage).toBe('identified');
    const body = draft!.bodyDraft.replace(/\[[^\]]+\]/g, 'we both studied at Michigan');
    const r = await approveAndSend(user, draft!.id, body, draft!.subject ?? 'Quick question');
    expect(r.ok).toBe(true);
    // but a nurture on the declined chat itself is still held back
    const n = await checkSendAllowed(user.id, p.id, 'gmail', 'nurture', new Date(), {
      chatId: (await db.chats
        .where('personId')
        .equals(p.id)
        .filter((c) => c.stage === 'declined')
        .first())!.id,
    });
    expect(n.allowed).toBe(false);
  });
});

describe('a time-limited decline (L35, L36)', () => {
  it('the re-engagement card Orbit offers once the window passed can be sent, once', async () => {
    const D = 86_400_000;
    // ten days into the current quarter; they said "not this quarter" 25 days before it began
    const today = new Date();
    const qStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    const now = new Date(qStart.getTime() + 10 * D + 12 * 3_600_000);
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * D).toISOString();
    const who = { name: 'Marcus Webb', email: 'marcus.webb@ramp.com' };
    const raw = (id: string, dir: 'out' | 'in', sentAt: string, body: string) => ({
      externalMessageId: `rg_${id}`,
      externalThreadId: 'rg_thread',
      from: dir === 'out' ? user.email : `${who.name} <${who.email}>`,
      to: [dir === 'out' ? who.email : user.email],
      cc: [],
      subject: dir === 'out' ? 'Coffee chat?' : 'Re: Coffee chat?',
      sentAt,
      bodyText: body,
      headers: { 'message-id': `<rg_${id}@test>` },
    });
    await ingestEmails(
      user,
      [
        raw(
          '1',
          'out',
          at(45),
          "Hi Marcus,\n\nI'm a junior at Cornell studying CS. Would you be open to a 20-minute call sometime in the next couple of weeks?\n\nBest,\nAlex",
        ),
        raw(
          '2',
          'in',
          at(35),
          "Hi Alex, thanks for writing. I'm not able to take calls this quarter, sorry.\n\nMarcus",
        ),
      ],
      { useLlm: false, now },
    );
    const p = (await db.people.filter((x) => x.primaryEmail === who.email).first())!;
    const chat = (await db.chats.where('personId').equals(p.id).first())!;
    if (chat.stage !== 'declined')
      await db.chats.update(chat.id, { stage: 'declined', stageEnteredAt: at(35) });
    // still inside the window: the declined chat holds every ask back
    const early = await checkSendAllowed(
      user.id,
      p.id,
      'gmail',
      'nurture',
      new Date(now.getTime() - 12 * D),
      {
        chatId: chat.id,
      },
    );
    expect(early.allowed).toBe(false);
    await generateBrief(user, 'daily', now);
    const card = (await db.suggestions.where('personId').equals(p.id).toArray()).find((s) =>
      s.dedupeKey.startsWith('reengage:'),
    );
    expect(card?.status).toBe('pending');
    // drafted when the brief shows it, or when the student opens it
    const d = card!.outboundMessageId
      ? (await db.outbound.get(card!.outboundMessageId))!
      : (await draftForSuggestion(user, card!, now))!;
    expect(d.kind).toBe('nurture');
    const r = await approveAndSend(user, d.id, d.bodyDraft, d.subject, now);
    expect(r).toMatchObject({ ok: true });
    // that was the one second try: another ask on the declined chat is held back again
    await confirmHandoff(user, d.id);
    const again = await checkSendAllowed(user.id, p.id, 'gmail', 'nurture', new Date(now.getTime() + 5 * D), {
      chatId: chat.id,
    });
    expect(again.allowed).toBe(false);
  });
});

describe('hand-offs (SND-07, SND-12, SND-14, UI-09)', () => {
  it('a rule re-run keeps a handed-off draft on its card, so "I sent it" stays (e2e flake)', async () => {
    const { s, d } = await pendingDraft(user, 'thank_you');
    const r = await approveAndSend(user, d.id, `${d.bodyDraft}\n\nPS kept`);
    expect(r.ok && r.status).toBe('handed_off');
    // the same card comes back from the rules (a brief, an immediate pass) while the student is in the mail app
    await evaluateImmediateSuggestions(user.id, { chatId: s.chatId, personId: s.personId });
    await generateBrief(user, 'daily');
    const after = (await db.suggestions.get(s.id))!;
    expect(after.outboundMessageId).toBe(d.id);
    const o = (await db.outbound.get(d.id))!;
    expect(o.status).toBe('handed_off');
    expect(o.bodyFinal).toMatch(/PS kept$/);
    expect((await confirmHandoff(user, d.id)).ok).toBe(true);
  });

  it('mailto is handed_off, not sent, until the student confirms; "Not sent" reverts to draft', async () => {
    const { s, d } = await pendingDraft(user, 'thank_you');
    const r = await approveAndSend(user, d.id, d.bodyDraft);
    expect(r.ok && r.status === 'handed_off' && r.via).toBe('mailto');
    const o = (await db.outbound.get(d.id))!;
    expect(o.status).toBe('handed_off');
    expect(o.sentAt).toBeUndefined();
    expect((await db.chats.get(s.chatId!))!.stage).toBe('completed');
    expect(await revertHandoff(user, d.id)).toBe(true);
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
    await approveAndSend(user, d.id, d.bodyDraft);
    await confirmHandoff(user, d.id);
    expect((await db.outbound.get(d.id))!.status).toBe('sent');
    expect((await db.chats.get(s.chatId!))!.stage).toBe('followed_up');
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
    expect((await confirmHandoff(user, d.id)).ok).toBe(false);
  });

  it('LinkedIn: a non-connection goes to the profile with a note capped at 300 characters; a connection to compose', async () => {
    const cold = await freshPerson(user, { email: false, linkedin: true, connected: false });
    const note = await draftMessage(user, cold.id, 'outreach', 'linkedin');
    const tooLong = `Hi ${cold.firstName}, ${'I am a student who would value 20 minutes of your time. '.repeat(8)}`;
    const blocked = await approveAndSend(user, note.id, tooLong);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.error).toMatch(/300 characters/);
    expect((await db.outbound.get(note.id))!.status).toBe('draft');
    const short = `Hi ${cold.firstName}, I'm a junior at Michigan recruiting for product roles. Could I ask you 3 questions about your team in 20 minutes? Thanks, Sam`;
    const ok = await approveAndSend(user, note.id, short);
    expect(ok.ok && ok.status === 'handed_off' && ok.via).toBe('linkedin_connect');
    expect(ok.ok && ok.status === 'handed_off' && ok.handoffUrl).toBe(
      `https://www.linkedin.com/in/${cold.linkedinSlug}/`,
    );
    const warm = await freshPerson(user, { email: false, linkedin: true, connected: true });
    const msg = await draftMessage(user, warm.id, 'nurture', 'linkedin');
    const r = await approveAndSend(user, msg.id, `Hi ${warm.firstName}, ${tooLong}`);
    expect(r.ok && r.status === 'handed_off' && r.via).toBe('linkedin_compose');
    expect(r.ok && r.status === 'handed_off' && r.handoffUrl).toMatch(/messaging\/compose/);
  });

  it('LinkedIn: someone who answered a chat that started with a connection note gets a message, not Connect', async () => {
    const p = await freshPerson(user, { email: false, linkedin: true, connected: false });
    const note = await draftMessage(user, p.id, 'outreach', 'linkedin');
    const short = `Hi ${p.firstName}, I'm a junior at Michigan recruiting for product roles. Could I ask you 3 questions about your team in 20 minutes? Thanks, Sam`;
    expect((await approveAndSend(user, note.id, short)).ok).toBe(true);
    expect((await confirmHandoff(user, note.id)).ok).toBe(true);
    const chat = (await db.chats.where('personId').equals(p.id).first())!;
    expect(chat.outreachChannel).toBe('linkedin');
    // before they answer, anything else still goes with the request and is capped at 300 characters
    const early = await draftMessage(user, p.id, 'nurture', 'linkedin', chat.id);
    const long = `Hi ${p.firstName}, ${'A short update from me on the internship search and what I learned. '.repeat(6)}`;
    const capped = await reviewDraft(user, early, long);
    expect(capped.find((i) => i.code === 'linkedin_note_too_long')?.blocking).toBe(true);
    // they accepted and we had the chat
    await db.chats.update(chat.id, { stage: 'completed', stageEnteredAt: new Date().toISOString() });
    const ty = await draftMessage(user, p.id, 'thank_you', 'linkedin', chat.id);
    expect(
      (await reviewDraft(user, ty, long)).find((i) => i.code === 'linkedin_note_too_long'),
    ).toBeUndefined();
    const r = await approveAndSend(user, ty.id, `Hi ${p.firstName}, thanks again for the time today. Sam`);
    expect(r.ok && r.status === 'handed_off' && r.via).toBe('linkedin_compose');
    expect(r.ok && r.status === 'handed_off' && r.handoffUrl).toMatch(/messaging\/compose/);
    expect((await handoffLink(user, ty.id))?.via).toBe('linkedin_compose');
  });

  it('LinkedIn: after the chat moves on to Nurturing or Archived, a check-in is still a message, not Connect', async () => {
    const p = await freshPerson(user, { email: false, linkedin: true, connected: false });
    const note = await draftMessage(user, p.id, 'outreach', 'linkedin');
    const short = `Hi ${p.firstName}, I'm a junior at Michigan recruiting for product roles. Could I ask you 3 questions about your team in 20 minutes? Thanks, Sam`;
    expect((await approveAndSend(user, note.id, short)).ok).toBe(true);
    expect((await confirmHandoff(user, note.id)).ok).toBe(true);
    const chat = (await db.chats.where('personId').equals(p.id).first())!;
    const long = `Hi ${p.firstName}, ${'A short update from me on the internship search and what I learned. '.repeat(6)}`;
    // the note went out weeks ago; they answered on LinkedIn (marked by hand, so no inbound email date) and the chat happened
    await db.outbound.update(note.id, { sentAt: new Date(Date.now() - 45 * 86_400_000).toISOString() });
    const answered = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await db.chats.update(chat.id, { stage: 'replied', stageEnteredAt: answered });
    await db.chats.update(chat.id, { stage: 'completed', stageEnteredAt: answered, completedAt: answered });
    for (const stage of ['nurturing', 'archived'] as const) {
      await db.chats.update(chat.id, { stage, stageEnteredAt: new Date().toISOString() });
      const d = await draftMessage(user, p.id, 'nurture', 'linkedin', chat.id);
      expect(
        (await reviewDraft(user, d, long)).find((i) => i.code === 'linkedin_note_too_long'),
      ).toBeUndefined();
      const r = await approveAndSend(user, d.id, long);
      expect(r.ok && r.status === 'handed_off' && r.via).toBe('linkedin_compose');
      expect(r.ok && r.status === 'handed_off' && r.handoffUrl).toMatch(/messaging\/compose/);
      expect((await handoffLink(user, d.id))?.via).toBe('linkedin_compose');
      expect(await revertHandoff(user, d.id)).toBe(true);
      await db.outbound.update(d.id, { status: 'cancelled' });
    }
    // an archived chat they never answered does not make them a connection
    await db.chats.update(chat.id, { completedAt: undefined });
    const cold = await draftMessage(user, p.id, 'nurture', 'linkedin', chat.id);
    expect(
      (await reviewDraft(user, cold, long)).find((i) => i.code === 'linkedin_note_too_long')?.blocking,
    ).toBe(true);
  });

  it('hand-offs count toward the daily cap from the moment they open', async () => {
    await db.settings.update(user.id, { dailySendCapLinkedin: 1 });
    const a = await freshPerson(user, { email: false, linkedin: true, connected: false });
    const d1 = await draftMessage(user, a.id, 'outreach', 'linkedin');
    expect(
      (await approveAndSend(user, d1.id, `Hi ${a.firstName}, could I ask you 3 questions? Sam`)).ok,
    ).toBe(true);
    const b = await freshPerson(user, { email: false, linkedin: true, connected: false });
    const d2 = await draftMessage(user, b.id, 'outreach', 'linkedin');
    const r = await approveAndSend(user, d2.id, `Hi ${b.firstName}, could I ask you 3 questions? Sam`);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Daily limit reached: 1 LinkedIn messages today/);
    expect((await db.outbound.get(d2.id))!.status).toBe('draft');
  });

  it('a confirmation that fails half way is still recorded as sent, never stuck in sending', async () => {
    const { s, d } = await pendingDraft(user, 'thank_you');
    expect((await approveAndSend(user, d.id, d.bodyDraft)).ok).toBe(true);
    const spy = vi.spyOn(db.touchpoints, 'add').mockRejectedValueOnce(new Error('QuotaExceededError'));
    const r = await confirmHandoff(user, d.id);
    spy.mockRestore();
    expect(r.ok).toBe(false);
    // the chat did move, so the student is not told it did not
    expect(!r.ok && r.error).toBe(
      'Logged as sent and the chat is updated, but Orbit could not save all of it to their history. Check their page.',
    );
    const o = (await db.outbound.get(d.id))!;
    expect(o.status).toBe('sent');
    expect(o.sentAt).toBeTruthy();
    expect((await confirmHandoff(user, d.id)).ok).toBe(false);
    // the rest of the bookkeeping still ran: the card is closed and the chat moved on
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
    expect((await db.chats.get(s.chatId!))!.stage).toBe('followed_up');
  });

  it('a confirmation whose chat update fails says the chat is behind', async () => {
    const { s, d } = await pendingDraft(user, 'thank_you');
    expect((await approveAndSend(user, d.id, d.bodyDraft)).ok).toBe(true);
    const spy = vi.spyOn(db.chats, 'update').mockRejectedValueOnce(new Error('QuotaExceededError'));
    const r = await confirmHandoff(user, d.id);
    spy.mockRestore();
    expect(!r.ok && r.error).toBe(
      'Logged as sent, but Orbit could not update the chat. Check its stage on their page.',
    );
    expect((await db.outbound.get(d.id))!.status).toBe('sent');
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
  });

  it('a Gmail send whose bookkeeping fails tells the student whether the chat moved', async () => {
    await connectGoogle(user);
    const seen = new Set<string>();
    const newNotes = async () => {
      const fresh = (await db.notifications.where('userId').equals(user.id).toArray()).filter(
        (n) => !seen.has(n.id),
      );
      for (const n of fresh) seen.add(n.id);
      return fresh.filter((n) => n.title === 'Sent').map((n) => n.body);
    };
    await newNotes();
    const t0 = new Date();
    const due = new Date(t0.getTime() + UNDO_WINDOW_MS + 1000);
    const { d } = await pendingDraft(user, 'thank_you');
    await approveAndSend(user, d.id, d.bodyDraft, undefined, t0);
    const audit = vi.spyOn(db.audit, 'add').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await sendDueQueued(user, due);
    audit.mockRestore();
    expect(await newNotes()).toEqual([
      'Orbit sent it and updated the chat, but could not save all of it to their history. Check their page.',
    ]);
    const bump = await bumpDraft(user);
    await approveAndSend(user, bump.id, bump.bodyDraft, undefined, t0);
    const chats = vi.spyOn(db.chats, 'update').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await sendDueQueued(user, due);
    chats.mockRestore();
    expect((await db.outbound.get(bump.id))!.status).toBe('sent');
    expect(await newNotes()).toEqual(['Orbit sent it but could not update the chat. Check its stage.']);
  });

  it('a Gmail send whose bookkeeping fails half way still closes the card and moves the chat', async () => {
    await connectGoogle(user);
    const { s, d } = await pendingDraft(user, 'thank_you');
    const t0 = new Date();
    await approveAndSend(user, d.id, d.bodyDraft, undefined, t0);
    const spy = vi.spyOn(db.audit, 'add').mockRejectedValueOnce(new Error('QuotaExceededError'));
    const res = await sendDueQueued(user, new Date(t0.getTime() + UNDO_WINDOW_MS + 1000));
    spy.mockRestore();
    expect(res).toEqual([{ id: d.id, ok: true }]);
    expect(sent).toHaveLength(1);
    expect((await db.outbound.get(d.id))!.status).toBe('sent');
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
    expect((await db.chats.get(s.chatId!))!.stage).toBe('followed_up');
  });

  it('a person with no email and no LinkedIn profile gets an error, never "sent"', async () => {
    const p = await freshPerson(user, { email: false, linkedin: true });
    await db.people.update(p.id, { linkedinUrl: undefined, linkedinSlug: undefined });
    const d = await draftMessage(user, p.id, 'nurture', 'linkedin');
    const r = await approveAndSend(user, d.id, `Hi ${p.firstName}, quick update from me.`);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no LinkedIn profile/);
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
  });
});

describe('undo window (SND-12)', () => {
  it('a Gmail send is queued for 60 seconds, can be undone, and the scheduler sends it when due', async () => {
    await connectGoogle(user);
    const { s, d } = await pendingDraft(user, 'thank_you');
    const t0 = new Date();
    const r = await approveAndSend(user, d.id, d.bodyDraft, undefined, t0);
    expect(r).toEqual({
      ok: true,
      status: 'queued',
      sendAt: new Date(t0.getTime() + UNDO_WINDOW_MS).toISOString(),
    });
    expect((await db.outbound.get(d.id))!.status).toBe('queued');
    expect(await sendDueQueued(user, new Date(t0.getTime() + 30_000))).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(await undoQueued(user, d.id)).toBe(true);
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
    expect((await db.suggestions.get(s.id))!.status).toBe('pending');
    await approveAndSend(user, d.id, d.bodyDraft, undefined, t0);
    const res = await sendDueQueued(user, new Date(t0.getTime() + UNDO_WINDOW_MS + 1000));
    expect(res).toEqual([{ id: d.id, ok: true }]);
    expect(sent).toHaveLength(1);
    expect((await db.outbound.get(d.id))!.status).toBe('sent');
    expect(await undoQueued(user, d.id)).toBe(false);
    expect((await db.suggestions.get(s.id))!.status).toBe('sent');
    // a second scheduler tick sends nothing more
    expect(await sendDueQueued(user, new Date(t0.getTime() + UNDO_WINDOW_MS + 5000))).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('a queue found long after its window (Orbit was closed) is not sent blindly', async () => {
    await connectGoogle(user);
    const { d } = await pendingDraft(user, 'thank_you');
    const t0 = new Date();
    await approveAndSend(user, d.id, d.bodyDraft, undefined, t0);
    const res = await sendDueQueued(user, new Date(t0.getTime() + 3_600_000));
    expect(res[0]!.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect((await db.outbound.get(d.id))!.status).toBe('failed');
  });
});

describe('re-validation at approval (SND-17) and stage mapping (SND-21)', () => {
  it('edited text addressed to the wrong person or with a template phrase is blocked; the unedited draft is not', async () => {
    const { d } = await pendingDraft(user, 'thank_you');
    expect((await reviewDraft(user, d, d.bodyDraft)).filter((i) => i.blocking)).toEqual([]);
    const r = await approveAndSend(
      user,
      d.id,
      'Hi Priya,\n\nI hope this email finds you well. Thanks again.\n\nSam',
    );
    expect(r.ok).toBe(false);
    const codes = !r.ok ? (r.issues ?? []).filter((i) => i.blocking).map((i) => i.code) : [];
    expect(codes).toContain('missing_name');
    expect(codes).toContain('banned_phrase');
    expect((await db.outbound.get(d.id))!.status).toBe('draft');
    const warn = await reviewDraft(user, d, `${d.bodyDraft}\n\nMy site: https://sam.dev`);
    expect(warn.find((i) => i.code === 'unknown_url')?.blocking).toBe(false);
  });

  it("a plain 'reply' (not a time confirmation) does not move the chat to scheduling", async () => {
    const d = await bumpDraft(user);
    const chat = (await db.chats.get(d.chatId!))!;
    await db.chats.update(chat.id, { stage: 'replied', stageEnteredAt: new Date().toISOString() });
    const reply: OutboundMessage = {
      ...d,
      id: newId('out'),
      kind: 'reply',
      suggestionId: undefined,
      status: 'draft',
    };
    await db.outbound.add(reply);
    const r = await approveAndSend(user, reply.id, reply.bodyDraft);
    expect(r.ok).toBe(true);
    await confirmHandoff(user, reply.id);
    expect((await db.chats.get(chat.id))!.stage).toBe('replied');
  });
});

describe('gfetch retries (IS-6)', () => {
  it('retries 429 and 403 rate-limit with backoff, gives up after the cap, never retries a failed POST', async () => {
    await connectGoogle(user);
    const delays: number[] = [];
    gfetchRetry.sleep = async (ms) => {
      delays.push(ms);
    };
    const rate403 = () =>
      Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 });
    const ok = () => Response.json({ messages: [{ id: 'a' }] });
    const seq = [new Response('', { status: 429, headers: { 'retry-after': '2' } }), rate403(), ok()];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => seq.shift()!),
    );
    expect(await gmailListIds('in:sent')).toEqual(['a']);
    expect(delays[0]).toBe(2000);
    expect(delays).toHaveLength(2);
    const always = vi.fn(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', always);
    await expect(gmailListIds('in:sent')).rejects.toThrow(/rate limiting/);
    expect(always).toHaveBeenCalledTimes(gfetchRetry.maxRetries + 1);
    const forbidden = vi.fn(async () =>
      Response.json({ error: { errors: [{ reason: 'forbidden' }] } }, { status: 403 }),
    );
    vi.stubGlobal('fetch', forbidden);
    await expect(gmailListIds('in:sent')).rejects.toThrow(/403/);
    expect(forbidden).toHaveBeenCalledTimes(1);
    const { d } = await pendingDraft(user, 'thank_you');
    const fail500 = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fail500);
    const r = await approveAndSend(user, d.id, d.bodyDraft, undefined, new Date(), { undoWindowMs: 0 });
    expect(r.ok).toBe(false);
    expect(fail500).toHaveBeenCalledTimes(1);
  });
});

describe('LinkedIn and mail hand-off in the browser (IS-5)', () => {
  const fakeToast = () => {
    const pushed: { text: string; action?: { label: string; onClick: () => void } }[] = [];
    return { pushed, toast: { push: (t: (typeof pushed)[number]) => pushed.push(t) } as never };
  };

  it('says "Copied" only when the clipboard write worked, and offers an Open button when the tab was blocked', async () => {
    const cold = await freshPerson(user, { email: false, linkedin: true, connected: true });
    const d = await draftMessage(user, cold.id, 'nurture', 'linkedin');
    const body = `Hi ${cold.firstName}, quick update from me on the internship search.`;
    // clipboard refused and popup blocked
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const a = fakeToast();
    expect(await runApproval(user, d, body, undefined, a.toast, cold.firstName)).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    expect(a.pushed[0]!.text).not.toMatch(/Copied/);
    expect(a.pushed[0]!.text).toMatch(/blocked/);
    expect(a.pushed[0]!.action?.label).toBe('Open LinkedIn');
    expect((await db.outbound.get(d.id))!.status).toBe('handed_off');
    // the Open button retries inside its own click
    const win = { opener: {} as unknown };
    open.mockReturnValueOnce(win as never);
    a.pushed[0]!.action!.onClick();
    expect(open).toHaveBeenLastCalledWith(expect.stringMatching(/linkedin\.com/), '_blank');
    expect(win.opener).toBeNull();
    // "Open again" resolves the same link while the message waits for confirmation
    expect((await handoffLink(user, d.id))?.via).toBe('linkedin_compose');

    // clipboard works and the tab opens
    await revertHandoff(user, d.id);
    const writes: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: async (t: string) => void writes.push(t) },
    });
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ opener: null })),
    );
    const b = fakeToast();
    await runApproval(user, (await db.outbound.get(d.id))!, body, undefined, b.toast, cold.firstName);
    expect(writes).toEqual([body]);
    expect(b.pushed[0]!.text).toMatch(/^Copied\./);
    expect(b.pushed[0]!.action).toBeUndefined();
    await confirmHandoff(user, d.id);
    expect(await handoffLink(user, d.id)).toBeUndefined();
  });

  it('a mail hand-off opens through a link click, not a popup window', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const clicked: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    expect(openHandoff('mailto:a%40b.com?subject=Re%3A%20Hi&body=x')).toBe(true);
    expect(clicked[0]).toMatch(/^mailto:/);
    expect(open).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('Google permissions (IS-10)', () => {
  it('asks for read-only calendar access and explains any permission the student did not grant', () => {
    expect(GOOGLE_SCOPES).toContain(CALENDAR_READ_SCOPE);
    expect(GOOGLE_SCOPES).not.toContain('https://www.googleapis.com/auth/calendar.events');
    expect(googleScopeWarning(GOOGLE_SCOPES)).toBeUndefined();
    expect(googleScopeWarning(undefined)).toBeUndefined();
    const noSend = googleScopeWarning([GMAIL_READ_SCOPE, CALENDAR_READ_SCOPE, 'openid']);
    expect(noSend).toMatch(/send email, so approved emails will open in your mail app/);
    expect(noSend).not.toMatch(/[\u2013\u2014!]/);
  });

  it('without the send permission an approved email hands off to the mail app instead of failing at send time', async () => {
    await connectGoogle(user);
    await db.integrations.update('int_google', { scopes: [GMAIL_READ_SCOPE, CALENDAR_READ_SCOPE] });
    const { d } = await pendingDraft(user, 'thank_you');
    const r = await approveAndSend(user, d.id, d.bodyDraft);
    expect(r.ok && r.status === 'handed_off' && r.via).toBe('mailto');
    expect(fetchMock).not.toHaveBeenCalled();
    // a token whose grant lacks gmail.send is also respected (older rows stored no scopes)
    await revertHandoff(user, d.id);
    await db.integrations.update('int_google', { scopes: [] });
    sessionStorage.setItem(
      'orbit.google.token',
      JSON.stringify({ accessToken: 't', expiresAt: Date.now() + 3_600_000, scopes: [GMAIL_READ_SCOPE] }),
    );
    const r2 = await approveAndSend(user, d.id, d.bodyDraft);
    expect(r2.ok && r2.status === 'handed_off').toBe(true);
    // with the permission it queues for the Gmail API
    await revertHandoff(user, d.id);
    await db.integrations.update('int_google', { scopes: GOOGLE_SCOPES });
    sessionStorage.setItem(
      'orbit.google.token',
      JSON.stringify({ accessToken: 't', expiresAt: Date.now() + 3_600_000, scopes: GOOGLE_SCOPES }),
    );
    const r3 = await approveAndSend(user, d.id, d.bodyDraft);
    expect(r3.ok && r3.status).toBe('queued');
  });

  it('a 403 for a missing permission says so in plain words', async () => {
    await connectGoogle(user);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: 'Request had insufficient authentication scopes.',
              errors: [{ reason: 'insufficientPermissions' }],
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(gmailListIds('in:sent')).rejects.toThrow(/did not give Orbit permission/);
  });

  it('shows the consent screen on the first connection only, records the granted scopes, and again after disconnect', async () => {
    localStorage.clear();
    writePrefs({ googleClientId: 'test-client.apps.googleusercontent.com' });
    const prompts: (string | undefined)[] = [];
    let granted = GOOGLE_SCOPES.join(' ');
    let requested = '';
    vi.stubGlobal('google', {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { scope: string; callback: (r: object) => void }) => ({
            requestAccessToken: (o?: { prompt?: string }) => {
              prompts.push(o?.prompt);
              requested = cfg.scope;
              cfg.callback({ access_token: 'tok', expires_in: 3600, scope: granted });
            },
          }),
          revoke: () => {},
        },
      },
    });
    const first = await connectGoogleOAuth();
    expect(requested).toContain('calendar.events.readonly');
    expect(first.scopes).toEqual(GOOGLE_SCOPES);
    await connectGoogleOAuth();
    expect(prompts).toEqual(['consent', '']);
    // a partial grant keeps asking with the consent screen until everything is allowed
    granted = [GMAIL_READ_SCOPE, CALENDAR_READ_SCOPE].join(' ');
    const partial = await connectGoogleOAuth();
    expect(partial.scopes).not.toContain(GMAIL_SEND_SCOPE);
    await connectGoogleOAuth();
    expect(prompts.at(-1)).toBe('consent');
    granted = GOOGLE_SCOPES.join(' ');
    await connectGoogleOAuth();
    disconnectGoogle();
    await connectGoogleOAuth();
    expect(prompts.at(-1)).toBe('consent');
  });
});
