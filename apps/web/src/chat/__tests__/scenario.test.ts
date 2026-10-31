/**
 * A student's day through execute() only: the brief, a person, a draft edited and sent, a note that becomes facts
 * and a thank-you, pipeline moves with their guards, an intro request from a route, an import, a setting, a card
 * dismissed and restored.
 */
import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { execute } from '../registry';
import type { ResultEnvelope } from '../types';
import { makeCtx, NOW } from './helpers';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

const run = (name: string, input: Record<string, unknown>, over = {}): Promise<ResultEnvelope> =>
  execute(name, input, makeCtx(user, over));
const model = (env: ResultEnvelope) => (env.data as { forModel: Record<string, unknown> }).forModel;

async function approve(
  env: ResultEnvelope,
  name: string,
  input: Record<string, unknown>,
  edited?: { body: string; subject?: string },
) {
  expect(env.kind).toBe('needs_confirmation');
  const token = env.confirmationId!;
  return execute(name, input, makeCtx(user, { confirmation: token, toolUseId: token, edited }));
}

describe('a day in the chat', () => {
  it('brief, person, draft, edit, send needs confirmation, approve, then the hand-off is visible in the drafts', async () => {
    const brief = await run('get_today_brief', {});
    expect(brief.kind).toBe('brief');
    const cards = model(brief).cards as { id: string; kind: string; personId?: string; draftId?: string }[];
    const thanks = cards.find((c) => c.kind === 'thank_you' && c.draftId)!;
    expect(thanks).toBeTruthy();

    const person = await run('get_person', {
      personId: thanks.personId,
      include: ['facts', 'drafts', 'prep'],
    });
    expect(person.kind).toBe('person');
    const pm = model(person) as {
      facts: unknown[];
      prep: { questions: string[] };
      nextMessage: { kind?: string };
    };
    expect(pm.facts.length).toBeGreaterThan(0);
    expect(pm.prep.questions.length).toBeGreaterThan(0);
    expect(pm.nextMessage.kind).toBe('thank_you');

    // "write a thank-you": the card's draft is reopened, not written twice
    const draft = await run('create_draft', { personId: thanks.personId, kind: 'thank_you' });
    expect(draft.kind).toBe('draft');
    const dm = model(draft) as { id: string; reopened: boolean; body: string };
    expect(dm.id).toBe(thanks.draftId);
    expect(dm.reopened).toBe(true);

    const newBody = `${dm.body.trim()}\n\nP.S. I took your advice to heart.`;
    const edited = await run('update_draft_body', { draftId: dm.id, body: newBody });
    expect(edited.kind).toBe('draft');
    expect((await db.outbound.get(dm.id))!.bodyFinal).toBe(newBody);

    const ask = await run('send_draft', { draftId: dm.id });
    expect(ask.kind).toBe('needs_confirmation');
    expect((ask.data as { blockedReason?: string }).blockedReason).toBeUndefined();
    expect(ask.summary).toMatch(/Nothing happens until you approve/);
    expect((await db.outbound.get(dm.id))!.status).toBe('draft');

    const sent = await approve(ask, 'send_draft', { draftId: dm.id }, { body: newBody, subject: undefined });
    expect(sent.kind, sent.summary).toBe('draft');
    const row = (await db.outbound.get(dm.id))!;
    // no Google in the tests: the editor's own path hands the email to the mail app and waits for "I sent it"
    expect(row.status).toBe('handed_off');
    expect(row.bodyFinal).toBe(newBody);
    expect(row.bodyFinalHash).toBeTruthy();
    expect(sent.summary).toMatch(/mail app/);

    const opened = await run('list_drafts', { list: 'opened' });
    const om = model(opened) as { opened: { id: string; status: string }[] };
    expect(om.opened.some((o) => o.id === dm.id && o.status === 'handed_off')).toBe(true);
    const detail = await run('get_draft', { draftId: dm.id });
    expect((model(detail) as { handoffUrl?: string }).handoffUrl).toMatch(/^mailto:/);

    // "I sent it" needs its own approval, then the chat moves on
    const confirmAsk = await run('confirm_handoff', { draftId: dm.id });
    const confirmed = await approve(confirmAsk, 'confirm_handoff', { draftId: dm.id });
    expect(confirmed.kind, confirmed.summary).toBe('draft');
    expect((await db.outbound.get(dm.id))!.status).toBe('sent');
    const chat = await db.chats.get(row.chatId!);
    expect(chat?.stage).toBe('followed_up');
  }, 60_000);

  it('a note becomes facts and a thank-you draft, and the person page shows both', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const stranger = people.find(
      (p) => p.isHuman && !p.hiddenAt && !!p.primaryEmail && !chats.some((c) => c.personId === p.id),
    )!;
    const preview = await run('preview_note_match', {
      text: `Coffee chat with ${stranger.displayName}. ${stranger.firstName} said to lead with a project story.`,
    });
    expect(preview.kind).toBe('note');
    expect((model(preview) as { match: string; person?: { id: string } }).person?.id).toBe(stranger.id);

    const note = await run('add_note', {
      personId: stranger.id,
      text: `Coffee chat with ${stranger.displayName}
${stranger.displayName}: That's great, we're actually hiring in January.
${user.fullName}: I'll send over my resume tonight.
${stranger.displayName}: No guarantee of course, but I'll put in a good word.`,
      source: 'manual',
      when: new Date(NOW.getTime() - 3_600_000).toISOString(),
    });
    expect(note.kind, note.summary).toBe('note');
    const nm = model(note) as {
      facts: unknown[];
      promises: unknown[];
      stage?: string;
      thankYou?: { draftId?: string };
    };
    expect(nm.facts.length).toBeGreaterThan(0);
    expect(nm.promises.length).toBeGreaterThan(0);
    expect(nm.stage).toBe('Completed');
    expect(nm.thankYou?.draftId).toBeTruthy();
    expect(note.summary).toMatch(/thank-you draft is ready/);

    const page = await run('get_person', { personId: stranger.id, include: ['facts', 'drafts', 'promises'] });
    const pm = model(page) as { facts: { text: string }[]; drafts: { kind: string }[]; promises: unknown[] };
    expect(pm.facts.length).toBeGreaterThan(0);
    expect(pm.drafts.some((d) => d.kind === 'thank_you')).toBe(true);
    expect(pm.promises.length).toBeGreaterThan(0);
  }, 60_000);

  it('moves a chat with the engine guards: early done asks first, scheduled asks for the time, undo goes back', async () => {
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const booked = chats.find((c) => c.stage === 'scheduled')!;
    const early = await run('move_pipeline_stage', { chatId: booked.id, stage: 'completed' });
    expect(early.kind).toBe('pipeline');
    expect((model(early) as { outcome: string }).outcome).toBe('meeting_ahead');
    expect((await db.chats.get(booked.id))!.stage).toBe('scheduled');
    const forced = await run('move_pipeline_stage', {
      chatId: booked.id,
      stage: 'completed',
      confirmEarly: true,
    });
    expect((model(forced) as { outcome: string }).outcome).toBe('applied');
    expect((await db.chats.get(booked.id))!.stage).toBe('completed');
    const undone = await run('undo_stage_move', { chatId: booked.id });
    expect(undone.kind).toBe('pipeline');
    expect((await db.chats.get(booked.id))!.stage).toBe('scheduled');

    const waiting = chats.find((c) => c.stage === 'outreach_sent' || c.stage === 'replied')!;
    const moved = await run('move_pipeline_stage', { chatId: waiting.id, stage: 'scheduled' });
    expect((model(moved) as { needsTime: boolean }).needsTime).toBe(true);
    expect(moved.summary).toMatch(/When is the chat/);
    const past = await run('schedule_chat', {
      chatId: waiting.id,
      startAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
    });
    expect(past.kind).toBe('error');
    expect(past.summary).toMatch(/has not passed yet/);
    const when = new Date(NOW.getTime() + 2 * 86_400_000);
    const set = await run('schedule_chat', { chatId: waiting.id, startAt: when.toISOString(), minutes: 20 });
    expect(set.kind).toBe('pipeline');
    const ev = await db.events.get((model(set) as { eventId: string }).eventId);
    expect(ev?.startAt).toBe(when.toISOString());
    const same = await run('move_pipeline_stage', { chatId: waiting.id, stage: 'scheduled' });
    expect((model(same) as { outcome: string }).outcome).toBe('unchanged');
  }, 60_000);

  it('finds routes to a company, then drafts an intro request through the first hop', async () => {
    const targets = await db.targetCompanies.where('userId').equals(user.id).toArray();
    let company: ResultEnvelope | undefined;
    for (const t of targets) {
      const r = await run('find_routes', { company: t.nameRaw });
      if (r.kind === 'company' && (model(r) as { thereNow: unknown[] }).thereNow.length) {
        company = r;
        break;
      }
    }
    expect(company, 'a target company with people in the network').toBeTruthy();
    const cm = model(company!) as { thereNow: { id: string }[] };
    const target = cm.thereNow[0]!;
    const routes = await run('find_routes', { personId: target.id });
    expect(routes.kind).toBe('routes');
    const rm = model(routes) as { routes: { hops: unknown[]; firstHopId?: string }[] };
    const via = rm.routes.find((r) => r.hops.length >= 2) ?? rm.routes[0];
    expect(via).toBeTruthy();
    const connector = via!.firstHopId!;
    if (connector !== target.id) {
      const intro = await run('create_draft', {
        personId: connector,
        kind: 'intro_request',
        targetPersonId: target.id,
      });
      expect(intro.kind, intro.summary).toBe('draft');
      const im = model(intro) as { cardId: string; kind: string; id: string };
      expect(im.kind).toBe('intro_request');
      const card = await db.suggestions.get(im.cardId);
      expect(card?.dedupeKey).toBe(`intro:${connector}:${target.id}`);
      const again = await run('create_draft', {
        personId: connector,
        kind: 'intro_request',
        targetPersonId: target.id,
      });
      expect((model(again) as { id: string; reopened: boolean }).id).toBe(im.id);
    }
    const query = await run('find_routes', { query: 'zzz nobody' });
    expect(query.summary).toMatch(/No one by that name/);
  }, 60_000);

  it('imports a small LinkedIn CSV after approval', async () => {
    const csv = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Tara,Nguyen,https://www.linkedin.com/in/tara-nguyen-chat,,Brex,Associate Product Manager,01 Oct 2026
Devin,Park,https://www.linkedin.com/in/devin-park-chat,devin@example.com,Ramp,Software Engineer,28 Sep 2026
`;
    const ask = await run('import_linkedin', { csvText: csv, filename: 'Connections.csv' });
    expect(ask.kind).toBe('needs_confirmation');
    expect((ask.data as { summary: string }).summary).toMatch(/Connections.csv/);
    const done = await approve(ask, 'import_linkedin', { csvText: csv, filename: 'Connections.csv' });
    expect(done.kind, done.summary).toBe('import');
    const im = model(done) as { imported: number; updated: number };
    expect(im.imported + im.updated).toBe(2);
    const found = await run('search_people', { query: 'Tara Nguyen' });
    expect((model(found) as { people: { name: string }[] }).people[0]?.name).toBe('Tara Nguyen');
  }, 60_000);

  it('updates settings: a plain write for the profile and goals, an approval for the limits', async () => {
    const profile = await run('update_settings', {
      section: 'profile',
      fullName: 'Alex J. Rivera',
      currentCity: 'Ithaca',
    });
    expect(profile.kind).toBe('settings');
    const u = (await db.users.get(user.id))!;
    expect(u.firstName).toBe('Alex');
    expect(u.lastName).toBe('J. Rivera');
    expect(u.currentCity).toBe('Ithaca');
    const goals = await run('update_settings', {
      section: 'goals',
      targetFunctions: ['Product', 'consulting'],
      targetLocations: ['New York'],
    });
    expect(goals.kind).toBe('settings');
    expect((await db.goals.get(user.id))!.targetFunctions).toEqual(['pm', 'consulting']);
    const link = await run('update_settings', {
      section: 'schedule',
      schedulingLink: 'https://cal.com/alex/20min',
    });
    expect(link.kind).toBe('settings');
    expect((await db.settings.get(user.id))!.schedulingLink).toBe('https://cal.com/alex/20min');

    const before = (await db.settings.get(user.id))!;
    const ask = await run('update_limits', { weeklyOutreachTarget: 6, dailySendCapGmail: 100 });
    expect(ask.kind).toBe('needs_confirmation');
    expect((await db.settings.get(user.id))!.weeklyOutreachTarget).toBe(before.weeklyOutreachTarget);
    const done = await approve(ask, 'update_limits', { weeklyOutreachTarget: 6, dailySendCapGmail: 100 });
    expect(done.kind, done.summary).toBe('settings');
    const after = (await db.settings.get(user.id))!;
    expect(after.weeklyOutreachTarget).toBe(6);
    // the cap table (plan 29 §B2.1): a request above it is clamped to the most the student may send by hand
    expect(after.dailySendCapGmail).toBe(15);
    expect(done.summary).toMatch(/kept inside the allowed range/);
    const settings = await run('get_settings', { section: 'limits' });
    expect(
      (model(settings) as { limits: { weeklyOutreachTarget: number } }).limits.weeklyOutreachTarget,
    ).toBe(6);
  }, 60_000);

  it('dismisses a card after approval and restores it with a plain write', async () => {
    const pending = await db.suggestions
      .where('userId')
      .equals(user.id)
      .filter((s) => s.status === 'pending' && !!s.outboundMessageId)
      .toArray();
    const card = pending.find((s) => s.kind !== 'thank_you') ?? pending[0]!;
    const ask = await run('dismiss_suggestion', { suggestionId: card.id, reason: 'not_now' });
    expect(ask.kind).toBe('needs_confirmation');
    expect((await db.suggestions.get(card.id))!.status).toBe('pending');
    const done = await approve(ask, 'dismiss_suggestion', { suggestionId: card.id, reason: 'not_now' });
    expect(done.kind, done.summary).toBe('suggestion');
    expect((await db.suggestions.get(card.id))!.status).toBe('dismissed');
    expect((await db.outbound.get(card.outboundMessageId!))!.status).toBe('cancelled');
    const undo = (model(done) as { undo: { tool: string; input: Record<string, unknown> } }).undo;
    const back = await run(undo.tool, undo.input);
    expect(back.kind).toBe('suggestion');
    expect((await db.suggestions.get(card.id))!.status).toBe('pending');
    expect((await db.outbound.get(card.outboundMessageId!))!.status).toBe('draft');
    const snoozed = await run('manage_suggestion', { suggestionId: card.id, action: 'snooze', days: 7 });
    expect(snoozed.summary).toMatch(/a week/);
    const listed = await run('list_drafts', { list: 'snoozed' });
    expect(
      (model(listed) as { snoozed: { card: { id: string } }[] }).snoozed.some((s) => s.card.id === card.id),
    ).toBe(true);
    const woke = await run('manage_suggestion', { suggestionId: card.id, action: 'unsnooze' });
    expect(woke.kind).toBe('suggestion');
    expect((await db.suggestions.get(card.id))!.status).toBe('pending');
  }, 60_000);

  it('a cold LinkedIn stranger gets the warm-up choice, and skipping it drafts the first message', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    const settings = (await db.settings.get(user.id))!;
    expect(settings.warmUpEnabled).toBe(true);
    const cold = people.find(
      (p) =>
        p.isHuman &&
        !p.hiddenAt &&
        !p.primaryEmail &&
        !!p.linkedinSlug &&
        p.strength < 0.2 &&
        !chats.some((c) => c.personId === p.id),
    );
    if (!cold) return;
    const choice = await run('create_draft', { personId: cold.id, kind: 'outreach' });
    expect(choice.kind).toBe('text');
    expect(choice.summary).toMatch(/warm-up/);
    expect(await db.outbound.where('personId').equals(cold.id).count()).toBe(0);
    const now = await run('create_draft', { personId: cold.id, kind: 'outreach', warmUp: 'skip' });
    expect(now.kind, now.summary).toBe('draft');
    expect((model(now) as { channel: string }).channel).toBe('linkedin');
  }, 60_000);
});
