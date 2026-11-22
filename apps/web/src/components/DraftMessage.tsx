import type { OutboundMessage, Person } from '@orbit/core';
import { CHANNEL_LABELS, draftKindLabel } from '@orbit/core';
import { ChevronDown } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { discardDraft, restoreDraft } from '../engine/drafts';
import { lastTouch } from '../engine/search';
import { useSession } from '../state/session';
import { Avatar, Chip, cx, relDate, useToast } from '../ui';
import { runApproval } from './approve';
import { PersonCompanyLogo } from './CompanyLogo';
import { DraftEditor } from './DraftEditor';

/**
 * A message in Drafts' To send list that belongs to no card: a draft the student started on a person's page, or a
 * message opened in the mail app or LinkedIn that waits for "I sent it". Closed, it is one compact row like the
 * cards' rows (who, what kind, the start of the text); open, it is the editor with Send, or the "I sent it" step.
 */

/**
 * Which rows of the list are open: a row the student has not touched is open only while it waits for "I sent it"
 * (that needs them), and opening a draft closes the other open drafts, so one editor is open at a time.
 */
export function useOpenRows(messages: Pick<OutboundMessage, 'id' | 'status'>[]) {
  const [rows, setRows] = useState<Record<string, boolean>>({});
  const isOpen = (o: Pick<OutboundMessage, 'id' | 'status'>, from = rows) =>
    from[o.id] ?? o.status === 'handed_off';
  const setOpen = (o: Pick<OutboundMessage, 'id' | 'status'>, open: boolean) =>
    setRows((was) => {
      const next = { ...was, [o.id]: open };
      if (open)
        for (const m of messages)
          if (m.id !== o.id && m.status === 'draft' && isOpen(m, was)) next[m.id] = false;
      return next;
    });
  return { isOpen, setOpen };
}

/** "started 4 days ago" for a draft, "opened 2 hours ago" for one waiting for I sent it. */
function when(o: OutboundMessage): string {
  return o.status === 'draft'
    ? `started ${relDate(o.createdAt)}`
    : `opened ${relDate(o.approvedAt ?? o.createdAt)}`;
}

/** The start of the message on one line: the blank line after "Hi Dana," does not push the words out of view. */
function preview(o: OutboundMessage): string {
  return (o.bodyFinal ?? o.bodyDraft).replace(/\s+/g, ' ').trim();
}

/** The kind of message, and the channel where it is not email (where it goes changes what Send does). */
function Chips({ o, person }: { o: OutboundMessage; person?: Person }) {
  return (
    <>
      <Chip className="h-[18px] text-[10.5px] px-1.5 shrink-0">
        {draftKindLabel(o.kind, person && lastTouch(person))}
      </Chip>
      {o.channel !== 'gmail' && (
        <Chip className="h-[18px] text-[10.5px] px-1.5 shrink-0">{CHANNEL_LABELS[o.channel]}</Chip>
      )}
    </>
  );
}

/** Drop a draft, with Undo in the toast. */
function useDiscard(o: OutboundMessage) {
  const toast = useToast();
  return async () => {
    await discardDraft(o.id);
    toast.push({
      text: 'Draft discarded.',
      action: { label: 'Undo', onClick: () => restoreDraft(o.id) },
      ttl: 7000,
    });
  };
}

/** The open message: the editor, with Send and the rest (a message waiting for I sent it shows that step instead). */
function MessageBody({ o, person, onClose }: { o: OutboundMessage; person?: Person; onClose?: () => void }) {
  const { user } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <DraftEditor
      draft={o}
      thread
      focusOnOpen
      busy={busy}
      onApprove={async (body, subject) => {
        setBusy(true);
        try {
          return await runApproval(user, o, body, subject, toast, person?.firstName);
        } finally {
          setBusy(false);
        }
      }}
      onCancel={onClose && (() => onClose())}
    />
  );
}

const quietButton =
  'relative shrink-0 rounded px-1 text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25';

/**
 * Drafts' list, stacked: the row opens in place on a click anywhere on it but the name, and closes on a second click
 * on its header, the chevron or Escape. The editor saves what was typed as it goes and again as it closes, so closing
 * never loses words.
 */
export function MessageRow({
  o,
  person,
  open,
  onOpenChange,
}: {
  o: OutboundMessage;
  person?: Person;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bodyId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const discard = useDiscard(o);
  const name = person?.displayName ?? 'Unknown';
  const draft = o.status === 'draft';
  // opening one row closes another above it, which moves this one up: keep its header on screen
  useEffect(() => {
    if (open) toggleRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  const close = () => {
    // the focus was in the editor that is about to go: it lands on the header, where Enter opens it again
    const inside =
      !!document.activeElement && document.getElementById(bodyId)?.contains(document.activeElement);
    onOpenChange(false);
    if (inside) toggleRef.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
    e.preventDefault();
    close();
  };
  return (
    <li
      onKeyDown={onKeyDown}
      data-testid={draft ? 'started-draft' : 'outbox-item'}
      data-open={open || undefined}
    >
      <div className="relative flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-canvas-2">
        {/* the whole header is one button under its content: a click anywhere on it but the name opens or closes */}
        <button
          ref={toggleRef}
          type="button"
          className="absolute inset-0 w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/25"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-label={`${open ? 'Close' : 'Open'} your ${draft ? 'draft' : 'message'} to ${name}`}
          onClick={() => (open ? close() : onOpenChange(true))}
          data-testid={draft ? 'started-draft-toggle' : 'outbox-item-toggle'}
        />
        {person ? (
          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={30} />
        ) : (
          <span className="w-[30px] h-[30px] rounded-full bg-canvas-2 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <Link
              to={person ? `/people/${person.id}` : '#'}
              className="relative text-[13.5px] font-medium truncate hover:underline"
            >
              {name}
            </Link>
            {person && <PersonCompanyLogo person={person} size={14} />}
            <span className="ml-auto pl-2 shrink-0 text-[12px] text-ink-3">{when(o)}</span>
            <ChevronDown
              size={15}
              aria-hidden
              className={cx('shrink-0 text-ink-3 transition-transform duration-150', open && 'rotate-180')}
            />
          </span>
          <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <Chips o={o} person={person} />
            {!open && (
              <span className="text-[12px] text-ink-3 truncate" data-testid="started-draft-preview">
                {preview(o) || 'Nothing written yet.'}
              </span>
            )}
            {open && draft && (
              <button
                type="button"
                className={cx(quietButton, 'ml-auto')}
                onClick={() => {
                  onOpenChange(false);
                  void discard();
                }}
                data-testid="started-draft-discard"
              >
                Discard draft
              </button>
            )}
          </span>
        </span>
      </div>
      {open && (
        <div
          id={bodyId}
          className="px-3 pb-3 pt-1"
          data-testid={draft ? 'started-draft-editor' : 'outbox-item-body'}
        >
          <MessageBody o={o} person={person} onClose={close} />
        </div>
      )}
    </li>
  );
}

/** Drafts' list on a wide screen: the same row as an option, opened beside the list. */
export function MessageOption({
  o,
  person,
  active,
  onSelect,
}: {
  o: OutboundMessage;
  person?: Person;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li data-row={o.id}>
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
        data-message={o.status === 'draft' ? 'started' : 'handed_off'}
      >
        {person ? (
          <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={30} />
        ) : (
          <span className="w-[30px] h-[30px] rounded-full bg-canvas-2 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cx('text-[13.5px] truncate', active ? 'font-semibold' : 'font-medium')}>
              {person?.displayName ?? 'Unknown'}
            </span>
            {person && <PersonCompanyLogo person={person} size={14} />}
            <span className="ml-auto pl-2 shrink-0 text-[11.5px] text-ink-3">{when(o)}</span>
          </span>
          <span className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <Chips o={o} person={person} />
            <span className="text-[12px] text-ink-3 truncate">{preview(o)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** The message picked in the wide list, open beside it: who, what kind, and the editor or the I sent it step. */
export function MessagePane({ o, person }: { o: OutboundMessage; person?: Person }) {
  const discard = useDiscard(o);
  const draft = o.status === 'draft';
  return (
    <div
      className="bg-canvas border border-line rounded-[var(--radius-card)] p-4 min-w-0"
      data-testid={draft ? 'started-draft' : 'outbox-item'}
    >
      <div className="flex items-center gap-3">
        {person && (
          <Link to={`/people/${person.id}`} className="shrink-0">
            <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={40} />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Chips o={o} person={person} />
            <Link to={person ? `/people/${person.id}` : '#'} className="font-medium hover:underline truncate">
              {person?.displayName ?? 'Unknown'}
            </Link>
          </div>
          <p className="text-[13px] text-ink-3 mt-0.5">
            {draft ? `You ${when(o)}, not sent yet.` : `You ${when(o)}. It waits for I sent it.`}
          </p>
        </div>
        {draft && (
          <button
            type="button"
            className={quietButton}
            onClick={() => void discard()}
            data-testid="started-draft-discard"
          >
            Discard draft
          </button>
        )}
      </div>
      <div className="mt-3" data-testid={draft ? 'started-draft-editor' : 'outbox-item-body'}>
        <MessageBody key={o.id} o={o} person={person} />
      </div>
    </div>
  );
}
