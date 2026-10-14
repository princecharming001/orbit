import { describe, expect, it } from 'vitest';
import {
  type AutonomyContext,
  autonomyAllows,
  checkAttachments,
  checkCalendar,
  checkCrossThread,
  checkDoNotContact,
  checkFirstMessage,
  checkImpersonation,
  checkIntroAsk,
  checkInventedFacts,
  checkLinkedIn,
  checkLinks,
  checkMinor,
  checkMoney,
  checkSend,
  checkSensitive,
  checkTimeCommitments,
  checkUnanswered,
  looksLikeMinor,
  messageHash,
  type OutgoingAction,
  type SendContext,
  sendAllowed,
  unansweredBefore,
} from '../safety/rules';

// Wednesday 14 October 2026, 15:00 UTC (11:00 in New York)
const NOW = new Date('2026-10-14T15:00:00Z');
const TZ = 'America/New_York';

const draft = (extra: Partial<OutgoingAction> = {}): OutgoingAction => ({
  kind: 'reply',
  channel: 'gmail',
  personId: 'p',
  subject: null,
  body: 'Hi Maya,\n\nThursday works for me. Talk then.\n\nBest,\nAlex',
  fromEmail: 'alex@cornell.edu',
  signedAs: 'Alex',
  ...extra,
});

const ctx = (extra: Partial<SendContext> = {}): SendContext => ({
  now: NOW,
  userEmails: ['alex@cornell.edu', 'alex.rivera@gmail.com'],
  userName: 'Alex Rivera',
  recipient: {},
  history: [
    { direction: 'out', at: '2026-10-05T14:00:00Z' },
    { direction: 'in', at: '2026-10-13T14:00:00Z' },
  ],
  timeZone: TZ,
  ...extra,
});

const rules = (vs: { rule: string }[]) => vs.map((v) => v.rule);

describe('hard rules (§14.6): approval of the exact message', () => {
  it('LinkedIn messages always need approval', () => {
    expect(rules(checkLinkedIn(draft({ channel: 'linkedin' })))).toEqual(['linkedin_needs_approval']);
    expect(checkLinkedIn(draft())).toEqual([]);
  });

  it('a first message to anyone needs approval', () => {
    expect(rules(checkFirstMessage(draft(), ctx({ history: [] })))).toEqual(['first_message_needs_approval']);
    expect(
      rules(checkFirstMessage(draft(), ctx({ history: [{ direction: 'in', at: '2026-10-01T00:00:00Z' }] }))),
    ).toEqual(['first_message_needs_approval']);
    expect(checkFirstMessage(draft(), ctx())).toEqual([]);
  });

  it('money amounts need approval', () => {
    for (const body of [
      'We charge $500 a month.',
      'The round is 1.5 million dollars.',
      'A €20k pilot',
      'about 300 USD',
    ])
      expect(rules(checkMoney(draft({ body }))), body).toEqual(['money_needs_approval']);
    expect(checkMoney(draft({ body: 'Thursday at 2 works for 20 minutes.' }))).toEqual([]);
  });

  it('attachments need approval', () => {
    expect(rules(checkAttachments(draft({ attachments: ['resume.pdf'] })))).toEqual([
      'attachment_needs_approval',
    ]);
    expect(rules(checkAttachments(draft({ body: 'My resume is attached.' })))).toEqual([
      'attachment_needs_approval',
    ]);
    expect(checkAttachments(draft())).toEqual([]);
  });

  it('links other than the scheduling link need approval', () => {
    const body = 'Grab a time here: https://cal.com/alex/20min or see https://alex.dev';
    expect(checkLinks(draft({ body }), { schedulingLink: 'https://cal.com/alex' })).toEqual([
      { rule: 'link_needs_approval', kind: 'needs_approval', detail: 'https://alex.dev' },
    ]);
    expect(
      checkLinks(draft({ body: 'https://cal.com/alex/20min' }), { schedulingLink: 'https://cal.com/alex' }),
    ).toEqual([]);
  });

  it('times beyond the offered slots need approval', () => {
    const offered = ['2026-10-15T18:00:00Z']; // Thursday 2pm New York
    const ok = draft({ body: 'Thursday at 2pm works for me.' });
    expect(checkTimeCommitments(ok, { now: NOW, timeZone: TZ, offeredSlots: offered })).toEqual([]);
    const extra = draft({ body: 'Thursday at 2pm works, or Friday at 10am.' });
    expect(rules(checkTimeCommitments(extra, { now: NOW, timeZone: TZ, offeredSlots: offered }))).toEqual([
      'time_commitment_needs_approval',
    ]);
  });

  it('calendar changes need approval', () => {
    expect(rules(checkCalendar(draft({ action: 'calendar_event' })))).toEqual(['calendar_needs_approval']);
    expect(checkCalendar(draft())).toEqual([]);
  });

  it('asking a third party for an introduction needs approval', () => {
    expect(rules(checkIntroAsk(draft({ kind: 'intro_request' })))).toEqual(['intro_ask_needs_approval']);
    expect(rules(checkIntroAsk(draft({ kind: 'forwardable_blurb' })))).toEqual(['intro_ask_needs_approval']);
    expect(checkIntroAsk(draft({ kind: 'bump' }))).toEqual([]);
  });

  it("revealing one person's thread to another needs approval", () => {
    const other = ['Between us, the team is about to lose its budget and two people are leaving next month.'];
    const leak = draft({
      body: 'I heard the team is about to lose its budget and two people are leaving soon.',
    });
    expect(rules(checkCrossThread(leak, { otherThreads: other }))).toEqual(['cross_thread_needs_approval']);
    expect(checkCrossThread(draft(), { otherThreads: other })).toEqual([]);
  });

  it('approval of the exact message clears approval rules, and only for those words', () => {
    const d = draft({ channel: 'linkedin', body: 'See https://alex.dev for the deck.' });
    const before = checkSend(d, ctx());
    expect(rules(before)).toEqual(['linkedin_needs_approval', 'link_needs_approval']);
    expect(checkSend(d, ctx({ approvedHash: messageHash(d) }))).toEqual([]);
    const edited = { ...d, body: `${d.body} Thanks!` };
    expect(checkSend(edited, ctx({ approvedHash: messageHash(d) })).length).toBe(2);
    expect(messageHash(d)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('hard rules (§14.6): never', () => {
  it('never contacts someone marked do_not_contact, approved or not', () => {
    expect(rules(checkDoNotContact({ recipient: { doNotContact: true } }))).toEqual(['do_not_contact']);
    const d = draft();
    expect(
      rules(checkSend(d, ctx({ recipient: { doNotContact: true }, approvedHash: messageHash(d) }))),
    ).toEqual(['do_not_contact']);
  });

  it('never sends a fourth unanswered message', () => {
    const three = ['2026-09-01', '2026-09-10', '2026-09-20'].map((d) => ({
      direction: 'out' as const,
      at: `${d}T12:00:00Z`,
    }));
    expect(unansweredBefore(three)).toBe(3);
    expect(rules(checkUnanswered(draft(), { history: three }))).toEqual(['unanswered_limit']);
    expect(checkUnanswered(draft(), { history: three.slice(0, 2) })).toEqual([]);
    expect(
      checkUnanswered(draft(), { history: [...three, { direction: 'in', at: '2026-09-25T12:00:00Z' }] }),
    ).toEqual([]);
  });

  it('never impersonates anyone other than the student', () => {
    expect(rules(checkImpersonation(draft({ fromEmail: 'maya@stripe.com' }), ctx()))).toEqual([
      'impersonation',
    ]);
    expect(rules(checkImpersonation(draft({ signedAs: 'Lena' }), ctx()))).toEqual(['impersonation']);
    expect(
      checkImpersonation(draft({ fromEmail: 'Alex.Rivera+orbit@gmail.com', signedAs: 'Alex Rivera' }), ctx()),
    ).toEqual([]);
  });

  it('never invents names or numbers that are not in the inputs', () => {
    const d = draft({ body: 'Hi Maya,\n\nJordan Blake said your team grew 300% this year.\n\nBest,\nAlex' });
    const v = checkInventedFacts(d, { inputs: 'Maya Chen, Stripe, Alex Rivera' });
    expect(rules(v)).toEqual(['invented_fact', 'invented_fact']);
    expect(checkInventedFacts(d, {})).toEqual([]);
  });

  it('never contacts someone who appears to be a minor', () => {
    expect(looksLikeMinor({ headline: 'High school junior who loves robotics' })).toBe(true);
    expect(looksLikeMinor({ title: 'Student', headline: '16 years old, coding since 12' })).toBe(true);
    expect(looksLikeMinor({ title: 'Senior Analyst' })).toBe(false);
    expect(rules(checkMinor({ recipient: { isMinor: true } }))).toEqual(['minor']);
  });

  it('never states or infers sensitive personal categories about the recipient', () => {
    for (const body of [
      'As a fellow Christian yourself, I thought you would relate.',
      'I hope your cancer treatment is going well.',
      'Given your immigration status, this role might be hard.',
    ])
      expect(rules(checkSensitive(draft({ body }))), body).toEqual(['sensitive_category']);
    expect(checkSensitive(draft({ body: 'Your talk on payments was great.' }))).toEqual([]);
  });

  it('a clean reply in a two-way thread passes every rule', () => {
    expect(sendAllowed(checkSend(draft(), ctx()))).toBe(true);
  });
});

describe('autonomy level 2 (§8.4)', () => {
  const auto = (extra: Partial<AutonomyContext> = {}): AutonomyContext => ({
    ...ctx({ offeredSlots: ['2026-10-15T18:00:00Z'] }),
    userAutonomy: 2,
    replyClass: 'scheduling',
    inThread: true,
    recipientScore: 55,
    validatorOk: true,
    autoSentToday: 0,
    recipientTimeZone: TZ,
    ...extra,
  });
  const confirm = draft({ body: 'Hi Maya,\n\nThursday at 2pm works. Talk then.\n\nBest,\nAlex' });

  it('auto-sends a scheduling confirmation in a two-way Gmail thread', () => {
    expect(autonomyAllows(confirm, auto())).toEqual({ allowed: true, reasons: [] });
  });

  it('refuses a cold first-touch reply, LinkedIn, late at night, and every other failed condition', () => {
    const reason = (d: OutgoingAction, c: AutonomyContext) => autonomyAllows(d, c).reasons;
    expect(reason(confirm, auto({ history: [{ direction: 'in', at: '2026-10-13T14:00:00Z' }] }))).toEqual(
      expect.arrayContaining(['not a reply in a two-way thread', 'first_message_needs_approval']),
    );
    expect(reason({ ...confirm, channel: 'linkedin' }, auto())).toEqual(
      expect.arrayContaining(['not Gmail', 'linkedin_needs_approval']),
    );
    expect(reason(confirm, auto({ now: new Date('2026-10-15T03:00:00Z') }))).toEqual([
      '23:00 in their time zone',
    ]);
    expect(reason(confirm, auto({ userAutonomy: 1 }))).toEqual(['autonomy level 1']);
    expect(reason(confirm, auto({ userAutonomy: 0, goalAutonomy: 2 }))).toEqual([]);
    expect(reason(confirm, auto({ replyClass: 'question' }))).toEqual(['reply class question']);
    expect(reason(confirm, auto({ recipientScore: 30 }))).toEqual(['score 30 below 40']);
    expect(reason(confirm, auto({ validatorOk: false }))).toEqual(['validator failed']);
    expect(reason(confirm, auto({ autoSentToday: 5 }))).toEqual(['5 auto-sends today']);
    expect(reason({ ...confirm, body: `${confirm.body} The fee is $200.` }, auto())).toEqual([
      'money_needs_approval',
    ]);
    expect(reason({ ...confirm, body: 'Thursday at 2pm or Friday at 9am both work.' }, auto())).toEqual([
      'time_commitment_needs_approval',
    ]);
    expect(reason(confirm, auto({ inThread: false }))).toEqual(['not a reply in a two-way thread']);
  });
});
