/**
 * The student's word on one hop (plan 21 §3.5): "Not right?" opens two answers inline — they don't really know each
 * other (the pair is never a hop again until undone) or they're close — and a pair the student has spoken about
 * says so, with an undo. Inline rather than a popover, so it works the same by touch and in a narrow panel.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../../db/schema';
import { clearPairNote, setPairNote } from '../../engine/pairNotes';
import { cx } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';
const link = cx('text-ink-3 underline underline-offset-4 hover:text-ink', TAP);

export function PairNoteMenu({
  userId,
  aId,
  bId,
  aName,
  bName,
  className,
  named,
}: {
  userId: string;
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  className?: string;
  /** say which pair on the closed link (a route with several hops shows one per hop) */
  named?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [x, y] = aId < bId ? [aId, bId] : [bId, aId];
  const note = useLiveQuery(
    async () =>
      (await db.pairNotes.get(`${userId}:${x}|${y}:blocked`))?.kind ??
      (await db.pairNotes.get(`${userId}:${x}|${y}:close`))?.kind,
    [userId, x, y],
  );
  if (note)
    return (
      <span className={cx('text-[12px] text-ink-3', className)} data-testid="pair-note">
        {note === 'close'
          ? `You said ${aName} and ${bName} are close. `
          : `You said ${aName} and ${bName} don't really know each other. `}
        <button
          type="button"
          className={link}
          onClick={() => void clearPairNote(userId, aId, bId, note)}
          data-testid="pair-note-undo"
        >
          Undo
        </button>
      </span>
    );
  if (!open)
    return (
      <button
        type="button"
        className={cx('text-[12px]', link, className)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-expanded={false}
        data-testid="pair-note-open"
      >
        {named ? `Not right about ${aName} and ${bName}?` : 'Not right?'}
      </button>
    );
  return (
    <span
      className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]', className)}
      data-testid="pair-note-choices"
    >
      <span className="text-ink-3">
        {aName} and {bName}:
      </span>
      <button
        type="button"
        className={link}
        onClick={(e) => {
          e.stopPropagation();
          void setPairNote(userId, aId, bId, 'blocked');
        }}
        data-testid="pair-note-blocked"
      >
        don't really know each other
      </button>
      <button
        type="button"
        className={link}
        onClick={(e) => {
          e.stopPropagation();
          void setPairNote(userId, aId, bId, 'close');
        }}
        data-testid="pair-note-close"
      >
        are close
      </button>
      <button
        type="button"
        className={link}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
}
