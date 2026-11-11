/**
 * Plan 40: where Orbit stands, always one glance away. In the sidebar a quiet chip ("Syncing · 62%", then "Ready")
 * opens the checklist; at the top of the chat a slim line says what is still coming in while it does; and when it
 * finishes in front of the student, a toast says so once. Contractbook keeps "Importing… (33%)" in its top bar the
 * same way; HubSpot and Clay say they will email when it is done.
 */
import { progressLabel } from '@orbit/core';
import { ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onBecameReady, useReadiness, watchReadiness } from '../../state/readiness';
import { cx, useToast } from '../../ui';
import { ProgressRing, ReadyChecklist } from './ReadyChecklist';

/** Starts the watch for the whole app and says "Orbit is ready" when it happens in front of the student. */
export function ReadinessWatch() {
  const toast = useToast();
  const nav = useNavigate();
  useEffect(() => watchReadiness(), []);
  useEffect(
    () =>
      onBecameReady(() =>
        toast.push({
          text: 'Orbit is ready. Your network is in and your first suggestions are waiting.',
          tone: 'good',
          ttl: 12_000,
          action: { label: 'See who to reach out to', onClick: () => nav('/inbox') },
        }),
      ),
    [toast, nav],
  );
  return null;
}

/** The chip in the sidebar; `compact` is the narrow rail (a mark alone, the words in its tooltip). */
export function ReadinessChip({ compact, className }: { compact?: boolean; className?: string }) {
  const v = useReadiness();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!v || v.readiness.state === 'nothing') return null;
  const r = v.readiness;
  const ready = r.state === 'ready';
  const label = ready
    ? 'Ready'
    : r.state === 'problem'
      ? 'Needs you'
      : r.state === 'usable'
        ? `Finishing · ${progressLabel(r)}`
        : `Syncing · ${progressLabel(r)}`;
  const mark = ready ? (
    <span className="inline-block h-2 w-2 rounded-full bg-good" aria-hidden />
  ) : r.state === 'problem' ? (
    <span className="inline-block h-2 w-2 rounded-full bg-warn" aria-hidden />
  ) : (
    <ProgressRing value={r.progress} className="text-accent" />
  );
  return (
    <div ref={box} className={cx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Setup: ${r.headline}`}
        title={compact ? `${r.headline} · ${label}` : undefined}
        className={cx(
          'group inline-flex items-center gap-2 rounded-full text-[12.5px] text-ink-2 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          compact ? 'h-9 w-9 justify-center' : 'h-8 px-2.5 -ml-0.5',
        )}
        data-testid="readiness-chip"
        data-state={r.state}
      >
        {mark}
        {!compact && <span className="tabular-nums">{label}</span>}
        {!compact && (
          <ChevronDown
            size={13}
            className={cx('text-ink-3 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Setup progress"
          className={cx(
            'pop-in absolute z-[80] bottom-full mb-2 w-[330px] rounded-[var(--radius-card)] border border-line bg-canvas p-4 shadow-[var(--shadow-card)]',
            compact ? 'left-full ml-2 bottom-0 mb-0' : 'left-0',
          )}
          data-testid="readiness-panel"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:bg-canvas-2 hover:text-ink"
            aria-label="Close"
          >
            <X size={14} />
          </button>
          <ReadyChecklist readiness={r} notify={v.notify} className="pr-5" />
        </div>
      )}
    </div>
  );
}

/**
 * The slim line at the top of the chat while the import runs: what is coming in, how far along, and a fold that
 * opens the checklist. Gone once Orbit is ready.
 */
export function ReadinessBanner({ className }: { className?: string }) {
  const v = useReadiness();
  const [open, setOpen] = useState(false);
  if (!v) return null;
  const r = v.readiness;
  if (r.state === 'ready' || r.state === 'nothing') return null;
  const lead =
    r.state === 'usable'
      ? 'Orbit is ready to use and still finishing'
      : r.state === 'problem'
        ? r.headline
        : `${r.headline}. Answers get sharper as it comes in`;
  return (
    <div
      className={cx('w-full border-y border-line py-2.5', className)}
      data-testid="readiness-banner"
      data-state={r.state}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left text-[13px] text-ink-2 hover:text-ink"
      >
        {r.state === 'problem' ? (
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
        ) : (
          <ProgressRing value={r.progress} className="text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate">{lead}</span>
        {r.state !== 'problem' && (
          <span className="shrink-0 tabular-nums text-ink-3">{progressLabel(r)}</span>
        )}
        <ChevronDown
          size={14}
          className={cx('shrink-0 text-ink-3 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      <div
        className={cx(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <ReadyChecklist readiness={r} notify={v.notify} title={false} className="pt-1 pb-1 pl-[26px]" />
        </div>
      </div>
    </div>
  );
}
