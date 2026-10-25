/**
 * The deck: a set of cards the student moves through one at a time, in the middle of the screen on a laptop and as a
 * sheet from the bottom on a phone. The morning brief and the Prep deck share it. Click, swipe or use the arrow keys
 * to move; Enter presses the card's main button (`data-primary="true"`); Esc does what the caller says (put it away,
 * or close); Tab stays inside. Focus moves into the deck when it opens and back to where it was when it goes.
 */
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './index';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const TYPING = ['INPUT', 'TEXTAREA', 'SELECT'];
export const isTyping = (el: Element | null) =>
  !!el && ((el as HTMLElement).isContentEditable || TYPING.includes(el.tagName));

/**
 * The keyboard while a deck is open: ← → move, Enter presses the main button, Esc calls `onEscape`, Tab stays inside.
 * A key typed into a field is the field's.
 */
export function useDeckKeys(
  ref: RefObject<HTMLElement | null>,
  opts: { open: boolean; i: number; go: (to: number) => void; onEscape: () => void },
): void {
  const { open, i, go, onEscape } = opts;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const node = ref.current;
      if (!node || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key === 'Tab') {
        const list = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (x) => x.offsetParent !== null,
        );
        if (!list.length) return e.preventDefault();
        const first = list[0]!;
        const last = list[list.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === node || !node.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !node.contains(active))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      const t = e.target as HTMLElement | null;
      if (isTyping(t) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
      else if (e.key === 'Enter') {
        // a focused button or link takes its own Enter
        if (t && t !== node && t.closest('button, a, [role="button"]')) return;
        const primary = node.querySelector<HTMLElement>('[data-primary="true"]:not([disabled])');
        if (!primary) return;
        primary.click();
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

/** Focus goes into the deck when it opens, onto the deck itself at each step, and back where it was when it goes. */
export function useDeckFocus(ref: RefObject<HTMLElement | null>, open: boolean, i: number): void {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous && document.contains(previous) && previous !== document.body) previous.focus();
    };
  }, [open]);
  // each step starts with the focus on the deck itself, so Enter presses the step's main button
  useEffect(() => {
    void i;
    if (!open) return;
    const node = ref.current;
    if (!node || (node.contains(document.activeElement) && isTyping(document.activeElement))) return;
    node.focus({ preventScroll: true });
  }, [i, open, ref]);
}

/**
 * A swipe sideways on a phone moves a step (not a drag that starts on a button, a link or a text box, and never a
 * mouse, which clicks instead).
 */
export function useDeckSwipe(i: number, go: (to: number) => void) {
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      const t = e.target as HTMLElement;
      start.current =
        e.pointerType === 'mouse' || t.closest('button, a, input, textarea, select, [contenteditable="true"]')
          ? undefined
          : { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const s = start.current;
      start.current = undefined;
      if (!s) return;
      const dx = e.clientX - s.x;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) go(i + (dx < 0 ? 1 : -1));
    },
  };
}

/**
 * The layer a deck sits on: a dimmed backdrop (clicking it calls `onBackdrop`) and the dialog, a sheet from the
 * bottom on a phone (most of the height, so steps barely move) and a 560px card in the middle on a laptop.
 */
export function DeckLayer({
  deckRef,
  label,
  testId,
  layerTestId,
  backdropTestId,
  step,
  onBackdrop,
  swipe,
  children,
}: {
  deckRef: RefObject<HTMLElement | null>;
  label: string;
  testId: string;
  layerTestId?: string;
  backdropTestId?: string;
  /** the step showing, for tests and styles */
  step?: string;
  onBackdrop: () => void;
  swipe: ReturnType<typeof useDeckSwipe>;
  children: ReactNode;
}) {
  // on the body, so a page's own transforms (an animation on a card) never pin the layer to that card instead of the
  // screen
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center md:p-6"
      data-testid={layerTestId}
    >
      <div
        className="absolute inset-0 bg-[rgba(10,10,10,0.38)]"
        onClick={onBackdrop}
        aria-hidden
        data-testid={backdropTestId}
      />
      <section
        ref={deckRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx(
          'relative flex flex-col bg-canvas border border-line shadow-[0_32px_80px_-24px_rgba(0,0,0,0.45)] sheet-in focus:outline-none',
          'w-full min-h-[min(560px,calc(100dvh-28px))] max-h-[calc(100dvh-28px)] rounded-t-[24px] pb-[env(safe-area-inset-bottom)]',
          'md:w-[560px] md:min-h-[min(500px,calc(100dvh-48px))] md:max-h-[min(780px,calc(100dvh-48px))] md:rounded-[24px] md:pb-0',
        )}
        data-testid={testId}
        data-step={step}
        onPointerDown={swipe.onPointerDown}
        onPointerUp={swipe.onPointerUp}
      >
        <span className="md:hidden mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        {children}
      </section>
    </div>,
    document.body,
  );
}

/** One segment per step, like stories: done, current and still to come; `tone` colours a segment (a decision made). */
export function DeckProgress({
  count,
  i,
  label,
  testId,
  tone,
}: {
  count: number;
  i: number;
  label: string;
  testId?: string;
  tone?: (k: number) => string | undefined;
}) {
  return (
    <div
      className="flex-1 flex gap-1"
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={i + 1}
      aria-valuetext={`Step ${i + 1} of ${count}`}
      data-testid={testId}
    >
      {Array.from({ length: count }, (_, k) => (
        <span
          key={k}
          className={cx(
            'h-[3px] flex-1 rounded-full transition-colors',
            tone?.(k) ?? (k === i ? 'bg-ink' : k < i ? 'bg-ink-3' : 'bg-line'),
          )}
        />
      ))}
    </div>
  );
}
