/**
 * A quiet three-dot button that opens a short menu of actions beside it: the way to put something away (Not now,
 * Hide) without a row of buttons on every line. Escape, a click outside, or picking an item closes it.
 */
import { MoreHorizontal } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from './index';

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  tone?: 'bad';
  testId?: string;
}

export function RowMenu({
  items,
  label = 'More',
  className,
  align = 'right',
  testId,
}: {
  items: RowMenuItem[];
  /** what the button is called to a screen reader ("More for Maya Lin") */
  label?: string;
  className?: string;
  align?: 'left' | 'right';
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={box} className={cx('relative', className)}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={cx(
          'inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-canvas-2 hover:text-ink',
          open && 'bg-canvas-2 text-ink',
        )}
        data-testid={testId}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className={cx(
            'pop-in absolute top-full z-40 mt-1 min-w-[180px] rounded-[10px] border border-line bg-canvas p-1 shadow-[0_8px_28px_rgba(0,0,0,0.10)]',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-canvas-2 focus-visible:bg-canvas-2',
                it.tone === 'bad' ? 'text-bad' : 'text-ink',
              )}
              data-testid={it.testId}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
