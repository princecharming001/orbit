/**
 * A text field with suggestions as you type: a menu of matches under the field, picked by click or keyboard, while
 * anything typed still counts (the field is free text with help, not a list to choose from). Suggestions come from
 * `suggest(query)`, which may be async (the school list loads on first use) and may give each a second line.
 */
import { Check } from 'lucide-react';
import {
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cx, Input } from './index';

export interface Suggestion {
  /** what goes into the field when picked */
  value: string;
  /** shown instead of the value when it reads better (the value is shown otherwise) */
  label?: string;
  /** a second line: where a school is, what a cycle means */
  sub?: string;
  /** a small mark on the left: a logo, an initial */
  mark?: ReactNode;
}

const MENU_MAX = 320;

export function Suggest({
  value,
  onChange,
  suggest,
  minChars = 1,
  /** suggestions shown before anything is typed (the common choices for a cycle) */
  initial,
  onPick,
  input: InputComponent = Input,
  className,
  menuClassName,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  suggest: (query: string) => Suggestion[] | Promise<Suggestion[]>;
  minChars?: number;
  initial?: Suggestion[];
  /** a suggestion was picked (typing alone only calls onChange) */
  onPick?: (s: Suggestion) => void;
  input?: (props: InputHTMLAttributes<HTMLInputElement>) => ReactNode;
  className?: string;
  menuClassName?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'className'>) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; up: boolean }>();
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const latest = useRef(0);
  const picked = useRef<string>();
  const listId = useId();

  // look up matches when the text changes (never after a pick, which already set the text)
  useEffect(() => {
    if (!open) return;
    if (picked.current === value) return;
    const q = value.trim();
    if (q.length < minChars) {
      setItems(initial ?? []);
      setActive(-1);
      return;
    }
    const n = ++latest.current;
    void Promise.resolve(suggest(q)).then((r) => {
      if (n !== latest.current) return;
      setItems(r);
      setActive(r.length ? 0 : -1);
    });
  }, [value, open, minChars, suggest, initial]);

  const place = () => {
    const el = wrap.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 200 && r.top > below;
    setRect({ left: r.left, top: up ? r.top : r.bottom, width: r.width, up });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('scroll', on, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const pick = (s: Suggestion) => {
    picked.current = s.value;
    onChange(s.value);
    onPick?.(s);
    setOpen(false);
  };
  const shown = open && items.length > 0 && rect;
  return (
    <div ref={wrap} className={cx('relative', className)}>
      <InputComponent
        {...rest}
        value={value}
        onChange={(e) => {
          picked.current = undefined;
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={(e) => {
          rest.onFocus?.(e);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (!shown) {
            if (e.key === 'ArrowDown') setOpen(true);
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % items.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            pick(items[active]!);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === 'Tab') setOpen(false);
        }}
        autoComplete="off"
        role="combobox"
        aria-expanded={!!shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
      />
      {shown &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            className={cx(
              'pop-in fixed z-[110] overflow-y-auto rounded-[var(--radius-card)] border border-line bg-canvas p-1 shadow-[var(--shadow-card)]',
              menuClassName,
            )}
            style={{
              left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
              width: rect.width,
              maxHeight: MENU_MAX,
              ...(rect.up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.top + 4 }),
            }}
            data-testid="suggest-menu"
          >
            {items.map((s, i) => (
              <button
                type="button"
                key={`${s.value}:${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-[13.5px]',
                  i === active ? 'bg-canvas-2' : 'hover:bg-canvas-2',
                )}
                data-testid="suggest-option"
              >
                {s.mark}
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate', s.value === value && 'font-medium')}>
                    {s.label ?? s.value}
                  </span>
                  {s.sub && <span className="block truncate text-[12px] text-ink-3">{s.sub}</span>}
                </span>
                {s.value === value && <Check size={14} className="shrink-0 text-accent" aria-hidden />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
