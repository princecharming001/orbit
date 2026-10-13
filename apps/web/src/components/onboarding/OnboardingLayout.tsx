import { ArrowLeft } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import type { StepStatus } from '../../pages/onboardingSteps';
import { cx } from '../../ui';
import { Logo } from '../AppShell';

/**
 * The setup frame: a plain near-white page (the app's drifting colour blobs stay hidden behind it), the logo top
 * left, a thin segmented progress bar top right, and one centred column for the step. The look follows Linear's and
 * TheyDo's web onboarding: no card, big tight title, quiet subtitle, full-width black button, a text link to skip.
 */
export function OnboardingLayout({
  steps,
  index,
  optional,
  stepKey,
  onBack,
  children,
}: {
  /** each shown step's title and state, in order */
  steps: { title: string; status: StepStatus }[];
  /** the current step's position in `steps` */
  index: number;
  optional?: boolean;
  /** changes with the step, so the column fades in again */
  stepKey: number | string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    // opaque and positioned, so the body's fixed colour blobs (z-index -1) are covered on these pages
    <div className="relative z-0 min-h-dvh bg-[#fcfcfd] flex flex-col" data-testid="ob-layout">
      <header className="h-16 shrink-0 px-4 sm:px-8 flex items-center justify-between gap-4">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
          title="Back to the Orbit home page"
        >
          <Logo size={24} />
          <span className="font-semibold tracking-tight text-[15px]">Orbit</span>
        </Link>
        <div className="flex items-center gap-3 min-w-0">
          <p className="text-[12.5px] text-ink-3 tabular-nums whitespace-nowrap" data-testid="ob-progress">
            <span className="sr-only sm:not-sr-only">Step </span>
            {index + 1} of {steps.length}
            {optional ? <span> · Optional</span> : null}
          </p>
          <ol className="flex items-center gap-1" aria-label="Setup steps">
            {steps.map((s, i) => (
              <li
                key={s.title}
                aria-current={s.status === 'current' ? 'step' : undefined}
                data-testid={`ob-step-${i + 1}`}
                data-status={s.status}
              >
                <span
                  aria-hidden
                  className={cx(
                    'block h-[3px] w-4 sm:w-6 rounded-full transition-colors duration-300',
                    s.status === 'done' || s.status === 'current'
                      ? 'bg-ink'
                      : s.status === 'skipped'
                        ? 'bg-ink/25'
                        : 'bg-[#e4e6eb]',
                  )}
                />
                <span className="sr-only">
                  {s.title}:{' '}
                  {s.status === 'current' ? 'current step' : s.status === 'todo' ? 'not started' : s.status}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center px-4 pt-6 pb-16 sm:pt-[9vh]">
        <div key={stepKey} className="w-full max-w-[440px] fade-up">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              title="Back"
              className="-ml-2 mb-4 inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-2 hover:bg-black/[0.04] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}

/** The step's heading: an optional mark above, a 28px tight title and a muted line under it, all centred. */
export function ObHeader({
  icon,
  title,
  subtitle,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="text-center mb-8">
      {icon ? <div className="mb-5 flex justify-center">{icon}</div> : null}
      <h1 className="text-[26px] sm:text-[28px] leading-[1.15] font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      {subtitle ? (
        <p className="mt-2.5 text-[15px] leading-[1.55] text-ink-2 text-balance">{subtitle}</p>
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
  'h-11 w-full rounded-lg border border-[#d9dce3] bg-white px-3.5 text-[15px] text-ink placeholder:text-[#9aa1b0] transition-[border-color,box-shadow] hover:border-[#c3c8d2] focus:outline-none focus:border-ink focus:ring-[3px] focus:ring-ink/[0.08]';

export function ObInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(field, className)} {...rest} />;
}

export function ObSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        field,
        'appearance-none pr-9 bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2716%27%20height%3D%2716%27%20fill%3D%27none%27%20stroke%3D%27%23637089%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27m4%206%204%204%204-4%27/%3E%3C/svg%3E")] bg-no-repeat bg-[position:right_12px_center]',
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
        'h-11 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-ink text-white text-[15px] font-medium transition-colors hover:bg-[#262d3f] disabled:bg-[#c9cdd6] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/25',
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
        'h-11 w-full inline-flex items-center justify-center gap-2 rounded-lg border border-[#d9dce3] bg-white text-ink text-[15px] font-medium transition-colors hover:bg-[#f5f6f8] disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
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
        'rounded-xl border border-[#e6e8ec] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] divide-y divide-[#eef0f3]',
        className,
      )}
    >
      {children}
    </div>
  );
}
