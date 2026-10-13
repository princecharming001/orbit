import { FUNCTION_LABELS, yearLabel } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Linkedin, Mail, Minus, Star, Upload, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import {
  ObHeader,
  ObInput,
  ObLabel,
  ObPanel,
  ObPrimary,
  ObQuiet,
  ObSecondary,
  ObSelect,
  OnboardingLayout,
} from '../components/onboarding/OnboardingLayout';
import { db } from '../db/schema';
import { finishOnboarding, setOnboardingStep } from '../engine/account';
import { connectAndSyncGoogle } from '../engine/integrations';
import { connectionsText, importLinkedInExport } from '../engine/linkedin';
import { connectLinkedInLive, liveLinkedInAvailable } from '../engine/linkedinLive';
import { removeTargetCompany, saveGoals, setTargetPriority, updateProfile } from '../engine/settings';
import { addTargetCompanies } from '../engine/targets';
import { googleClientId } from '../integrations/google';
import { envGoogleClientId } from '../integrations/prefs';
import { useSession } from '../state/session';
import { cx, Spinner } from '../ui';
import {
  OPTIONAL_STEPS,
  resolveStep,
  STEP,
  STEP_TITLES,
  stepPath,
  stepStatuses,
  visibleSteps,
} from './onboardingSteps';

/** The address of a stored onboarding step (Welcome, stored as 1, is /onboarding/0); see `onboardingSteps.ts`. */
export function onboardingPath(step: number): string {
  return stepPath(step, !!googleClientId());
}

/** A LinkedIn import of either kind: the export file, or the live connection once it exists. */
function isLinkedIn(provider: string): boolean {
  return provider === 'linkedin_csv' || provider === 'linkedin_live';
}

export function Onboarding() {
  const { step: stepParam } = useParams();
  const step = Number(stepParam ?? 0) + 1;
  const nav = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  // what the optional steps actually produced, so a skipped step never shows as done
  const did = useLiveQuery(async () => {
    if (!user) return {};
    const ints = await db.integrations.where('userId').equals(user.id).toArray();
    return {
      [STEP.linkedin]: ints.some((i) => isLinkedIn(i.provider)),
      [STEP.gmail]: ints.some((i) => i.provider === 'google'),
    } as Record<number, boolean>;
  }, [user?.id]);
  const google = !!googleClientId();
  const STEPS = visibleSteps(google);
  useEffect(() => {
    // each step opens at its title, not scrolled down to where the last step's button was
    void step;
    window.scrollTo(0, 0);
  }, [step]);
  if (!user) return null;
  const idx = STEPS.indexOf(step);
  const done = !!user.onboardingCompletedAt;
  // An unknown step (an old link, a typo) goes back to where the user actually is; after setup, to the chat.
  if (done && idx === -1) return <Navigate to="/" replace />;
  if (!done) {
    // a hidden step (Gmail without Google) or a step of the older setup moves forward to the next one shown, but
    // never past the furthest step reached: setup is not skipped by typing an address. A step change made here
    // carries `fromStep`, and the stored step is written before it, so only addresses from outside are checked.
    const furthest = resolveStep(user.onboardingStep, google);
    const internal = (location.state as { fromStep?: number } | null)?.fromStep !== undefined;
    let target = resolveStep(step, google);
    if (!internal && target > furthest) target = furthest;
    if (target !== step) return <Navigate to={`/onboarding/${target - 1}`} replace />;
  }
  const after = (s: number) => STEPS.find((x) => x > s) ?? STEP.ready;
  const before = (s: number) => [...STEPS].reverse().find((x) => x < s) ?? STEP.welcome;
  const go = async (next: number) => {
    await setOnboardingStep(user.id, next);
    nav(`/onboarding/${next - 1}`, { state: { fromStep: step } });
  };
  // Back is the browser's Back when the step before is where the student came from, so the browser's own Back
  // button afterwards keeps going back instead of returning to the step just left
  const back = (to: number) => {
    if ((location.state as { fromStep?: number } | null)?.fromStep === to) nav(-1);
    else nav(`/onboarding/${to - 1}`, { replace: true, state: { fromStep: step } });
  };
  const jump = (to: number) => nav(`/onboarding/${to - 1}`, { state: { fromStep: step } });
  const finish = async () => {
    await finishOnboarding(user.id);
    nav('/');
  };
  const statuses = stepStatuses(STEPS, step, did ?? {});
  const onBack = step === STEP.welcome ? undefined : () => back(before(step));
  let body: ReactNode = null;
  if (step === STEP.welcome) body = <StepWelcome onNext={() => go(after(STEP.welcome))} />;
  else if (step === STEP.you) body = <StepYou onNext={() => go(after(STEP.you))} />;
  else if (step === STEP.goals)
    body = <StepGoals onNext={() => go(after(STEP.goals))} onBack={() => back(before(STEP.goals))} />;
  else if (step === STEP.linkedin) body = <StepLinkedIn onNext={() => go(after(STEP.linkedin))} />;
  else if (step === STEP.gmail) body = <StepGmail onNext={() => go(after(STEP.gmail))} />;
  else if (step === STEP.ready) body = <StepReady google={google} onFinish={finish} onJump={jump} />;
  return (
    <OnboardingLayout
      steps={STEPS.map((s, i) => ({ title: STEP_TITLES[s]!, status: statuses[i]! }))}
      index={idx}
      optional={OPTIONAL_STEPS.has(step)}
      stepKey={step}
      // Goals saves what is on screen before it goes back, so it brings its own Back
      onBack={step === STEP.goals ? undefined : onBack}
    >
      {body}
    </OnboardingLayout>
  );
}

/** The back arrow for a step that must save before it leaves (the layout's arrow, with the step's own action). */
function BackArrow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      title="Back"
      className="-ml-2 mb-4 inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-2 hover:bg-black/[0.04] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <path d="m12 19-7-7 7-7M19 12H5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Says what is missing while the button above it is disabled. */
function Missing({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 text-center text-[13px] text-ink-3" data-testid="ob-missing">
      {children}
    </p>
  );
}

/** A round mark above a step's title. */
function StepMark({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[#e6e8ec] bg-white text-ink shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      {children}
    </span>
  );
}

/** One line of a "what this does" list: a check, then the words. */
function CheckRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-[14px] leading-[1.5] text-ink">
      <Check size={16} className="mt-[3px] shrink-0 text-ink-3" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center pt-[8vh] sm:pt-12" data-testid="ob-welcome">
      <div className="mb-7 flex justify-center">
        <span className="inline-flex h-[72px] w-[72px] items-center justify-center rounded-[20px] border border-[#e6e8ec] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05),0_8px_24px_rgba(16,24,40,0.06)]">
          <Logo size={44} />
        </span>
      </div>
      <h1 className="text-[32px] sm:text-[36px] leading-[1.1] font-semibold tracking-[-0.025em] text-ink">
        Welcome to Orbit
      </h1>
      <p className="mt-3 text-[15px] leading-[1.55] text-ink-2 text-balance">
        Orbit finds the people in your network worth a coffee chat, and helps you write to them, one message
        at a time.
      </p>
      <ObPrimary className="mt-8" onClick={onNext}>
        Get started
      </ObPrimary>
      <p className="mt-4 text-[13px] text-ink-3">
        Takes about two minutes. Everything stays in this browser.
      </p>
    </div>
  );
}

/** The school domain an email implies ("umich.edu" for jpark@umich.edu), or '' for a non-school address. */
function autoDomain(email: string): string {
  return /@([\w.-]+\.edu)$/i.exec(email.trim())?.[1]?.toLowerCase() ?? '';
}

function StepYou({ onNext }: { onNext: () => void }) {
  const user = useSession().user!;
  const [f, setF] = useState({
    fullName: user.fullName,
    email: user.email,
    school: user.school,
    // no default: a guessed year would call a sophomore a junior in every message
    graduationYear: user.graduationYear ? String(user.graduationYear) : '',
  });
  const [busy, setBusy] = useState(false);
  // a school domain typed in Settings (not the one an email implied) is kept; otherwise the email decides it
  const emailDomain = (e: string) => (e.includes('@') ? e.split('@')[1]!.trim().toLowerCase() : '');
  const ownDomain =
    user.schoolDomain && user.schoolDomain !== emailDomain(user.email) ? user.schoolDomain : undefined;
  const domain = autoDomain(f.email);
  const missing = [
    !f.fullName.trim() && 'name',
    !f.email.includes('@') && 'email',
    !f.school.trim() && 'school',
    !f.graduationYear && 'graduation year',
  ].filter(Boolean) as string[];
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (missing.length || busy) return;
    setBusy(true);
    await updateProfile(user.id, {
      fullName: f.fullName,
      email: f.email.trim().toLowerCase(),
      school: f.school,
      schoolDomain: ownDomain ?? (domain || emailDomain(f.email) || undefined),
      graduationYear: Number(f.graduationYear),
    });
    onNext();
  };
  const now = new Date();
  const firstYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  // the years someone in a program now can graduate in: four for a bachelor's, more for a PhD
  const degree = user.degree ?? '';
  const grad = /\b(MBA|MS|MENG|PHD)\b/i.test(degree);
  const span = /PHD/i.test(degree) ? 6 : grad ? 2 : 4;
  const years = Array.from({ length: span }, (_, i) => firstYear + i);
  // a year saved earlier stays selectable, even one outside this list
  if (f.graduationYear && !years.includes(Number(f.graduationYear))) years.unshift(Number(f.graduationYear));
  return (
    <form onSubmit={save} noValidate>
      <ObHeader
        title="Tell us about you"
        subtitle="Orbit signs your messages with this and spots alumni from your school."
      />
      <div className="space-y-5">
        <div>
          <ObLabel htmlFor="ob-name">Full name</ObLabel>
          <ObInput
            id="ob-name"
            value={f.fullName}
            onChange={(e) => setF({ ...f, fullName: e.target.value })}
            placeholder="Alex Rivera"
            autoComplete="name"
            aria-required="true"
            data-testid="ob-name"
          />
        </div>
        <div>
          <ObLabel htmlFor="ob-email" hint="The one you recruit from">
            Email
          </ObLabel>
          <ObInput
            id="ob-email"
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            placeholder="alex@cornell.edu"
            autoComplete="email"
            aria-required="true"
            aria-describedby={domain ? 'ob-school-domain' : undefined}
            data-testid="ob-email"
          />
          {domain && !ownDomain ? (
            <p
              id="ob-school-domain"
              className="mt-1.5 text-[12.5px] text-ink-3"
              data-testid="ob-school-domain"
            >
              Orbit will look for {domain} addresses to spot alumni.
            </p>
          ) : null}
        </div>
        <div className="grid gap-5 sm:grid-cols-[1fr_168px] sm:gap-3">
          <div>
            <ObLabel htmlFor="ob-school">School</ObLabel>
            <ObInput
              id="ob-school"
              value={f.school}
              onChange={(e) => setF({ ...f, school: e.target.value })}
              placeholder="Cornell University"
              autoComplete="organization"
              aria-required="true"
              data-testid="ob-school"
            />
          </div>
          <div>
            <ObLabel htmlFor="ob-year">Graduation year</ObLabel>
            <ObSelect
              id="ob-year"
              value={f.graduationYear}
              onChange={(e) => setF({ ...f, graduationYear: e.target.value })}
              aria-required="true"
              className={f.graduationYear ? undefined : 'text-[#9aa1b0]'}
              data-testid="ob-year"
            >
              <option value="">Choose</option>
              {years.map((y) => (
                <option key={y} value={String(y)} className="text-ink">
                  {y} ({yearLabel(y, degree, now)})
                </option>
              ))}
            </ObSelect>
          </div>
        </div>
      </div>
      <ObPrimary type="submit" className="mt-8" disabled={missing.length > 0 || busy}>
        Continue
      </ObPrimary>
      {missing.length > 0 && (
        <Missing>Add your {missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} to continue.</Missing>
      )}
    </form>
  );
}

/** An example company that fits the first function the student picked, so a banker is not shown a tech company. */
const COMPANY_EXAMPLE: Record<string, string> = {
  ib: 'Evercore',
  finance: 'Blackstone',
  consulting: 'McKinsey',
  vc: 'Sequoia',
  design: 'Figma',
};

const PACE: { value: 1 | 2 | 3; count: number; label: string }[] = [
  { value: 1, count: 2, label: 'Steady' },
  { value: 2, count: 4, label: 'Focused' },
  { value: 3, count: 7, label: 'All in' },
];

function StepGoals({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  // null once read and absent; undefined only while loading
  const goals = useLiveQuery(async () => (await db.goals.get(user.id)) ?? null, [user.id]);
  const tcs =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
  const [fns, setFns] = useState<string[]>([]);
  const [ambition, setAmbition] = useState<1 | 2 | 3>(2);
  const [company, setCompany] = useState('');
  const [companyNote, setCompanyNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  useEffect(() => {
    // fill the form once from what is stored; later saves (Back, Continue) must not reset what is being chosen
    if (goals === undefined || loaded.current) return;
    loaded.current = true;
    if (goals) {
      setFns(goals.targetFunctions);
      setAmbition(goals.ambition);
    }
  }, [goals]);
  // "Evercore, Lazard" adds two companies
  const addCompany = async () => {
    // take the text now and clear the box at once, so a company typed while this one saves is kept
    const value = company;
    if (!value.trim()) return;
    setCompany('');
    let r: Awaited<ReturnType<typeof addTargetCompanies>>;
    try {
      r = await addTargetCompanies(user.id, value);
    } catch (e) {
      setCompany((current) => current || value);
      throw e;
    }
    setCompanyNote(
      r.duplicates.length
        ? `${r.duplicates.join(', ')} ${r.duplicates.length === 1 ? 'is' : 'are'} already on your list.`
        : '',
    );
  };
  /** Keep what is on screen, whichever way the student leaves the step (a company typed but not added included). */
  const persist = async () => {
    if (company.trim()) await addCompany();
    await saveGoals(
      user.id,
      {
        // the rest of the goals (roles, industries, places) are asked later, in Settings or by the chat
        cycleLabel: goals?.cycleLabel ?? `Summer ${new Date().getFullYear() + 1} internship`,
        targetFunctions: fns,
        ambition,
      },
      { applyAmbition: true },
    );
  };
  const extra = fns.filter((v) => !FUNCTION_LABELS[v]);
  const example = COMPANY_EXAMPLE[fns[0] ?? ''] ?? 'Stripe';
  return (
    <div>
      <BackArrow
        onClick={async () => {
          await persist();
          onBack();
        }}
      />
      <ObHeader
        title="What are you recruiting for?"
        subtitle="Orbit uses this to choose who to meet first."
      />
      <div className="space-y-7">
        <div>
          <ObLabel>What kind of work</ObLabel>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Kind of work">
            {[...Object.entries(FUNCTION_LABELS), ...extra.map((x) => [x, x] as const)].map(([k, l]) => {
              const on = fns.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFns(on ? fns.filter((x) => x !== k) : [...fns, k])}
                  className={cx(
                    'h-9 px-3.5 rounded-full text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
                    on ? 'bg-ink text-white' : 'bg-[#f1f2f4] text-ink-2 hover:bg-[#e8eaee] hover:text-ink',
                  )}
                  data-testid={`ob-fn-${k}`}
                >
                  {l}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <ObLabel htmlFor="ob-company" hint="Optional">
            Target companies
          </ObLabel>
          {/* a token field: each company is a chip with its star and remove button, typing adds the next */}
          <div
            className="min-h-11 w-full rounded-lg border border-[#d9dce3] bg-white px-1.5 py-1.5 flex flex-wrap items-center gap-1.5 transition-[border-color,box-shadow] hover:border-[#c3c8d2] focus-within:border-ink focus-within:ring-[3px] focus-within:ring-ink/[0.08] cursor-text"
            onClick={(e) => {
              if (e.target === e.currentTarget) inputRef.current?.focus();
            }}
          >
            {tcs.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center h-7 rounded-md bg-[#f1f2f4] pl-0.5 pr-0.5 text-[13.5px] text-ink"
              >
                <button
                  type="button"
                  className={cx(
                    'h-6 w-6 inline-flex items-center justify-center rounded hover:bg-black/[0.06]',
                    t.priority === 1 ? 'text-[#d99a00]' : 'text-ink-3',
                  )}
                  title={
                    t.priority === 1
                      ? 'Top priority. Click to make it a normal target'
                      : 'Mark as top priority'
                  }
                  aria-label={
                    t.priority === 1
                      ? `Make ${t.nameRaw} a normal target`
                      : `Mark ${t.nameRaw} as top priority`
                  }
                  aria-pressed={t.priority === 1}
                  onClick={() => setTargetPriority(t.id, t.priority === 1 ? 2 : 1)}
                >
                  <Star size={13} fill={t.priority === 1 ? 'currentColor' : 'none'} aria-hidden />
                </button>
                <span className="px-1">{t.nameRaw}</span>
                <button
                  type="button"
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-ink-3 hover:text-ink hover:bg-black/[0.06]"
                  onClick={() => removeTargetCompany(t.id)}
                  aria-label={`Remove ${t.nameRaw}`}
                  title={`Remove ${t.nameRaw}`}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              id="ob-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ',') return;
                e.preventDefault();
                addCompany();
              }}
              placeholder={tcs.length ? 'Add another' : `${example}, or a few separated by commas`}
              className="flex-1 min-w-[9rem] h-7 bg-transparent px-2 text-[15px] text-ink placeholder:text-[#9aa1b0] outline-none"
              data-testid="ob-company"
            />
            {company.trim() ? (
              <button
                type="button"
                onClick={addCompany}
                className="h-7 px-2.5 rounded-md bg-ink text-white text-[13px] font-medium hover:bg-[#262d3f]"
              >
                Add
              </button>
            ) : null}
          </div>
          {companyNote ? (
            <p className="text-[12.5px] text-ink-3 mt-1.5" role="status">
              {companyNote}
            </p>
          ) : tcs.length > 0 ? (
            <p className="text-[12.5px] text-ink-3 mt-1.5">Star a company to make it a top priority.</p>
          ) : null}
        </div>
        <div>
          <ObLabel hint="A goal, not a limit">First messages a week</ObLabel>
          <div
            role="radiogroup"
            aria-label="First messages a week"
            className="grid grid-cols-3 gap-1 rounded-[10px] bg-[#f1f2f4] p-1"
          >
            {PACE.map((p) => {
              const on = ambition === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setAmbition(p.value)}
                  className={cx(
                    'h-14 rounded-lg flex flex-col items-center justify-center transition-[background-color,box-shadow,color] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
                    on
                      ? 'bg-white text-ink shadow-[0_1px_2px_rgba(16,24,40,0.08),0_1px_1px_rgba(16,24,40,0.04)]'
                      : 'text-ink-2 hover:text-ink',
                  )}
                  data-testid={`ob-pace-${p.value}`}
                >
                  <span className="text-[14.5px] font-medium tabular-nums">{p.count} a week</span>
                  <span className={cx('text-[12px]', on ? 'text-ink-2' : 'text-ink-3')}>{p.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <ObPrimary
        className="mt-8"
        disabled={!fns.length || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await persist();
            onNext();
          } finally {
            setBusy(false);
          }
        }}
      >
        Continue
      </ObPrimary>
      {!fns.length && <Missing>Pick at least one kind of work to continue.</Missing>}
    </div>
  );
}

function StepLinkedIn({ onNext }: { onNext: () => void }) {
  const user = useSession().user!;
  // once the live sign-in says it is not switched on, the step stops offering it: no button that can only fail
  const [liveOff, setLiveOff] = useState(false);
  const live = liveLinkedInAvailable(user) && !liveOff;
  const [showUpload, setShowUpload] = useState(!live);
  const [busy, setBusy] = useState<string>();
  const [upBusy, setUpBusy] = useState<string>();
  const [result, setResult] = useState<string>();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  // an import done earlier (before Back, or on another visit) still shows, so the step never looks undone
  const earlier = useLiveQuery(
    () =>
      db.integrations
        .where('userId')
        .equals(user.id)
        .filter((i) => isLinkedIn(i.provider))
        .first(),
    [user.id],
  );
  const connectLive = async () => {
    setError(undefined);
    setNote(undefined);
    setBusy('Waiting for LinkedIn…');
    try {
      const r = await connectLinkedInLive(user, {
        onProgress: (n) => setBusy(`Importing ${n} connections…`),
      });
      if (r.ok) setResult(`${r.rows} connections imported, ${r.added} of them new.`);
      else if (r.reason === 'unconfigured') {
        setNote(r.message);
        setLiveOff(true);
        setShowUpload(true);
      } else if (r.reason === 'error') setError(r.message);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  const onFile = async (f: File) => {
    setUpBusy('Importing…');
    setError(undefined);
    try {
      const r = await importLinkedInExport(user, await connectionsText(f), (d, t) =>
        setUpBusy(`Importing ${d}/${t}…`),
      );
      if (r.imported + r.updated === 0) {
        setError(
          'Orbit found nobody in that file. Upload Connections.csv from the LinkedIn export, or the ZIP.',
        );
        return;
      }
      setResult(
        `${r.imported} people added${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} rows skipped` : ''}.`,
      );
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setUpBusy(undefined);
    }
  };
  const doneBefore =
    !result && earlier
      ? `${String((earlier.syncState as { rows?: number }).rows ?? 0)} connections imported.`
      : '';
  const done = !!(result || doneBefore);
  return (
    <div>
      <ObHeader
        icon={
          <StepMark>
            <Linkedin size={22} aria-hidden />
          </StepMark>
        }
        title="Bring in your LinkedIn"
        subtitle="Orbit looks through the people you already know for alumni and anyone at your target companies."
      />
      {done ? (
        <div
          className="flex items-center gap-3 rounded-xl border border-[#e6e8ec] bg-white px-4 py-3.5 text-[14px]"
          data-testid="ob-linkedin-done"
        >
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-good text-white">
            <Check size={14} aria-hidden />
          </span>
          <span className="text-ink">{result || doneBefore}</span>
        </div>
      ) : live ? (
        <ObPanel>
          <ul className="divide-y divide-[#eef0f3]">
            <CheckRow>Brings in your connections with their companies and titles.</CheckRow>
            <CheckRow>Keeps them up to date, so new connections show up on their own.</CheckRow>
            <CheckRow>You approve every message before it goes anywhere.</CheckRow>
          </ul>
        </ObPanel>
      ) : null}
      {note && (
        <p
          className="mb-4 rounded-lg bg-[#f1f2f4] px-3.5 py-2.5 text-[13.5px] text-ink-2 text-center"
          role="status"
        >
          {note}
        </p>
      )}
      {!done && showUpload && (
        <div className={live ? 'mt-4' : undefined}>
          <ObPanel>
            <ol className="px-4 py-3.5 space-y-2 text-[13.5px] leading-[1.5] text-ink-2 list-decimal pl-9">
              <li>
                On LinkedIn, open{' '}
                <strong className="font-medium text-ink">
                  Settings, Data privacy, Get a copy of your data
                </strong>
                .
              </li>
              <li>
                Choose <strong className="font-medium text-ink">Connections</strong> and request the archive.
                It arrives by email, usually within ten minutes.
              </li>
              <li>Upload the ZIP as it is, or Connections.csv from inside it.</li>
            </ol>
          </ObPanel>
          <label className="mt-3 flex h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#cfd3db] bg-white text-ink transition-colors hover:border-ink/40 hover:bg-[#fafbfc] focus-within:border-ink focus-within:ring-[3px] focus-within:ring-ink/[0.08]">
            <input
              type="file"
              accept=".csv,.zip"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onFile(file);
              }}
              data-testid="ob-linkedin"
            />
            {upBusy ? <Spinner /> : <Upload size={18} className="text-ink-3" aria-hidden />}
            <span className="text-[14px] font-medium">
              {upBusy ?? (earlier ? 'Upload a newer export' : 'Upload the ZIP or Connections.csv')}
            </span>
          </label>
        </div>
      )}
      {error && (
        <p className="mt-3 text-[13px] text-bad text-center" role="alert">
          {error}
        </p>
      )}
      <div className="mt-8 space-y-3">
        {done ? (
          <ObPrimary onClick={onNext}>Continue</ObPrimary>
        ) : live ? (
          <>
            <ObPrimary onClick={connectLive} disabled={!!busy} data-testid="ob-linkedin-live">
              {busy ? (
                <>
                  <Spinner className="border-white/30 border-t-white" /> {busy}
                </>
              ) : (
                'Connect LinkedIn'
              )}
            </ObPrimary>
            {!showUpload && (
              <ObSecondary onClick={() => setShowUpload(true)} data-testid="ob-linkedin-upload">
                Upload your export instead
              </ObSecondary>
            )}
          </>
        ) : null}
        {!done && (
          <ObQuiet onClick={onNext} data-testid="ob-skip">
            I'll do this later
          </ObQuiet>
        )}
      </div>
    </div>
  );
}

function StepGmail({ onNext }: { onNext: () => void }) {
  const user = useSession().user!;
  const [clientId, setClientId] = useState(googleClientId() ?? '');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const account = useLiveQuery(
    () =>
      db.integrations
        .where('userId')
        .equals(user.id)
        .filter((i) => i.provider === 'google')
        .first(),
    [user.id],
  );
  const connect = async () => {
    setError(undefined);
    try {
      setBusy('Waiting for Google…');
      const { warning } = await connectAndSyncGoogle(user, {
        clientId,
        fresh: true,
        onProgress: (p) => setBusy(`${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
      });
      setBusy(undefined);
      setError(warning);
    } catch (e) {
      setBusy(undefined);
      setError(String((e as Error).message ?? e));
    }
  };
  // A copy of Orbit set up with its own Google sign-in needs nothing from the student but a click. Without one, the
  // client ID field is for someone who runs their own copy, so it waits behind a closed section.
  const builtIn = !!envGoogleClientId();
  return (
    <div>
      <ObHeader
        icon={
          <StepMark>
            <Mail size={22} aria-hidden />
          </StepMark>
        }
        title="Connect Gmail & Calendar"
        subtitle="Orbit finds the people you already email and meet, and notices when they reply."
      />
      {builtIn || account ? (
        <ObPanel>
          <ul className="divide-y divide-[#eef0f3]">
            <CheckRow>Reads conversations with real people, never newsletters.</CheckRow>
            <CheckRow>Sees who you have met, so a thank-you is never forgotten.</CheckRow>
            <CheckRow>Sends only the messages you approve. Everything stays in this browser.</CheckRow>
          </ul>
        </ObPanel>
      ) : (
        <div
          className="rounded-xl border border-[#e6e8ec] bg-white px-4 py-3.5 text-[14px]"
          data-testid="ob-google-unavailable"
        >
          <p className="font-medium text-ink">Google sign-in is not set up on this copy of Orbit.</p>
          <p className="text-ink-2 mt-1">
            That is fine. You can add people by hand or bring in LinkedIn, and approved emails open in your
            mail app.
          </p>
        </div>
      )}
      {account && (
        <p className="mt-3 text-center text-[13px] text-good inline-flex w-full items-center justify-center gap-1">
          <Check size={14} aria-hidden /> Connected
          {account.externalAccountId ? ` as ${account.externalAccountId}` : ''}
        </p>
      )}
      {error && (
        <p className="mt-3 text-[13px] text-bad text-center" role="alert">
          {error}
        </p>
      )}
      <div className="mt-8 space-y-3">
        {builtIn || account ? (
          <>
            {account ? (
              <ObPrimary onClick={onNext}>Continue</ObPrimary>
            ) : (
              <ObPrimary
                onClick={connect}
                disabled={!!busy || !clientId.trim()}
                data-testid="ob-gmail-connect"
              >
                {busy ? (
                  <>
                    <Spinner /> {busy}
                  </>
                ) : (
                  'Connect Gmail & Calendar'
                )}
              </ObPrimary>
            )}
            {account ? (
              <ObQuiet onClick={connect} disabled={!!busy} data-testid="ob-gmail-connect">
                {busy ?? 'Reconnect and sync'}
              </ObQuiet>
            ) : (
              <ObQuiet onClick={onNext} data-testid="ob-skip">
                I'll do this later
              </ObQuiet>
            )}
          </>
        ) : (
          <ObPrimary onClick={onNext} data-testid="ob-skip">
            Continue
          </ObPrimary>
        )}
      </div>
      {!builtIn && (
        <details className="mt-8 text-[13px]">
          <summary className="cursor-pointer text-center text-ink-3 hover:text-ink">
            For developers: connect your own Google Cloud project
          </summary>
          <div className="mt-3">
            <ObLabel htmlFor="ob-client-id">OAuth client ID</ObLabel>
            <p className="-mt-1 mb-2 text-[12px] text-ink-3">
              Google Cloud, APIs and Services, Credentials, OAuth client (Web application), with this site as
              an authorised JavaScript origin.
            </p>
            <div className="flex gap-2">
              <ObInput
                id="ob-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="1234567890-abc.apps.googleusercontent.com"
                className="flex-1 min-w-0 text-[13px]"
              />
              <ObSecondary
                onClick={connect}
                disabled={!!busy || !clientId.trim()}
                className="w-auto shrink-0 px-4 text-[14px]"
              >
                Connect
              </ObSecondary>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function StepReady({
  google,
  onFinish,
  onJump,
}: {
  google: boolean;
  onFinish: () => Promise<void>;
  onJump: (step: number) => void;
}) {
  const user = useSession().user!;
  const [busy, setBusy] = useState(false);
  const info = useLiveQuery(async () => {
    const [goals, companies, ints] = await Promise.all([
      db.goals.get(user.id),
      db.targetCompanies.where('userId').equals(user.id).count(),
      db.integrations.where('userId').equals(user.id).toArray(),
    ]);
    return {
      goals,
      companies,
      linkedin: ints.find((i) => isLinkedIn(i.provider)),
      google: ints.find((i) => i.provider === 'google'),
    };
  }, [user.id]);
  const fns = (info?.goals?.targetFunctions ?? []).map((f) => FUNCTION_LABELS[f] ?? f);
  const rows: { key: string; title: string; detail: string; ok: boolean; step: number }[] = [
    {
      key: 'you',
      title: 'Your profile',
      detail: [user.fullName, user.school, user.graduationYear ? `class of ${user.graduationYear}` : '']
        .filter(Boolean)
        .join(', '),
      ok: true,
      step: STEP.you,
    },
    {
      key: 'goals',
      title: 'Goals',
      detail: [
        fns.length > 2 ? `${fns.slice(0, 2).join(', ')} and ${fns.length - 2} more` : fns.join(' and '),
        info?.companies ? `${info.companies} target ${info.companies === 1 ? 'company' : 'companies'}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      ok: fns.length > 0,
      step: STEP.goals,
    },
    {
      key: 'linkedin',
      title: 'LinkedIn',
      detail: info?.linkedin
        ? `${String((info.linkedin.syncState as { rows?: number }).rows ?? 0)} connections imported`
        : 'Skipped for now',
      ok: !!info?.linkedin,
      step: STEP.linkedin,
    },
  ];
  if (google)
    rows.push({
      key: 'gmail',
      title: 'Gmail & Calendar',
      detail: info?.google
        ? `Connected${info.google.externalAccountId ? ` as ${info.google.externalAccountId}` : ''}`
        : 'Skipped for now',
      ok: !!info?.google,
      step: STEP.gmail,
    });
  const skipped = rows.some((r) => !r.ok);
  return (
    <div data-testid="ob-ready">
      <ObHeader
        icon={
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-ink text-white">
            <Check size={22} aria-hidden />
          </span>
        }
        title="You're all set"
        subtitle={
          skipped
            ? 'Anything skipped can be added later in Settings, or just ask Orbit in the chat.'
            : 'Orbit has what it needs to find your first people to meet.'
        }
      />
      <ObPanel>
        <ul className="divide-y divide-[#eef0f3]">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center gap-3 px-4 py-3.5"
              data-testid={`ob-ready-${r.key}`}
              data-status={r.ok ? 'done' : 'skipped'}
            >
              <span
                className={cx(
                  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                  r.ok ? 'bg-good text-white' : 'bg-[#f1f2f4] text-ink-3',
                )}
              >
                {r.ok ? <Check size={14} aria-hidden /> : <Minus size={14} aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-ink">{r.title}</span>
                <span className="block text-[13px] leading-[1.45] text-ink-3">{r.detail}</span>
              </span>
              {!r.ok && (
                <button
                  type="button"
                  onClick={() => onJump(r.step)}
                  className="shrink-0 rounded-md px-2 py-1 text-[13px] font-medium text-ink-2 hover:text-ink hover:bg-black/[0.04]"
                >
                  {r.key === 'goals' ? 'Add' : 'Connect'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </ObPanel>
      <ObPrimary
        className="mt-8"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onFinish();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <>
            <Spinner className="border-white/30 border-t-white" /> Opening Orbit…
          </>
        ) : (
          'Open Orbit'
        )}
      </ObPrimary>
    </div>
  );
}
