import type { Need } from '@orbit/core/search';
import { cx } from '../../ui';

/** Must have or nice to have: must-haves decide who fits, nice-to-haves rank people higher. */
export function NeedToggle({
  value,
  onChange,
  label,
  testId,
}: {
  value: Need;
  onChange: (next: Need) => void;
  /** what it is about, for screen readers ("Job title") */
  label: string;
  testId?: string;
}) {
  return (
    <div
      className="inline-flex rounded-[8px] border border-line p-0.5 bg-canvas"
      role="group"
      aria-label={`${label}: must have or nice to have`}
      data-testid={testId}
    >
      {(['must', 'nice'] as const).map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value === n}
          onClick={() => onChange(n)}
          className={cx(
            'h-7 px-2.5 rounded-[6px] text-[12.5px] transition-colors',
            value === n ? 'bg-canvas-2 text-ink font-medium' : 'text-ink-3 hover:text-ink',
          )}
          data-testid={testId ? `${testId}-${n}` : undefined}
        >
          {n === 'must' ? 'Must have' : 'Nice to have'}
        </button>
      ))}
    </div>
  );
}
