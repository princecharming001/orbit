/**
 * The one table every list of people uses: a hairline box, a plain header (no capitals), one line a row, a hairline
 * between columns as well as rows, so a long list reads like a sheet. Cells truncate; the full text is the hover.
 * `Bars` draws a strength out of four, `Thumb` an answer to a check.
 */
import { Minus, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './index';

/** The box around a table: it scrolls sideways on a narrow screen instead of squeezing the columns. */
export function TableBox({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('rounded-[10px] border border-line bg-canvas overflow-x-auto scroll-thin', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Table({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cx('w-full border-separate border-spacing-0 text-[13.5px]', className)} {...rest}>
      {children}
    </table>
  );
}

const CELL = 'px-3 border-b border-line border-r last:border-r-0 text-left align-middle';

/** A header cell: plain words in ink, the same size as the rows. */
export function Th({
  children,
  className,
  wrap,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { wrap?: boolean }) {
  return (
    <th
      className={cx(
        CELL,
        'h-11 bg-canvas-2/60 font-medium text-ink',
        wrap ? 'py-2 leading-snug' : 'whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

/** A body cell: one line, cut with an ellipsis. `wrap` lets a cell that needs two lines have them. */
export function Td({
  children,
  className,
  wrap,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { wrap?: boolean }) {
  return (
    <td
      className={cx(CELL, 'h-11 group-last/row:border-b-0', !wrap && 'whitespace-nowrap', className)}
      {...rest}
    >
      {children}
    </td>
  );
}

/** A body row: a faint wash under the pointer. */
export function Tr({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cx('group/row hover:bg-canvas-2/50', className)} {...rest}>
      {children}
    </tr>
  );
}

/** Text that cuts with an ellipsis inside a cell of a set width. */
export function Clip({
  children,
  className,
  title,
  max = 260,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  max?: number;
}) {
  return (
    <span className={cx('block truncate', className)} style={{ maxWidth: max }} title={title}>
      {children}
    </span>
  );
}

/** A strength out of four, as bars: how warm a path is, how close someone is. */
export function Bars({ level, label, testId }: { level: number; label: string; testId?: string }) {
  const n = Math.max(0, Math.min(4, Math.round(level)));
  return (
    <span
      className="inline-flex items-end gap-[2px] h-3.5 shrink-0"
      role="img"
      aria-label={label}
      title={label}
      data-testid={testId}
      data-level={n}
    >
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cx('w-[3px] rounded-[1px]', i <= n ? 'bg-accent' : 'bg-line')}
          style={{ height: `${4 + i * 2.5}px` }}
        />
      ))}
    </span>
  );
}

export type ThumbAnswer = 'yes' | 'likely' | 'unknown' | 'no';

const THUMB_WORDS: Record<ThumbAnswer, string> = {
  yes: 'Yes',
  likely: 'Likely',
  unknown: 'Not known',
  no: 'No',
};

/** An answer to one check: a green thumb for yes, a paler one for likely, a dash for not known, a red thumb for no. */
export function Thumb({
  answer,
  detail,
  testId,
}: {
  answer: ThumbAnswer;
  /** the words the answer rests on, for the hover */
  detail?: string;
  testId?: string;
}) {
  const words = detail ? `${THUMB_WORDS[answer]}: ${detail}` : THUMB_WORDS[answer];
  return (
    <span
      className={cx(
        'inline-flex items-center justify-center w-9 h-7 rounded-[6px]',
        answer === 'yes' && 'bg-good-soft text-good',
        answer === 'likely' && 'bg-good-soft/60 text-good/70',
        answer === 'unknown' && 'bg-canvas-2 text-ink-3',
        answer === 'no' && 'bg-bad-soft text-bad',
      )}
      role="img"
      aria-label={words}
      title={words}
      data-testid={testId}
      data-answer={answer}
    >
      {answer === 'unknown' ? (
        <Minus size={14} />
      ) : answer === 'no' ? (
        <ThumbsDown size={14} />
      ) : (
        <ThumbsUp size={14} />
      )}
    </span>
  );
}
