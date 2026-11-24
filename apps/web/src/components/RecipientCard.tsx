/**
 * Who a draft goes to, the way Gmail shows a recipient: the name in full on the To line, and on a click a small card
 * with their photo, full name and address, the address one tap from the clipboard, and their profile one tap away.
 */
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, cx } from '../ui';

export function RecipientCard({
  name,
  email,
  photo,
  personId,
  linkedinUrl,
  note,
}: {
  /** the person's full name, else the address itself */
  name: string;
  email?: string;
  photo?: string;
  personId?: string;
  linkedinUrl?: string;
  /** a word on the address ("Guessed address, not confirmed") */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const copy = async () => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
    } catch {
      // a browser without clipboard access: select the address so a copy by hand works
      const range = document.createRange();
      const el = box.current?.querySelector('[data-testid="recipient-email"]');
      if (el) {
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span ref={box} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={email ? `${name} <${email}>` : name}
        className={cx(
          'inline-flex max-w-full items-center rounded-full px-2 py-0.5 -ml-2 text-left leading-normal transition-colors',
          open ? 'bg-canvas-2' : 'hover:bg-canvas-2',
        )}
        data-testid="recipient-chip"
      >
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={`${name}, recipient`}
          className="absolute left-0 top-full z-30 mt-1.5 flex w-[300px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-[12px] border border-line bg-canvas p-3.5 text-[13px] shadow-[0_8px_28px_rgba(0,0,0,0.10)]"
          data-testid="recipient-card"
        >
          <span className="flex items-center gap-3">
            <Avatar name={name} src={photo} id={personId} size={40} />
            <span className="min-w-0">
              <span className="block break-words font-medium text-ink" data-testid="recipient-name">
                {name}
              </span>
              {email ? (
                <span className="block break-all text-ink-3" data-testid="recipient-email">
                  {email}
                </span>
              ) : (
                <span className="block text-ink-3">No email address yet</span>
              )}
              {note && <span className="mt-0.5 block text-[12px] text-ink-3">{note}</span>}
            </span>
          </span>
          <span className="flex items-center gap-2 border-t border-line-2 pt-3">
            {email && (
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-ink-2 hover:bg-canvas-2"
                data-testid="recipient-copy"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy email'}
              </button>
            )}
            {personId && (
              <Link
                to={`/people/${personId}`}
                className="inline-flex items-center rounded-[6px] px-2 py-1 text-ink-2 hover:bg-canvas-2"
                data-testid="recipient-profile"
              >
                Open profile
              </Link>
            )}
            {!personId && linkedinUrl && (
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-[6px] px-2 py-1 text-ink-2 hover:bg-canvas-2"
              >
                LinkedIn profile
              </a>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
