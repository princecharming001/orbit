/**
 * The parts every Settings page is built from, so the pages read as one: a title, then flat sections (a heading over
 * a hairline, rows split by hairlines, no boxes) of rows (the label and its short note on the left, the control on
 * the right) or of fields (a form in a grid).
 */
import type { ReactNode } from 'react';
import { cx } from '../../ui';

/** A page's title, one line on what it is for, and (on the right) how its saving stands. */
export function SettingsHeader({
  title,
  description,
  aside,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-[60ch] text-[13.5px] text-ink-3">{description}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </header>
  );
}

/**
 * A group of settings: an optional title and line over a hairline, then its rows split by hairlines, flush with the
 * page (no box around them). A form goes in `<CardFields>`. `tone="danger"` is for what cannot be undone.
 */
export function SettingsCard({
  title,
  description,
  aside,
  children,
  footer,
  tone,
  className,
  'data-testid': testId,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tone?: 'danger';
  className?: string;
  'data-testid'?: string;
  id?: string;
}) {
  return (
    <section className={cx('scroll-mt-20', className)} data-testid={testId} id={id}>
      <SectionHead title={title} description={description} aside={aside} tone={tone} />
      <div
        className={cx(
          FLAT_ROWS,
          !(title || aside) && 'border-t',
          tone === 'danger' ? 'border-bad/30' : 'border-line',
        )}
      >
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-2 pt-4">
          {footer}
        </div>
      )}
    </section>
  );
}

/** Rows flush with the page: split by hairlines, the rows' own side padding dropped (they were drawn for a box). */
export const FLAT_ROWS = 'divide-y divide-line-2 [&_.px-5]:px-0! [&_.p-5]:px-0!';

/** A section's heading over a hairline: its title, an optional line, and anything on the right. */
export function SectionHead({
  title,
  description,
  aside,
  tone,
}: {
  title?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  tone?: 'danger';
}) {
  if (!title && !aside) return null;
  return (
    <div
      className={cx(
        'flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b pb-2.5',
        tone === 'danger' ? 'border-bad/30' : 'border-line',
      )}
    >
      <div className="min-w-0">
        {title && (
          <h3
            className={cx(
              'text-[13.5px] font-semibold tracking-[-0.005em]',
              tone === 'danger' ? 'text-bad' : 'text-ink',
            )}
          >
            {title}
          </h3>
        )}
        {description && <p className="mt-0.5 max-w-[64ch] text-[12.5px] text-ink-3">{description}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

/**
 * One setting: what it is (and a short note) on the left, its control on the right. `stack` puts the control under
 * the words, full width (a text box, a slider); on a phone every row stacks when the control would not fit.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  control,
  children,
  stack,
  'data-testid': testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control?: ReactNode;
  children?: ReactNode;
  stack?: boolean;
  'data-testid'?: string;
}) {
  const Name = htmlFor ? 'label' : 'div';
  return (
    <div className="px-5 py-4" data-testid={testId}>
      <div
        className={cx(
          'flex gap-x-6 gap-y-3',
          stack ? 'flex-col' : 'flex-col @[34rem]:flex-row @[34rem]:items-center @[34rem]:justify-between',
        )}
      >
        <div className="min-w-0 @[34rem]:max-w-[60%]">
          <Name htmlFor={htmlFor} className="block text-[13.5px] font-medium text-ink">
            {label}
          </Name>
          {description && (
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{description}</div>
          )}
        </div>
        {control && <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** A form inside a card: fields in two columns where there is room. */
export function CardFields({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('grid gap-x-4 gap-y-4 py-5 @[40rem]:grid-cols-2', className)}>{children}</div>;
}

/** The cards of one page, spaced the same everywhere. */
export function SettingsStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('space-y-10 pb-10', className)}>{children}</div>;
}
