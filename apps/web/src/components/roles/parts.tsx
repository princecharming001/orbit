/**
 * The small pieces every Roles view shares: the fit ("78" with a short bar, its parts on hover or tap), the path
 * (who the student knows there), and the "Not for me" reasons.
 */
import type { DismissReason, RoleMatch } from '@orbit/core';
import { Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BAND_WORDS, DISMISS_REASONS, partWords, type RolePath } from '../../engine/roles';
import { Avatar, cx } from '../../ui';
import { Bars } from '../../ui/table';

/** A score's bar, filled to the score out of 100, in the band's tone. */
export function FitBar({ score, className }: { score: number; className?: string }) {
  return (
    <span
      className={cx(
        'relative inline-block h-[5px] w-10 shrink-0 overflow-hidden rounded-full bg-line',
        className,
      )}
      aria-hidden
    >
      <span
        className={cx(
          'absolute inset-y-0 left-0 rounded-full',
          score >= 65 ? 'bg-accent' : score >= 50 ? 'bg-warn' : 'bg-ink-3',
        )}
        style={{ width: `${score}%` }}
      />
    </span>
  );
}

/** A part of the score, 0 to 1, as a bar. */
export function PartBar({ value }: { value?: number }) {
  return (
    <span className="relative inline-block h-[5px] w-full overflow-hidden rounded-full bg-line" aria-hidden>
      {value !== undefined && (
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      )}
    </span>
  );
}

/** "78" and its bar; the parts in words on hover, and on a tap. A role not read closely has no number. */
export function FitCell({ match, stretch }: { match: RoleMatch; stretch?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!match.fit)
    return (
      <span
        className="text-[12.5px] text-ink-3"
        title="Orbit could not read this role closely yet. It is ranked by what can be read without that: the level, the place and skills by word."
        data-testid="role-fit-rough"
      >
        Not read closely yet
      </span>
    );
  const f = match.fit;
  const parts = partWords(match);
  const words = [
    `${f.score} out of 100: ${BAND_WORDS[f.band]}.`,
    ...parts.map((p) => `${p.name}: ${p.value === undefined ? 'left out. ' : ''}${p.words}`),
    ...f.caps.map((c) => c.label),
  ].join('\n');
  return (
    <span ref={box} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex items-center gap-2 rounded-[6px] px-1 -mx-1 py-0.5 tabular-nums hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        title={words}
        aria-expanded={open}
        aria-label={`Fit ${f.score} out of 100, ${BAND_WORDS[f.band]}. Show the parts`}
        data-testid="role-fit"
        data-score={f.score}
      >
        <span className="font-medium">{f.score}</span>
        <span className="hidden @[36rem]:inline-flex">
          <FitBar score={f.score} />
        </span>
        {stretch && <span className="text-[12px] text-ink-3">Stretch</span>}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Why this score"
          className="absolute left-0 top-full z-30 mt-1 w-[300px] rounded-[10px] border border-line bg-canvas p-3 text-left shadow-[0_12px_32px_rgba(20,20,15,0.10)] whitespace-normal"
          data-testid="role-fit-parts"
        >
          <span className="block text-[13px] font-medium">
            {f.score} out of 100, {(BAND_WORDS[f.band] ?? '').toLowerCase()}
          </span>
          <span className="mt-2 block space-y-2">
            {parts.map((p) => (
              <span key={p.part} className="block">
                <span className="flex items-center gap-2 text-[12px] text-ink-2">
                  <span className="w-[74px] shrink-0">{p.name}</span>
                  <PartBar value={p.value} />
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">{p.words}</span>
              </span>
            ))}
          </span>
          {f.caps.length > 0 && (
            <span className="mt-2 block text-[12px] text-bad">{f.caps.map((c) => c.label).join('. ')}</span>
          )}
          <span className="mt-2 block text-[11.5px] leading-snug text-ink-3">
            Fit on paper: how well what you wrote matches what the posting asks. Not a chance of an offer.
          </span>
        </span>
      )}
    </span>
  );
}

const CLOSE_WORDS = ['No tie yet', 'A light tie', 'A warm tie', 'A strong tie', 'A close tie'];

/** "Priya Shah and 2 more" with the closeness bars, "2 alumni", or "No one yet". */
export function PathCell({ path, compact }: { path: RolePath; compact?: boolean }) {
  const first = path.known[0];
  if (first) {
    const more = path.known.length - 1;
    const words = `${CLOSE_WORDS[first.level] ?? CLOSE_WORDS[1]} with ${first.name}${more ? `, and ${more} more you know there` : ''}`;
    return (
      <span className="flex min-w-0 items-center gap-2" data-testid="role-path" data-kind="known">
        {!compact && <Avatar name={first.name} src={first.photoUrl} id={first.id} size={20} />}
        <span className="min-w-0 truncate">
          <Link to={`/people/${first.id}`} className="font-medium hover:underline" title={words}>
            {first.name}
          </Link>
          {more > 0 && <span className="text-ink-3"> and {more} more</span>}
        </span>
        <Bars level={first.level} label={words} testId="role-path-bars" />
      </span>
    );
  }
  if (path.alumni.length)
    return (
      <span
        className="flex min-w-0 items-center gap-2 text-ink-2"
        data-testid="role-path"
        data-kind="alumni"
        title={path.alumni.map((a) => a.name).join(', ')}
      >
        {!compact && (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-canvas-2 text-ink-3">
            <Users size={11} aria-hidden />
          </span>
        )}
        {path.alumni.length} {path.alumni.length === 1 ? 'alum' : 'alumni'}
      </span>
    );
  return (
    <span className="text-ink-3" data-testid="role-path" data-kind="none">
      No one yet
    </span>
  );
}

/** "Not for me", with why: the reason tunes later results. */
export function DismissMenu({
  onPick,
  onClose,
  className,
}: {
  onPick: (reason: DismissReason) => void;
  onClose: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    box.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div
      ref={box}
      role="menu"
      aria-label="Why not for you"
      className={cx(
        'z-40 w-[240px] rounded-[10px] border border-line bg-canvas p-1 text-left shadow-[0_12px_32px_rgba(20,20,15,0.10)]',
        className,
      )}
      data-testid="role-dismiss-menu"
    >
      <p className="px-2.5 pb-1 pt-1.5 text-[12px] text-ink-3">Not for me, because</p>
      {DISMISS_REASONS.map((r) => (
        <button
          key={r.value}
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation();
            onPick(r.value);
          }}
          className="block w-full rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-canvas-2 hover:text-ink focus-visible:bg-canvas-2 focus-visible:outline-none"
          data-testid={`role-dismiss-${r.value}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export const STATUS_WORDS: Record<RoleMatch['status'], string> = {
  new: 'New',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  dismissed: 'Not for me',
};
