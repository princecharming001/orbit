import { Check, ChevronDown } from 'lucide-react';
import {
  type KeyboardEvent,
  type SelectHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Row =
  | { kind: 'group'; label: string; key: string }
  | { kind: 'option'; value: string; label: string; disabled: boolean; index: number; key: string };

/** the menu's rows, read from the real <select> so any option markup (lists, fragments, optgroups) shows as it would */
function readRows(sel: HTMLSelectElement): Row[] {
  const rows: Row[] = [];
  const option = (o: HTMLOptionElement, groupDisabled = false) =>
    rows.push({
      kind: 'option',
      value: o.value,
      label: o.text,
      disabled: o.disabled || groupDisabled,
      index: o.index,
      key: `o${o.index}`,
    });
  for (const child of Array.from(sel.children)) {
    if (child instanceof HTMLOptGroupElement) {
      rows.push({ kind: 'group', label: child.label, key: `g${rows.length}` });
      for (const o of Array.from(child.children))
        if (o instanceof HTMLOptionElement) option(o, child.disabled);
    } else if (child instanceof HTMLOptionElement) option(child);
  }
  return rows;
}

const GAP = 6; // between the field and its menu
const EDGE = 8; // the menu never comes closer than this to the window's edge
const MAX_H = 320;

/**
 * A dropdown that looks like the rest of Orbit: a field showing the choice, and a card of options under it (a check on
 * the chosen one) instead of the system's grey menu.
 *
 * The real <select> stays in the page, see-through, under the field: it gives the field its size, carries the value,
 * the label and the test id, takes keyboard focus and is what a screen reader, a form and a test (`selectOption`,
 * `toHaveValue`) work with. The button on top of it is only for the pointer. A choice from the menu sets the
 * <select> and fires its change event, so callers keep reading `e.target.value`.
 */
export function Select({
  className,
  children,
  disabled,
  title,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const selRef = useRef<HTMLSelectElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [label, setLabel] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [active, setActive] = useState(-1);
  const [chosen, setChosen] = useState(-1);
  const [up, setUp] = useState(false);
  const pointer = useRef<string>('mouse');

  // the field shows what the <select> shows (its value can come from props, a test or the browser restoring a form)
  useLayoutEffect(() => {
    const text = selRef.current?.selectedOptions[0]?.text ?? '';
    if (text !== label) setLabel(text);
  });

  const enabled = rows.filter(
    (r): r is Extract<Row, { kind: 'option' }> => r.kind === 'option' && !r.disabled,
  );

  const show = useCallback(() => {
    const sel = selRef.current;
    if (!sel || sel.disabled) return;
    const next = readRows(sel);
    setRows(next);
    setActive(sel.selectedIndex);
    setChosen(sel.selectedIndex);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const pick = useCallback((index: number) => {
    const sel = selRef.current;
    setOpen(false);
    if (!sel) return;
    const o = sel.options[index];
    if (!o || o.disabled) return;
    if (sel.selectedIndex !== index) {
      sel.selectedIndex = index;
      // a real change event: React's onChange runs with the <select> as its target, as it would for the system menu
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (pointer.current === 'mouse') sel.focus({ preventScroll: true });
  }, []);

  // place the menu under the field, or over it when the window has no room below; never past either side
  const place = useCallback(() => {
    const box = boxRef.current;
    const menu = menuRef.current;
    if (!box || !menu) return;
    const r = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const natural = Math.min(menu.scrollHeight, MAX_H);
    const flip = natural > below && above > below;
    const room = Math.max(120, flip ? above : below);
    menu.style.maxHeight = `${Math.min(MAX_H, room)}px`;
    menu.style.minWidth = `${Math.min(r.width, vw - EDGE * 2)}px`;
    menu.style.maxWidth = `${Math.min(Math.max(r.width, 360), vw - EDGE * 2)}px`;
    const w = menu.offsetWidth;
    const left = Math.max(EDGE, Math.min(r.left, vw - w - EDGE));
    menu.style.left = `${left}px`;
    if (flip) {
      menu.style.top = '';
      menu.style.bottom = `${vh - r.top + GAP}px`;
    } else {
      menu.style.bottom = '';
      menu.style.top = `${r.bottom + GAP}px`;
    }
    setUp(flip);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, place]);

  // keep the highlighted row in view as the arrows move it
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const step = (dir: 1 | -1) => {
    if (!enabled.length) return;
    const at = enabled.findIndex((r) => r.index === active);
    const next =
      at < 0 ? (dir === 1 ? 0 : enabled.length - 1) : Math.max(0, Math.min(enabled.length - 1, at + dir));
    setActive(enabled[next]!.index);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLSelectElement>) => {
    rest.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pointer.current = 'keyboard';
        show();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Home':
      case 'PageUp':
        e.preventDefault();
        if (enabled[0]) setActive(enabled[0].index);
        break;
      case 'End':
      case 'PageDown':
        e.preventDefault();
        if (enabled.length) setActive(enabled[enabled.length - 1]!.index);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0) pick(active);
        else close();
        break;
      case 'Escape':
        // only the menu closes, not the dialog it sits in
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close();
        break;
      default:
        // a letter jumps to the next option that starts with it
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const key = e.key.toLowerCase();
          const at = enabled.findIndex((r) => r.index === active);
          const order = [...enabled.slice(at + 1), ...enabled.slice(0, at + 1)];
          const hit = order.find((r) => r.label.trim().toLowerCase().startsWith(key));
          if (hit) setActive(hit.index);
        }
    }
  };

  const testId = (rest as Record<string, unknown>)['data-testid'];

  return (
    <span
      ref={boxRef}
      className={cx(
        'relative inline-flex rounded-[10px] border border-line bg-canvas align-middle transition-shadow',
        'focus-within:ring-4 focus-within:ring-ink/[0.06] focus-within:border-[#bdbab5]',
        open && 'ring-4 ring-ink/[0.06] border-[#bdbab5]',
        disabled && 'opacity-50',
        // the default size gives way to one the caller sets (a compact select in a table row or on a card)
        !/(^|\s)h-/.test(className ?? '') && 'h-10',
        !/(^|\s)text-\[/.test(className ?? '') && 'text-[14px]',
        className,
      )}
    >
      <select
        {...rest}
        ref={selRef}
        disabled={disabled}
        title={title}
        onKeyDown={onKeyDown}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        className="h-full w-full min-w-0 cursor-pointer rounded-[10px] bg-transparent px-2.5 opacity-0 focus:outline-none"
      >
        {children}
      </select>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        title={title}
        onPointerDown={(e) => {
          pointer.current = e.pointerType || 'mouse';
        }}
        onMouseDown={(e) => {
          // the focus stays on the <select>, so the keys work on a menu opened with the mouse
          e.preventDefault();
          if (pointer.current === 'mouse') selRef.current?.focus({ preventScroll: true });
        }}
        onClick={() => (open ? close() : show())}
        className="absolute inset-0 flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-[10px] pl-2.5 pr-2 text-left disabled:cursor-not-allowed"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={cx('shrink-0 text-ink-3 transition-transform duration-150', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={rest['aria-label']}
            className={cx(
              'pop-in fixed z-[70] overflow-y-auto overscroll-contain scroll-thin rounded-[var(--radius-card)] border border-line bg-canvas p-1 text-[13px] text-ink shadow-[var(--shadow-card),0_12px_32px_rgba(0,0,0,0.08)]',
              up && '[transform-origin:bottom_center]',
            )}
            style={{ left: 0, top: 0 }}
            data-testid={typeof testId === 'string' ? `${testId}-menu` : undefined}
            onMouseDown={(e) => e.preventDefault()}
          >
            {rows.map((r) =>
              r.kind === 'group' ? (
                <div
                  key={r.key}
                  className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3 first:pt-1.5"
                >
                  {r.label}
                </div>
              ) : (
                <div
                  key={r.key}
                  id={`${listId}-${r.index}`}
                  role="option"
                  aria-selected={r.index === chosen}
                  aria-disabled={r.disabled || undefined}
                  data-index={r.index}
                  tabIndex={-1}
                  onMouseMove={() => !r.disabled && active !== r.index && setActive(r.index)}
                  onClick={() => !r.disabled && pick(r.index)}
                  className={cx(
                    'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-[8px] px-2.5 py-1.5',
                    r.index === active && !r.disabled && 'bg-canvas-2',
                    r.index === chosen ? 'font-medium text-ink' : 'text-ink-2',
                    r.disabled && 'cursor-default opacity-40',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <Check
                    size={14}
                    strokeWidth={2.25}
                    className={cx('shrink-0 text-accent', r.index !== chosen && 'invisible')}
                    aria-hidden
                  />
                </div>
              ),
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
