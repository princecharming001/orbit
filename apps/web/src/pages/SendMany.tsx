/**
 * Send to many (plan 38 §B): the whole job on one page, top to bottom. Who (each person once, the ones who cannot be
 * emailed set aside with the reason), the message (Orbit writes each one, or the student writes one and Orbit fills
 * it in), when they go (a pace, the plan as days), what happens when they reply (the group's funnel), and one button.
 * Opened from People (Select), a company page, the chat's drafts card, or Drafts: `?people=a,b`, `?drafts=x,y`,
 * `?batch=id`.
 */
import type { FunnelInterested, OutboundMessage, Person } from '@orbit/core';
import { LINK_REPLY } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronDown, ChevronRight, Clock, Mail, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CompanyLogo } from '../components/CompanyLogo';
import { SchedulingLinkField } from '../components/SchedulingLinkField';
import { ChoiceTiles } from '../components/settings/kit';
import { type BatchRow, db } from '../db/schema';
import {
  applyTemplate,
  type BatchOutcome,
  batchCanSend,
  createBatch,
  dailyEmailCap,
  draftForBatch,
  type PlannedSend,
  planForBatch,
  type RecipientState,
  recipientState,
  scheduleBatch,
  stateWords,
} from '../engine/batch';
import { FIELD_LABELS, fieldsIn, nearTwins, TEMPLATE_FIELDS, type TemplateField } from '../engine/batchText';
import { BATCH_PACES, type BatchPace, clockTime, perDayFor, planDays } from '../engine/batchTime';
import { setDraftText } from '../engine/drafts';
import { autoRepliesOn, saveFunnel, setAutoReplies } from '../engine/funnels';
import { setSchedulingLink } from '../engine/settings';
import { isServerUser } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Avatar, Button, cx, Input, PageHeader, Skeleton, Switch, Textarea, useToast, Working } from '../ui';

const TAP = 'pointer-coarse:min-h-11';

const DEFAULT_TEMPLATE = {
  subject: 'Quick question about {company}',
  body: "Hi {first},\n\nI'm a student at {school} and I'm interested in internships at {company}. Would you have 15 minutes in the next couple of weeks to tell me how you think about candidates for your team?\n\nThank you,",
};

interface Row {
  person: Person;
  state: RecipientState;
  draftId?: string;
  writing?: boolean;
  error?: string;
  /** fields the student's message could not fill for them */
  missing?: TemplateField[];
  /** the student changed this one by hand: the shared message no longer writes over it */
  edited?: boolean;
}

/** A message that is not ready to go: a gap Orbit marked, or a field left in braces. */
function gapIn(d: Pick<OutboundMessage, 'bodyDraft' | 'bodyFinal' | 'subject' | 'needsInput'>): boolean {
  const text = `${d.subject ?? ''}\n${d.bodyFinal ?? d.bodyDraft}`;
  return (
    !!d.needsInput?.length ||
    /\[ASK USER/i.test(text) ||
    /\{(first|last|name|company|title|school)\}/i.test(text)
  );
}

function Section({
  n,
  title,
  aside,
  children,
  testId,
}: {
  n: number;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="py-8 border-t border-line-2 first:border-t-0 first:pt-2" data-testid={testId}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="section-title flex items-baseline gap-2.5">
          <span className="font-mono text-[12px] text-ink-3 tabular">{n}</span>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function SendManyPage() {
  const { user, settings } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [batch, setBatch] = useState<BatchRow>();
  const [rows, setRows] = useState<Row[]>();
  const [mode, setMode] = useState<'orbit' | 'own'>('orbit');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [pace, setPace] = useState<BatchPace>('steady');
  const [startDate, setStartDate] = useState('');
  const [spread, setSpread] = useState(true);
  const [plan, setPlan] = useState<PlannedSend[]>([]);
  const [cap, setCap] = useState(15);
  const [canSend, setCanSend] = useState<boolean>();
  const [interested, setInterested] = useState<FunnelInterested>('slots');
  const [ownReply, setOwnReply] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [replies, setReplies] = useState(false);
  const [open, setOpen] = useState<string>();
  const [scheduling, setScheduling] = useState(false);
  const [done, setDone] = useState<BatchOutcome[]>();
  const writingRef = useRef(false);
  // bumped when one message is written, so the next one starts (the row update can land before the flag is down)
  const [pump, setPump] = useState(0);
  const userId = user?.id ?? '';

  // the people (or drafts, or a batch) asked for, once
  useEffect(() => {
    if (!user) return;
    let live = true;
    void (async () => {
      const id = params.get('batch');
      let b = id ? await db.batches.get(id) : undefined;
      if (!b) {
        const draftIds = params.get('drafts')?.split(',').filter(Boolean) ?? [];
        const fromDrafts = (await db.outbound.bulkGet(draftIds)).filter((d): d is OutboundMessage => !!d);
        const personIds = [
          ...new Set([
            ...(params.get('people')?.split(',').filter(Boolean) ?? []),
            ...fromDrafts.map((d) => d.personId),
          ]),
        ];
        b = await createBatch(user, personIds, { draftIds: fromDrafts.map((d) => d.id) });
      }
      const people = (await db.people.bulkGet(b.personIds)).filter((p): p is Person => !!p);
      const drafts = (await db.outbound.bulkGet(b.draftIds)).filter((d): d is OutboundMessage => !!d);
      const out: Row[] = [];
      for (const p of people) {
        const d = drafts.find((x) => x.personId === p.id && x.status === 'draft');
        out.push({
          person: p,
          state: d ? { state: 'ready' } : await recipientState(user, p),
          draftId: d?.id,
        });
      }
      if (!live) return;
      setBatch(b);
      setRows(out);
      setCap(await dailyEmailCap(user.id));
      setCanSend(await batchCanSend(user));
      setReplies(await autoRepliesOn(user.id));
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  const ready = rows?.filter((r) => r.state.state === 'ready') ?? [];
  const aside = rows?.filter((r) => r.state.state !== 'ready') ?? [];
  const draftIds = ready.map((r) => r.draftId).filter((x): x is string => !!x);
  const drafts = useLiveQuery(
    async () => (await db.outbound.bulkGet(draftIds)).filter((d): d is OutboundMessage => !!d),
    [draftIds.join(',')],
    [] as OutboundMessage[],
  );
  const byId = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);
  const patch = (personId: string, change: Partial<Row>) =>
    setRows((rs) => rs?.map((r) => (r.person.id === personId ? { ...r, ...change } : r)));

  // each message written one at a time, so the first ones can be read while the rest arrive
  useEffect(() => {
    if (!user || !rows || !batch || writingRef.current) return;
    const next = rows.find((r) => r.state.state === 'ready' && !r.draftId && !r.writing && !r.error);
    if (!next) return;
    writingRef.current = true;
    patch(next.person.id, { writing: true });
    void (async () => {
      try {
        const r = await draftForBatch(user, next.person.id);
        if (r.draft) {
          patch(next.person.id, { writing: false, draftId: r.draft.id });
          const b = await db.batches.get(batch.id);
          if (b && !b.draftIds.includes(r.draft.id))
            await db.batches.update(batch.id, { draftIds: [...b.draftIds, r.draft.id] });
        } else patch(next.person.id, { writing: false, error: r.why ?? 'Orbit could not write this one' });
      } catch {
        patch(next.person.id, { writing: false, error: 'Orbit could not write this one' });
      } finally {
        writingRef.current = false;
        setPump((n) => n + 1);
      }
    })();
  }, [rows, batch, userId, pump]);

  // the student's own message, written into each draft they have not changed by hand
  useEffect(() => {
    if (!user || mode !== 'own' || !rows) return;
    const t = setTimeout(() => {
      void (async () => {
        for (const r of rows) {
          if (!r.draftId || r.edited) continue;
          const d = await db.outbound.get(r.draftId);
          if (d?.status !== 'draft') continue;
          const { missing } = await applyTemplate(user, d, r.person, template);
          patch(r.person.id, { missing: missing as TemplateField[] });
        }
      })();
    }, 350);
    return () => clearTimeout(t);
  }, [mode, template, rows?.map((r) => `${r.draftId}:${r.edited}`).join(','), userId]);

  // the messages that can go, and their plan
  const goable = drafts.filter((d) => d.status === 'draft' && d.channel === 'gmail' && !gapIn(d));
  const goKey = goable.map((d) => d.id).join(',');
  useEffect(() => {
    if (!user) return;
    let live = true;
    const t = setTimeout(() => {
      const start = startDate ? new Date(`${startDate}T00:00:00`) : undefined;
      void planForBatch(user, goable, pace, { start, oneCompanyADay: spread }).then(
        (p) => live && setPlan(p),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [goKey, pace, startDate, spread, userId]);

  const days = useMemo(() => planDays(plan.map((p) => p.at)), [plan]);
  const twins = useMemo(
    () =>
      nearTwins(
        goable.map((d) => {
          const p = rows?.find((r) => r.draftId === d.id)?.person;
          return {
            body: d.bodyFinal ?? d.bodyDraft,
            names: [p?.firstName ?? '', p?.lastName ?? '', p?.currentOrganizationRaw ?? ''],
          };
        }),
      ),
    [goable.map((d) => `${d.id}:${(d.bodyFinal ?? d.bodyDraft).length}`).join(',')],
  );
  const stillWriting = ready.some((r) => r.writing || (!r.draftId && !r.error));
  // the ones that need the student first, then the rest; a long batch shows a few until asked
  const [allMessages, setAllMessages] = useState(false);
  const rank = (r: Row) => {
    const d = r.draftId ? byId.get(r.draftId) : undefined;
    return r.error ? 0 : d && gapIn(d) ? 1 : 2;
  };
  const ordered = [...ready].sort((a, b) => rank(a) - rank(b));
  const listed = allMessages
    ? ordered
    : ordered.slice(0, Math.max(8, ordered.filter((r) => rank(r) < 2).length));
  const needsLine = ready.filter((r) => r.draftId && byId.get(r.draftId) && gapIn(byId.get(r.draftId)!));

  if (!user) return null;

  const schedule = async () => {
    if (!batch || !plan.length) return;
    setScheduling(true);
    try {
      // the group's funnel and the reply switch go first, so a fast reply already finds them
      await saveFunnel(user.id, {
        id: batch.id,
        name: batch.name,
        personIds: plan.map((p) => p.personId),
        interested,
        reply: interested === 'own' ? ownReply : interested === 'link' ? ownReply || undefined : undefined,
        followUp: followUp.trim() || undefined,
        createdAt: batch.createdAt,
      });
      if (replies !== (await autoRepliesOn(user.id))) await setAutoReplies(user.id, replies);
      // a name that only counted who was picked now counts who it goes to
      const name = /^\d+ (people|person), /.test(batch.name)
        ? batch.name.replace(
            /^\d+ (people|person)/,
            `${plan.length} ${plan.length === 1 ? 'person' : 'people'}`,
          )
        : batch.name;
      await db.batches.update(batch.id, {
        name,
        pace,
        ...(mode === 'own' ? { template } : {}),
      });
      const out = await scheduleBatch(user, batch.id, plan);
      setDone(out);
      const n = out.filter((o) => o.ok).length;
      toast.push({
        text: n ? `${n} ${n === 1 ? 'email' : 'emails'} scheduled.` : 'Nothing was scheduled.',
        tone: n ? 'good' : 'bad',
      });
    } finally {
      setScheduling(false);
    }
  };

  if (done) return <Done user={user} batch={batch!} out={done} rows={rows ?? []} />;

  const perDay = perDayFor(pace, cap);
  const last = days[days.length - 1];
  return (
    <div className="max-w-[880px] pb-6" data-testid="send-many">
      <PageHeader title="Send to many" subtitle={rows ? batch?.name : 'Getting everyone ready'} />
      {canSend === false && (
        <div
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-warn-soft px-4 py-3 text-[13.5px]"
          data-testid="send-many-no-gmail"
        >
          <span>Connect Gmail with permission to send, so Orbit can send these at their times.</span>
          <Link to="/settings/integrations">
            <Button size="sm" variant="secondary">
              Connect Gmail
            </Button>
          </Link>
        </div>
      )}

      <Section
        n={1}
        title="Who"
        testId="send-many-who"
        aside={
          rows && (
            <span className="text-[13px] text-ink-3 tabular">
              {ready.length} can be emailed{aside.length ? ` · ${aside.length} set aside` : ''}
            </span>
          )
        }
      >
        {!rows ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !rows.length ? (
          <p className="text-[13.5px] text-ink-3">
            Nobody picked yet. Select people on{' '}
            <Link to="/people?view=list" className="underline underline-offset-2">
              People
            </Link>{' '}
            and choose Write to them.
          </p>
        ) : (
          <>
            <PeoplePicked
              rows={ready}
              onRemove={(id) => setRows((rs) => rs?.filter((x) => x.person.id !== id))}
            />
            {aside.length > 0 && (
              <details className="mt-4 group" data-testid="send-many-aside">
                <summary className="cursor-pointer list-none inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink">
                  <ChevronRight size={14} className="group-open:rotate-90 transition-transform" aria-hidden />
                  {aside.length} set aside
                </summary>
                <ul className="mt-2 divide-y divide-line-2">
                  {aside.map((r) => (
                    <li key={r.person.id} className="flex items-center gap-3 py-2 text-[13.5px]">
                      <Avatar
                        name={r.person.displayName}
                        src={r.person.photoUrl}
                        id={r.person.id}
                        size={26}
                      />
                      <Link to={`/people/${r.person.id}`} className="font-medium hover:underline">
                        {r.person.displayName}
                      </Link>
                      <span className="text-ink-3 text-[12.5px]" data-testid="send-many-aside-why">
                        {stateWords(r.state, r.person.firstName)}
                        {r.state.state === 'no_email' && '. Write to them on LinkedIn from their page'}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </Section>

      <Section n={2} title="The message" testId="send-many-message">
        <ChoiceTiles
          label="How the messages are written"
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === 'orbit') setRows((rs) => rs?.map((r) => ({ ...r, missing: undefined })));
          }}
          options={[
            {
              value: 'orbit',
              title: 'Orbit writes each one',
              line: 'Fitted to each person, from what Orbit knows',
              testId: 'send-many-mode-orbit',
            },
            {
              value: 'own',
              title: 'Write your own',
              line: 'One message, with their name and company filled in',
              testId: 'send-many-mode-own',
            },
          ]}
        />
        {mode === 'own' && <TemplateEditor template={template} onChange={setTemplate} school={user.school} />}
        {ready.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-[12.5px] text-ink-3">
              <span>
                {stillWriting ? (
                  <span className="inline-flex items-center gap-1.5" data-testid="send-many-writing">
                    <Working /> Writing {ready.filter((r) => r.draftId).length + 1} of {ready.length}
                  </span>
                ) : (
                  `${goable.length} ready${needsLine.length ? ` · ${needsLine.length} need a line` : ''}`
                )}
              </span>
              <span>Open one to change it</span>
            </div>
            <ul className="divide-y divide-line-2 border-y border-line-2" data-testid="send-many-messages">
              {listed.map((r) => (
                <MessageRow
                  key={r.person.id}
                  row={r}
                  draft={r.draftId ? byId.get(r.draftId) : undefined}
                  open={open === r.person.id}
                  onToggle={() => setOpen((o) => (o === r.person.id ? undefined : r.person.id))}
                  onEdited={() => patch(r.person.id, { edited: true })}
                />
              ))}
            </ul>
            {ordered.length > listed.length || allMessages ? (
              <button
                type="button"
                className="mt-2 text-[13px] text-ink-2 hover:text-ink underline-offset-2 hover:underline"
                onClick={() => setAllMessages((v) => !v)}
                data-testid="send-many-messages-more"
              >
                {allMessages ? 'Show fewer' : `Show all ${ordered.length}`}
              </button>
            ) : null}
            {twins >= 3 && twins >= goable.length * 0.3 && (
              <p
                className="mt-3 flex items-start gap-2 text-[13px] text-ink-2"
                data-testid="send-many-similar"
              >
                <Sparkles size={14} className="mt-[3px] shrink-0 text-warn" aria-hidden />
                {twins} of these read nearly the same. Spam filters group mail like that, so a line about each
                person helps more than anything else here.
              </p>
            )}
          </div>
        )}
      </Section>

      <Section n={3} title="When they go" testId="send-many-when">
        <ChoiceTiles
          label="Pace"
          value={pace}
          onChange={setPace}
          options={(Object.keys(BATCH_PACES) as BatchPace[]).map((p) => ({
            value: p,
            title: p === 'steady' ? `${BATCH_PACES[p].title} (recommended)` : BATCH_PACES[p].title,
            line: p === 'faster' ? `Up to ${cap} a day, your limit` : BATCH_PACES[p].line,
            testId: `send-many-pace-${p}`,
          }))}
        />
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13.5px]">
          <label className="inline-flex items-center gap-2">
            <span className="text-ink-2">Start</span>
            <Input
              type="date"
              value={startDate}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-9 w-[10.5rem]"
              aria-label="Start on"
              data-testid="send-many-start"
            />
            {!startDate && (
              <span className="text-ink-3 text-[12.5px] whitespace-nowrap">the next good time</span>
            )}
          </label>
          <label className="inline-flex items-center gap-2.5">
            <Switch checked={spread} onChange={setSpread} label="One person per company a day" />
            <span className="text-ink-2">One person per company a day</span>
          </label>
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3 max-w-[70ch]">
          {pace === 'gentle'
            ? 'Tuesday to Thursday, 8 to 10:30 in the morning, in each person’s time zone.'
            : 'Weekdays, 8 to 11:30 and 1 to 4, in each person’s time zone.'}{' '}
          A few minutes apart at random, never a holiday, and counted against your daily limit with anything
          already scheduled. Anyone who replies is not sent anything else.
          {!isServerUser(user.id) && ' Orbit sends from this browser, so keep it open at those times.'}
        </p>
        <div className="mt-5" data-testid="send-many-plan">
          {!plan.length ? (
            <p className="text-[13px] text-ink-3">
              {stillWriting ? 'The plan shows once the messages are written.' : 'Nothing ready to plan yet.'}
            </p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {days.map((d) => (
                  <li key={d.key} className="flex items-center gap-3 text-[13px]" data-testid="send-many-day">
                    <span className="w-[6.5rem] shrink-0 font-medium">{d.label}</span>
                    <span className="relative h-2 flex-1 max-w-[220px] rounded-full bg-line-2 overflow-hidden">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-accent"
                        style={{ width: `${Math.min(100, (d.count / perDay) * 100)}%` }}
                      />
                    </span>
                    <span className="tabular text-ink-2 w-[5.5rem]">
                      {d.count} {d.count === 1 ? 'email' : 'emails'}
                    </span>
                    <span className="tabular text-ink-3">
                      {clockTime(d.first)}
                      {d.count > 1 ? ` to ${clockTime(d.last)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12.5px] text-ink-3" data-testid="send-many-summary">
                {plan.length} {plan.length === 1 ? 'email' : 'emails'} over {days.length}{' '}
                {days.length === 1 ? 'day' : 'days'}, at most {perDay} a day. The last one goes {last?.label}.
              </p>
            </>
          )}
        </div>
      </Section>

      <Section n={4} title="When they reply" testId="send-many-replies">
        <div className="text-[13.5px] font-medium mb-2">If they are interested</div>
        <ChoiceTiles
          label="When someone is interested"
          value={interested}
          onChange={setInterested}
          options={[
            {
              value: 'slots',
              title: 'Offer three times',
              line: 'Free times from your calendar, in their time',
              testId: 'send-many-interested-slots',
            },
            {
              value: 'link',
              title: 'Send my booking link',
              line: settings?.schedulingLink ? 'They pick a time themselves' : 'Add your link below',
              testId: 'send-many-interested-link',
            },
            {
              value: 'own',
              title: 'My own reply',
              line: 'Your words for this group',
              testId: 'send-many-interested-own',
            },
          ]}
        />
        {interested === 'link' && (
          <div className="mt-3 max-w-xl space-y-3">
            {!settings?.schedulingLink && (
              <SchedulingLinkField
                user={user}
                value={settings?.schedulingLink}
                onChange={(link) => void setSchedulingLink(user.id, link)}
              />
            )}
            <Textarea
              rows={5}
              value={ownReply || LINK_REPLY}
              onChange={(e) => setOwnReply(e.target.value)}
              aria-label="The reply with your booking link"
              data-testid="send-many-link-reply"
            />
          </div>
        )}
        {interested === 'own' && (
          <Textarea
            rows={5}
            className="mt-3 max-w-xl"
            value={ownReply}
            onChange={(e) => setOwnReply(e.target.value)}
            placeholder="Hi {first}, thank you so much. Could I send you my resume for the {company} role first?"
            aria-label="Your reply when someone is interested"
            data-testid="send-many-own-reply"
          />
        )}
        <div className="mt-6 text-[13.5px] font-medium mb-1">If they do not answer</div>
        <p className="text-[12.5px] text-ink-3 mb-2">
          Orbit drafts one follow-up a few days later. Leave this empty for Orbit to write it.
        </p>
        <Textarea
          rows={3}
          className="max-w-xl"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          placeholder="Hi {first}, floating this back up in case it got buried. Happy to work around your schedule."
          aria-label="Your follow-up"
          data-testid="send-many-follow-up"
        />
        <label className="mt-6 flex items-start gap-3 max-w-xl" data-testid="send-many-auto-replies">
          <Switch checked={replies} onChange={setReplies} label="Send these replies for me" />
          <span>
            <span className="block text-[13.5px] font-medium">Send these replies for me</span>
            <span className="block text-[12.5px] text-ink-3">
              Booking a time, thank-yous and interested replies go on their own, from your Gmail. A question,
              a no or anything else waits for you. Off, each one waits in Drafts for a tap.
            </span>
          </span>
        </label>
      </Section>

      <div className="sticky bottom-4 z-20 mt-2">
        <div>
          <div
            className="flex flex-wrap items-center justify-end sm:justify-between gap-3 rounded-[12px] border border-line bg-canvas/95 backdrop-blur px-3 sm:px-4 py-2.5 sm:py-3 shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
            data-testid="send-many-bar"
          >
            <span className="hidden sm:inline text-[13px] text-ink-2">
              {plan.length
                ? `${plan.length} ready · ${days[0]?.label}${days.length > 1 ? ` to ${last?.label}` : ''}`
                : stillWriting
                  ? 'Writing the messages'
                  : 'Nothing ready yet'}
            </span>
            <span className="flex items-center gap-2">
              <Button variant="ghost" className={TAP} onClick={() => nav(-1)}>
                Not now
              </Button>
              <Button
                variant="primary"
                className={TAP}
                disabled={!plan.length || canSend === false || stillWriting}
                loading={scheduling}
                onClick={() => void schedule()}
                data-testid="send-many-schedule"
              >
                <Clock size={14} aria-hidden />
                Schedule {plan.length || ''} {plan.length === 1 ? 'email' : 'emails'}
              </Button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Who is in: a row of faces and the count, opening to everyone with a way to leave any of them out. */
function PeoplePicked({ rows, onRemove }: { rows: Row[]; onRemove: (personId: string) => void }) {
  const [all, setAll] = useState(rows.length <= 12);
  const shown = all ? rows : rows.slice(0, 12);
  const companies = new Set(rows.map((r) => r.person.currentOrganizationRaw).filter(Boolean)).size;
  return (
    <div data-testid="send-many-people">
      <div className="flex items-center gap-3">
        <span className="flex -space-x-2">
          {rows.slice(0, 6).map((r) => (
            <span key={r.person.id} className="rounded-full ring-2 ring-[var(--color-page,#fdfcfc)]">
              <Avatar name={r.person.displayName} src={r.person.photoUrl} id={r.person.id} size={28} />
            </span>
          ))}
        </span>
        <span className="text-[13.5px] text-ink-2">
          <span className="font-medium text-ink">
            {rows.length} {rows.length === 1 ? 'person' : 'people'}
          </span>
          {companies > 1 ? ` at ${companies} companies` : ''}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {shown.map((r) => (
          <span
            key={r.person.id}
            className="inline-flex items-center gap-1.5 h-8 pl-1 pr-1.5 rounded-full border border-line bg-canvas text-[13px]"
            data-testid="send-many-person"
          >
            <Avatar name={r.person.displayName} src={r.person.photoUrl} id={r.person.id} size={24} />
            <span className="max-w-[160px] truncate">{r.person.displayName}</span>
            <button
              type="button"
              className="h-5 w-5 inline-flex items-center justify-center rounded-full text-ink-3 hover:bg-canvas-2 hover:text-ink"
              aria-label={`Leave ${r.person.firstName} out`}
              onClick={() => onRemove(r.person.id)}
              data-testid="send-many-remove"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        {rows.length > 12 && (
          <button
            type="button"
            className="h-8 px-3 rounded-full text-[13px] text-ink-2 hover:bg-canvas-2"
            onClick={() => setAll((v) => !v)}
            data-testid="send-many-people-more"
          >
            {all ? 'Show fewer' : `and ${rows.length - 12} more`}
          </button>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({
  template,
  onChange,
  school,
}: {
  template: { subject: string; body: string };
  onChange: (t: { subject: string; body: string }) => void;
  school?: string;
}) {
  const body = useRef<HTMLTextAreaElement>(null);
  const used = fieldsIn(`${template.subject}\n${template.body}`);
  const insert = (f: TemplateField) => {
    const el = body.current;
    const token = `{${f}}`;
    if (!el) return onChange({ ...template, body: `${template.body}${token}` });
    const at = el.selectionStart ?? template.body.length;
    const next = `${template.body.slice(0, at)}${token}${template.body.slice(el.selectionEnd ?? at)}`;
    onChange({ ...template, body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };
  return (
    <div className="mt-4 space-y-2" data-testid="send-many-template">
      <Input
        value={template.subject}
        onChange={(e) => onChange({ ...template, subject: e.target.value })}
        aria-label="Subject"
        placeholder="Subject"
        data-testid="send-many-template-subject"
      />
      <Textarea
        ref={body}
        rows={8}
        value={template.body}
        onChange={(e) => onChange({ ...template, body: e.target.value })}
        aria-label="Your message"
        data-testid="send-many-template-body"
      />
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
        <span className="text-ink-3 mr-1">Insert</span>
        {TEMPLATE_FIELDS.filter((f) => f !== 'name').map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => insert(f)}
            className={cx(
              'h-7 px-2.5 rounded-full border text-[12px] transition-colors',
              used.includes(f)
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-line hover:bg-canvas-2',
            )}
            data-testid={`send-many-insert-${f}`}
          >
            {f === 'school' ? `Your school${school ? ` (${school})` : ''}` : FIELD_LABELS[f]}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({
  row,
  draft,
  open,
  onToggle,
  onEdited,
}: {
  row: Row;
  draft?: OutboundMessage;
  open: boolean;
  onToggle: () => void;
  onEdited: () => void;
}) {
  const p = row.person;
  const body = draft ? (draft.bodyFinal ?? draft.bodyDraft) : '';
  const [text, setText] = useState(body);
  const [subject, setSubject] = useState(draft?.subject ?? '');
  useEffect(() => {
    if (!open) {
      setText(body);
      setSubject(draft?.subject ?? '');
    }
  }, [body, draft?.subject, open]);
  const gap = draft ? gapIn(draft) : false;
  // the first words after the greeting ("Hi Zara," is the same on every row)
  const firstLine = body
    .replace(/^\s*(hi|hey|hello|dear)\b[^,\n]*,?\s*/i, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  const save = async () => {
    if (!draft) return;
    if (text === body && subject === (draft.subject ?? '')) return;
    await setDraftText(draft.id, { body: text, subject });
    onEdited();
  };
  return (
    <li data-testid="send-many-row" data-person-id={p.id}>
      <button
        type="button"
        className="w-full flex items-center gap-3 py-3 text-left hover:bg-canvas-2/50 px-1 -mx-1 rounded-[6px]"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[13.5px]">
            <span className="font-medium truncate">{p.displayName}</span>
            {p.currentOrganizationRaw && (
              <span className="inline-flex items-center gap-1 text-ink-3 truncate">
                <CompanyLogo
                  name={p.currentOrganizationRaw}
                  orgId={p.currentOrganizationId}
                  size={13}
                  decorative
                />
                {p.currentOrganizationRaw}
              </span>
            )}
          </span>
          <span className="block text-[12.5px] text-ink-3 truncate">
            {row.writing || (!draft && !row.error) ? (
              <span className="inline-flex items-center gap-1.5">
                <Working /> Writing
              </span>
            ) : row.error ? (
              <span className="text-bad">{row.error}</span>
            ) : (
              <>
                {draft?.subject && <span className="text-ink-2">{draft.subject} · </span>}
                {firstLine}
              </>
            )}
          </span>
        </span>
        {draft &&
          (gap ? (
            <span className="text-[12px] font-medium text-warn shrink-0" data-testid="send-many-needs-line">
              Needs a line
            </span>
          ) : (
            <Check size={15} className="shrink-0 text-good" aria-label="Ready" />
          ))}
        <ChevronDown
          size={15}
          className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && draft && (
        <div className="pb-4 pl-[42px] space-y-2" data-testid="send-many-editor">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Mail size={13} aria-hidden /> To {draft.toEmail ?? p.primaryEmail}
          </div>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={() => void save()}
            aria-label={`Subject to ${p.firstName}`}
          />
          <Textarea
            rows={9}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void save()}
            aria-label={`Message to ${p.firstName}`}
            data-testid="send-many-editor-body"
          />
          {row.missing?.length ? (
            <p className="text-[12.5px] text-warn">
              Orbit has no {row.missing.map((m) => FIELD_LABELS[m].toLowerCase()).join(' or ')} for{' '}
              {p.firstName}: write it in where the braces are.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

function Done({
  user,
  batch,
  out,
  rows,
}: {
  user: { timezone?: string };
  batch: BatchRow;
  out: BatchOutcome[];
  rows: Row[];
}) {
  const ok = out.filter((o): o is Extract<BatchOutcome, { ok: true }> => o.ok);
  const bad = out.filter((o): o is Extract<BatchOutcome, { ok: false }> => !o.ok);
  const name = (draftId: string) => rows.find((r) => r.draftId === draftId)?.person;
  const first = ok.sort((a, b) => a.at.localeCompare(b.at))[0];
  const firstWho = first ? name(first.draftId) : undefined;
  void user;
  return (
    <div className="max-w-[760px]" data-testid="send-many-done">
      <PageHeader
        title={
          ok.length ? `${ok.length} ${ok.length === 1 ? 'email' : 'emails'} scheduled` : 'Nothing scheduled'
        }
        subtitle={batch.name}
      />
      {first && (
        <p className="text-[14px] text-ink-2" data-testid="send-many-done-first">
          The first goes to {firstWho?.displayName ?? 'them'}{' '}
          {new Date(first.at).toLocaleString('en-US', {
            weekday: 'long',
            hour: 'numeric',
            minute: '2-digit',
          })}
          . You can move or cancel any of them until then.
        </p>
      )}
      {bad.length > 0 && (
        <div className="mt-6">
          <div className="text-[13.5px] font-medium mb-2">
            {bad.length} {bad.length === 1 ? 'stayed a draft' : 'stayed drafts'}
          </div>
          <ul className="divide-y divide-line-2 border-y border-line-2" data-testid="send-many-done-held">
            {bad.map((b) => {
              const p = name(b.draftId);
              return (
                <li key={b.draftId} className="py-2.5 text-[13.5px]">
                  <span className="font-medium">{p?.displayName ?? 'Someone'}</span>
                  <span className="text-ink-3"> · {b.error}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-8 flex flex-wrap gap-2">
        <Link to="/inbox?tab=scheduled">
          <Button variant="primary" data-testid="send-many-see-queue">
            See the queue
          </Button>
        </Link>
        <Link to="/people?view=list">
          <Button variant="secondary">Back to People</Button>
        </Link>
      </div>
    </div>
  );
}
