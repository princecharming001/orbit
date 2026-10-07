import { RELATIONSHIP_LABELS, STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AddPersonButton } from '../components/AddPerson';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { db } from '../db/schema';
import { useSession } from '../state/session';
import { Avatar, Chip, EmptyState, Input, PageHeader, relDate, Select } from '../ui';
import { StrengthDots } from './Pipeline';

export function People() {
  const { userId } = useSession();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'alumni' | 'strong' | 'chats' | 'targets' | 'hidden'>('all');
  const [sort, setSort] = useState<'strength' | 'recent' | 'name'>('strength');
  const people =
    useLiveQuery(() => (userId ? db.people.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const chats =
    useLiveQuery(() => (userId ? db.chats.where('userId').equals(userId).toArray() : []), [userId]) ?? [];
  const tcs =
    useLiveQuery(
      () => (userId ? db.targetCompanies.where('userId').equals(userId).toArray() : []),
      [userId],
    ) ?? [];
  const targetNames = useMemo(() => new Set(tcs.map((t) => t.nameRaw.toLowerCase())), [tcs]);
  const activeChat = useMemo(
    () => new Map(chats.filter((c) => c.stage !== 'archived').map((c) => [c.personId, c])),
    [chats],
  );
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return people
      .filter((p) => (filter === 'hidden' ? !!p.hiddenAt : p.isHuman && !p.hiddenAt))
      .filter(
        (p) =>
          !s ||
          p.displayName.toLowerCase().includes(s) ||
          (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
          (p.currentTitle ?? '').toLowerCase().includes(s) ||
          (p.primaryEmail ?? '').includes(s),
      )
      .filter((p) =>
        filter === 'alumni'
          ? p.isAlumni
          : filter === 'strong'
            ? p.strength >= 0.6
            : filter === 'chats'
              ? activeChat.has(p.id)
              : filter === 'targets'
                ? targetNames.has((p.currentOrganizationRaw ?? '').toLowerCase())
                : true,
      )
      .sort((a, b) =>
        sort === 'strength'
          ? b.strength - a.strength
          : sort === 'recent'
            ? (b.lastInteractionAt ?? '').localeCompare(a.lastInteractionAt ?? '')
            : a.displayName.localeCompare(b.displayName),
      );
  }, [people, q, filter, sort, activeChat, targetNames]);
  const total = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  const hiddenCount = people.filter((p) => p.hiddenAt).length;
  const filtered = !!q.trim() || filter !== 'all';
  const shown = Math.min(list.length, 300);
  const role = (p: (typeof list)[number]) =>
    p.relationshipType === 'unknown' || (p.relationshipType === 'alumni' && p.isAlumni)
      ? undefined
      : RELATIONSHIP_LABELS[p.relationshipType];
  return (
    <div>
      <PageHeader
        title="People"
        subtitle={
          filter === 'hidden'
            ? `${list.length} hidden ${list.length === 1 ? 'person' : 'people'}. Open one and choose Unhide to bring them back.`
            : filtered
              ? `${list.length} of ${total} people`
              : `${total} people in your orbit`
        }
        actions={<AddPersonButton />}
      />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, company, title"
          aria-label="Search people"
          className="w-full sm:w-64"
        />
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as never)}
          aria-label="Filter people"
        >
          <option value="all">Everyone</option>
          <option value="alumni">Alumni</option>
          <option value="strong">Close ties</option>
          <option value="chats">With a chat</option>
          <option value="targets">At target companies</option>
          <option value="hidden">Hidden{hiddenCount ? ` (${hiddenCount})` : ''}</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as never)} aria-label="Sort people">
          <option value="strength">By closeness</option>
          <option value="recent">Most recent</option>
          <option value="name">By name</option>
        </Select>
      </div>
      {list.length ? (
        <>
          {/* phones get a list: one person per row, nothing cut mid-word, nothing off to the side */}
          <ul
            className="md:hidden divide-y divide-line border border-line rounded-[var(--radius-card)]"
            data-testid="people-list"
          >
            {list.slice(0, 300).map((p) => {
              const c = activeChat.get(p.id);
              return (
                <li key={p.id}>
                  <Link to={`/people/${p.id}`} className="flex items-start gap-3 p-3 hover:bg-canvas-2/60">
                    <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium">{p.displayName}</span>
                        {p.isAlumni && (
                          <Chip tone="accent" className="h-5">
                            Alum
                          </Chip>
                        )}
                      </span>
                      <span className="block text-[12.5px] text-ink-2">
                        {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') || '—'}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                        <StrengthDots v={p.strength} showValue />
                        {role(p) && <span>{role(p)}</span>}
                        {c && <Chip className="h-5">{STAGE_LABELS[c.stage]}</Chip>}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block border border-line rounded-[var(--radius-card)] overflow-x-auto">
            <table className="w-full text-[13.5px] min-w-[640px]">
              <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
                <tr>
                  {['Name', 'Title · Company', 'Relationship', 'Closeness', 'Last touch', 'Stage'].map(
                    (h) => (
                      <th key={h} className="text-left font-medium px-3 h-9 whitespace-nowrap">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.slice(0, 300).map((p) => {
                  const c = activeChat.get(p.id);
                  return (
                    <tr key={p.id} className="hover:bg-canvas-2/60">
                      <td className="px-3 h-12">
                        <Link
                          to={`/people/${p.id}`}
                          className="inline-flex items-center gap-2.5 font-medium hover:underline whitespace-nowrap"
                        >
                          <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />
                          {p.displayName}
                          {p.isAlumni && (
                            <Chip tone="accent" className="h-5">
                              Alum
                            </Chip>
                          )}
                        </Link>
                      </td>
                      <td className="px-3 text-ink-2 truncate max-w-[220px]">
                        {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 text-ink-2 whitespace-nowrap">{role(p) ?? '—'}</td>
                      <td className="px-3">
                        <StrengthDots v={p.strength} showValue />
                      </td>
                      <td className="px-3 text-ink-2 whitespace-nowrap">{relDate(p.lastInteractionAt)}</td>
                      <td className="px-3">
                        {c ? <Chip>{STAGE_LABELS[c.stage]}</Chip> : <span className="text-ink-3">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.length > shown && (
            <p className="text-[12px] text-ink-3 mt-2">
              Showing the first {shown}. Search to find someone further down.
            </p>
          )}
        </>
      ) : total === 0 && filter !== 'hidden' ? (
        <EmptyState
          title="No one here yet"
          body="Add the people you want to talk to, or import your LinkedIn connections to bring everyone in at once."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <AddPersonButton variant="primary" />
              <LinkedInImportButton />
              <Link
                to="/settings/integrations"
                className="self-center text-[13px] text-ink-3 underline underline-offset-2 hover:text-ink"
              >
                How to get the LinkedIn file
              </Link>
            </div>
          }
        />
      ) : (
        <EmptyState title={filter === 'hidden' ? 'Nobody is hidden' : 'Nobody matches'} />
      )}
    </div>
  );
}
