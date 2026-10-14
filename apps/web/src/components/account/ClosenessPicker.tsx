import { CLOSENESS_LABELS, type Closeness } from '../../engine/closeness';
import { cx } from '../../ui';

/** Five taps from "Barely know them" to "Very close": the student's own sense of a tie (plan 16 §3.5). */
export function ClosenessPicker({
  value,
  onPick,
  disabled,
  name,
}: {
  value?: Closeness;
  onPick: (c: Closeness) => void;
  disabled?: boolean;
  /** whose closeness, for the screen reader's label */
  name: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`How close are you to ${name}?`}>
      {([1, 2, 3, 4, 5] as const).map((c) => {
        const on = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            title={CLOSENESS_LABELS[c]}
            onClick={() => onPick(c)}
            className={cx(
              'h-8 min-w-8 px-2.5 rounded-full text-[12.5px] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
              on ? 'bg-ink text-white' : 'bg-[#f1f2f4] text-ink-2 hover:bg-[#e8eaee] hover:text-ink',
            )}
            data-testid={`closeness-${c}`}
          >
            <span className="tabular-nums">{c}</span>
            <span className="ml-1 hidden sm:inline">{CLOSENESS_LABELS[c]}</span>
          </button>
        );
      })}
    </div>
  );
}
