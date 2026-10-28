import { FUNCTION_LABELS, initials } from '@orbit/core';
import { X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import { photoBroken, photoWanted } from '../engine/photoSignals';
import { linkedInImageExpired } from '../engine/photos';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  /** the click is being worked on: a spinner in the button, which stays full strength but takes no second click */
  loading?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-full font-medium tracking-[0.005em] transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] disabled:active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 focus-visible:ring-offset-1 whitespace-nowrap';
  const sizes = { sm: 'h-8 px-3 text-[13px]', md: 'h-9 px-4 text-[14px]', lg: 'h-11 px-5 text-[15px]' }[size];
  // after Tsenta: a deep green pill for the main action in the app (black on the landing page and setup), a white
  // pill on a hairline for the rest
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-[#fdfcfc] hover:bg-accent-2 shadow-[var(--shadow-pill)]',
    dark: 'bg-ink text-[#fdfcfc] hover:bg-[#262626] shadow-[var(--shadow-pill)]',
    secondary: 'bg-canvas text-ink border border-line shadow-[var(--shadow-pill)] hover:bg-canvas-2',
    ghost: 'bg-transparent text-ink-2 hover:bg-canvas-2 hover:text-ink',
    subtle: 'bg-canvas-2 text-ink hover:bg-line-2',
    danger: 'bg-bad-soft text-bad hover:bg-[#fbdcd8]',
  };
  return (
    <button
      className={cx(
        base,
        sizes,
        variants[variant],
        loading && 'disabled:opacity-100 cursor-progress',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Working />}
      {children}
    </button>
  );
}

/** A small spinner in the text's own color, for inside a button. */
export function Working({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block w-3.5 h-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin opacity-80',
        className,
      )}
      aria-hidden
    />
  );
}

export function Card({
  className,
  children,
  padded = true,
  'data-testid': testId,
}: {
  className?: string;
  children: ReactNode;
  padded?: boolean;
  'data-testid'?: string;
}) {
  return (
    <div
      className={cx(
        'bg-canvas border border-line rounded-[var(--radius-card)] shadow-[var(--shadow-card)]',
        padded && 'p-4',
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-10 w-full rounded-[10px] border border-line bg-canvas px-3 text-[14px] placeholder:text-[#a59f97] focus:outline-none focus:ring-4 focus:ring-ink/[0.06] focus:border-[#bdbab5] transition-shadow',
        className,
      )}
      {...rest}
    />
  );
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        'w-full rounded-[10px] border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed placeholder:text-[#a59f97] focus:outline-none focus:ring-4 focus:ring-ink/[0.06] focus:border-[#bdbab5] transition-shadow',
        className,
      )}
      {...rest}
    />
  );
}
export { Select } from './Select';
/**
 * A field label. The label never shrinks: a long hint wraps under it instead of squeezing the label into a column.
 * Pass `htmlFor` so a click (and a screen reader) lands on the field; `required` / `optional` say so in words.
 */
export function Label({
  children,
  hint,
  htmlFor,
  required,
  optional,
}: {
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink shrink-0">
        {children}
        {required && <span className="ml-1 text-[12px] font-normal text-ink-3"> Required</span>}
        {optional && <span className="ml-1 text-[12px] font-normal text-ink-3"> Optional</span>}
      </label>
      {hint && <span className="text-[12px] text-ink-3 min-w-0">{hint}</span>}
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  className,
  ...rest
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
  className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'className' | 'children'> & { 'data-testid'?: string }) {
  const tones = {
    neutral: 'bg-canvas text-ink-2 border-line',
    accent: 'bg-accent-soft text-accent border-[#d3e5dc]',
    good: 'bg-good-soft text-good border-[#cfe9d8]',
    warn: 'bg-warn-soft text-warn border-[#f3dfb8]',
    bad: 'bg-bad-soft text-bad border-[#f6cdc8]',
  }[tone];
  return (
    <span
      {...rest}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 h-[22px] text-[12px] font-medium leading-none whitespace-nowrap shrink-0',
        tones,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({
  name,
  src,
  id,
  size = 32,
  ring,
}: {
  name: string;
  src?: string;
  id?: string;
  size?: number;
  ring?: string;
}) {
  const hue = useMemo(() => {
    let h = 0;
    const s = id ?? name;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }, [id, name]);
  // LinkedIn's photo links expire: one past its date is not even tried, and the photo queue fetches a fresh one
  // (engine/photoQueue, which hears who is on screen). A picture that fails to load is tried once more, then the
  // initials show and the queue hears of it; a new link from the queue starts over.
  const usable = src && !linkedInImageExpired(src) ? src : undefined;
  const [failed, setFailed] = useState<{ src: string; tries: number }>();
  const tries = failed && failed.src === usable ? failed.tries : 0;
  const shown = usable && tries < 2 ? usable : undefined;
  useEffect(() => (id ? photoWanted(id) : undefined), [id]);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {shown ? (
        <img
          key={tries}
          src={shown}
          alt=""
          className="rounded-full object-cover w-full h-full"
          referrerPolicy="no-referrer"
          onError={() => {
            setFailed({ src: shown, tries: tries + 1 });
            if (tries + 1 >= 2 && id) photoBroken(id, shown);
          }}
        />
      ) : (
        <span
          className="rounded-full w-full h-full inline-flex items-center justify-center font-semibold text-white"
          style={{ background: `hsl(${hue} 32% 52%)`, fontSize: Math.max(10, size * 0.36) }}
        >
          {initials(name)}
        </span>
      )}
      {ring && <span className="absolute inset-[-2px] rounded-full border-2" style={{ borderColor: ring }} />}
    </span>
  );
}

/** A LinkedIn profile, as LinkedIn's small blue mark: opens the profile in a new tab. */
export function LinkedInMark({ url, name, testId }: { url: string; name: string; testId?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${name} on LinkedIn`}
      title="Open on LinkedIn"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-[#0a66c2] text-[9px] font-bold leading-none text-white hover:opacity-85"
      data-testid={testId}
    >
      in
    </a>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        <h1 className="text-[26px] sm:text-[30px] font-normal tracking-[-0.025em] leading-[1.1]">{title}</h1>
        {subtitle && <p className="text-ink-3 mt-1.5 text-[14px] max-w-[62ch]">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="border border-line bg-canvas rounded-[var(--radius-card)] p-10 text-center">
      <p className="text-[16px] font-medium tracking-[-0.01em]">{title}</p>
      {body && <p className="text-ink-3 mt-1 text-[13px] max-w-md mx-auto">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** A dead-end route (a merged person, an old link): say what happened and offer the way back. */
export function NotFound({
  title,
  body,
  to,
  linkLabel,
}: {
  title: string;
  body: string;
  to: string;
  linkLabel: string;
}) {
  return (
    <div className="py-10" data-testid="not-found">
      <EmptyState
        title={title}
        body={body}
        action={
          <Link
            to={to}
            className="inline-flex items-center h-9 px-4 rounded-full bg-ink text-white text-[14px] font-medium hover:bg-[#262626]"
          >
            {linkLabel}
          </Link>
        }
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block w-4 h-4 border-2 border-line border-t-ink rounded-full animate-spin',
        className,
      )}
      role="status"
      aria-label="Loading"
    />
  );
}

/** A block standing in for something still loading: a soft light sweeping across it (styles: `.skeleton`). */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={cx('skeleton block', className)} style={style} aria-hidden />;
}

/**
 * What a list or a panel looks like while its data loads, so a moment of loading never reads as "nothing here". It
 * fades in after a beat (`.loading-in`): a read that answers at once shows no flash at all.
 */
function Loading({
  className,
  testId,
  children,
}: {
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={cx('loading-in', className)}
      data-testid={testId ?? 'loading'}
    >
      {children}
    </div>
  );
}

// line lengths that look like real names and roles, in a fixed order so a list does not flicker between renders
const NAME_W = ['42%', '55%', '36%', '48%', '60%', '40%', '52%', '45%'];
const SUB_W = ['68%', '58%', '74%', '62%', '50%', '70%', '56%', '64%'];
const TEXT_W = ['100%', '94%', '97%', '89%'];

/** Rows of people, chats or messages still loading: an avatar and two lines each, fading toward the last. */
export function SkeletonRows({
  rows = 5,
  avatar = 36,
  divided,
  className,
  testId,
}: {
  rows?: number;
  /** avatar size in px; 0 for rows without one */
  avatar?: number;
  /** a hairline between rows, as in a list */
  divided?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <Loading className={cx(divided ? 'divide-y divide-line-2' : 'space-y-3.5', className)} testId={testId}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cx('flex items-center gap-3', divided && 'py-3')}
          style={{ opacity: 1 - (i / rows) * 0.6 }}
        >
          {avatar > 0 && (
            <Skeleton className="rounded-full shrink-0" style={{ width: avatar, height: avatar }} />
          )}
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-3" style={{ width: NAME_W[i % NAME_W.length] }} />
            <Skeleton className="h-2.5" style={{ width: SUB_W[i % SUB_W.length] }} />
          </div>
        </div>
      ))}
    </Loading>
  );
}

/** Cards still loading (drafts, suggestions, panels): an avatar, a title, and a few lines of body each. */
export function SkeletonCards({
  count = 3,
  className,
  testId,
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <Loading className={cx('space-y-3', className)} testId={testId}>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="bg-canvas border border-line rounded-[var(--radius-card)] p-4"
          style={{ opacity: 1 - (i / count) * 0.5 }}
        >
          <div className="flex items-start gap-3">
            <Skeleton className="w-10 h-10 rounded-full shrink-0" />
            <div className="flex-1 min-w-0 space-y-2 pt-1">
              <Skeleton className="h-3" style={{ width: NAME_W[i % NAME_W.length] }} />
              <Skeleton className="h-2.5 w-4/5" />
            </div>
          </div>
          <div className="mt-4 space-y-1.5">
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-11/12" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
        </div>
      ))}
    </Loading>
  );
}

/** A paragraph or a few facts still loading. */
export function SkeletonText({
  lines = 3,
  className,
  testId,
}: {
  lines?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <Loading className={cx('space-y-2', className)} testId={testId}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-2.5"
          style={{ width: i === lines - 1 ? '60%' : TEXT_W[i % TEXT_W.length] }}
        />
      ))}
    </Loading>
  );
}

/** Numbers still loading (a row of stats): a small label and a figure each. */
export function SkeletonStats({
  count = 3,
  className,
  testId,
}: {
  count?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <Loading className={cx('grid gap-3', className)} testId={testId}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-2.5 w-1/2" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ))}
    </Loading>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string; count?: number }[];
}) {
  return (
    <div
      // tabs wrap on a narrow screen instead of hiding the last one off the edge
      className="flex flex-wrap items-center gap-1 sm:gap-1.5 mb-4"
      role="tablist"
    >
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cx(
            'px-2.5 sm:px-3 h-8 rounded-full border text-[12.5px] sm:text-[13px] transition-colors shrink-0 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25',
            value === it.value
              ? 'bg-ink border-ink text-white font-medium'
              : 'bg-canvas border-line text-ink-2 hover:text-ink hover:bg-canvas-2',
          )}
        >
          {it.label}
          {it.count !== undefined && (
            <span
              className={cx(
                'ml-1 sm:ml-1.5 text-[12px] tabular',
                // on a phone only the open tab shows its count, so the tabs keep to one row
                value === it.value ? 'text-white/70' : 'text-ink-3 hidden sm:inline',
              )}
            >
              {it.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog keyboard behaviour: Escape closes, Tab stays inside, focus moves in on open and back out on close. */
export function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const items = () => (node ? [...node.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);
    // Prefer a field the dialog autofocuses (the palette input); otherwise the first control after the close button.
    const auto = node?.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
    (auto ?? items()[1] ?? items()[0] ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const list = items();
      if (!list.length) return e.preventDefault();
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);
  return ref;
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const ref = useDialog(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <aside
        ref={ref}
        tabIndex={-1}
        className="absolute right-0 top-0 h-full bg-canvas border-l border-line shadow-xl overflow-y-auto scroll-thin fade-up focus:outline-none"
        style={{ width: `min(${width}px, 100vw)` }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="sticky top-0 bg-canvas/95 backdrop-blur border-b border-line px-5 h-14 flex items-center justify-between">
          <div className="font-medium truncate">{title}</div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-canvas-2" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 520,
  keepOnBackdrop,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  /** a tap outside does not close it (a form with something typed in): Cancel, the close button or Escape do */
  keepOnBackdrop?: boolean;
}) {
  const ref = useDialog(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/25" onClick={keepOnBackdrop ? undefined : onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        className="relative bg-canvas rounded-[16px] border border-line shadow-[0_24px_60px_rgba(0,0,0,0.12)] w-full fade-up focus:outline-none"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="px-5 h-14 flex items-center justify-between border-b border-line">
          <div className="font-medium">{title}</div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-canvas-2" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; onClick: () => void };
  tone?: 'neutral' | 'good' | 'bad';
  /** something is being worked on: a spinner, and it stays up until it is dismissed or replaced */
  working?: boolean;
  ttl?: number;
  /** keep the toast when the page changes (it announces what the new page shows) */
  sticky?: boolean;
  at: number;
}
const ToastCtx = createContext<{
  push: (t: Omit<ToastItem, 'id' | 'at'>) => number;
  dismiss: (id: number) => void;
}>({ push: () => 0, dismiss: () => {} });
/** One toast at a time: a new one replaces the last instead of stacking over the page. */
const MAX_TOASTS = 1;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const { pathname } = useLocation();
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id' | 'at'>) => {
      const id = ++counter.current;
      setItems((xs) => [...xs, { ...t, id, at: Date.now() }].slice(-MAX_TOASTS));
      // short, so it does not sit over the page: only a toast with a button (Undo, Open) may stay longer
      // a working toast stays until its work ends (with a minute's limit, so one can never be stuck on screen)
      setTimeout(
        () => dismiss(id),
        t.working ? 60_000 : t.action ? (t.ttl ?? 6000) : Math.min(t.ttl ?? 4000, 5000),
      );
      return id;
    },
    [dismiss],
  );
  // A toast belongs to the page it was raised on. Moving to another page clears it, unless it was raised for that
  // move (just before it) or says what the new page holds.
  useEffect(() => {
    void pathname;
    setItems((xs) => xs.filter((x) => x.sticky || Date.now() - x.at < 1500));
  }, [pathname]);
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        // on a phone the toast sits under the top bar, clear of the cards' buttons and the bottom tabs; on a laptop it
        // sits in the bottom right corner, off the main column where the cards and their buttons are
        className="fixed top-14 md:top-auto md:bottom-4 inset-x-4 md:inset-x-auto md:right-4 z-[60] flex flex-col gap-2 items-center md:items-end pointer-events-none"
        aria-live="polite"
        data-testid="toasts"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto fade-up flex items-center gap-3 rounded-full px-4 py-2.5 min-h-10 max-w-full md:max-w-[420px] shadow-[0_8px_30px_rgba(0,0,0,0.18)] text-[13px] leading-snug',
              t.tone === 'bad'
                ? 'bg-bad text-white'
                : t.tone === 'good'
                  ? 'bg-accent text-white'
                  : 'bg-ink text-white',
            )}
            role="status"
          >
            {t.working && <Working />}
            <span className="min-w-0">{t.text}</span>
            {t.action && (
              <button
                className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              className="shrink-0 -mr-1 p-1 rounded-full opacity-70 hover:opacity-100"
              onClick={() => dismiss(t.id)}
              aria-label="Close message"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  return useContext(ToastCtx);
}

/**
 * For a click that takes a while (Claude writing a draft, a server call): the screen answers at once with a working
 * toast ("Writing to Priya…") and `busy` set to the action's key, so its button can show a spinner and take no second
 * click; a failure says so in a red toast instead of the click seeming to do nothing. The action's own toast (Undo,
 * Open) replaces the working one when it lands.
 */
export function useWorking() {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const running = useRef<string | undefined>(undefined);
  const run = useCallback(
    async <T,>(key: string, label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (running.current) return undefined;
      running.current = key;
      setBusy(key);
      const id = toast.push({ text: label, working: true, sticky: true });
      try {
        return await fn();
      } catch (e) {
        toast.dismiss(id);
        const m = e instanceof Error ? e.message : '';
        toast.push({ text: m && m.length < 160 ? m : 'That did not work. Try again.', tone: 'bad' });
        return undefined;
      } finally {
        toast.dismiss(id);
        running.current = undefined;
        setBusy(undefined);
      }
    },
    [toast],
  );
  return { busy, run };
}

/** The modifier key a shortcut uses on this computer: the Command key on a Mac, Ctrl elsewhere. */
export function modKeyLabel(): string {
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad/i.test(p) ? '⌘' : 'Ctrl';
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-line bg-canvas-2 text-[11px] text-ink-3 font-medium">
      {children}
    </kbd>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="label-mono">{label}</div>
      <div className="text-[26px] font-normal tracking-[-0.02em] tabular leading-tight mt-1">{value}</div>
      {hint && <div className="text-[12px] text-ink-3 mt-0.5">{hint}</div>}
    </div>
  );
}

/** Whole calendar days from `a` to `b` in local time (Wednesday evening to Thursday morning is 1). */
export function calendarDaysBetween(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db_ = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db_.getTime() - da.getTime()) / 86_400_000);
}

export function relDate(iso: string | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = now.getTime() - d.getTime();
  const days = calendarDaysBetween(d, now);
  if (diff < 0) {
    // ahead: counted in calendar days, so Thursday is "tomorrow" all of Wednesday
    const ahead = -days;
    if (-diff < 3_600_000) return 'in under an hour';
    if (ahead === 0) return `in ${Math.round(-diff / 3_600_000)} h`;
    return ahead === 1 ? 'tomorrow' : `in ${ahead} days`;
  }
  if (diff < 3_600_000) return 'just now';
  if (days === 0) return `${Math.round(diff / 3_600_000)} h ago`;
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Chip picker for recruiting functions; stores codes, shows words. Used by onboarding and Settings. */
export function FunctionPicker({
  value,
  onChange,
  testIdPrefix = 'fn',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  testIdPrefix?: string;
}) {
  const extra = value.filter((v) => !FUNCTION_LABELS[v]);
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Functions">
      {[...Object.entries(FUNCTION_LABELS), ...extra.map((x) => [x, x] as const)].map(([k, l]) => {
        const on = value.includes(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}
            className={cx(
              'h-9 px-3.5 rounded-full border text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25',
              on
                ? 'bg-ink text-white border-ink'
                : 'bg-canvas border-line text-ink-2 hover:bg-canvas-2 hover:text-ink',
            )}
            data-testid={`${testIdPrefix}-${k}`}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A first-run hint: a short note that explains a page the first time. "Got it" closes it for good (stored with the
 * student's settings, so it does not come back on another visit).
 */
export function FirstRunHint({
  id,
  title,
  children,
  dismissed,
  onDismiss,
}: {
  id: string;
  title: string;
  children: ReactNode;
  dismissed: boolean;
  onDismiss: (id: string) => void;
}) {
  if (dismissed) return null;
  // one quiet line under the page title, not a boxed card: the page itself is what the student came for
  return (
    <div
      className="mb-5 flex items-start gap-2 text-[13px] text-ink-3 leading-relaxed"
      role="note"
      aria-label={title}
      data-testid={`hint-${id}`}
    >
      <p className="min-w-0 max-w-[68ch]">{children}</p>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        className="shrink-0 -mt-0.5 h-7 px-2 rounded-md text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        data-testid={`hint-${id}-dismiss`}
      >
        Got it
      </button>
    </div>
  );
}

/**
 * An on/off switch, the way most apps show a setting or a connection: the track fills when it is on. It is a button
 * with role switch, so keyboards and screen readers treat it as one.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  busy,
  className,
  ...rest
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** what it turns on or off, for screen readers ("Google") */
  label: string;
  /** working: the knob pulses and clicks wait */
  busy?: boolean;
  className?: string;
} & { 'data-testid'?: string; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed',
        checked ? 'bg-accent border-accent' : 'bg-line-2 border-line',
        disabled && !busy && 'opacity-50',
        className,
      )}
      {...rest}
    >
      <span
        className={cx(
          'inline-block h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          busy && 'animate-pulse',
        )}
      />
    </button>
  );
}
