import type { ChatStage } from '@orbit/core';
import { useEffect, useRef, useState } from 'react';
import { QUIET_DAYS, wentQuiet } from '../../engine/pipeline';
import { cx } from '../../ui';

// the rule lives in the engine so the chat, Drafts and People share it; re-exported for the pages that show it
export { QUIET_DAYS, wentQuiet };

/** One colour per stage: the board's column dots, the stage legend, the map's stage rings and the person page. */
export const STAGE_COLOR: Record<ChatStage, string> = {
  identified: '#9aa1ad',
  warming: '#b7791f',
  outreach_sent: '#5b5bd6',
  replied: '#1f8a4c',
  scheduling: '#5b5bd6',
  scheduled: '#1f8a4c',
  completed: '#1f8a4c',
  followed_up: '#1f8a4c',
  nurturing: '#3f4650',
  declined: '#c43d3d',
  no_response: '#9aa1ad',
  archived: '#c7cbd3',
};

export function StrengthDots({
  v,
  label = 'Closeness',
  showValue,
}: {
  v: number;
  label?: string;
  /** also print the number (out of 100), so two people with four dots can still be told apart */
  showValue?: boolean;
}) {
  const n = v >= 0.6 ? 4 : v >= 0.4 ? 3 : v >= 0.2 ? 2 : v > 0.02 ? 1 : 0;
  const text = `${label} ${Math.round(v * 100)} of 100`;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={text}>
      <span className="inline-flex gap-0.5" role="img" aria-label={text}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx('w-1.5 h-1.5 rounded-full', i < n ? 'bg-accent' : 'bg-line')} />
        ))}
      </span>
      {showValue && (
        <span className="tabular text-[12px] text-ink-3" aria-hidden>
          {Math.round(v * 100)}
        </span>
      )}
    </span>
  );
}

/** "Under a day", "1 day", "12 days": how long a chat has sat in its stage. */
export function daysLabel(since: string): string {
  const d = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));
  return d === 0 ? 'Under a day' : d === 1 ? '1 day' : `${d} days`;
}

/**
 * True when the page's own box is under the md width (768px), where the board's stages stack instead of scrolling
 * sideways. It follows the box the page sits in, not the window, so the same page stacks inside the chat's side
 * panel. Attach the returned ref to the page's root element.
 */
export function useNarrow(): [boolean, React.RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setNarrow(el.getBoundingClientRect().width < 768);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [narrow, ref];
}
