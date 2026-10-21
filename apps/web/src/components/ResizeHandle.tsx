import { type CSSProperties, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../ui';

/**
 * A side panel's width that the student sets by dragging its edge, remembered in this browser. `max` is worked out
 * from the container each time (what the other side still needs), so the panel never squeezes the main view away.
 */
export function useResizableWidth(
  storageKey: string,
  opts: { initial: number; min: number; reserve: number },
  container: RefObject<HTMLElement | null>,
) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return Number.isFinite(v) && v >= opts.min ? v : opts.initial;
    } catch {
      return opts.initial;
    }
  });
  const clamp = useCallback(
    (w: number) => {
      const room = container.current?.clientWidth;
      const max = room ? Math.max(opts.min, room - opts.reserve) : Number.POSITIVE_INFINITY;
      return Math.round(Math.min(max, Math.max(opts.min, w)));
    },
    [container, opts.min, opts.reserve],
  );
  // a window made smaller keeps the panel inside it
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth((w) => clamp(w)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [container, clamp]);
  const set = useCallback(
    (w: number) => {
      const next = clamp(w);
      setWidth(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {}
    },
    [clamp, storageKey],
  );
  const reset = useCallback(() => {
    setWidth(clamp(opts.initial));
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  }, [clamp, opts.initial, storageKey]);
  return { width, set, reset, min: opts.min };
}

/**
 * The edge between a main view and a side panel, dragged to resize it. `side` says where the panel is: dragging
 * toward the main view widens it. Double-click puts it back; with focus, the arrow keys move it a step.
 */
export function ResizeHandle({
  width,
  onResize,
  onReset,
  side,
  label,
  className,
  style,
}: {
  width: number;
  onResize: (w: number) => void;
  onReset: () => void;
  side: 'left' | 'right';
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  const sign = side === 'right' ? -1 : 1;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      className={cx(
        'group z-10 w-3 -mx-1.5 cursor-col-resize touch-none select-none flex justify-center focus-visible:outline-none',
        className,
      )}
      style={style}
      data-testid="resize-handle"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setActive(true);
        document.body.style.cursor = 'col-resize';
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(drag.current.w + sign * (e.clientX - drag.current.x));
      }}
      onPointerUp={() => {
        drag.current = null;
        setActive(false);
        document.body.style.cursor = '';
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
        document.body.style.cursor = '';
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 24;
        if (e.key === 'ArrowLeft') onResize(width - sign * step);
        else if (e.key === 'ArrowRight') onResize(width + sign * step);
        else if (e.key === 'Home' || e.key === 'Escape') onReset();
        else return;
        e.preventDefault();
      }}
    >
      {/* a hairline that thickens under the pointer, with a small grip in the middle */}
      <span
        className={cx(
          'relative w-px h-full transition-colors',
          active ? 'bg-accent' : 'bg-transparent group-hover:bg-ink-3/40 group-focus-visible:bg-accent',
        )}
      >
        <span
          className={cx(
            'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-1.5 rounded-full border border-line bg-canvas shadow-[var(--shadow-pill)] transition-opacity',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        />
      </span>
    </div>
  );
}
