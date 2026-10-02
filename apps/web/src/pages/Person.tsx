import type { MessageKind, Person } from '@orbit/core';
import { linkedinActivityUrl, newId, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ExternalLink, Linkedin, Mail, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DraftEditor } from '../components/DraftEditor';
import { feedback } from '../db/repo';
import { db } from '../db/schema';
import { draftMessage, refreshPersonSummary, startWarmUpOrOutreach } from '../engine/brief';
import { approveAndSend } from '../engine/send';
import { applyStage } from '../engine/stages';
import { useSession } from '../state/session';
import { Avatar, Button, Card, Chip, cx, relDate, Select, Tabs, useToast } from '../ui';
import { STAGE_COLOR, StrengthDots } from './Pipeline';

const TP_ICON: Record<string, string> = {
  email_in: '↙',
  email_out: '↗',
  email_cc: 'cc',
  meeting: '☕',
  linkedin_in: 'in',
  linkedin_out: 'in',
  linkedin_connected: '+',
  linkedin_engaged: '♥',
  note: '✎',
  manual_log: '✓',
  intro_observed: '⇄',
};

export function PersonPage() {
  const { id } = useParams();
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'timeline' | 'facts' | 'connections' | 'prep') ?? 'timeline';
  const nav = useNavigate();
  const toast = useToast();
  const person = useLiveQuery(() => (id ? db.people.get(id) : undefined), [id]);
  const chats = useLiveQuery(() => (id ? db.chats.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const tps =
    useLiveQuery(() => (id ? db.touchpoints.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const facts =
    useLiveQuery(
      () =>
        id
          ? db.facts
              .where('personId')
              .equals(id)
              .filter((f) => !f.deletedAt)
              .toArray()
          : [],
      [id],
    ) ?? [];
  const items =
    useLiveQuery(() => (id ? db.actionItems.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const drafts =
    useLiveQuery(() => (id ? db.outbound.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const edges =
    useLiveQuery(
      () => (id ? db.edges.where('personAId').equals(id).or('personBId').equals(id).toArray() : []),
      [id],
    ) ?? [];
  const affs =
    useLiveQuery(() => (id ? db.affiliations.where('personId').equals(id).toArray() : []), [id]) ?? [];
  const neighbourIds = useMemo(
    () => edges.map((e) => (e.personAId === id ? e.personBId : e.personAId)),
    [edges, id],
  );
  const neighbours =
    useLiveQuery(
      () => (neighbourIds.length ? db.people.bulkGet(neighbourIds) : []),
      [neighbourIds.join(',')],
    ) ?? [];
  const notes =
    useLiveQuery(
      () =>
        id
          ? db.notes
              .where('userId')
              .equals(user?.id ?? '')
              .filter((n) => n.personIds.includes(id))
              .toArray()
          : [],
      [id, user?.id],
    ) ?? [];
  const [composing, setComposing] = useState<MessageKind | undefined>(
    (params.get('draft') as MessageKind | null) ?? undefined,
  );
  const [draftId, setDraftId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chat = chats.find((c) => !['archived'].includes(c.stage)) ?? chats[0];
  useEffect(() => {
    if (person && !person.summary && user) refreshPersonSummary(user, person.id);
  }, [person?.id, person?.summary, user]);
  const wantDraft = params.get('draft') as MessageKind | null;
  useEffect(() => {
    if (person && user && wantDraft && !draftId && !busy) {
      compose(wantDraft);
      setParams(
        (p) => {
          p.delete('draft');
          return p;
        },
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id, user?.id, wantDraft]);
  if (!user || !person) return null;
  const compose = async (kind: MessageKind) => {
    setBusy(true);
    const channel = person.primaryEmail ? 'gmail' : 'linkedin';
    if (kind === 'outreach' && !chat) {
      const r = await startWarmUpOrOutreach(user, person.id, channel);
      setBusy(false);
      if (!r.draft) {
        toast.push({ text: 'Warm-up started. Your first action is on Today.', tone: 'good', ttl: 6000 });
        nav('/today');
        return;
      }
      setDraftId(r.draft.id);
      setComposing(kind);
      return;
    }
    const d = await draftMessage(user, person.id, kind, channel, chat?.id);
    setDraftId(d.id);
    setComposing(kind);
    setBusy(false);
  };
  const draft = drafts.find((d) => d.id === draftId);
  const send = async (body: string, subject?: string) => {
    if (!draft) return;
    setBusy(true);
    const r = await approveAndSend(user, draft.id, body, subject);
    setBusy(false);
    if (!r.ok) return toast.push({ text: r.error, tone: 'bad', ttl: 6000 });
    if (r.handoffUrl) window.open(r.handoffUrl, '_blank', 'noopener');
    toast.push({
      text: r.handoffUrl
        ? draft.channel === 'linkedin'
          ? 'Copied. Paste into LinkedIn.'
          : 'Opened your mail app.'
        : 'Sent.',
      tone: 'good',
    });
    setComposing(undefined);
    setDraftId(undefined);
  };
  const timeline = [
    ...tps.map((t) => ({
      at: t.occurredAt,
      text: t.summary ?? t.kind,
      icon: TP_ICON[t.kind] ?? '•',
      kind: t.kind,
    })),
    ...drafts
      .filter((d) => d.status === 'sent')
      .map((d) => ({
        at: d.sentAt!,
        text: `Sent ${d.kind.replace('_', ' ')} via ${d.channel}`,
        icon: '↗',
        kind: 'sent',
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const grouped = new Map<string, typeof facts>();
  for (const f of facts) grouped.set(f.type, [...(grouped.get(f.type) ?? []), f]);
  const upcoming = chat?.scheduledEventId ? undefined : undefined;
  return (
    <div>
      <div className="flex items-start gap-4 mb-5">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{person.displayName}</h1>
            {person.isAlumni && <Chip tone="accent">{user.school} alum</Chip>}
            {chat && (
              <Chip>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: STAGE_COLOR[chat.stage] }} />
                {STAGE_LABELS[chat.stage]}
              </Chip>
            )}
          </div>
          <p className="text-ink-2 mt-0.5">
            {person.headline ??
              [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-3">
            {person.location && <span>{person.location}</span>}
            {person.school && <span>{person.school}</span>}
            {person.primaryEmail && (
              <a
                href={`mailto:${person.primaryEmail}`}
                className="inline-flex items-center gap-1 hover:text-ink"
              >
                <Mail size={13} /> {person.primaryEmail}
              </a>
            )}
            {person.linkedinUrl && (
              <a
                href={person.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-ink"
              >
                <Linkedin size={13} /> LinkedIn
              </a>
            )}
            <span className="inline-flex items-center gap-1.5">
              Closeness <StrengthDots v={person.strength} />{' '}
              <span className="tabular">{Math.round(person.strength * 100)}</span>
            </span>
            <span>Last touch {relDate(person.lastInteractionAt)}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex gap-2">
            <Select
              value={person.relationshipType}
              onChange={(e) => db.people.update(person.id, { relationshipType: e.target.value as never })}
              className="h-8 text-[13px]"
            >
              {[
                'unknown',
                'recruiter',
                'alumni',
                'peer',
                'mentor',
                'professor',
                'family_friend',
                'colleague',
                'other',
              ].map((r) => (
                <option key={r} value={r}>
                  {r.replace('_', ' ')}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() =>
                compose(
                  chat
                    ? chat.stage === 'completed'
                      ? 'thank_you'
                      : chat.stage === 'outreach_sent'
                        ? 'bump'
                        : chat.stage === 'nurturing' || chat.stage === 'followed_up'
                          ? 'nurture'
                          : chat.stage === 'replied' || chat.stage === 'scheduling'
                            ? 'schedule'
                            : 'outreach'
                    : 'outreach',
                )
              }
              data-testid="person-write"
            >
              Write to {person.firstName}
            </Button>
          </div>
          <div className="flex gap-1 text-[12px]">
            {chat && (
              <Select
                value={chat.stage}
                onChange={(e) => applyStage(chat, e.target.value as never, 'user', 'user:select')}
                className="h-7 text-[12px]"
              >
                {Object.entries(STAGE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
            <Button variant="ghost" size="sm" onClick={() => nav(`/notes/new?person=${person.id}`)}>
              Add note
            </Button>
            <Button variant="ghost" size="sm" onClick={() => nav(`/map?reach=${person.id}`)}>
              Reach
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await db.people.update(person.id, {
                  hiddenAt: person.hiddenAt ? undefined : new Date().toISOString(),
                });
                nav('/people');
              }}
            >
              {person.hiddenAt ? 'Unhide' : 'Hide'}
            </Button>
          </div>
        </div>
      </div>

      {composing && draft && (
        <Card className="mb-5 border-accent/40">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium">
              {composing.replace('_', ' ')} · via {draft.channel}
            </div>
            <div className="flex gap-1 text-[12px]">
              {(
                ['outreach', 'bump', 'schedule', 'thank_you', 'nurture', 'referral_ask'] as MessageKind[]
              ).map((k) => (
                <button
                  key={k}
                  onClick={() => compose(k)}
                  className={cx(
                    'px-2 h-6 rounded-full border',
                    composing === k ? 'border-ink bg-ink text-white' : 'border-line text-ink-2',
                  )}
                >
                  {k.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
          <DraftEditor
            draft={draft}
            onApprove={send}
            onCancel={() => {
              setComposing(undefined);
              setDraftId(undefined);
            }}
            busy={busy}
          />
        </Card>
      )}

      <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div>
          <Tabs
            value={tab}
            onChange={(v) => setParams({ tab: v })}
            items={[
              { value: 'timeline', label: 'Timeline', count: timeline.length },
              { value: 'facts', label: 'Facts', count: facts.length },
              { value: 'connections', label: 'Connections', count: neighbours.filter(Boolean).length },
              { value: 'prep', label: 'Prep' },
            ]}
          />
          {tab === 'timeline' && (
            <ol className="relative border-l border-line ml-3 space-y-4">
              {timeline.length === 0 && <li className="pl-5 text-ink-3 text-[13px]">No interactions yet.</li>}
              {timeline.slice(0, 100).map((t, i) => (
                <li key={i} className="pl-5">
                  <span className="absolute -left-[9px] w-[18px] h-[18px] rounded-full bg-canvas border border-line text-[10px] inline-flex items-center justify-center text-ink-3">
                    {t.icon}
                  </span>
                  <div className="text-[13.5px]">{t.text}</div>
                  <div className="text-[12px] text-ink-3">
                    {new Date(t.at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {tab === 'facts' && (
            <div className="space-y-4">
              {facts.length === 0 && (
                <p className="text-ink-3 text-[13px]">
                  Nothing yet. Facts come from emails and meeting notes.
                </p>
              )}
              {[...grouped.entries()].map(([type, fs]) => (
                <div key={type}>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1.5">
                    {type.replace('_', ' ')}
                  </div>
                  <ul className="space-y-1.5">
                    {fs.map((f) => (
                      <li key={f.id} className="group flex items-start gap-2 text-[13.5px]">
                        <span className="flex-1">
                          {f.text}{' '}
                          <span className="text-ink-3 text-[12px]">
                            · {f.sourceTable === 'notes' ? 'from notes' : 'from email'}
                            {f.occurredAt ? ` · ${new Date(f.occurredAt).toLocaleDateString()}` : ''}
                          </span>
                        </span>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-bad"
                          title="Delete this fact (it won't come back)"
                          onClick={async () => {
                            await db.facts.update(f.id, { deletedAt: new Date().toISOString() });
                            await feedback(user.id, 'fact_delete', { refTable: 'facts', refId: f.id });
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <AddFact personId={person.id} userId={user.id} />
              {notes.length > 0 && (
                <div>
                  <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1.5">Notes</div>
                  {notes.map((n) => (
                    <details key={n.id} className="border border-line rounded-lg p-3 mb-2">
                      <summary className="cursor-pointer text-[13.5px] font-medium">
                        {n.title}{' '}
                        <span className="text-ink-3 font-normal">
                          · {new Date(n.occurredAt).toLocaleDateString()} · {n.source.replace('_', ' ')}
                        </span>
                      </summary>
                      <p className="text-[13px] text-ink-2 mt-2 whitespace-pre-line">
                        {n.summary ?? n.rawText.slice(0, 600)}
                      </p>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'connections' && (
            <div className="space-y-2">
              {neighbours.filter(Boolean).length === 0 && (
                <p className="text-ink-3 text-[13px]">
                  No inferred connections yet. These appear from shared employers, schools, threads and
                  meetings.
                </p>
              )}
              {edges.map((e) => {
                const other = neighbours.find(
                  (p) => p && p.id === (e.personAId === id ? e.personBId : e.personAId),
                ) as Person | undefined;
                if (!other) return null;
                return (
                  <Link
                    key={e.id}
                    to={`/people/${other.id}`}
                    className="flex items-center gap-3 border border-line rounded-lg p-3 hover:bg-canvas-2/60"
                  >
                    <Avatar name={other.displayName} id={other.id} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-medium">
                        {other.displayName}{' '}
                        <span className="text-ink-3 font-normal">
                          {other.currentOrganizationRaw ? `· ${other.currentOrganizationRaw}` : ''}
                        </span>
                      </div>
                      <div className="text-[12px] text-ink-3">{e.evidence.text ?? e.type}</div>
                    </div>
                    <StrengthDots v={e.weight} />
                  </Link>
                );
              })}
            </div>
          )}
          {tab === 'prep' && (
            <Prep
              person={person}
              facts={facts}
              timeline={timeline.map((t) => `${t.at.slice(0, 10)}: ${t.text}`)}
              items={items}
            />
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <div className="font-medium mb-2">Summary</div>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">{person.summary ?? 'Building…'}</p>
            {person.talkingPoints && person.talkingPoints.length > 0 && (
              <>
                <div className="font-medium mt-4 mb-1.5">Talking points</div>
                <ul className="list-disc pl-4 text-[13.5px] text-ink-2 space-y-1">
                  {person.talkingPoints.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="mt-3 text-[12px] text-ink-3 underline"
              onClick={() => refreshPersonSummary(user, person.id)}
            >
              Refresh
            </button>
          </Card>
          {chat?.warmUp && (
            <Card>
              <div className="font-medium mb-2">LinkedIn warm-up</div>
              <ul className="space-y-2 text-[13px]">
                {chat.warmUp.actions.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span
                      className={cx(
                        'w-4 h-4 rounded-full border inline-flex items-center justify-center text-[10px]',
                        a.doneAt
                          ? 'bg-good border-good text-white'
                          : a.skippedAt
                            ? 'bg-line border-line'
                            : 'border-line',
                      )}
                    >
                      {a.doneAt ? '✓' : ''}
                    </span>
                    <span className={cx('flex-1', (a.doneAt || a.skippedAt) && 'text-ink-3 line-through')}>
                      {a.label}
                    </span>
                    <a href={a.url} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-ink">
                      <ExternalLink size={13} />
                    </a>
                  </li>
                ))}
              </ul>
              <p className="text-[12px] text-ink-3 mt-2">
                Outreach suggested after{' '}
                {new Date(chat.warmUp.readyAt).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                .{' '}
                {person.linkedinSlug && (
                  <a
                    className="underline"
                    href={linkedinActivityUrl(person.linkedinSlug)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Their activity
                  </a>
                )}
              </p>
            </Card>
          )}
          {items.filter((i) => i.status === 'open').length > 0 && (
            <Card>
              <div className="font-medium mb-2">You promised</div>
              <ul className="space-y-1.5 text-[13px]">
                {items
                  .filter((i) => i.status === 'open')
                  .map((i) => (
                    <li key={i.id} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        onChange={() => db.actionItems.update(i.id, { status: 'done' })}
                      />
                      <span className="flex-1">
                        {i.text}
                        {i.dueAt ? <span className="text-ink-3"> · due {relDate(i.dueAt)}</span> : null}
                      </span>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
          {affs.length > 0 && (
            <Card>
              <div className="font-medium mb-2">History</div>
              <ul className="space-y-1.5 text-[13px]">
                {affs
                  .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))
                  .map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">{a.title ?? a.degree ?? a.kind}</span>{' '}
                      <span className="text-ink-2">· {a.nameRaw}</span>
                      {a.startDate ? (
                        <span className="text-ink-3">
                          {' '}
                          · {a.startDate.slice(0, 4)}–{a.isCurrent ? 'now' : (a.endDate?.slice(0, 4) ?? '')}
                        </span>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </Card>
          )}
          {chats.length > 1 && (
            <Card>
              <div className="font-medium mb-2">Past chats</div>
              <ul className="text-[13px] space-y-1">
                {chats.map((c) => (
                  <li key={c.id}>
                    {STAGE_LABELS[c.stage]} · started {new Date(c.createdAt).toLocaleDateString()}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function AddFact({ personId, userId }: { personId: string; userId: string }) {
  const [text, setText] = useState('');
  const [type, setType] = useState<'hook' | 'advice' | 'offer' | 'personal' | 'role_detail' | 'background'>(
    'hook',
  );
  return (
    <div className="flex gap-2 items-center">
      <Select value={type} onChange={(e) => setType(e.target.value as never)} className="h-8 text-[13px]">
        {['hook', 'advice', 'offer', 'personal', 'role_detail', 'background'].map((t) => (
          <option key={t} value={t}>
            {t.replace('_', ' ')}
          </option>
        ))}
      </Select>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a fact you know…"
        className="flex-1 h-8 rounded-lg border border-line px-2.5 text-[13px]"
        onKeyDown={async (e) => {
          if (e.key === 'Enter' && text.trim()) {
            await db.facts.add({
              id: newId('f'),
              userId,
              personId,
              type,
              text: text.trim(),
              sourceTable: 'manual',
              sourceId: 'manual',
              confidence: 1,
              occurredAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });
            setText('');
          }
        }}
      />
    </div>
  );
}

function Prep({
  person,
  facts,
  timeline,
  items,
}: {
  person: Person;
  facts: { type: string; text: string }[];
  timeline: string[];
  items: { text: string; status: string }[];
}) {
  const advice = facts.filter((f) => f.type === 'advice');
  const offers = facts.filter((f) => f.type === 'offer');
  const hooks = facts.filter((f) => f.type === 'hook');
  const role = facts.filter((f) => f.type === 'role_detail' || f.type === 'background');
  const personal = facts.filter((f) => f.type === 'personal');
  const questions = [
    person.currentTitle
      ? `How did you get from ${person.school ?? 'school'} to ${person.currentTitle}${person.currentOrganizationRaw ? ` at ${person.currentOrganizationRaw}` : ''}?`
      : 'How did your path lead you to what you do now?',
    person.currentOrganizationRaw
      ? `What does a strong intern or new grad do in their first 90 days at ${person.currentOrganizationRaw}?`
      : 'What separates the people who do well early from those who struggle?',
    hooks[0]
      ? `You mentioned ${hooks[0].text.replace(/\.$/, '')} — how is that going?`
      : 'What are you most focused on right now?',
    'What would you want to know at my stage that nobody told you?',
    offers[0]
      ? `When would be a good time to follow up on ${offers[0].text.replace(/\.$/, '')}?`
      : 'Is there anyone else you think I should talk to?',
    'What is the best way to be helpful to you?',
  ];
  return (
    <div className="space-y-4 text-[13.5px]">
      <Card>
        <div className="font-medium">Who they are</div>
        <p className="text-ink-2 mt-1">
          {person.headline ??
            [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ') ??
            ''}
          {person.isAlumni ? ' · alum' : ''}
          {person.location ? ` · ${person.location}` : ''}
        </p>
        {role.length > 0 && (
          <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
            {role.slice(0, 4).map((f, i) => (
              <li key={i}>{f.text}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <div className="font-medium">What you discussed before</div>
        {timeline.length ? (
          <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
            {timeline.slice(0, 6).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3 mt-1">First conversation.</p>
        )}
        {advice.length > 0 && (
          <>
            <div className="font-medium mt-3">Advice they gave</div>
            <ul className="list-disc pl-4 mt-1 text-ink-2 space-y-1">
              {advice.map((f, i) => (
                <li key={i}>{f.text}</li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card>
        <div className="font-medium">Questions to ask</div>
        <ol className="list-decimal pl-4 mt-2 text-ink-2 space-y-1">
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      </Card>
      <Card>
        <div className="font-medium">Follow-through from last time</div>
        {items.filter((i) => i.status === 'open').length || offers.length ? (
          <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
            {items
              .filter((i) => i.status === 'open')
              .map((i, k) => (
                <li key={`i${k}`}>You promised: {i.text}</li>
              ))}
            {offers.map((o, k) => (
              <li key={`o${k}`}>They offered: {o.text}</li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3 mt-1">Nothing outstanding.</p>
        )}
        {personal.length > 0 && (
          <>
            <div className="font-medium mt-3">Personal</div>
            <ul className="list-disc pl-4 mt-1 text-ink-2 space-y-1">
              {personal.slice(0, 3).map((f, i) => (
                <li key={i}>{f.text}</li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card>
        <div className="font-medium">Things to avoid</div>
        <ul className="list-disc pl-4 mt-2 text-ink-2 space-y-1">
          <li>Asking for a job in the first conversation.</li>
          <li>Generic praise; reference something specific they said or did.</li>
          <li>Going over the time you asked for.</li>
        </ul>
      </Card>
    </div>
  );
}
