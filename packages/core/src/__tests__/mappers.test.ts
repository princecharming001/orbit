import { describe, expect, it } from 'vitest';
import {
  affiliationFromRow,
  affiliationToRow,
  calendarEventFromRow,
  calendarEventToRow,
  chatFromRow,
  chatToRow,
  dossierFromRow,
  dossierToRow,
  draftRowFromOutbound,
  edgeFromTieRow,
  factFromRow,
  factToRow,
  goalFromRow,
  goalToRow,
  mergeSuggestionFromRow,
  mergeSuggestionToRow,
  messageFromRow,
  messageToRow,
  noteFromRow,
  noteToRow,
  organizationFromRow,
  organizationToRow,
  outboundFromDraftRow,
  personFromRow,
  personToRow,
  type Row,
  recommendationFromRow,
  recommendationToRow,
  stageEventFromRow,
  stageEventToRow,
  threadFromRow,
  threadToRow,
  tieRowFromEdge,
  tieScoreFromRow,
  tieScoreToRow,
  userFromRow,
} from '../server/mappers';

const AT = '2026-10-14T12:00:00.000Z';
const U = '00000000-0000-4000-8000-000000000001';
const P = '00000000-0000-4000-8000-0000000000aa';
const Q = '00000000-0000-4000-8000-0000000000bb';

const person: Row.People = {
  id: P,
  user_id: U,
  is_self: false,
  display_name: 'Maya Chen',
  first_name: 'Maya',
  last_name: 'Chen',
  name_norm: 'maya chen',
  primary_email: 'maya@stripe.com',
  headline: 'PM at Stripe',
  title: 'Product Manager',
  org_id: 'org-1',
  org_raw: 'Stripe',
  location: 'New York, NY',
  timezone: null,
  school: 'Cornell University',
  is_alumni: true,
  photo_url: null,
  linkedin_url: 'https://www.linkedin.com/in/maya-chen',
  linkedin_slug: 'maya-chen',
  linkedin_member_id: 'ACoAA123',
  relationship_type: 'alumni',
  sources: ['gmail', 'linkedin_csv'],
  first_seen_at: '2026-01-02T00:00:00.000Z',
  last_interaction_at: '2026-10-01T00:00:00.000Z',
  strength: 0.79,
  summary: null,
  tags: ['fintech'],
  notes: null,
  do_not_contact: false,
  hidden_at: null,
  merged_into: null,
  created_at: AT,
  updated_at: AT,
  deleted_at: null,
};

describe('server mappers (§11.4): rows round-trip through the core types', () => {
  it('people, with identities and the tie score', () => {
    const p = personFromRow(person, {
      identities: [
        {
          id: 'i1',
          user_id: U,
          person_id: P,
          kind: 'email',
          value_norm: 'maya.chen@gmail.com',
          value_raw: 'Maya.Chen@gmail.com',
          source: 'gmail',
          confidence: 1,
          created_at: AT,
        },
        {
          id: 'i2',
          user_id: U,
          person_id: P,
          kind: 'linkedin_slug',
          value_norm: 'maya-chen',
          value_raw: null,
          source: 'unipile',
          confidence: 1,
          created_at: AT,
        },
      ],
      tieScore: {
        user_id: U,
        person_id: P,
        score: 79,
        band: 'strong',
        features: { log_in: 1.1 },
        contributions: { log_in: 0.2 },
        explanation: ['5 messages between you (2 from them)'],
        model_version: 'tie-v1',
        computed_at: AT,
        updated_at: AT,
      },
    });
    expect(p).toMatchObject({
      displayName: 'Maya Chen',
      currentTitle: 'Product Manager',
      currentOrganizationRaw: 'Stripe',
      emails: ['maya@stripe.com', 'maya.chen@gmail.com'],
      strength: 0.79,
      tieScore: 79,
      tieBand: 'strong',
      tieExplanation: ['5 messages between you (2 from them)'],
      isHuman: true,
    });
    expect(personToRow(p)).toEqual(person);
    expect(personFromRow(personToRow(p))).toEqual({
      ...p,
      emails: ['maya@stripe.com'],
      strengthBreakdown: undefined,
      tieScore: undefined,
      tieBand: undefined,
      tieExplanation: undefined,
    });
    const dnc = personFromRow({ ...person, do_not_contact: true });
    expect(dnc.doNotContact).toBe(true);
    expect(personToRow(dnc).do_not_contact).toBe(true);
  });

  it('tie scores', () => {
    const r: Row.TieScores = {
      user_id: U,
      person_id: P,
      score: 42,
      band: 'warm',
      features: { never: 0 },
      contributions: { never: 0.07 },
      explanation: ['Connected on LinkedIn'],
      model_version: 'tie-v1',
      computed_at: AT,
      updated_at: AT,
    };
    expect(tieScoreToRow(tieScoreFromRow(r), U, P, AT)).toEqual(r);
  });

  it('users', () => {
    const r: Row.Users = {
      id: U,
      google_sub: '123',
      email: 'alex@cornell.edu',
      full_name: 'Alex Rivera',
      first_name: 'Alex',
      last_name: 'Rivera',
      avatar_url: null,
      school: 'Cornell University',
      school_domain: 'cornell.edu',
      grad_year: 2028,
      degree: 'BS',
      majors: ['CS'],
      current_title: null,
      current_org: null,
      current_city: 'Ithaca',
      timezone: 'America/New_York',
      autonomy_level: 0,
      settings: {},
      onboarding: { step: 4 },
      created_at: AT,
      updated_at: AT,
      last_seen_at: null,
      deleted_at: null,
    };
    expect(userFromRow(r)).toEqual({
      id: U,
      email: 'alex@cornell.edu',
      fullName: 'Alex Rivera',
      firstName: 'Alex',
      lastName: 'Rivera',
      school: 'Cornell University',
      schoolDomain: 'cornell.edu',
      graduationYear: 2028,
      degree: 'BS',
      majors: ['CS'],
      currentCity: 'Ithaca',
      timezone: 'America/New_York',
      onboardingStep: 4,
      createdAt: AT,
    });
  });

  it('organizations, affiliations and merge suggestions', () => {
    const o: Row.Organizations = {
      id: 'org-1',
      user_id: U,
      name: 'Stripe',
      name_norm: 'stripe',
      domains: ['stripe.com'],
      linkedin_slug: null,
      industry: 'Fintech',
      size_bucket: '5001-10000',
      created_at: AT,
      updated_at: AT,
    };
    expect(organizationToRow(organizationFromRow(o), U, AT)).toEqual(o);
    const a: Row.Affiliations = {
      id: 'a1',
      user_id: U,
      person_id: P,
      org_id: 'org-1',
      org_raw: 'Stripe',
      kind: 'employment',
      title: 'PM',
      degree: null,
      field: null,
      start_date: '2022-06-01',
      end_date: null,
      is_current: true,
      source: 'linkedin_csv',
      created_at: AT,
      updated_at: AT,
    };
    expect(affiliationToRow(affiliationFromRow(a), AT)).toEqual(a);
    const m: Row.MergeSuggestions = {
      id: 'm1',
      user_id: U,
      person_a: P,
      person_b: Q,
      score: 0.88,
      features: { name_sim: 1 },
      status: 'open',
      created_at: AT,
      decided_at: null,
      updated_at: AT,
    };
    expect(mergeSuggestionFromRow(m).status).toBe('pending');
    expect(mergeSuggestionToRow(mergeSuggestionFromRow(m), AT)).toEqual(m);
    expect(mergeSuggestionToRow({ ...mergeSuggestionFromRow(m), status: 'rejected' }, AT)).toMatchObject({
      status: 'rejected',
      decided_at: AT,
    });
  });

  it('goals', () => {
    const g: Row.Goals = {
      id: 'g1',
      user_id: U,
      kind: 'fundraising',
      title: 'Pre-seed for Tidewater',
      description: null,
      targets: { organizations: ['Lowercarbon'], roles: [], geographies: ['NYC'], people: [] },
      criteria: { stage: 'pre-seed' },
      success_metric: '10 investor calls by Jan 15',
      priority: 1,
      status: 'active',
      autonomy_level: null,
      due_at: '2027-01-15',
      source: 'inferred',
      evidence: "I'm raising a pre-seed",
      created_at: AT,
      updated_at: AT,
      deleted_at: null,
    };
    const goal = goalFromRow(g);
    expect(goal).toMatchObject({
      kind: 'fundraising',
      successMetric: '10 investor calls by Jan 15',
      dueAt: '2027-01-15',
    });
    expect(goalToRow(goal)).toEqual(g);
  });

  it('threads, messages and calendar events', () => {
    const t: Row.Threads = {
      id: 't1',
      user_id: U,
      provider: 'gmail',
      external_id: '18f2',
      subject: 'coffee?',
      participant_person_ids: [P],
      participant_count: 1,
      first_at: '2026-10-01T00:00:00.000Z',
      last_at: '2026-10-02T00:00:00.000Z',
      message_count: 2,
      last_direction: 'in',
      category: 'networking',
      is_networking: true,
      chat_id: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(threadToRow(threadFromRow(t), { lastDirection: 'in', at: AT })).toEqual(t);
    const m: Row.Messages = {
      id: 'm1',
      user_id: U,
      thread_id: 't1',
      provider: 'gmail',
      external_id: 'msg-1',
      rfc_message_id: '<a@b>',
      in_reply_to: null,
      direction: 'in',
      from_person_id: P,
      from_addr: 'maya@stripe.com',
      to_addrs: ['alex@cornell.edu'],
      cc_addrs: [],
      to_person_ids: [],
      cc_person_ids: [],
      sent_at: '2026-10-02T00:00:00.000Z',
      subject: 'Re: coffee?',
      snippet: null,
      body_text: 'Happy to chat!',
      is_automated: false,
      list_unsubscribe: false,
      reply_class: 'interested',
      reply_confidence: 0.9,
      extraction: null,
      embedding: null,
      created_at: AT,
      updated_at: AT,
    };
    const msg = messageFromRow(m);
    expect(msg).toMatchObject({
      direction: 'inbound',
      fromEmail: 'maya@stripe.com',
      replyClass: 'interested',
      headers: { 'message-id': '<a@b>' },
    });
    expect(messageToRow(msg, { at: AT })).toEqual(m);
    const e: Row.CalendarEvents = {
      id: 'e1',
      user_id: U,
      external_id: 'gcal-1',
      title: 'Coffee',
      description: null,
      start_at: '2026-10-20T15:00:00.000Z',
      end_at: '2026-10-20T15:30:00.000Z',
      status: 'confirmed',
      organizer_email: 'alex@cornell.edu',
      attendees: [
        { email: 'alex@cornell.edu', self: true },
        { email: 'maya@stripe.com', responseStatus: 'accepted' },
      ],
      attendee_person_ids: [P],
      attendee_count: 2,
      conference_url: null,
      is_one_on_one: true,
      chat_id: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(
      calendarEventToRow(calendarEventFromRow(e), { organizerEmail: 'alex@cornell.edu', at: AT }),
    ).toEqual(e);
  });

  it('ties become edges whose weight is w·c, and back', () => {
    const r: Row.Ties = {
      id: 'tie1',
      user_id: U,
      a_person_id: P,
      b_person_id: Q,
      kind: 'email_exchange',
      weight: 0.6,
      confidence: 0.95,
      evidence: { threads: 1 },
      first_seen_at: '2026-09-01T00:00:00.000Z',
      last_seen_at: '2026-09-02T00:00:00.000Z',
      created_at: AT,
      updated_at: AT,
    };
    const e = edgeFromTieRow(r);
    expect(e.weight).toBeCloseTo(0.57, 10);
    expect(e).toMatchObject({ type: 'email_exchange', confidence: 0.95, kinds: ['email_exchange'] });
    const back = tieRowFromEdge(e, AT);
    expect({ ...back, weight: Math.round(back.weight * 1e9) / 1e9 }).toEqual(r);
  });

  it('chats spread their data, stage events keep their evidence', () => {
    const r: Row.Chats = {
      id: 'c1',
      user_id: U,
      person_id: P,
      goal_id: 'g1',
      org_id: null,
      stage: 'outreach_sent',
      stage_entered_at: AT,
      data: {
        source: 'manual',
        goalTags: ['pm'],
        bumpCount: 1,
        priority: 1,
        outreachChannel: 'gmail',
        lastOutboundAt: AT,
      },
      archived_at: null,
      created_at: AT,
      updated_at: AT,
    };
    const c = chatFromRow(r);
    expect(c).toMatchObject({ goalId: 'g1', bumpCount: 1, outreachChannel: 'gmail', stage: 'outreach_sent' });
    expect(chatToRow(c)).toEqual(r);
    const s: Row.StageEvents = {
      id: 's1',
      user_id: U,
      chat_id: 'c1',
      from_stage: 'outreach_sent',
      to_stage: 'replied',
      status: 'applied',
      actor: 'system',
      reason: 'signal:reply_positive',
      evidence: { table: 'messages', id: 'm1' },
      confidence: 0.9,
      created_at: AT,
      decided_at: null,
      updated_at: AT,
    };
    expect(stageEventToRow(stageEventFromRow(s), AT)).toEqual(s);
  });

  it('drafts map to outbound messages', () => {
    const r: Row.Drafts = {
      id: 'd1',
      user_id: U,
      person_id: P,
      chat_id: 'c1',
      goal_id: 'g1',
      channel: 'gmail',
      kind: 'first_touch',
      subject: 'your path at Stripe',
      body: 'Hi Maya, ...',
      ask: null,
      hooks: [],
      via: null,
      thread_external_id: null,
      in_reply_to: null,
      status: 'scheduled',
      autonomy_level: 1,
      send_at: AT,
      sent_at: null,
      provider_message_id: null,
      error: null,
      cancel_reason: null,
      validator: null,
      generated_by: 'llm',
      prompt_version: 'compose-v2.0',
      variant: null,
      replied_at: null,
      reply_class: null,
      created_at: AT,
      updated_at: AT,
    };
    const o = outboundFromDraftRow(r);
    expect(o).toMatchObject({
      status: 'queued',
      bodyDraft: 'Hi Maya, ...',
      kind: 'first_touch',
      generatedBy: 'llm',
      goalId: 'g1',
    });
    expect(draftRowFromOutbound(o, { at: AT, prompt_version: 'compose-v2.0', autonomy_level: 1 })).toEqual(r);
    expect(outboundFromDraftRow({ ...r, status: 'discarded' }).status).toBe('cancelled');
  });

  it('notes, facts, dossiers and recommendations', () => {
    const note: Row.Notes = {
      id: 'n1',
      user_id: U,
      person_ids: [P],
      chat_id: null,
      source: 'manual',
      title: 'Coffee with Maya',
      occurred_at: AT,
      raw_text: 'She leads payments.',
      extraction: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(noteToRow(noteFromRow(note), AT)).toEqual(note);
    const fact: Row.Facts = {
      id: 'f1',
      user_id: U,
      person_id: P,
      type: 'role_detail',
      text: 'leads payments',
      source_table: 'notes',
      source_id: 'n1',
      occurred_at: null,
      confidence: 0.8,
      deleted_at: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(factToRow(factFromRow(fact), AT)).toEqual(fact);
    const dossier: Row.Dossiers = {
      id: 'do1',
      user_id: U,
      person_id: P,
      goal_id: null,
      status: 'ready',
      content: { openers: [] },
      sources: [{ id: 's1', url: 'https://example.com/a' }],
      candidates: null,
      cost_usd: '0.1234',
      model: 'claude-opus-5-5',
      error: null,
      created_at: AT,
      updated_at: AT,
      expires_at: AT,
    };
    expect(dossierFromRow(dossier).costUsd).toBeCloseTo(0.1234, 10);
    expect(dossierToRow(dossierFromRow(dossier))).toEqual(dossier);
    const rec: Row.Recommendations = {
      id: 'r1',
      user_id: U,
      goal_id: 'g1',
      person_id: P,
      candidate: {},
      source: 'apollo',
      external_id: null,
      rank: 0.7,
      fit: 0.6,
      reach: 0.5,
      responsiveness: 0.4,
      reasons: ['Cornell alum'],
      status: 'added',
      batch_id: 'b1',
      created_at: AT,
      updated_at: AT,
    };
    const mapped = recommendationFromRow(rec)!;
    expect(mapped).toMatchObject({
      status: 'converted',
      reasons: [{ code: 'reason', text: 'Cornell alum' }],
      batchDate: '2026-10-14',
    });
    expect(recommendationToRow(mapped, { batchId: 'b1', source: 'apollo', goalId: 'g1', at: AT })).toEqual(
      rec,
    );
    expect(recommendationFromRow({ ...rec, person_id: null })).toBeUndefined();
  });
});
