import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { useSession } from '../state/session';
import { Avatar, cx, Modal } from '../ui';

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { userId } = useSession();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  const people =
    useLiveQuery(
      () =>
        userId
          ? db.people
              .where('userId')
              .equals(userId)
              .filter((p) => p.isHuman && !p.hiddenAt)
              .toArray()
          : [],
      [userId],
    ) ?? [];
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const actions = [
      { kind: 'action', id: 'today', label: 'Go to Today', to: '/today' },
      { kind: 'action', id: 'note', label: 'Add a note', to: '/notes/new' },
      { kind: 'action', id: 'map', label: 'Open the map', to: '/map' },
      { kind: 'action', id: 'reach', label: 'Find someone who can introduce you', to: '/map?reach=1' },
      { kind: 'action', id: 'discover', label: 'Discover people to meet', to: '/discover' },
      { kind: 'action', id: 'settings', label: 'Settings', to: '/settings' },
    ].filter((a) => !s || a.label.toLowerCase().includes(s));
    const ppl = (
      s
        ? people.filter(
            (p) =>
              p.displayName.toLowerCase().includes(s) ||
              (p.currentOrganizationRaw ?? '').toLowerCase().includes(s) ||
              (p.currentTitle ?? '').toLowerCase().includes(s),
          )
        : people.slice().sort((a, b) => b.strength - a.strength)
    ).slice(0, 8);
    return [
      ...ppl.map((p) => ({
        kind: 'person' as const,
        id: p.id,
        label: p.displayName,
        sub: [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' · '),
        to: `/people/${p.id}`,
        person: p,
      })),
      ...actions.map((a) => ({ ...a, kind: 'action' as const, sub: undefined, person: undefined })),
    ];
  }, [q, people]);
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => ref.current?.focus(), 10);
    }
  }, [open]);
  const go = (to: string) => {
    onClose();
    nav(to);
  };
  return (
    <Modal open={open} onClose={onClose} title="Search people and actions" width={560}>
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((i) => Math.min(i + 1, results.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((i) => Math.max(i - 1, 0));
          }
          if (e.key === 'Enter' && results[idx]) go(results[idx]!.to);
        }}
        placeholder="Type a name, a company they work at, or an action…"
        className="w-full h-10 rounded-lg border border-line px-3 text-[14px] focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <ul className="mt-3 max-h-[360px] overflow-y-auto scroll-thin -mx-2">
        {results.map((r, i) => (
          <li key={`${r.kind}-${r.id}`}>
            <button
              onMouseEnter={() => setIdx(i)}
              onClick={() => go(r.to)}
              className={cx(
                'w-full text-left px-2 h-11 rounded-lg flex items-center gap-3',
                i === idx ? 'bg-canvas-2' : '',
              )}
            >
              {r.kind === 'person' && r.person ? (
                <Avatar name={r.label} id={r.id} size={26} />
              ) : (
                <span className="w-[26px] h-[26px] rounded-md bg-accent-soft text-accent inline-flex items-center justify-center text-[12px] font-semibold">
                  →
                </span>
              )}
              <span className="flex-1 min-w-0">
                <span className="block truncate">{r.label}</span>
                {r.sub && <span className="block text-[12px] text-ink-3 truncate">{r.sub}</span>}
              </span>
            </button>
          </li>
        ))}
        {!results.length && <li className="px-2 py-6 text-center text-ink-3 text-[13px]">No matches</li>}
      </ul>
    </Modal>
  );
}
