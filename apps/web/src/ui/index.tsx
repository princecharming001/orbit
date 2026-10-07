import { FUNCTION_LABELS, initials } from '@orbit/core';
import { X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 whitespace-nowrap';
  const sizes = { sm: 'h-8 px-2.5 text-[13px]', md: 'h-9 px-3.5 text-[14px]', lg: 'h-11 px-5 text-[15px]' }[
    size
  ];
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-white hover:bg-accent-2',
    secondary: 'bg-canvas text-ink border border-line hover:bg-canvas-2',
    ghost: 'bg-transparent text-ink-2 hover:bg-canvas-2 hover:text-ink',
    subtle: 'bg-canvas-2 text-ink hover:bg-line-2',
    danger: 'bg-bad-soft text-bad hover:bg-red-100',
  };
  return <button className={cx(base, sizes, variants[variant], className)} {...rest} />;
}

export function Card({
  className,
  children,
  padded = true,
}: {
  className?: string;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <div
      className={cx('bg-canvas border border-line rounded-[var(--radius-card)]', padded && 'p-4', className)}
    >
      {children}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-9 w-full rounded-lg border border-line bg-canvas px-3 text-[14px] placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent',
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
        'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[14px] leading-relaxed placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent',
        className,
      )}
      {...rest}
    />
  );
}
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'h-9 rounded-lg border border-line bg-canvas px-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-accent/30',
        className,
      )}
      {...rest}
    />
  );
}
export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between">
      <span className="text-[13px] font-medium text-ink-2">{children}</span>
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-canvas-2 text-ink-2 border-line',
    accent: 'bg-accent-soft text-accent border-transparent',
    good: 'bg-good-soft text-good border-transparent',
    warn: 'bg-warn-soft text-warn border-transparent',
    bad: 'bg-bad-soft text-bad border-transparent',
  }[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 h-6 text-[12px] font-medium leading-none',
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
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" className="rounded-full object-cover w-full h-full" />
      ) : (
        <span
          className="rounded-full w-full h-full inline-flex items-center justify-center font-semibold text-white"
          style={{ background: `hsl(${hue} 45% 55%)`, fontSize: Math.max(10, size * 0.38) }}
        >
          {initials(name)}
        </span>
      )}
      {ring && <span className="absolute inset-[-2px] rounded-full border-2" style={{ borderColor: ring }} />}
    </span>
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
    <div className="flex items-start justify-between gap-4 mb-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] leading-tight">{title}</h1>
        {subtitle && <p className="text-ink-3 mt-1 text-[14px]">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="border border-dashed border-line rounded-[var(--radius-card)] p-8 text-center">
      <p className="font-medium">{title}</p>
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
            className="inline-flex items-center h-9 px-3.5 rounded-lg bg-accent text-white text-[14px] font-medium hover:bg-accent-2"
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
        'inline-block w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin',
        className,
      )}
      role="status"
      aria-label="Loading"
    />
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
      className="flex items-center gap-1 border-b border-line mb-4 overflow-x-auto scroll-thin"
      role="tablist"
    >
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cx(
            'px-3 h-9 text-[14px] border-b-2 transition-colors shrink-0 whitespace-nowrap',
            value === it.value
              ? 'border-ink text-ink font-medium'
              : 'border-transparent text-ink-3 hover:text-ink',
          )}
        >
          {it.label}
          {it.count !== undefined && (
            <span className="ml-1.5 text-[12px] text-ink-3 tabular">{it.count}</span>
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
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        className="relative bg-canvas rounded-[var(--radius-card)] border border-line shadow-xl w-full fade-up focus:outline-none"
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
  ttl?: number;
}
const ToastCtx = createContext<{ push: (t: Omit<ToastItem, 'id'>) => number; dismiss: (id: number) => void }>(
  { push: () => 0, dismiss: () => {} },
);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++counter.current;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => dismiss(id), t.ttl ?? 4000);
      return id;
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'fade-up flex items-center gap-3 rounded-full px-4 h-10 shadow-lg text-[13px]',
              t.tone === 'bad'
                ? 'bg-bad text-white'
                : t.tone === 'good'
                  ? 'bg-good text-white'
                  : 'bg-ink text-white',
            )}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                className="font-semibold underline-offset-2 hover:underline"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  return useContext(ToastCtx);
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
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="text-[22px] font-semibold tabular leading-tight mt-0.5">{value}</div>
      {hint && <div className="text-[12px] text-ink-3 mt-0.5">{hint}</div>}
    </div>
  );
}

export function relDate(iso: string | undefined, now = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (diff < 0) {
    const ahead = Math.ceil(-diff / 86_400_000);
    if (-diff < 3_600_000) return 'in under an hour';
    if (-diff < 86_400_000) return `in ${Math.round(-diff / 3_600_000)} h`;
    return ahead === 1 ? 'tomorrow' : `in ${ahead} days`;
  }
  if (diff < 3_600_000) return 'just now';
  if (days === 0) return `${Math.round(diff / 3_600_000)} h ago`;
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} d ago`;
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
              'h-8 px-3 rounded-full border text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              on ? 'bg-ink text-white border-ink' : 'border-line text-ink-2 hover:bg-canvas-2',
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
