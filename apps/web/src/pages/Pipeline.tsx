import type { ChatStage, CoffeeChat, Person } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { KIND_LABEL } from '../components/SuggestionCard';
import { db } from '../db/schema';
import { applyStage } from '../engine/stages';
import { useSession } from '../state/session';
import { Avatar, Button, Chip, cx, EmptyState, Input, PageHeader, relDate, Select, Tabs } from '../ui';

export const STAGE_COLOR: Record<ChatStage, string> = {
  identified: '#9aa1ad',
  warming: '#b7791f',
  outreach_sent: '#5b5bd6',
  replied: '#1f8a4c',
  scheduling: '#5b5bd6',
  scheduled: '#1f8a4c',
  completed: '#1f8a4c',
  followed_up: '#1f8a4c',
  nurturing: '#3f4650',
  declined: '#c43d3d',
  no_response: '#9aa1ad',
  archived: '#c7cbd3',
};

export function Pipeline() {
  const { userId, user } = useSession();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as 'board' | 'table' | 'companies') ?? 'board';
  const [q, setQ] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [onlyTargets, setOnlyTargets] = useState(false);
  const nav = useNavigate();
  const chats =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const suggestions =
    useLiveQuery(
      () =>
        userId
          ? db.suggestions
              .where('userId')
              .equals(userId)
              .filter((s) => s.status === 'pending')
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const tcs =
    useLiveQuery(
      () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
      [userId],
    ) ?? [];
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const targetNames = useMemo(() => new Set(tcs.map((t) => t.nameRaw.toLowerCase())), [tcs]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return chats
      .map((c) => ({ chat: c, person: byId.get(c.personId) }))
      .filter(
        (r): r is { chat: CoffeeChat; person: Person } =>
          !!r.person && r.person.isHuman && !r.person.hiddenAt,
      )
      .filter(
        (r) =>
          !s ||
          r.person.displayName.toLowerCase().includes(s) ||
          (r.person.currentOrganizationRaw ?? '').toLowerCase().includes(s),
      )
      .filter((r) => !onlyTargets || targetNames.has((r.person.currentOrganizationRaw ?? '').toLowerCase()))
      .sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt));
  }, [chats, byId, q, onlyTargets, targetNames]);
  const nextFor = (chatId: string, personId: string) =>
    suggestions.find((s) => s.chatId === chatId || (s.personId === personId && !s.chatId));
  const move = async (chat: CoffeeChat, to: ChatStage) => {
    await applyStage(chat, to, 'user', 'user:drag');
  };
  const stages: ChatStage[] = showClosed ? [...ACTIVE_STAGES, ...CLOSED_STAGES] : ACTIVE_STAGES;
  return (
    <div>
      <PageHeader
        title="Pipeline"
        subtitle="Every coffee chat, in the stage Orbit inferred from your email and calendar."
        actions={
          <Link to="/discover">
            <Button variant="primary">Start a new chat</Button>
          </Link>
        }
      />
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Tabs
          value={view}
          onChange={(v) => setParams({ view: v })}
          items={[
            { value: 'board', label: 'Board' },
            { value: 'table', label: 'Table' },
            { value: 'companies', label: 'Companies' },
          ]}
        />
        <div className="sm:ml-auto flex flex-wrap items-center gap-2 sm:-mt-4 w-full sm:w-auto">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or company"
            aria-label="Search chats by name or company"
            className="w-full sm:w-56"
          />
          <label className="text-[13px] inline-flex items-center gap-1.5">
            <input type="checkbox" checked={onlyTargets} onChange={(e) => setOnlyTargets(e.target.checked)} />{' '}
            Targets only
          </label>
          <label className="text-[13px] inline-flex items-center gap-1.5">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />{' '}
            Show closed
          </label>
        </div>
      </div>
      {view === 'board' && (
        <div className="flex gap-3 overflow-x-auto pb-4 scroll-thin -mx-4 px-4 md:mx-0 md:px-0">
          {stages.map((stage) => {
            const items = rows.filter((r) => r.chat.stage === stage);
            return (
              <div
                key={stage}
                className="w-[240px] shrink-0"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/chat');
                  const c = chats.find((x) => x.id === id);
                  if (c) move(c, stage);
                }}
              >
                <div className="flex items-center gap-2 mb-2 px-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: STAGE_COLOR[stage] }} />
                  <span className="text-[13px] font-medium">{STAGE_LABELS[stage]}</span>
                  <span className="text-[12px] text-ink-3 tabular">{items.length}</span>
                </div>
                <div className="space-y-2 min-h-[80px] rounded-[12px] bg-canvas-2/70 p-2">
                  {items.map(({ chat, person }) => {
                    const next = nextFor(chat.id, person.id);
                    return (
                      <div
                        key={chat.id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/chat', chat.id)}
                        className="relative bg-canvas border border-line rounded-[10px] p-3 hover:shadow-[var(--shadow-card)] focus-within:ring-2 focus-within:ring-accent/40 transition-shadow"
                        data-testid={`chat-card-${stage}`}
                      >
                        <div className="flex items-center gap-2">
                          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={28} />
                          <div className="min-w-0">
                            {/* The name link stretches over the whole card, so the card is one tab stop and opens on Enter. */}
                            <Link
                              to={`/people/${person.id}`}
                              className="block text-[13.5px] font-medium truncate focus:outline-none after:absolute after:inset-0 after:content-['']"
                            >
                              {person.displayName}
                            </Link>
                            <div className="text-[12px] text-ink-3 truncate">
                              {[person.currentTitle, person.currentOrganizationRaw]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-3">
                          <span>{daysLabel(chat.stageEnteredAt)} in stage</span>
                          {next && (
                            <Chip tone="accent" className="h-5">
                              {KIND_LABEL[next.kind].label}
                            </Chip>
                          )}
                        </div>
                        {chat.warmUp && stage === 'warming' && (
                          <div className="mt-2 h-1 rounded bg-line">
                            <div
                              className="h-1 rounded bg-warn"
                              style={{
                                width: `${(chat.warmUp.actions.filter((a) => a.doneAt).length / chat.warmUp.actions.length) * 100}%`,
                              }}
                            />
                          </div>
                        )}
                        <select
                          value=""
                          onChange={(e) => e.target.value && move(chat, e.target.value as ChatStage)}
                          className="relative z-10 mt-2 h-7 w-full rounded-md border border-line bg-canvas px-1.5 text-[12px] text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
                          aria-label={`Move ${person.displayName} to another stage`}
                          data-testid="chat-card-move"
                        >
                          <option value="" disabled>
                            Move to…
                          </option>
                          {[...ACTIVE_STAGES, ...CLOSED_STAGES]
                            .filter((s) => s !== chat.stage)
                            .map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABELS[s]}
                              </option>
                            ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {view === 'table' &&
        (rows.length ? (
          <div className="border border-line rounded-[var(--radius-card)] overflow-x-auto">
            <table className="w-full text-[13.5px] min-w-[760px]">
              <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
                <tr>
                  {[
                    'Person',
                    'Company',
                    'Stage',
                    'In stage',
                    'Last sent',
                    'Last reply',
                    'Next',
                    'Closeness',
                  ].map((h) => (
                    <th key={h} className="text-left font-medium px-3 h-9">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows
                  .filter((r) => showClosed || !CLOSED_STAGES.includes(r.chat.stage))
                  .map(({ chat, person }) => {
                    const next = nextFor(chat.id, person.id);
                    return (
                      <tr
                        key={chat.id}
                        className="hover:bg-canvas-2/60 cursor-pointer"
                        onClick={() => nav(`/people/${person.id}`)}
                      >
                        <td className="px-3 h-11">
                          <span className="inline-flex items-center gap-2">
                            <Avatar name={person.displayName} id={person.id} size={24} />{' '}
                            <Link
                              to={`/people/${person.id}`}
                              className="font-medium hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {person.displayName}
                            </Link>
                          </span>
                        </td>
                        <td className="px-3 text-ink-2">{person.currentOrganizationRaw ?? '—'}</td>
                        <td className="px-3" onClick={(e) => e.stopPropagation()}>
                          <Select
                            value={chat.stage}
                            onChange={(e) => move(chat, e.target.value as ChatStage)}
                            className="h-7 text-[12px]"
                            aria-label={`Stage for ${person.displayName}`}
                          >
                            {[...ACTIVE_STAGES, ...CLOSED_STAGES].map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABELS[s]}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-3 tabular text-ink-2 whitespace-nowrap">
                          {daysLabel(chat.stageEnteredAt)}
                        </td>
                        <td className="px-3 text-ink-2">{relDate(chat.lastOutboundAt)}</td>
                        <td className="px-3 text-ink-2">{relDate(chat.lastInboundAt)}</td>
                        <td className="px-3">
                          {next ? (
                            <Chip tone="accent">{KIND_LABEL[next.kind].label}</Chip>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="px-3">
                          <StrengthDots v={person.strength} />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No chats yet"
            body="Start one from Discover or let Orbit detect them from your email."
          />
        ))}
      {view === 'companies' && <CompaniesView rows={rows} targetNames={targetNames} />}
      {user && rows.length === 0 && view === 'board' && (
        <p className="text-[13px] text-ink-3 mt-2">
          No chats match. Start one from{' '}
          <Link className="underline" to="/discover">
            Discover
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function daysLabel(since: string): string {
  const d = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));
  return d === 0 ? 'Under a day' : d === 1 ? '1 day' : `${d} days`;
}

export function StrengthDots({ v, label = 'Closeness' }: { v: number; label?: string }) {
  const n = v >= 0.6 ? 4 : v >= 0.4 ? 3 : v >= 0.2 ? 2 : v > 0.02 ? 1 : 0;
  const text = `${label} ${Math.round(v * 100)} of 100`;
  return (
    <span className="inline-flex gap-0.5" title={text} role="img" aria-label={text}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={cx('w-1.5 h-1.5 rounded-full', i < n ? 'bg-accent' : 'bg-line')} />
      ))}
    </span>
  );
}

function CompaniesView({
  rows,
  targetNames,
}: {
  rows: { chat: CoffeeChat; person: Person }[];
  targetNames: Set<string>;
}) {
  const groups = new Map<
    string,
    { name: string; orgId?: string; people: Set<string>; byStage: Map<ChatStage, number>; last?: string }
  >();
  for (const { chat, person } of rows) {
    const key = person.currentOrganizationId ?? person.currentOrganizationRaw ?? 'Independent';
    const g = groups.get(key) ?? {
      name: person.currentOrganizationRaw ?? 'Independent',
      orgId: person.currentOrganizationId,
      people: new Set(),
      byStage: new Map(),
      last: undefined,
    };
    g.people.add(person.id);
    g.byStage.set(chat.stage, (g.byStage.get(chat.stage) ?? 0) + 1);
    if (!g.last || chat.updatedAt > g.last) g.last = chat.updatedAt;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.people.size - a.people.size);
  if (!list.length) return <EmptyState title="No companies yet" />;
  return (
    <div className="border border-line rounded-[var(--radius-card)] overflow-x-auto">
      <table className="w-full text-[13.5px] min-w-[560px]">
        <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
          <tr>
            {['Company', 'People', 'Stages', 'Target', 'Last activity'].map((h) => (
              <th key={h} className="text-left font-medium px-3 h-9">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {list.map((g) => (
            <tr key={g.name}>
              <td className="px-3 h-11 font-medium">
                {g.orgId ? (
                  <Link to={`/companies/${g.orgId}`} className="hover:underline">
                    {g.name}
                  </Link>
                ) : (
                  g.name
                )}
              </td>
              <td className="px-3 tabular">{g.people.size}</td>
              <td className="px-3">
                <span className="flex flex-wrap gap-1">
                  {[...g.byStage.entries()].map(([s, n]) => (
                    <Chip key={s}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: STAGE_COLOR[s] }} />
                      {STAGE_LABELS[s]} {n}
                    </Chip>
                  ))}
                </span>
              </td>
              <td className="px-3">
                {targetNames.has(g.name.toLowerCase()) ? (
                  <Chip tone="accent">Target</Chip>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </td>
              <td className="px-3 text-ink-2">{relDate(g.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
