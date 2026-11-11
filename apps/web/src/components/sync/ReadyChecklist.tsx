/**
 * Plan 40: the first import as a short checklist (Monarch's "Syncing account" list, HubSpot's "we'll email you"):
 * each step with a mark (done, working, waiting, needs you) and a few words, a thin bar for the whole, and one line
 * saying how the student will hear it is done. Flat: hairlines, no boxes inside boxes.
 */
import type { Readiness, ReadyStep } from '@orbit/core';
import { progressLabel } from '@orbit/core';
import { AlertCircle, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { NotifyStatus } from '../../engine/notify';
import { cx } from '../../ui';

/** A ring that fills with the progress: the chip's mark, and the working step's. */
export function ProgressRing({
  value,
  size = 14,
  className,
}: {
  /** 0 to 1, or undefined for a ring that turns */
  value?: number;
  size?: number;
  className?: string;
}) {
  const r = (size - 2.5) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cx(value === undefined && 'animate-spin', 'shrink-0', className)}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeWidth={2}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={value === undefined ? c * 0.7 : c * (1 - Math.max(0.04, Math.min(1, value)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 500ms ease' }}
      />
    </svg>
  );
}

function StepMark({ s }: { s: ReadyStep }) {
  if (s.state === 'done')
    return (
      <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-good text-white">
        <Check size={11} strokeWidth={3} aria-hidden />
      </span>
    );
  if (s.state === 'problem') return <AlertCircle size={18} className="text-warn" aria-hidden />;
  if (s.state === 'working') return <ProgressRing value={s.share} size={18} className="text-accent" />;
  return (
    <span className="inline-block h-[18px] w-[18px] rounded-full border-[1.5px] border-line" aria-hidden />
  );
}

const fmtPhone = (e164: string) =>
  e164.startsWith('+1') && e164.length === 12
    ? `+1 ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}`
    : e164;

/** "We'll email you at a@b.com and text +1 415 555 0123 when it's done." */
export function NotifyLine({ notify, readiness }: { notify?: NotifyStatus; readiness: Readiness }) {
  if (!notify) return null;
  const { contact, notifiedAt, emailAvailable, smsAvailable } = notify;
  const email = contact.emailOn && emailAvailable && contact.email ? contact.email : undefined;
  const text = contact.smsOn && smsAvailable && contact.phone ? fmtPhone(contact.phone) : undefined;
  if (notifiedAt)
    return (
      <p className="text-[12.5px] text-ink-3" data-testid="ready-notify">
        {email || text
          ? `Sent to ${[email, text].filter(Boolean).join(' and ')} when it finished.`
          : 'Finished.'}
      </p>
    );
  if (readiness.state === 'ready' || readiness.state === 'nothing') return null;
  const ways = [email ? `email you at ${email}` : '', text ? `text ${text}` : ''].filter(Boolean);
  return (
    <p className="text-[12.5px] leading-[1.5] text-ink-3" data-testid="ready-notify">
      {ways.length
        ? `We'll ${ways.join(' and ')} the moment it's done.`
        : "You'll see it here the moment it's done."}
      {!contact.phone && smsAvailable && (
        <>
          {' '}
          <Link
            to="/settings/profile#phone"
            className="text-ink-2 underline decoration-line underline-offset-2 hover:text-ink"
            data-testid="ready-add-phone"
          >
            Get a text too
          </Link>
        </>
      )}
    </p>
  );
}

export function ReadyChecklist({
  readiness,
  notify,
  className,
  title = true,
}: {
  readiness: Readiness;
  notify?: NotifyStatus;
  className?: string;
  /** the headline and percentage over the list (off where the surrounding screen already says it) */
  title?: boolean;
}) {
  const ready = readiness.state === 'ready';
  return (
    <div className={cx('min-w-0', className)} data-testid="ready-checklist" data-state={readiness.state}>
      {title && (
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[14px] font-medium text-ink" data-testid="ready-headline">
            {readiness.headline}
          </p>
          {!ready && readiness.state !== 'nothing' && (
            <span className="tabular-nums text-[12.5px] text-ink-3" data-testid="ready-percent">
              {progressLabel(readiness)}
            </span>
          )}
        </div>
      )}
      {title && readiness.state !== 'nothing' && (
        <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-canvas-2" aria-hidden>
          <div
            className={cx(
              'h-full rounded-full transition-[width] duration-700',
              ready ? 'bg-good' : 'bg-accent',
            )}
            style={{ width: `${Math.round(readiness.progress * 100)}%` }}
          />
        </div>
      )}
      <ul className="mt-3 space-y-2.5" aria-label="What Orbit is setting up">
        {readiness.steps.map((s) => (
          <li
            key={s.key}
            className="flex items-center gap-3 text-[13px]"
            data-testid={`ready-step-${s.key}`}
            data-state={s.state}
          >
            <StepMark s={s} />
            <span
              className={cx('min-w-0 flex-1 truncate', s.state === 'waiting' ? 'text-ink-3' : 'text-ink')}
            >
              {s.label}
            </span>
            {s.detail && (
              <span
                className={cx(
                  'shrink-0 truncate max-w-[55%] text-right tabular-nums text-[12.5px]',
                  s.state === 'problem' ? 'text-warn' : 'text-ink-3',
                )}
              >
                {s.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
      {readiness.state === 'problem' && (
        <Link
          to="/settings/integrations"
          className="mt-3 inline-block text-[12.5px] font-medium text-ink-2 underline decoration-line underline-offset-2 hover:text-ink"
        >
          Fix it in Integrations
        </Link>
      )}
      {readiness.state === 'usable' && (
        <p className="mt-3 text-[12.5px] leading-[1.5] text-ink-2" data-testid="ready-usable">
          You can start now. Suggestions get sharper as the rest comes in.
        </p>
      )}
      <div className="mt-3">
        <NotifyLine notify={notify} readiness={readiness} />
      </div>
    </div>
  );
}
