import { ArrowLeft } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type CSSProperties,
  Fragment,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import type { StepStatus } from '../../pages/onboardingSteps';
import { cx } from '../../ui';
import { Logo } from '../AppShell';

/**
 * The setup frame, after Tsenta: a warm white page under a hairline header (logo left, a mono step count right, and
 * one thin progress track along the header's bottom edge that eases forward with each step) and one centred column for
 * the step: a light display title, a quiet subtitle, full-width black pill button and a text link to skip. A step
 * slides in from the side it comes from: forward from the right, back from the left.
 */
export function OnboardingLayout({
  steps,
  index,
  optional,
  stepKey,
  direction = 'forward',
  onBack,
  children,
}: {
  /** each shown step's title and state, in order */
  steps: { title: string; status: StepStatus }[];
  /** the current step's position in `steps` */
  index: number;
  optional?: boolean;
  /** changes with the step, so the column slides in again */
  stepKey: number | string;
  /** where the step came from: forward slides in from the right, back from the left */
  direction?: 'forward' | 'back';
  onBack?: () => void;
  children: ReactNode;
}) {
  const fill = steps.length ? Math.max(0, Math.min(1, (index + 1) / steps.length)) : 0;
  return (
    // opaque and positioned, so the body's fixed colour blobs (z-index -1) are covered on these pages
    <div className="relative z-0 min-h-dvh bg-page flex flex-col" data-testid="ob-layout">
      <header className="relative h-16 shrink-0 px-4 sm:px-8 flex items-center justify-between gap-4 border-b border-line">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
          title="Back to the Orbit home page"
        >
          <Logo size={24} />
          <span className="font-medium tracking-[-0.01em] text-[15px]">Orbit</span>
        </Link>
        <p
          className="font-mono text-[11.5px] tracking-[0.04em] text-ink-3 tabular-nums whitespace-nowrap"
          data-testid="ob-progress"
        >
          <span className="sr-only sm:not-sr-only">Step </span>
          {index + 1} of {steps.length}
          {optional ? <span> · Optional</span> : null}
        </p>
        {/* one thin track on the header's bottom edge; the fill eases to the next step */}
        <div
          className="absolute inset-x-0 -bottom-px h-[2px] overflow-hidden"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={index + 1}
          data-testid="ob-progress-bar"
        >
          <div className="ob-progress-fill h-full bg-ink" style={{ width: `${(fill * 100).toFixed(2)}%` }} />
        </div>
        <ol className="sr-only" aria-label="Setup steps">
          {steps.map((s, i) => (
            <li
              key={s.title}
              aria-current={s.status === 'current' ? 'step' : undefined}
              data-testid={`ob-step-${i + 1}`}
              data-status={s.status}
            >
              {s.title}:{' '}
              {s.status === 'current' ? 'current step' : s.status === 'todo' ? 'not started' : s.status}
            </li>
          ))}
        </ol>
      </header>
      <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-16 sm:pt-[10vh] overflow-x-clip">
        <div
          key={stepKey}
          className={cx('w-full max-w-[460px]', direction === 'back' ? 'ob-in-prev' : 'ob-in-next')}
          data-direction={direction}
        >
          {onBack ? <ObBack onClick={onBack} /> : null}
          {children}
        </div>
      </main>
    </div>
  );
}

/** The pill that goes back a step. */
export function ObBack({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      title="Back"
      className="-ml-1 mb-5 inline-flex h-8 px-3 gap-1.5 items-center justify-center rounded-full border border-line bg-canvas text-[13px] text-ink-2 shadow-[var(--shadow-pill)] hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
    >
      <ArrowLeft size={14} aria-hidden /> Back
    </button>
  );
}

/**
 * A title that reveals word by word, each word rising out of a soft blur, about 40ms apart. The words are plain text
 * to a screen reader; with reduced motion it is just the title.
 */
export function RevealText({ text, delay = 0 }: { text: string; delay?: number }) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <span className="reveal-words">
      {words.map((w, i) => (
        // the words of one title never change order, so their position is their identity
        <Fragment key={i}>
          {i ? ' ' : null}
          <span style={{ '--i': i, '--d': `${delay}ms` } as CSSProperties}>{w}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The step's heading: an optional mark above, a small mono line over the title (the written questions' "In your
 * words, 2 of 5"), a light display title that reveals word by word and a muted line under it that follows; centred.
 */
export function ObHeader({
  icon,
  eyebrow,
  title,
  subtitle,
}: {
  icon?: ReactNode;
  eyebrow?: ReactNode;
  title: string;
  subtitle?: ReactNode;
}) {
  const words = title.split(/\s+/).length;
  return (
    <div className="text-center mb-8">
      {icon ? <div className="mb-5 flex justify-center">{icon}</div> : null}
      {eyebrow ? (
        <p
          className="ob-rise mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-3"
          data-testid="ob-eyebrow"
        >
          {eyebrow}
        </p>
      ) : null}
      <h1 className="text-[30px] sm:text-[36px] leading-[1.08] font-normal tracking-[-0.025em] text-ink text-balance">
        <RevealText text={title} delay={eyebrow ? 60 : 0} />
      </h1>
      {subtitle ? (
        <p
          className="ob-rise mt-3 text-[15px] leading-[1.55] text-ink-3 text-balance"
          style={{ '--d': `${160 + words * 40}ms` } as CSSProperties}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export function ObLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-[13.5px] font-medium text-ink">
        {children}
      </label>
      {hint ? <span className="text-[12.5px] text-ink-3">{hint}</span> : null}
    </div>
  );
}

const field =
  'h-11 w-full rounded-[10px] border border-line bg-white px-3.5 text-[15px] text-ink placeholder:text-[#a59f97] transition-[border-color,box-shadow] hover:border-[#d4d2ce] focus:outline-none focus:border-[#a8a5a0] focus:ring-4 focus:ring-ink/[0.05]';

export function ObInput({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx(field, className)} {...rest} />;
}

/** A written answer: grows with what is typed (where the browser can), never smaller than three lines. */
export function ObTextArea({ className, ...rest }: ComponentProps<'textarea'>) {
  return (
    <textarea
      rows={3}
      className={cx(
        'block w-full min-h-[92px] max-h-[260px] resize-none rounded-[12px] border border-line bg-white px-3.5 py-3 text-[15px] leading-[1.55] text-ink placeholder:text-[#a59f97] placeholder:leading-[1.55] transition-[border-color,box-shadow] hover:border-[#d4d2ce] focus:outline-none focus:border-[#a8a5a0] focus:ring-4 focus:ring-ink/[0.05] [field-sizing:content]',
        className,
      )}
      {...rest}
    />
  );
}

export function ObSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        field,
        'appearance-none pr-9 bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2716%27%20height%3D%2716%27%20fill%3D%27none%27%20stroke%3D%27%23777169%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27m4%206%204%204%204-4%27/%3E%3C/svg%3E")] bg-no-repeat bg-[position:right_12px_center]',
        className,
      )}
      {...rest}
    />
  );
}

/** The one strong action on a step: full width, black. */
export function ObPrimary({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'h-11 w-full inline-flex items-center justify-center gap-2 rounded-full bg-ink text-[#fdfcfc] text-[15px] font-medium shadow-[var(--shadow-pill)] transition-[background-color,transform] duration-150 hover:bg-[#262626] active:scale-[0.99] disabled:bg-[#d6d4d0] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/25',
        className,
      )}
      {...rest}
    />
  );
}

/** A second choice beside the primary one: full width, outlined. */
export function ObSecondary({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'h-11 w-full inline-flex items-center justify-center gap-2 rounded-full border border-line bg-white text-ink text-[15px] font-medium shadow-[var(--shadow-pill)] transition-colors hover:bg-canvas-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
        className,
      )}
      {...rest}
    />
  );
}

/** A quiet text link under the buttons: "I'll do this later", "Upload your export instead". */
export function ObQuiet({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'mx-auto block rounded-md px-2 py-1 text-[14px] text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20',
        className,
      )}
      {...rest}
    />
  );
}

/** A soft bordered panel for a short list (what connecting does, what is set up). */
export function ObPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'rounded-[14px] border border-line bg-white shadow-[var(--shadow-card)] divide-y divide-line',
        className,
      )}
    >
      {children}
    </div>
  );
}
