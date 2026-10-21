import type { Person, Suggestion } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef } from 'react';
import { db } from '../db/schema';
import { Avatar, Chip, cx } from '../ui';
import { PersonCompanyLogo } from './CompanyLogo';
import { gapLabel, KIND_LABEL, SuggestionCard } from './SuggestionCard';

export interface DraftGroup {
  label: string;
  items: Suggestion[];
}

/**
 * Drafts on a wide screen: every card as one skimmable row on the left, and the one picked open on the right, its
 * draft ready to edit and send. Arrow keys (or j and k) move down the list; when a card is sent, snoozed or
 * dismissed the next one opens.
 */
export function DraftsSplit({
  groups,
  selectedId,
  onSelect,
  byId,
}: {
  groups: DraftGroup[];
  selectedId?: string;
  onSelect: (id: string) => void;
  byId: Map<string, Person>;
}) {
  const all = groups.flatMap((g) => g.items);
  const selected = all.find((s) => s.id === selectedId) ?? all[0];
  const listRef = useRef<HTMLDivElement>(null);
  // the list moves with the keyboard, unless the student is typing in the draft
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
      if (!step || !selected) return;
      const i = all.findIndex((s) => s.id === selected.id);
      const next = all[Math.max(0, Math.min(all.length - 1, i + step))];
      if (!next || next.id === selected.id) return;
      e.preventDefault();
      onSelect(next.id);
      listRef.current
        ?.querySelector(`[data-row="${next.id}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div
      className="grid grid-cols-[minmax(280px,360px)_minmax(0,1fr)] gap-5 items-start"
      data-testid="drafts-split"
    >
      <div ref={listRef} className="min-w-0 space-y-4" role="listbox" aria-label="Drafts">
        {groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.label}>
              <div className="text-[11.5px] uppercase tracking-wide text-ink-3 mb-1.5 px-1 flex items-center gap-2">
                {g.label}
                <span className="tabular">{g.items.length}</span>
              </div>
              <ul className="rounded-[var(--radius-card)] border border-line bg-canvas divide-y divide-line-2 overflow-hidden">
                {g.items.map((s) => (
                  <DraftRow
                    key={s.id}
                    s={s}
                    person={s.personId ? byId.get(s.personId) : undefined}
                    active={s.id === selected?.id}
                    onSelect={() => onSelect(s.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        <p className="text-[11.5px] text-ink-3 px-1">↑ ↓ or j k to move through them.</p>
      </div>
      <div
        // the open card stays in view while the list scrolls
        className="min-w-0 sticky top-4"
        data-testid="drafts-reading"
      >
        {selected && <SuggestionCard key={selected.id} s={selected} defaultOpen />}
      </div>
    </div>
  );
}

function DraftRow({
  s,
  person,
  active,
  onSelect,
}: {
  s: Suggestion;
  person?: Person;
  active: boolean;
  onSelect: () => void;
}) {
  const draft = useLiveQuery(
    () => (s.outboundMessageId ? db.outbound.get(s.outboundMessageId) : undefined),
    [s.outboundMessageId],
  );
  const meta = KIND_LABEL[s.kind];
  const body = draft ? (draft.bodyFinal ?? draft.bodyDraft) : '';
  const gap = body ? gapLabel(body) : undefined;
  return (
    <li data-row={s.id}>
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        className={cx(
          'w-full text-left flex items-start gap-2.5 px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:bg-canvas-2',
          active ? 'bg-accent-soft/60' : 'hover:bg-canvas-2',
        )}
        data-testid="drafts-row"
      >
        {person ? (
          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={30} />
        ) : (
          <span className="w-[30px] h-[30px] rounded-full bg-canvas-2 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cx('text-[13.5px] truncate', active ? 'font-semibold' : 'font-medium')}>
              {person?.displayName ?? meta.label}
            </span>
            {person && <PersonCompanyLogo person={person} size={14} />}
          </span>
          <span className="flex items-center gap-1.5 mt-0.5">
            <Chip tone={meta.tone} className="h-[18px] text-[10.5px] px-1.5 shrink-0">
              {meta.label}
            </Chip>
            <span className="text-[12px] text-ink-3 truncate">{s.reasonText}</span>
          </span>
          {gap && (
            <span className="block text-[11.5px] text-warn mt-0.5 truncate" data-testid="drafts-row-gap">
              Needs a line: {gap}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
