import type { ReactNode } from 'react';
import { cx } from '../ui';

/** A small square mark for an app: its initials (or an icon) on a hairline tile; LinkedIn keeps its blue. */
export function AppMark({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'linkedin' }) {
  return (
    <span
      className={cx(
        'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[12px] font-semibold',
        tone === 'linkedin' ? 'bg-[#0a66c2] text-white' : 'border border-line bg-canvas text-ink-2',
      )}
      aria-hidden
    >
      {children}
    </span>
  );
}

/**
 * One app on the Integrations page: mark, name and status on the first line, one short line under it, and its
 * actions on the right. Anything longer (a key field, a how-to) goes in `children`, under the text.
 */
export function IntegrationRow({
  mark,
  name,
  status,
  line,
  actions,
  children,
  testId,
}: {
  mark: ReactNode;
  name: ReactNode;
  status?: ReactNode;
  line?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="py-4 first:pt-1 last:pb-1" data-testid={testId}>
      <div className="flex items-start gap-3">
        {mark}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[14px] font-medium text-ink">{name}</span>
            {status}
          </div>
          {line && <div className="mt-0.5 text-[12.5px] text-ink-3">{line}</div>}
          {children && <div className="mt-2.5 text-[13px]">{children}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

/** "Connected · 79 connections · synced 2 days ago": the green status after an app's name. */
export function RowStatus({
  tone = 'good',
  children,
  testId,
}: {
  tone?: 'good' | 'muted' | 'bad';
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      className={cx(
        'text-[12px] inline-flex flex-wrap items-center gap-1',
        tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-ink-3',
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

/** A group heading inside the Integrations card. */
export function RowGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="[&:not(:first-child)]:mt-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-line [&:not(:first-child)]:pt-4">
      <div className="label-mono pb-1">{title}</div>
      <div className="divide-y divide-line-2">{children}</div>
    </section>
  );
}
