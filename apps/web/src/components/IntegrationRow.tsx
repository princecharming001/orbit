import { companyLogoUrl } from '@orbit/core';
import { Children, type ReactNode, useState } from 'react';
import { cx } from '../ui';

/**
 * A small square mark for an app: its own logo on a white tile when it has a web address (`logo`), else its initials
 * or an icon. A `badge` sits on the corner (the LinkedIn export's file).
 */
export function AppMark({
  children,
  logo,
  badge,
  tone = 'plain',
  dark,
}: {
  children?: ReactNode;
  logo?: string;
  /** the logo is drawn in white (Fathom's), so it sits on a dark tile */
  dark?: boolean;
  badge?: ReactNode;
  tone?: 'plain' | 'linkedin';
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cx(
        'relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[12px] font-semibold',
        logo && !failed
          ? dark
            ? 'bg-ink'
            : 'border border-line bg-white'
          : tone === 'linkedin'
            ? 'bg-[#0a66c2] text-white'
            : 'border border-line bg-canvas text-ink-2',
      )}
      aria-hidden
    >
      {logo && !failed ? (
        <img
          src={companyLogoUrl(logo)}
          alt=""
          width={18}
          height={18}
          className="h-[18px] w-[18px] object-contain"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        children
      )}
      {badge && (
        <span className="absolute -right-1 -bottom-1 inline-flex h-4 min-w-4 items-center justify-center rounded-[5px] border border-line bg-canvas px-0.5 text-[8px] font-semibold text-ink-2">
          {badge}
        </span>
      )}
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
  // `{cond && <x/>}` children are false when nothing shows: only what renders counts, so a bare row stays centred
  const extra = Children.toArray(children).length > 0;
  return (
    <div className="px-5 py-4" data-testid={testId}>
      <div className={cx('flex gap-3', line || extra ? 'items-start' : 'items-center')}>
        {mark}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13.5px] font-medium text-ink">{name}</span>
            {status}
          </div>
          {line && <div className="mt-0.5 text-[12.5px] text-ink-3">{line}</div>}
          {extra && <div className="mt-2.5 text-[13px]">{children}</div>}
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

/** A group of apps on the Integrations page: its title above, the apps in one card split by hairlines. */
export function RowGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="[&:not(:first-child)]:mt-8">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 px-0.5">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
      </div>
      <div className="divide-y divide-line-2 overflow-hidden rounded-[14px] border border-line bg-canvas shadow-[var(--shadow-card)]">
        {children}
      </div>
    </section>
  );
}
