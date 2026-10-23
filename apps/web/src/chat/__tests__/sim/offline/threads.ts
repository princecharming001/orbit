/**
 * Multi-turn threads the offline simulation plays: a student following up on what the last card showed, the way
 * people do ("draft to the top 3", "make it shorter", "send the first", "and her?", "do it", "ask Maya"), on the
 * sample student, on a real-looking student, and on that student without Gmail or without LinkedIn.
 */
import type { Thread } from './runner';

const T = (
  id: string,
  account: Thread['account'],
  area: string,
  title: string,
  steps: Thread['steps'],
): Thread => ({ id, account, area, title, steps });

export const THREADS: Thread[] = [
  // ---- the real-looking student (Gmail, LinkedIn, a resume) ----
  T(
    'pm-stripe-top3',
    'student',
    'drafts',
    'who to reach for PM at Stripe, draft the top 3, shorten, send the first',
    [
      {
        say: 'who should I reach out to for PM at Stripe',
        expect: { tool: ['find_routes', 'search_people'] },
      },
      { say: 'draft to the top 3', expect: { tool: 'create_drafts', kind: 'drafts', noMove: true } },
      { say: 'make it shorter', expect: { tool: ['update_draft_body', 'offer_choices'], ask: true } },
      { say: 'send the first', expect: { tool: 'send_draft', pending: true } },
    ],
  ),
  T('prep-tomorrow', 'student', 'people', 'prep me for my chat tomorrow, then what to ask', [
    { say: 'prep me for my chat tomorrow', expect: { tool: 'get_person', kind: 'person', says: /Priya/ } },
    { say: 'what should I ask', expect: { tool: 'get_person', kind: 'person' } },
  ]),
  T('add-write-wait', 'student', 'people', 'add Priya from Figma, write to her, actually wait a week', [
    { say: 'add Priya Desai from Figma', expect: { ask: true, answer: true } },
    {
      say: 'add Priya Desai from Figma, priya.desai@figma.com',
      expect: { tool: 'add_person', personAdded: 'Priya Desai' },
    },
    { say: 'write to her', expect: { tool: 'create_draft', noMove: true } },
    { say: 'actually wait a week', expect: { answer: true, tool: ['manage_suggestion'], noMove: true } },
  ]),
  T('warm-intro-ask', 'student', 'map', 'find a warm intro to Jake, then ask Aisha', [
    { say: 'find a warm intro to Jake Morrison', expect: { tool: 'find_routes' } },
    { say: 'ask Aisha', expect: { tool: 'create_draft', kind: 'draft' } },
  ]),
  T('quiet-follow-all', 'student', 'pipeline', 'who went quiet, follow up with all of them', [
    { say: 'who went quiet?', expect: { tool: 'list_pipeline', kind: 'pipeline' } },
    { tap: 0, expect: { tool: ['create_draft', 'create_drafts'], noMove: true } },
  ]),
  T('thanks-tomas', 'student', 'drafts', 'thank Tomás for the chat, then show it again', [
    {
      say: 'thank Tomas for the chat',
      expect: { tool: 'create_draft', kind: 'draft', draftFor: 'Tomás Herrera' },
    },
    { say: 'make it shorter', expect: { tool: 'update_draft_body', kind: 'draft' } },
    { say: 'show it', expect: { tool: 'get_draft', kind: 'draft' } },
  ]),
  T('who-is-and-her', 'student', 'people', 'who is Ava, and Priya Raman?', [
    { say: 'who is Ava', expect: { tool: 'get_person', kind: 'person' } },
    { say: 'and Priya Raman?', expect: { tool: 'get_person', kind: 'person', says: /Priya Raman/ } },
    { say: 'write to her', expect: { tool: 'create_draft' } },
  ]),
  T('ambiguous-priya', 'student', 'people', '"write to Priya" asks which one; the second one', [
    { say: 'write to Priya', expect: { ask: true, tool: 'search_people' } },
    { say: 'the first one', expect: { tool: ['get_person', 'create_draft'] } },
  ]),
  T('recruiter-reply', 'student', 'drafts', 'reply to the Stripe recruiter', [
    { say: 'reply to Kelly', expect: { tool: 'create_draft', kind: ['draft', 'text'] } },
    { say: 'send it', expect: { tool: 'send_draft', pending: true } },
    { cancel: true, expect: {} },
  ]),
  T('note-then-write', 'student', 'notes', 'a note about Lauren, then write to her', [
    {
      say: 'note about Lauren: she said the Figma PM team hires interns in January',
      expect: { tool: 'add_note', noteAdded: true },
    },
    { say: 'write to her', expect: { tool: 'create_draft' } },
  ]),
  T('move-then-undo', 'student', 'pipeline', 'Marcus replied, then undo it', [
    { say: 'Marcus replied', expect: { tool: 'move_pipeline_stage', stage: ['Marcus Lee', 'replied'] } },
    { say: 'undo that', expect: { tool: 'undo_stage_move', stage: ['Marcus Lee', 'outreach_sent'] } },
  ]),
  T('company-then-each', 'student', 'map', 'who do I know at Figma, draft a message to each', [
    { say: 'who do I know at Figma', expect: { tool: 'find_routes', kind: ['company', 'routes'] } },
    { say: 'draft a message to each of them', expect: { tool: 'create_drafts', noMove: true } },
  ]),
  T('referral-switch', 'student', 'drafts', 'write to Ava, make it a referral ask instead', [
    { say: 'write to Ava', expect: { tool: 'create_draft' } },
    { say: 'make it a referral ask instead', expect: { tool: 'create_draft', kind: ['draft', 'text'] } },
  ]),
  T('discard-draft', 'student', 'drafts', 'show my draft to Marcus, then throw it away', [
    { say: 'show my draft to Marcus', expect: { tool: 'get_draft', kind: 'draft' } },
    { say: 'discard it', expect: { tool: 'discard_draft', pending: true } },
    { approve: true, expect: {} },
  ]),
  T('greeting-yes', 'student', 'today', 'hi, yes', [
    { say: 'hi', expect: { tool: 'offer_choices', kind: 'choices' } },
    { say: 'yes', expect: { tool: ['get_today_brief', 'list_drafts', 'list_pipeline'] } },
  ]),
  T('today-then-drafts', 'student', 'today', "what's on today, then my drafts", [
    { say: "what's on today", expect: { tool: 'get_today_brief', kind: 'brief' } },
    { say: 'show my drafts', expect: { tool: 'list_drafts', kind: 'drafts' } },
    { say: 'send the second', expect: { tool: 'send_draft', pending: true } },
  ]),
  T('resume-question', 'student', 'settings', 'what does my resume say, then where to change my profile', [
    { say: 'what is on my resume', expect: { tool: ['get_settings', 'open_page'], answer: true } },
    { say: 'where do I change my school', expect: { answer: true } },
  ]),
  T('goal-then-list', 'student', 'goals', 'track a goal, list goals', [
    { say: 'track a goal to land a PM internship at a fintech', expect: { tool: 'set_goal' } },
    { say: 'show my goals', expect: { tool: 'list_goals' } },
  ]),
  T('mutuals-ask', 'student', 'map', 'who knows Lauren, ask the first one', [
    { say: 'who knows Lauren Park', expect: { tool: ['get_mutual_connections', 'find_routes'] } },
    { say: 'do it', expect: { tool: ['find_routes', 'create_draft'] } },
  ]),
  T('person-do-it', 'student', 'people', 'who is Jake, do it (the first next step)', [
    { say: 'who is Jake', expect: { tool: 'get_person', kind: 'person' } },
    { say: 'do it', expect: { tool: ['create_draft', 'find_routes'] } },
  ]),
  T('tap-person-chip', 'student', 'people', 'open Lauren, tap the first chip', [
    { say: 'open Lauren Park', expect: { tool: 'get_person' } },
    { tap: 0, expect: { tool: ['create_draft', 'find_routes'] } },
  ]),
  T('recs-top2', 'student', 'discover', 'who should I meet, draft to the top 2', [
    { say: 'who should I meet', expect: { tool: 'list_recommendations' } },
    { say: 'write to the top 2', expect: { tool: ['create_drafts', 'create_draft'], ask: true } },
  ]),
  T('next-chat-prep-questions', 'student', 'people', 'prep for Priya Raman, then questions', [
    { say: 'prep me for my chat with Priya Raman', expect: { tool: 'get_person' } },
    { say: 'any questions to ask her', expect: { tool: 'get_person' } },
    { say: 'what do I know about her', expect: { tool: 'get_person' } },
  ]),
  T('snooze-card', 'student', 'today', 'follow up with Marcus, wait 3 days', [
    { say: 'follow up with Marcus', expect: { tool: 'create_draft', draftFor: 'Marcus Lee' } },
    { say: 'remind me in 3 days', expect: { tool: 'manage_suggestion', answer: true } },
  ]),
  T('scheduling-chat', 'student', 'pipeline', 'Ava replied, propose times', [
    { say: 'show me Ava', expect: { tool: 'get_person' } },
    { say: 'draft a scheduling message to her', expect: { tool: 'create_draft' } },
  ]),
  T('typo-thread', 'student', 'pipeline', 'typos through a thread', [
    { say: 'shwo my piepline', expect: { tool: 'list_pipeline' } },
    { say: 'who went queit', expect: { tool: 'list_pipeline' } },
  ]),
  T('polite-thread', 'student', 'drafts', 'polite long phrasing', [
    {
      say: 'Hey Orbit, could you please help me write a quick thank-you note to Tomás for chatting with me last week?',
      expect: { tool: 'create_draft' },
    },
    { say: 'thanks', expect: { answer: true, tool: ['offer_choices'] } },
  ]),
  T('multi-intent', 'student', 'today', 'two things in one message', [
    {
      say: 'show my pipeline and then draft a follow up to Marcus',
      expect: { tool: ['list_pipeline', 'create_draft'] },
    },
  ]),
  T(
    'linkedin-only-stranger',
    'student',
    'drafts',
    'write to a LinkedIn-only stranger: warm up or write now',
    [
      { say: 'write to Sofia Rossi', expect: { tool: 'create_draft' } },
      { tap: 1, expect: { tool: 'create_draft' } },
    ],
  ),
  T('hide-unhide', 'student', 'people', 'hide Tom, then bring him back', [
    { say: 'hide Tom Becker', expect: { tool: 'hide_person', pending: true } },
    { approve: true, expect: {} },
    { say: 'unhide Tom Becker', expect: { tool: 'update_person' } },
  ]),
  T('stage-explain', 'student', 'pipeline', 'what does scheduled mean, who is scheduled', [
    { say: 'what does scheduled mean', expect: { tool: 'explain_stage' } },
    { say: 'who is scheduled', expect: { tool: 'list_pipeline' } },
  ]),
  T('target-add-routes', 'student', 'settings', 'add Ramp to targets, then routes', [
    { say: 'add Ramp to my target companies', expect: { tool: 'manage_target_company' } },
    { say: 'who can introduce me to Ramp', expect: { tool: 'find_routes' } },
  ]),
  T('judgement-then-action', 'student', 'needs a key', 'a judgement call, then a concrete ask', [
    {
      say: 'should I email Marcus again or wait?',
      expect: { needsKey: true, tool: ['create_draft', 'get_person'] },
    },
    { say: 'ok follow up with him', expect: { tool: 'create_draft' } },
  ]),
  T('drafts-send-all', 'student', 'drafts', 'show drafts, send them all', [
    { say: 'unsent drafts', expect: { tool: 'list_drafts' } },
    { say: 'send them all', expect: { tool: ['send_draft', 'schedule_sends'] } },
  ]),
  T('notes-list-person', 'student', 'notes', 'notes about Tomás, then write to him', [
    { say: 'show my notes about Tomás', expect: { tool: 'list_notes' } },
    { say: 'write to him', expect: { tool: 'create_draft' } },
  ]),
  // ---- no Gmail ----
  T('nogmail-connect', 'student-nogmail', 'integrations', 'no Gmail: sync my inbox, then write to Jake', [
    { say: 'sync my inbox', expect: { tool: 'show_setup', kind: 'setup' } },
    { say: 'write to Jake Morrison', expect: { tool: 'create_draft' } },
  ]),
  T('nogmail-quiet', 'student-nogmail', 'pipeline', 'no Gmail: who went quiet', [
    { say: 'who went quiet', expect: { tool: 'list_pipeline' } },
    { say: 'connect gmail', expect: { tool: 'show_setup' } },
  ]),
  T('nogmail-prep', 'student-nogmail', 'people', 'no Gmail: prep for my next chat', [
    { say: 'prep me for my next chat', expect: { tool: ['list_pipeline', 'get_person'] } },
  ]),
  T('nogmail-routes', 'student-nogmail', 'map', 'no Gmail: who do I know at Stripe, write to the first', [
    { say: 'who do I know at Stripe', expect: { tool: 'find_routes' } },
    { say: 'write to the first one', expect: { tool: 'create_draft' } },
  ]),
  // ---- no LinkedIn ----
  T('nolinkedin-import', 'student-nolinkedin', 'integrations', 'no LinkedIn: sync linkedin, import it', [
    { say: 'sync my linkedin', expect: { tool: 'show_setup', kind: 'setup' } },
    { say: 'import my linkedin connections', expect: { tool: 'show_setup' } },
  ]),
  T('nolinkedin-mutuals', 'student-nolinkedin', 'map', 'no LinkedIn: who knows Priya Raman', [
    { say: 'who knows Priya Raman', expect: { tool: ['get_mutual_connections', 'find_routes'] } },
  ]),
  T('nolinkedin-recs', 'student-nolinkedin', 'discover', 'no LinkedIn: who should I meet', [
    { say: 'who should I meet', expect: { tool: 'list_recommendations' } },
  ]),
  // ---- empty account ----
  T('empty-hi', 'empty', 'onboarding', 'an empty account says hi and asks what to do', [
    { say: 'hi', expect: { tool: 'show_setup', kind: 'setup' } },
    { say: 'what can you do', expect: { tool: 'show_setup' } },
    { say: 'show my pipeline', expect: { tool: 'list_pipeline' } },
  ]),
  T('empty-add', 'empty', 'people', 'an empty account adds someone and writes to them', [
    {
      say: 'add Jordan Kim at Stripe, jordan@stripe.com',
      expect: { tool: 'add_person', personAdded: 'Jordan Kim' },
    },
    { say: 'write to them', expect: { tool: 'create_draft' } },
  ]),
  // ---- the sample student ----
  T('demo-thanks-send', 'demo', 'drafts', 'thank Lena, shorten, send, approve', [
    {
      say: 'draft a thank you to Lena',
      expect: { tool: 'create_draft', kind: 'draft', draftFor: 'Lena Novak' },
    },
    { say: 'shorter please', expect: { tool: 'update_draft_body' } },
    { say: 'send it', expect: { tool: 'send_draft', pending: true } },
  ]),
  T('demo-quiet-each', 'demo', 'pipeline', 'who went quiet, follow up with each', [
    { say: 'who went quiet', expect: { tool: 'list_pipeline' } },
    { say: 'follow up with all of them', expect: { tool: ['create_drafts', 'create_draft'] } },
  ]),
  T('demo-routes-ask', 'demo', 'map', 'routes to Daniel, ask the first one', [
    { say: 'who can introduce me to Daniel Okafor', expect: { tool: 'find_routes', kind: 'routes' } },
    { say: 'ask the first one', expect: { tool: 'create_draft', kind: 'draft' } },
  ]),
  T('demo-routes-tap', 'demo', 'map', 'routes to Daniel, tap the chip', [
    { say: 'routes to Daniel', expect: { tool: 'find_routes' } },
    { tap: 0, expect: { tool: 'create_draft' } },
  ]),
  T('demo-prep-ethan', 'demo', 'people', 'prep for next chat, what to ask, and his notes', [
    { say: 'prep me for my next chat', expect: { tool: 'get_person', says: /Ethan/ } },
    { say: 'what should I ask him', expect: { tool: 'get_person' } },
    { say: 'notes about him', expect: { tool: 'list_notes' } },
  ]),
  T('demo-who-and', 'demo', 'people', 'who is Hannah, and Omar?', [
    { say: 'who is Hannah', expect: { tool: 'get_person' } },
    { say: 'and Omar?', expect: { tool: 'get_person', says: /Omar/ } },
    { say: 'what about Caleb', expect: { tool: 'get_person', says: /Caleb/ } },
  ]),
  T('demo-stage-each', 'demo', 'pipeline', 'outreach sent list, draft each', [
    { say: 'who is in outreach sent', expect: { tool: 'list_pipeline' } },
    { tap: 0, expect: { tool: ['create_drafts', 'create_draft'] } },
  ]),
  T('demo-company-tap', 'demo', 'map', 'who do I know at Ramp, tap draft each', [
    { say: 'who do I know at Ramp', expect: { tool: 'find_routes' } },
    { tap: 1, expect: { tool: 'create_drafts' } },
  ]),
  T('demo-hello-show', 'demo', 'today', 'hello, show me', [
    { say: 'hello', expect: { tool: 'offer_choices' } },
    { tap: 0, expect: { tool: ['get_today_brief', 'list_drafts', 'list_pipeline'] } },
  ]),
  T('demo-maya-referral', 'demo', 'drafts', 'Maya referral, show, send', [
    { say: 'show my draft to Maya', expect: { tool: 'get_draft' } },
    { say: 'send it', expect: { tool: 'send_draft', pending: true } },
    { say: 'yes', expect: { answer: true } },
  ]),
  T('demo-intro-request', 'demo', 'map', 'intro request through Maya to Daniel', [
    { say: 'draft an intro request to Maya Chen for Daniel Okafor', expect: { tool: 'create_draft' } },
    { say: 'make it shorter', expect: { tool: 'update_draft_body' } },
  ]),
  T('demo-snooze-sofia', 'demo', 'today', "snooze Sofia's card, then today", [
    { say: 'snooze Sofia for a week', expect: { tool: 'manage_suggestion' } },
    { say: "what's on today", expect: { tool: 'get_today_brief' } },
  ]),
  T('demo-noah-warmup', 'demo', 'drafts', 'write to Noah: warm-up choice', [
    { say: 'write to Noah', expect: { tool: 'create_draft' } },
    { say: 'warm up Noah first', expect: { tool: 'create_draft' } },
  ]),
  T('demo-move-scheduling', 'demo', 'pipeline', 'move Hannah to scheduling then prep', [
    {
      say: 'move Hannah to scheduled',
      expect: { tool: 'move_pipeline_stage', stage: ['Hannah Brooks', 'scheduled'] },
    },
    { tap: 0, expect: { tool: 'get_person' } },
  ]),
  T('demo-recs-write', 'demo', 'discover', 'recommendations, write to the second', [
    { say: 'show my recommendations', expect: { tool: 'list_recommendations' } },
    { say: 'write to the second one', expect: { tool: 'create_draft' } },
  ]),
  T('demo-needs-key', 'demo', 'needs a key', 'a why question, then the honest next step', [
    { say: "why hasn't Daniel replied?", expect: { needsKey: true, tool: ['list_pipeline', 'get_person'] } },
    { say: 'follow up with Daniel', expect: { tool: 'create_draft' } },
  ]),
  T('demo-settings', 'demo', 'settings', 'tone, then limits', [
    { say: 'set my tone to direct', expect: { tool: 'update_settings' } },
    { say: 'set my weekly target to 6', expect: { tool: 'update_limits', pending: true } },
    { cancel: true, expect: {} },
  ]),
  T('demo-mutuals-yes', 'demo', 'map', 'who knows Maya, yes ask', [
    { say: 'who knows Maya', expect: { tool: 'get_mutual_connections' } },
    { say: 'yes', expect: { tool: 'create_draft' } },
  ]),
  T('demo-notes', 'demo', 'notes', 'note about Lena, notes list', [
    {
      say: 'note about Lena: she offered to refer me to the Ramp platform team',
      expect: { tool: 'add_note', noteAdded: true },
    },
    { say: 'show my notes', expect: { tool: 'list_notes' } },
  ]),
  T('demo-caleb-replied', 'demo', 'pipeline', 'Caleb wrote back, draft a scheduling note', [
    { say: 'Caleb wrote back', expect: { tool: 'move_pipeline_stage', stage: ['Caleb Weber', 'replied'] } },
    { tap: 0, expect: { tool: 'create_draft' } },
  ]),
  T('demo-ordinal-list', 'demo', 'people', 'search, pick the second', [
    { say: 'find Keiko', expect: { ask: true, tool: 'search_people' } },
    { say: 'the second one', expect: { tool: 'get_person' } },
  ]),
];
