import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/schema';
import { loadDemo } from '../../engine/demo';
import { saveGoal } from '../../engine/goals';
import { execute, modelResult, registry, tools } from '../registry';
import type { ResultEnvelope } from '../types';
import { makeCtx, NOW } from './helpers';

const DASHES = /[—–]/;

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 90_000);

/** Ids from the demo for every tool's example input, looked up once the demo is in. */
async function demoIds() {
  const uid = user.id;
  const people = await db.people.where('userId').equals(uid).toArray();
  const chats = await db.chats.where('userId').equals(uid).toArray();
  const suggestions = await db.suggestions.where('userId').equals(uid).toArray();
  const outbound = await db.outbound.where('userId').equals(uid).toArray();
  const facts = await db.facts.where('userId').equals(uid).toArray();
  const targets = await db.targetCompanies.where('userId').equals(uid).toArray();
  const recs = await db.recommendations.where('userId').equals(uid).toArray();
  const facets = await db.resumeFacets.toArray();
  const notes = await db.notes.where('userId').equals(uid).toArray();
  const items = await db.actionItems.where('userId').equals(uid).toArray();
  const byId = new Map(people.map((p) => [p.id, p]));
  const pending = suggestions.filter((s) => s.status === 'pending');
  const thankYou = pending.find((s) => s.kind === 'thank_you' && s.outboundMessageId)!;
  const warming = chats.find((c) => c.stage === 'warming' && c.warmUp)!;
  // a chat the example can really move to Replied (one already there is an unchanged move, with nothing to undo)
  const replied = chats.find((c) => c.stage === 'outreach_sent')!;
  const noChat = people.find(
    (p) => p.isHuman && !p.hiddenAt && !chats.some((c) => c.personId === p.id) && p.primaryEmail,
  )!;
  const confirmStage = pending.find((s) => s.kind === 'confirm_stage');
  const confirmIntro = pending.find((s) => s.kind === 'confirm_intro');
  const merge = await db.merges.where('userId').equals(uid).first();
  // a goal of the student's own for update_goal and archive_goal (local mode keeps goals in the browser)
  const goal = await saveGoal(user, { kind: 'advice', title: 'Get advice on product roles' });
  return {
    goal,
    people,
    byId,
    person: byId.get(thankYou.personId!)!,
    thankYou,
    draft: outbound.find((o) => o.id === thankYou.outboundMessageId)!,
    warming,
    replied,
    noChat,
    confirmStage,
    confirmIntro,
    merge,
    fact: facts.find((f) => !f.deletedAt)!,
    target: targets[0]!,
    rec: recs.find((r) => r.status === 'new') ?? recs[0]!,
    facet: facets[0]!,
    note: notes[0],
    item: items.find((i) => i.status === 'open'),
    snoozable: pending.find(
      (s) => s.kind === 'nurture_checkin' || s.kind === 'follow_up_bump' || s.kind === 'new_outreach',
    )!,
  };
}

const CSV = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
Tara,Nguyen,https://www.linkedin.com/in/tara-nguyen-demo,,Brex,Associate Product Manager,01 Oct 2026
`;

describe('every tool parses and executes its example input against the demo', () => {
  it('runs each tool once, in an order that keeps the demo usable', async () => {
    const ids = await demoIds();
    // one example per tool, in the order they run; risky tools stop at needs_confirmation here
    const examples: Record<string, Record<string, unknown>> = {
      get_today_brief: {},
      list_pipeline: { view: 'table', sortBy: 'lastReply' },
      search_people: { query: ids.person.firstName },
      get_person: {
        personId: ids.person.id,
        include: ['facts', 'timeline', 'prep', 'drafts', 'connections', 'notes', 'promises'],
      },
      list_drafts: { list: 'all' },
      get_draft: { draftId: ids.draft.id },
      find_routes: { personId: ids.noChat.id },
      get_intro_web: {},
      list_recommendations: {},
      list_notes: { personId: ids.person.id },
      preview_note_match: {
        text: `Chat with ${ids.person.displayName}: she said to lead with a project story.`,
      },
      get_settings: {},
      get_usage: {},
      explain_stage: { stage: 'followed_up' },
      open_page: { page: 'person', id: ids.person.id, tab: 'prep' },
      offer_choices: {
        options: [
          { label: 'Draft it', message: "Let's do it" },
          { label: 'What else?', message: 'What else can you do?' },
        ],
      },
      show_setup: { what: 'claude_key' },
      draft_warmup_comment: { postClaim: 'new analysts should ship something in week one' },
      ensure_card_drafts: { scope: 'today_more' },
      manage_suggestion: { suggestionId: ids.snoozable.id, action: 'snooze', days: 3 },
      answer_stage_question: ids.confirmStage
        ? { suggestionId: ids.confirmStage.id, accept: true }
        : { suggestionId: ids.thankYou.id, accept: true },
      reject_merge: { mergeId: ids.merge?.id ?? 'none' },
      answer_intro_question: ids.confirmIntro
        ? { suggestionId: ids.confirmIntro.id, yes: false }
        : { threadId: 'none', yes: false },
      mark_warmup_step: {
        chatId: ids.warming.id,
        actionId: ids.warming.warmUp!.actions[0]!.id,
        done: true,
        note: 'their post about onboarding',
      },
      complete_action_item: { actionItemId: ids.item?.id ?? 'none' },
      process_outbox: {},
      move_pipeline_stage: { chatId: ids.replied.id, stage: 'replied' },
      undo_stage_move: { chatId: ids.replied.id },
      schedule_chat: {
        chatId: ids.replied.id,
        startAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
        minutes: 30,
      },
      add_person: { name: 'Tom Lee', company: 'Stripe', title: 'Analyst', email: 'tom.lee@example.com' },
      update_person: { personId: ids.noChat.id, relationshipType: 'peer', tags: ['payments'] },
      manage_fact: {
        personId: ids.person.id,
        action: 'add',
        type: 'personal',
        text: 'Training for a marathon',
      },
      pick_prep_questions: {
        chatId: ids.replied.id,
        questions: ['What does a typical week look like for you?'],
      },
      save_suggested_contacts: { personId: ids.person.id, text: 'Maya Wu at Figma' },
      create_draft: {
        personId: ids.noChat.id,
        kind: 'outreach',
        connection: 'I read your post about payments onboarding',
      },
      update_draft_body: {
        draftId: ids.draft.id,
        body: 'Hi there, thank you again for the conversation this morning. Your advice to lead with a project story is exactly what I needed.\n\nThanks,\nAlex',
      },
      manage_draft: { draftId: ids.draft.id, action: 'reset_to_suggested' },
      redraft_with_inputs: { draftId: ids.draft.id, takeaway: 'lead with a project story' },
      add_note: {
        text: `Coffee chat with ${ids.person.displayName}. ${ids.person.firstName} said to lead with a project story and offered to put in a good word. I will send over my resume tomorrow.`,
        personId: ids.person.id,
        source: 'manual',
      },
      rematch_note: { noteId: ids.note?.id ?? 'none', personId: ids.note?.personIds[0] },
      manage_target_company: { action: 'add', names: 'Evercore, Lazard' },
      manage_recommendation: { action: 'save', recommendationId: ids.rec.id },
      update_settings: { section: 'profile', currentCity: 'Ithaca' },
      update_resume_facet: { facetId: ids.facet.id, used: true },
      advance_onboarding: { finish: true },
      refresh_brief: {},
      // risky: each returns needs_confirmation without a token
      dismiss_suggestion: { suggestionId: ids.thankYou.id, reason: 'not_now' },
      merge_people: { mergeId: ids.merge?.id ?? 'none' },
      hide_person: { personId: ids.noChat.id },
      delete_fact: { factId: ids.fact.id },
      discard_draft: { draftId: ids.draft.id },
      send_draft: { draftId: ids.draft.id },
      undo_send: { draftId: ids.draft.id },
      confirm_handoff: { draftId: ids.draft.id },
      schedule_sends: { draftIds: [ids.draft.id], perDay: 3 },
      delete_target_company: { targetId: ids.target.id },
      update_limits: { weeklyOutreachTarget: 6, dailySendCapGmail: 100 },
      set_claude_key: {},
      set_llm_feature: { feature: 'notes', on: true },
      save_resume: {
        filename: 'resume.txt',
        base64: btoa(
          'Alex Rivera\nCornell University, BS Computer Science, 2028\nSoftware Engineering Intern, Brex, Summer 2026',
        ),
      },
      import_linkedin: { csvText: CSV, filename: 'Connections.csv' },
      sync_google: {},
      disconnect_google: {},
      sync_linkedin: {},
      disconnect_linkedin: {},
      get_mutual_connections: { personId: ids.person.id },
      export_data: {},
      delete_all_data: {},
      load_demo: {},
      leave_demo: {},
      // plan 16: goals and the tie score work locally; the account tools say they need an Orbit account
      set_goal: { kind: 'fundraising', title: 'Raise a pre-seed', organizations: ['Sequoia'] },
      list_goals: {},
      update_goal: { goalId: ids.goal.id, status: 'paused', roles: ['PM'] },
      archive_goal: { goalId: ids.goal.id },
      explain_score: { personId: ids.person.id },
      rate_closeness: { personId: ids.noChat.id, closeness: 3 },
      research_person: { personId: ids.person.id },
      get_dossier: { personId: ids.person.id },
      find_people: { purpose: 'fundraising', query: 'seed investors in climate' },
      add_sourced: { recommendationIds: ['rec_1'] },
      list_replies: {},
      draft_reply: { messageId: 'msg_1' },
      pause_outreach: { until: '2026-12-20' },
      list_due: {},
      remember: { text: 'Prefers morning calls', kind: 'preference' },
      recall: { query: 'calls' },
      ask_for_intro: { pathId: 'path_1' },
      book_call: { draftId: 'out_1', slotStart: '2026-10-21T14:00:00Z' },
      set_autonomy: { level: 1 },
      forget: { memoryId: 'mem_1' },
    };
    const missing = tools.map((t) => t.name).filter((n) => !(n in examples));
    expect(missing, 'tools without an example').toEqual([]);
    const extra = Object.keys(examples).filter((n) => !registry.has(n));
    expect(extra, 'examples without a tool').toEqual([]);

    for (const [name, input] of Object.entries(examples)) {
      const spec = registry.get(name)!;
      const parsed = spec.input.safeParse(input);
      expect(
        parsed.success,
        `${name} parses its example: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
      const env: ResultEnvelope = await execute(name, input, makeCtx(user));
      expect(env.summary.trim().length, `${name} summary`).toBeGreaterThan(0);
      expect(env.summary, `${name} summary has a dash`).not.toMatch(DASHES);
      expect(env.summary, `${name} summary shouts`).not.toMatch(/!/);
      if (spec.kind === 'risky') {
        expect(env.kind, `${name}: ${env.summary}`).toBe('needs_confirmation');
        expect(env.confirmationId).toMatch(/^conf_/);
      } else {
        expect(env.kind, `${name}: ${env.summary}`).not.toBe('error');
        expect(env.kind).not.toBe('needs_confirmation');
      }
      // the model's view is compact JSON with the summary and never a bare UI object
      const m = modelResult(name, env);
      expect(m.summary).toBe(env.summary);
      expect(JSON.stringify(m).length).toBeLessThan(60_000);
      expect(JSON.stringify(m)).not.toContain('"forModel"');
    }
  }, 120_000);

  it("a read tool reports an engine error with the engine's words, never a throw", async () => {
    const env = await execute('get_person', { personId: 'nobody' }, makeCtx(user));
    expect(env.kind).toBe('error');
    expect(env.summary).toMatch(/no person with that id/);
    const unknown = await execute('no_such_tool', {}, makeCtx(user));
    expect(unknown.kind).toBe('error');
    const bad = await execute('get_person', { personId: 42 }, makeCtx(user));
    expect(bad.kind).toBe('error');
    expect(bad.summary).toMatch(/missing something/);
  });

  it('third-party text reaches the model wrapped in the conversation nonce', async () => {
    const ids = await demoIds();
    const ctx = makeCtx(user);
    const env = await execute('get_person', { personId: ids.person.id, include: ['facts'] }, ctx);
    const text = JSON.stringify(modelResult('get_person', env));
    expect(text).toContain(`<untrusted_${ctx.nonce}`);
  });
});
