import type { GoalKind, OwnWordsKey, User } from '@orbit/core';
import {
  answeredCount,
  CURRENT_JOB_MAX,
  currentJobInput,
  currentJobLabel,
  FUNCTION_LABELS,
  GOAL_KINDS,
  OWN_WORDS_MAX,
  OWN_WORDS_QUESTIONS,
  OWN_WORDS_TOTAL,
  ownWordsOf,
  parseCurrentJob,
  schoolShort,
  yearLabel,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Briefcase, Check, Linkedin, Link as LinkIcon, Mail, Minus, Plus, Upload, X } from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { ImportProgress } from '../components/account/ImportProgress';
import { CompanyLogo } from '../components/CompanyLogo';
import {
  ObBack,
  ObHeader,
  ObInput,
  ObLabel,
  ObPanel,
  ObPrimary,
  ObQuiet,
  ObSecondary,
  ObSelect,
  ObTextArea,
  OnboardingLayout,
} from '../components/onboarding/OnboardingLayout';
import { useWeeklyLimits, WeeklyTargetSlider } from '../components/WeeklyTargetSlider';
import { suggestCompanies } from '../data/companies';
import { suggestSchools } from '../data/schools';
import { db } from '../db/schema';
import { buildFirstBrief, markOnboardingDone, setOnboardingStep } from '../engine/account';
import { LINKEDIN_RISK_SENTENCE } from '../engine/consent';
import { archiveGoal, GOAL_KIND_LABELS, GOAL_KIND_TITLES, listGoals, saveGoal } from '../engine/goals';
import { connectAndSyncGoogle } from '../engine/integrations';
import { connectionsText, importLinkedInExport } from '../engine/linkedin';
import { connectLinkedInLive, liveLinkedInAvailable } from '../engine/linkedinLive';
import { type OwnWordsPatch, saveOwnWords } from '../engine/ownWords';
import { saveResume } from '../engine/resume';
import { pullNow } from '../engine/serverSync';
import { removeTargetCompany, saveGoals, updateLimits, updateProfile } from '../engine/settings';
import { addTargetCompanies } from '../engine/targets';
import { googleClientId } from '../integrations/google';
import { startGoogleSignIn } from '../integrations/orbitApi';
import { postingFromPath, readPosting } from '../integrations/postings';
import { envGoogleClientId } from '../integrations/prefs';
import { useAccount } from '../state/account';
import { useSession } from '../state/session';
import { cx, Spinner } from '../ui';
import { Suggest } from '../ui/Suggest';
import {
  OPTIONAL_STEPS,
  QUESTION_STEPS,
  resolveStep,
  STEP,
  STEP_TITLES,
  stepAddress,
  stepFromAddress,
  stepStatuses,
  visibleSteps,
} from './onboardingSteps';

export { onboardingPath } from './onboardingPath';

/** A connected LinkedIn: how many came in, or, before the first of them has, that they are on their way. */
function linkedinSoFar(n: number): string {
  return n ? connectionsImported(n) : 'Connected, your connections are coming in';
}

/** A LinkedIn import of either kind: the export file, or the live connection once it exists. */
function connectionsImported(n: number): string {
  return `${n} ${n === 1 ? 'connection' : 'connections'} imported`;
}

function isLinkedIn(provider: string): boolean {
  return provider === 'linkedin_csv' || provider === 'linkedin_live';
}

export function Onboarding() {
  const { step: stepParam } = useParams();
  const step = stepFromAddress(stepParam);
  const nav = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  const account = useAccount();
  // signed in to an Orbit account: Google came with the sign-in, and the server reads the mail
  const signedIn = account.signedIn && !!user && account.user?.id === user.id;
  // what the optional steps actually produced, so a skipped step never shows as done
  const did = useLiveQuery(async () => {
    if (!user) return {};
    const ints = await db.integrations.where('userId').equals(user.id).toArray();
    const w = ownWordsOf(await db.goals.get(user.id));
    return {
      [STEP.aim]: !!(w.aim || w.success),
      [STEP.story]: !!(w.story || w.proudOf),
      [STEP.people]: !!w.wantToMeet,
      [STEP.style]: !!(w.networkingHard || w.neverDo),
      [STEP.job]: !!w.currentJob,
      [STEP.linkedin]: ints.some((i) => isLinkedIn(i.provider)),
      [STEP.gmail]: ints.some((i) => i.provider === 'google'),
    } as Record<number, boolean>;
  }, [user?.id]);
  const google = !!googleClientId();
  const STEPS = visibleSteps(google, signedIn);
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
    const furthest = resolveStep(user.onboardingStep, google, signedIn);
    const internal = (location.state as { fromStep?: number } | null)?.fromStep !== undefined;
    let target = resolveStep(step, google, signedIn);
    if (!internal && target > furthest) target = furthest;
    if (target !== step) return <Navigate to={`/onboarding/${stepAddress(target)}`} replace />;
  }
  const after = (s: number) => STEPS.find((x) => x > s) ?? STEP.ready;
  const before = (s: number) => [...STEPS].reverse().find((x) => x < s) ?? STEP.welcome;
  const go = async (next: number) => {
    await setOnboardingStep(user.id, next);
    nav(`/onboarding/${stepAddress(next)}`, { state: { fromStep: step } });
  };
  // Back is the browser's Back when the step before is where the student came from, so the browser's own Back
  // button afterwards keeps going back instead of returning to the step just left
  const back = (to: number) => {
    if ((location.state as { fromStep?: number } | null)?.fromStep === to) nav(-1);
    else nav(`/onboarding/${stepAddress(to)}`, { replace: true, state: { fromStep: step } });
  };
  const jump = (to: number) => nav(`/onboarding/${stepAddress(to)}`, { state: { fromStep: step } });
  // a step reached from a later one (Back, or an Add on Ready) slides in from the left
  const from = (location.state as { fromStep?: number } | null)?.fromStep;
  const direction = from !== undefined && from > step ? 'back' : 'forward';
  const finish = async () => {
    // Orbit opens at once; the first brief is built behind it (account mode: from what the server has read so far,
    // pulled first) and shows up on Home as soon as it is ready
    const fresh = await markOnboardingDone(user.id);
    nav('/');
    if (!fresh) return;
    void (async () => {
      if (signedIn) await pullNow(user.id).catch(() => undefined);
      await buildFirstBrief(fresh).catch((e) => console.warn('first brief', e));
    })();
  };
  const statuses = stepStatuses(STEPS, step, did ?? {});
  const onBack = step === STEP.welcome ? undefined : () => back(before(step));
  let body: ReactNode = null;
  if (step === STEP.welcome)
    body = (
      <StepWelcome accountMode={account.mode} signedIn={signedIn} onNext={() => go(after(STEP.welcome))} />
    );
  else if (step === STEP.you) body = <StepYou onNext={() => go(after(STEP.you))} />;
  else if (step === STEP.goals)
    body = <StepGoals onNext={() => go(after(STEP.goals))} onBack={() => back(before(STEP.goals))} />;
  else if (QUESTION_STEPS.includes(step))
    body = (
      <StepWords step={step} onNext={() => go(after(step))} onBack={() => back(before(step))} user={user} />
    );
  else if (step === STEP.linkedin)
    body = <StepLinkedIn signedIn={signedIn} onNext={() => go(after(STEP.linkedin))} />;
  else if (step === STEP.gmail) body = <StepGmail onNext={() => go(after(STEP.gmail))} />;
  else if (step === STEP.ready)
    body = (
      <StepReady
        google={google}
        account={signedIn ? account.user?.email : undefined}
        onFinish={finish}
        onJump={jump}
      />
    );
  return (
    <OnboardingLayout
      steps={STEPS.map((s, i) => ({ title: STEP_TITLES[s]!, status: statuses[i]! }))}
      index={idx}
      optional={OPTIONAL_STEPS.has(step)}
      stepKey={step}
      direction={direction}
      // Goals and the written questions save what is on screen before they go back, so they bring their own Back
      onBack={step === STEP.goals || QUESTION_STEPS.includes(step) ? undefined : onBack}
    >
      {signedIn && step !== STEP.welcome && step !== STEP.ready ? (
        <ImportProgress firstName={user.firstName} />
      ) : null}
      {body}
    </OnboardingLayout>
  );
}

/** The back arrow for a step that must save before it leaves (the layout's arrow, with the step's own action). */
function BackArrow({ onClick }: { onClick: () => void }) {
  return <ObBack onClick={onClick} />;
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
    <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-white text-ink shadow-[var(--shadow-card)]">
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

function StepWelcome({
  onNext,
  accountMode,
  signedIn,
}: {
  onNext: () => void;
  /** this build has an Orbit server: Google sign-in is offered first */
  accountMode?: boolean;
  signedIn?: boolean;
}) {
  const offerGoogle = accountMode && !signedIn;
  return (
    <div className="text-center pt-[8vh] sm:pt-12" data-testid="ob-welcome">
      <div className="mb-7 flex justify-center">
        <span className="inline-flex h-[72px] w-[72px] items-center justify-center rounded-[20px] border border-line bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05),0_8px_24px_rgba(16,24,40,0.06)]">
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
      {offerGoogle ? (
        <>
          <ObPrimary className="mt-8" onClick={() => startGoogleSignIn()} data-testid="ob-google-signin">
            <GoogleMark /> Continue with Google
          </ObPrimary>
          <ObQuiet className="mt-3" onClick={onNext} data-testid="ob-without-google">
            Get started without Google
          </ObQuiet>
          <p className="mt-4 text-[13px] text-ink-3 text-balance">
            Orbit reads your email and calendar to find who you know. You approve every message before it goes
            anywhere.
          </p>
        </>
      ) : (
        <>
          <ObPrimary className="mt-8" onClick={onNext}>
            {signedIn ? 'Continue' : 'Get started'}
          </ObPrimary>
          <p className="mt-4 text-[13px] text-ink-3">
            {signedIn
              ? 'Signed in with Google. A few questions and you are in.'
              : 'Takes about three minutes. Everything stays in this browser.'}
          </p>
        </>
      )}
    </div>
  );
}

/** Google's "G", drawn inline (no external image under the CSP). */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden className="mr-1 shrink-0">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
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
  // the resume is optional and saved as soon as it is picked, so Back and Continue never lose it
  const resume = useLiveQuery(
    async () => (await db.resumes.where('userId').equals(user.id).toArray()).find((r) => r.isCurrent) ?? null,
    [user.id],
  );
  const [reading, setReading] = useState(false);
  const [resumeError, setResumeError] = useState<string>();
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
    // saved here at once; the copy on the account goes up behind the next step, so Continue never waits on the server
    void updateProfile(user.id, {
      fullName: f.fullName,
      email: f.email.trim().toLowerCase(),
      school: f.school,
      schoolDomain: ownDomain ?? (domain || emailDomain(f.email) || undefined),
      graduationYear: Number(f.graduationYear),
    }).catch((err) => console.warn('profile', err));
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
            <Suggest
              id="ob-school"
              input={ObInput}
              value={f.school}
              onChange={(school) => setF({ ...f, school })}
              suggest={suggestSchools}
              minChars={2}
              placeholder="Start typing your school"
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
              className={f.graduationYear ? undefined : 'text-[#a59f97]'}
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
        <div>
          <ObLabel htmlFor="ob-resume" hint="Optional">
            Resume
          </ObLabel>
          <label
            className="flex items-center gap-3 h-11 px-3.5 rounded-[10px] border border-dashed border-line bg-white cursor-pointer hover:border-[#cfcdc9] focus-within:ring-[3px] focus-within:ring-ink/15"
            data-testid="ob-resume"
          >
            <input
              id="ob-resume"
              type="file"
              accept=".pdf,.txt,.md,.docx"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setResumeError(undefined);
                setReading(true);
                try {
                  await saveResume(user, file);
                } catch (err) {
                  setResumeError(err instanceof Error ? err.message : 'Orbit could not read that file.');
                } finally {
                  setReading(false);
                }
              }}
            />
            <Upload size={16} className="text-ink-3 shrink-0" aria-hidden />
            <span className="text-[14px] text-ink-2 truncate">
              {reading ? 'Reading your resume…' : resume ? resume.filename : 'Add your resume (PDF or Word)'}
            </span>
            {resume && !reading && <Check size={15} className="ml-auto text-good shrink-0" aria-hidden />}
          </label>
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            {resumeError ??
              'Orbit uses it to describe you in first messages and to spot people with your background.'}
          </p>
        </div>
      </div>
      <ObPrimary type="submit" className="mt-8" disabled={missing.length > 0 || busy || reading}>
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

/** The goals' ambition level a weekly target stands for (the brief and the chat still read the level). */
function ambitionFor(weekly: number): 1 | 2 | 3 {
  return weekly <= 3 ? 1 : weekly <= 7 ? 2 : 3;
}

function StepGoals({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  const limits = useWeeklyLimits(user.id);
  // null once read and absent; undefined only while loading
  const goals = useLiveQuery(async () => (await db.goals.get(user.id)) ?? null, [user.id]);
  const tcs =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
  const [fns, setFns] = useState<string[]>([]);
  // what the student is working toward (plan 16 §17): recruiting unless they pick otherwise
  const [kinds, setKinds] = useState<GoalKind[]>(['recruiting']);
  const [goalError, setGoalError] = useState<string>();
  const kindsLoaded = useRef(false);
  useEffect(() => {
    if (kindsLoaded.current) return;
    kindsLoaded.current = true;
    listGoals(user.id).then((gs) => {
      const active = gs.filter((g) => g.status === 'active').map((g) => g.kind);
      if (active.length) setKinds([...new Set(active)]);
    });
  }, [user.id]);
  const recruiting = kinds.includes('recruiting');
  const [weekly, setWeekly] = useState(4);
  const storedWeekly = useLiveQuery(
    async () => (await db.settings.get(user.id))?.weeklyOutreachTarget,
    [user.id],
  );
  const [company, setCompany] = useState('');
  const [companyNote, setCompanyNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // one component for the whole step: a new one each render would remount the field and lose the cursor
  const CompanyInput = useMemo(
    () =>
      function CompanyField(props: InputHTMLAttributes<HTMLInputElement>) {
        return (
          <input
            {...props}
            ref={inputRef}
            className="w-full h-7 bg-transparent px-2 text-[15px] text-ink placeholder:text-[#a59f97] outline-none"
          />
        );
      },
    [],
  );
  const loaded = useRef(false);
  useEffect(() => {
    // fill the form once from what is stored; later saves (Back, Continue) must not reset what is being chosen
    if (goals === undefined || loaded.current) return;
    loaded.current = true;
    if (goals) setFns(goals.targetFunctions);
  }, [goals]);
  // the weekly goal is read on its own: it lives in the settings, which can arrive after the goals
  const weeklyLoaded = useRef(false);
  useEffect(() => {
    if (storedWeekly === undefined || weeklyLoaded.current) return;
    weeklyLoaded.current = true;
    setWeekly(storedWeekly);
  }, [storedWeekly]);
  // "Evercore, Lazard" adds two companies
  const addCompany = async (picked?: string) => {
    // take the text now and clear the box at once, so a company typed while this one saves is kept
    const value = picked ?? company;
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
  /** One goal per kind picked (a kind unpicked again is archived), on the server in account mode. */
  const saveKinds = async () => {
    const existing = await listGoals(user.id);
    const companies = (await db.targetCompanies.where('userId').equals(user.id).toArray()).map(
      (t) => t.nameRaw,
    );
    for (const kind of kinds)
      if (!existing.some((g) => g.kind === kind && g.status === 'active'))
        await saveGoal(user, {
          kind,
          title: GOAL_KIND_TITLES[kind],
          source: 'onboarding',
          targets: { organizations: companies.slice(0, 20), roles: [], geographies: [], people: [] },
        });
    for (const g of existing)
      if (g.source === 'onboarding' && g.status === 'active' && !kinds.includes(g.kind))
        await archiveGoal(user, g.id);
  };
  /** Keep what is on screen, whichever way the student leaves the step (a company typed but not added included). */
  const persist = async () => {
    if (company.trim()) await addCompany();
    await saveGoals(user.id, {
      // the rest of the goals (roles, industries, places) are asked later, in Settings or by the chat
      cycleLabel: goals?.cycleLabel ?? `Summer ${new Date().getFullYear() + 1} internship`,
      targetFunctions: fns,
      ambition: ambitionFor(weekly),
    });
    await updateLimits(user.id, { weeklyOutreachTarget: weekly });
  };
  const extra = fns.filter((v) => !FUNCTION_LABELS[v]);
  const example = COMPANY_EXAMPLE[fns[0] ?? ''] ?? 'Stripe';
  return (
    <div>
      <BackArrow
        onClick={async () => {
          // Back always goes back, even if saving the picks failed
          await persist().catch((err) => console.warn('goals', err));
          onBack();
        }}
      />
      <ObHeader
        title="What are you working toward?"
        subtitle="Pick all that fit. Orbit uses this to choose who to meet first and how to write to them."
      />
      <div className="space-y-7">
        <div>
          <ObLabel>Goals</ObLabel>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Goals">
            {GOAL_KINDS.map((k) => {
              const on = kinds.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  title={GOAL_KIND_TITLES[k]}
                  onClick={() => setKinds(on ? kinds.filter((x) => x !== k) : [...kinds, k])}
                  className={cx(
                    'h-9 px-3.5 rounded-full text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
                    on
                      ? 'bg-ink text-white border border-ink'
                      : 'bg-white border border-line text-ink-2 hover:text-ink hover:border-[#d4d2ce]',
                  )}
                  data-testid={`ob-goal-${k}`}
                >
                  {GOAL_KIND_LABELS[k]}
                </button>
              );
            })}
          </div>
        </div>
        {recruiting && (
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
                      on
                        ? 'bg-ink text-white border border-ink'
                        : 'bg-white border border-line text-ink-2 hover:text-ink hover:border-[#d4d2ce]',
                    )}
                    data-testid={`ob-fn-${k}`}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div>
          <ObLabel htmlFor="ob-company" hint="Optional">
            Target companies
          </ObLabel>
          {/* a token field: each company is a chip with its logo and remove button, typing adds the next */}
          <div
            className="min-h-11 w-full rounded-[10px] border border-line bg-white px-1.5 py-1.5 flex flex-wrap items-center gap-1.5 transition-[border-color,box-shadow] hover:border-[#d4d2ce] focus-within:border-ink focus-within:ring-[3px] focus-within:ring-ink/[0.08] cursor-text"
            onClick={(e) => {
              if (e.target === e.currentTarget) inputRef.current?.focus();
            }}
          >
            {tcs.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center h-7 rounded-md bg-canvas-2 pl-1.5 pr-0.5 text-[13.5px] text-ink"
              >
                <CompanyLogo name={t.nameRaw} size={16} decorative />
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
            {/* suggestions with each company's logo as you type; a pick adds it at once, anything typed still counts */}
            <Suggest
              className="flex-1 min-w-[9rem]"
              input={CompanyInput}
              id="ob-company"
              value={company}
              onChange={setCompany}
              suggest={(q) =>
                suggestCompanies(
                  q,
                  tcs.map((t) => t.nameRaw),
                )
              }
              onPick={(sg) => void addCompany(sg.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ',') return;
                // Enter on a highlighted suggestion picks it (Suggest handles that)
                if (e.key === 'Enter' && (e.target as HTMLInputElement).getAttribute('aria-activedescendant'))
                  return;
                e.preventDefault();
                addCompany();
              }}
              placeholder={tcs.length ? 'Add another' : `${example}, or a few separated by commas`}
              data-testid="ob-company"
            />
            {company.trim() ? (
              <button
                type="button"
                onClick={() => addCompany()}
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
          ) : null}
        </div>
        <div>
          <ObLabel hint="A goal, not a limit">First messages a week</ObLabel>
          <WeeklyTargetSlider value={weekly} onChange={setWeekly} testId="ob-pace" limits={limits} />
        </div>
      </div>
      <ObPrimary
        className="mt-8"
        disabled={!kinds.length || (recruiting && !fns.length) || busy}
        onClick={async () => {
          setBusy(true);
          setGoalError(undefined);
          try {
            await persist();
            await saveKinds();
            onNext();
          } catch (e) {
            setGoalError(String((e as Error).message ?? e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Continue
      </ObPrimary>
      {goalError && (
        <p className="mt-3 text-[13px] text-bad text-center" role="alert">
          {goalError}
        </p>
      )}
      {!kinds.length ? (
        <Missing>Pick what you're working toward to continue.</Missing>
      ) : recruiting && !fns.length ? (
        <Missing>Pick at least one kind of work to continue.</Missing>
      ) : null}
    </div>
  );
}

/** What each written step asks (plan 24): a title, a line under it and at most two questions. */
const WORD_STEPS: Record<number, { title: string; subtitle: string; keys: OwnWordsKey[] }> = {
  [STEP.aim]: {
    title: 'Start with your why',
    subtitle: 'A sentence or two is plenty. Orbit reads this before it suggests anyone or writes anything.',
    keys: ['aim', 'success'],
  },
  [STEP.story]: {
    title: 'How would you introduce yourself?',
    subtitle: "Write it the way you'd say it on a call. It shapes your first messages and your prep.",
    keys: ['story', 'proudOf'],
  },
  [STEP.people]: {
    title: 'Who do you want to meet?',
    subtitle: 'Roles, teams, schools or companies. Tap a starter or write your own.',
    keys: ['wantToMeet'],
  },
  [STEP.style]: {
    title: 'How should Orbit help?',
    subtitle: "So every message sounds like you, and never like something you'd cringe at.",
    keys: ['networkingHard', 'neverDo'],
  },
};

/** "Engineers", "PMs": the people of each kind of work, for the starters under "Who do you want to meet?". */
const FUNCTION_PEOPLE: Record<string, string> = {
  swe: 'Engineers',
  pm: 'PMs',
  ib: 'Bankers a year or two in',
  finance: 'People in finance',
  consulting: 'Consultants',
  vc: 'Investors',
  design: 'Designers',
  data: 'Data scientists',
  marketing: 'Marketers',
  research: 'Researchers',
  ops: 'People in operations',
};

const HARD_STARTERS = [
  'Cold messages feel awkward',
  "I don't know who to ask",
  'Following up without being annoying',
  'Finding the time',
];

/** Starter phrases for a question, or none. */
function startersFor(key: OwnWordsKey, fns: string[], school: string): string[] {
  if (key === 'networkingHard') return HARD_STARTERS;
  if (key !== 'wantToMeet') return [];
  const short = schoolShort(school);
  return [
    short ? `${short} alumni` : 'Alumni from my school',
    'People a year or two in',
    ...fns.map((f) => FUNCTION_PEOPLE[f]).filter((x): x is string => !!x),
    'Recruiters',
    'Founders',
  ].filter((x, i, all) => all.indexOf(x) === i);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether an answer already has a starter phrase in it. */
function hasStarter(value: string, phrase: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${escapeRe(phrase)}($|[^\\p{L}])`, 'iu').test(value);
}

/** A starter added to an answer: after a comma, or as the answer when there is none yet. */
function withStarter(value: string, phrase: string): string {
  const base = value.trimEnd();
  if (!base) return phrase;
  const lowerable = /^[A-Z][a-z]/.test(phrase) && !/^[A-Z][a-z]+ alumni$/.test(phrase);
  const p = lowerable ? `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}` : phrase;
  return /[.;:!?]$/.test(base) ? `${base} ${phrase}` : `${base.replace(/,$/, '')}, ${p}`;
}

/** A starter taken back out of an answer, with the comma that joined it. */
function withoutStarter(value: string, phrase: string): string {
  return value
    .replace(new RegExp(`(,\\s*)?${escapeRe(phrase)}`, 'i'), '')
    .replace(/^\s*,\s*/, '')
    .replace(/\s+,/g, ',')
    .trim();
}

/** Tap-to-add phrases under a question: each adds itself to the answer, and tapped again takes itself out. */
function Starters({
  items,
  value,
  onChange,
  label,
  testId,
}: {
  items: string[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {items.map((t) => {
        const on = hasStarter(value, t);
        return (
          <button
            key={t}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? withoutStarter(value, t) : withStarter(value, t))}
            className={cx(
              'inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ink/15',
              on
                ? 'chip-on border-ink bg-ink text-white'
                : 'border-line bg-white text-ink-2 hover:border-[#d4d2ce] hover:text-ink',
            )}
            data-testid={testId}
          >
            {on ? <Check size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
            {t}
          </button>
        );
      })}
    </div>
  );
}

/** "In your words · 2 of 5" over each written question. */
function wordsEyebrow(step: number): string {
  return `In your words · ${QUESTION_STEPS.indexOf(step) + 1} of ${QUESTION_STEPS.length}`;
}

/** Continue on Cmd or Ctrl and Enter, from any field of a written step. */
function submitOnModEnter(e: KeyboardEvent<HTMLFormElement>) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.currentTarget.requestSubmit();
  }
}

/** On a computer, the first field is ready to type in once the title has settled; a phone keeps its keyboard down. */
function useFocusFirst(ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>, ready: boolean) {
  useEffect(() => {
    if (!ready || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const t = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 450);
    return () => window.clearTimeout(t);
  }, [ready, ref]);
}

/** A written step: two questions at most, each optional, saved on Continue and on Back; Skip changes nothing. */
function StepWords(props: { step: number; user: User; onNext: () => void; onBack: () => void }) {
  return props.step === STEP.job ? <StepJob {...props} /> : <StepQuestions {...props} />;
}

function StepQuestions({
  step,
  user,
  onNext,
  onBack,
}: {
  step: number;
  user: User;
  onNext: () => void;
  onBack: () => void;
}) {
  const spec = WORD_STEPS[step]!;
  // null once read and absent; undefined only while loading
  const goals = useLiveQuery(async () => (await db.goals.get(user.id)) ?? null, [user.id]);
  const [f, setF] = useState<Partial<Record<OwnWordsKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const first = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef(false);
  useEffect(() => {
    // filled once from what is stored, so a save never resets what is being typed
    if (goals === undefined || loaded.current) return;
    loaded.current = true;
    const w = ownWordsOf(goals);
    setF(Object.fromEntries(spec.keys.map((k) => [k, w[k] ?? ''])));
  }, [goals, spec.keys]);
  useFocusFirst(first, goals !== undefined);
  const persist = async () => {
    const patch: OwnWordsPatch = {};
    for (const k of spec.keys) if (f[k] !== undefined) patch[k] = f[k];
    await saveOwnWords(user, patch);
  };
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await persist();
      onNext();
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  };
  const fns = goals?.targetFunctions ?? [];
  return (
    <form
      onSubmit={save}
      onKeyDown={submitOnModEnter}
      noValidate
      data-testid="ob-q"
      data-step={stepAddress(step)}
    >
      <BackArrow
        onClick={async () => {
          await persist().catch(() => undefined);
          onBack();
        }}
      />
      <ObHeader eyebrow={wordsEyebrow(step)} title={spec.title} subtitle={spec.subtitle} />
      <div className="space-y-7">
        {spec.keys.map((k, i) => {
          const q = OWN_WORDS_QUESTIONS[k];
          const starters = startersFor(k, fns, user.school);
          return (
            <div key={k} className="ob-rise" style={{ '--d': `${300 + i * 90}ms` } as CSSProperties}>
              {/* one question on a screen: the title already asks it */}
              <label
                htmlFor={`ob-q-${k}`}
                className={cx(
                  'mb-2 block text-[14px] font-medium text-ink',
                  spec.keys.length === 1 && 'sr-only',
                )}
              >
                {q.label}
              </label>
              <ObTextArea
                id={`ob-q-${k}`}
                ref={i === 0 ? first : undefined}
                value={f[k] ?? ''}
                onChange={(e) => setF((cur) => ({ ...cur, [k]: e.target.value }))}
                placeholder={q.placeholder}
                maxLength={OWN_WORDS_MAX}
                aria-describedby={`ob-q-${k}-uses`}
                data-testid={`ob-q-${k}`}
              />
              {starters.length ? (
                <Starters
                  items={starters}
                  value={f[k] ?? ''}
                  onChange={(v) => setF((cur) => ({ ...cur, [k]: v }))}
                  label={`Starters for: ${q.label}`}
                  testId={`ob-starter-${k}`}
                />
              ) : null}
              <p id={`ob-q-${k}-uses`} className="mt-2 text-[12.5px] leading-[1.45] text-ink-3">
                {q.uses}
              </p>
            </div>
          );
        })}
      </div>
      <div
        className="ob-rise mt-9 space-y-3"
        style={{ '--d': `${380 + spec.keys.length * 90}ms` } as CSSProperties}
      >
        <ObPrimary type="submit" disabled={busy} data-testid="ob-q-next">
          Continue
        </ObPrimary>
        <ObQuiet onClick={onNext} data-testid="ob-q-skip">
          Skip
        </ObQuiet>
      </div>
      {error && (
        <p className="mt-3 text-[13px] text-bad text-center" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** "Going for something right now?": a posting's link, a company and role, or both, in one box (plan 23 reads it). */
function StepJob({
  step,
  user,
  onNext,
  onBack,
}: {
  step: number;
  user: User;
  onNext: () => void;
  onBack: () => void;
}) {
  const goals = useLiveQuery(async () => (await db.goals.get(user.id)) ?? null, [user.id]);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (goals === undefined || loaded.current) return;
    loaded.current = true;
    setV(currentJobInput(goals?.currentJob));
  }, [goals]);
  useFocusFirst(input, goals !== undefined);
  const job = parseCurrentJob(v);
  // a pasted link is read (the server reads the page; its address answers when it cannot), so the job shows as
  // "Product Manager · Stripe" with the company's logo, and is saved by that name
  const [posting, setPosting] = useState<{ url: string; role: string; company: string }>();
  const [reading, setReading] = useState(false);
  const jobUrl = job?.url;
  useEffect(() => {
    if (!jobUrl) {
      setPosting(undefined);
      setReading(false);
      return;
    }
    let live = true;
    setReading(true);
    const t = setTimeout(async () => {
      const r = await readPosting(user.id, { url: jobUrl }).catch(() => undefined);
      const p = r?.ok && (r.posting.role || r.posting.company) ? r.posting : postingFromPath(jobUrl);
      if (!live) return;
      setPosting(
        p?.company || p?.role ? { url: jobUrl, role: p.role ?? '', company: p.company ?? '' } : undefined,
      );
      setReading(false);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [jobUrl, user.id]);
  const read = posting && posting.url === jobUrl ? posting : undefined;
  const named = read ? [read.role, read.company].filter(Boolean).join(' at ') : undefined;
  const persist = () =>
    saveOwnWords(user, { currentJob: job && read && !job.text ? { ...job, text: named } : job });
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await persist();
      onNext();
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  };
  const host = job?.url ? currentJobLabel({ url: job.url }) : undefined;
  return (
    <form onSubmit={save} noValidate data-testid="ob-q" data-step={stepAddress(step)}>
      <BackArrow
        onClick={async () => {
          await persist().catch(() => undefined);
          onBack();
        }}
      />
      <ObHeader
        eyebrow={wordsEyebrow(step)}
        title="Going for something right now?"
        subtitle="Paste the link or the company. Orbit keeps it in mind as you go."
      />
      <div className="ob-rise" style={{ '--d': '300ms' } as CSSProperties}>
        <ObLabel htmlFor="ob-q-job" hint="Optional">
          A job
        </ObLabel>
        <div className="relative">
          <Briefcase
            size={16}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
            aria-hidden
          />
          <ObInput
            id="ob-q-job"
            ref={input}
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder="A posting link, or Stripe, PM intern"
            maxLength={CURRENT_JOB_MAX * 2}
            className="pl-10"
            autoComplete="off"
            data-testid="ob-q-job"
          />
        </div>
        {job ? (
          <div
            className="pop-in mt-3 flex items-start gap-3 rounded-[12px] border border-line bg-white px-4 py-3 shadow-[var(--shadow-card)]"
            data-testid="ob-job-preview"
          >
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-canvas-2 text-ink-2">
              {read?.company ? (
                <CompanyLogo name={read.company} size={28} decorative />
              ) : job.url && reading ? (
                <Spinner />
              ) : job.url ? (
                <LinkIcon size={14} aria-hidden />
              ) : (
                <Briefcase size={14} aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-ink" data-testid="ob-job-title">
                {job.text ?? (read ? read.role || read.company : reading ? 'Reading the posting…' : host)}
              </span>
              <span className="block truncate text-[12.5px] text-ink-3">
                {job.url
                  ? job.text
                    ? host
                    : read
                      ? [read.role ? read.company : undefined, host].filter(Boolean).join(' · ')
                      : reading
                        ? host
                        : 'The posting, saved as a link'
                  : 'Add the posting link too, if you have it'}
              </span>
            </span>
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] leading-[1.45] text-ink-3">
            A link from a job board, or just the company and the role.
          </p>
        )}
      </div>
      <div className="ob-rise mt-9 space-y-3" style={{ '--d': '420ms' } as CSSProperties}>
        <ObPrimary type="submit" disabled={busy} data-testid="ob-q-next">
          Continue
        </ObPrimary>
        <ObQuiet onClick={onNext} data-testid="ob-q-skip">
          Skip
        </ObQuiet>
      </div>
      {error && (
        <p className="mt-3 text-[13px] text-bad text-center" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function StepLinkedIn({ onNext, signedIn }: { onNext: () => void; signedIn?: boolean }) {
  const user = useSession().user!;
  // LinkedIn connects through Unipile's sign-in; the file upload is only for a build with no live LinkedIn at all
  // (the tests' and a copy run without Orbit's server), never offered beside the live sign-in
  const live = signedIn || liveLinkedInAvailable(user);
  const showUpload = !live;
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
      if (r.ok)
        setResult(
          r.rows
            ? `${connectionsImported(r.rows)} so far. The rest keep coming in the background.`
            : 'LinkedIn is connected. Your connections are coming in the background.',
        );
      else if (r.reason === 'unconfigured') setNote(r.message);
      else if (r.reason === 'error') setError(r.message);
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
    !result && earlier ? `${linkedinSoFar((earlier.syncState as { rows?: number }).rows ?? 0)}.` : '';
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
          className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3.5 text-[14px]"
          data-testid="ob-linkedin-done"
        >
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-good text-white">
            <Check size={14} aria-hidden />
          </span>
          <span className="text-ink">{result || doneBefore}</span>
        </div>
      ) : live ? (
        <>
          <ObPanel>
            <ul className="divide-y divide-[#eef0f3]">
              <CheckRow>Brings in your connections with their companies and titles.</CheckRow>
              <CheckRow>Keeps them up to date, so new connections show up on their own.</CheckRow>
              <CheckRow>You approve every message before it goes anywhere.</CheckRow>
            </ul>
          </ObPanel>
          <p
            className="mt-3 text-[13px] leading-[1.5] text-ink-3 text-center text-balance"
            data-testid="ob-linkedin-risk"
          >
            {LINKEDIN_RISK_SENTENCE}
          </p>
        </>
      ) : null}
      {note && (
        <p
          className="mb-4 rounded-[10px] bg-canvas-2 px-3.5 py-2.5 text-[13.5px] text-ink-2 text-center"
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
          <label className="mt-3 flex h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#d4d2ce] bg-white text-ink transition-colors hover:border-ink/40 hover:bg-[#fafbfc] focus-within:border-ink focus-within:ring-[3px] focus-within:ring-ink/[0.08]">
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
          className="rounded-xl border border-line bg-white px-4 py-3.5 text-[14px]"
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

/** The start of what the student is going for, in quotes, for the Ready summary. */
function aimSnippet(aim: string | undefined): string | undefined {
  const t = aim?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return `\u201c${t.length > 44 ? `${t.slice(0, 43).trimEnd()}\u2026` : t}\u201d`;
}

function StepReady({
  google,
  account,
  onFinish,
  onJump,
}: {
  google: boolean;
  /** signed in to an Orbit account: its Google address */
  account?: string;
  onFinish: () => Promise<void>;
  onJump: (step: number) => void;
}) {
  const user = useSession().user!;
  const [busy, setBusy] = useState(false);
  const info = useLiveQuery(async () => {
    const [goals, companies, ints, kinds] = await Promise.all([
      db.goals.get(user.id),
      db.targetCompanies.where('userId').equals(user.id).count(),
      db.integrations.where('userId').equals(user.id).toArray(),
      listGoals(user.id),
    ]);
    return {
      goals,
      kinds: [...new Set(kinds.filter((g) => g.status === 'active').map((g) => g.kind))],
      companies,
      linkedin: ints.find((i) => isLinkedIn(i.provider)),
      google: ints.find((i) => i.provider === 'google'),
    };
  }, [user.id]);
  const fns = (info?.goals?.targetFunctions ?? []).map((f) => FUNCTION_LABELS[f] ?? f);
  // other goals than recruiting, by name ("Fundraising, Sales")
  const otherKinds = (info?.kinds ?? []).filter((k) => k !== 'recruiting').map((k) => GOAL_KIND_LABELS[k]);
  const goalWords = [...fns, ...otherKinds];
  const words = answeredCount(info?.goals);
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
        goalWords.length > 2
          ? `${goalWords.slice(0, 2).join(', ')} and ${goalWords.length - 2} more`
          : goalWords.join(' and '),
        info?.companies ? `${info.companies} target ${info.companies === 1 ? 'company' : 'companies'}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      ok: goalWords.length > 0,
      step: STEP.goals,
    },
    {
      key: 'words',
      title: 'In your words',
      detail: words
        ? [aimSnippet(info?.goals?.aim), `${words} of ${OWN_WORDS_TOTAL} answered`]
            .filter(Boolean)
            .join(' · ')
        : 'Skipped for now',
      ok: words > 0,
      step: STEP.aim,
    },
    {
      key: 'linkedin',
      title: 'LinkedIn',
      detail: info?.linkedin
        ? linkedinSoFar((info.linkedin.syncState as { rows?: number }).rows ?? 0)
        : 'Skipped for now',
      ok: !!info?.linkedin,
      step: STEP.linkedin,
    },
  ];
  if (account)
    rows.push({
      key: 'gmail',
      title: 'Gmail & Calendar',
      detail: `Connected as ${account}`,
      ok: true,
      step: STEP.welcome,
    });
  else if (google)
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
        <ul className="stagger divide-y divide-[#eef0f3]">
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
                  r.ok ? 'bg-good text-white' : 'bg-canvas-2 text-ink-3',
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
                  {r.key === 'goals' || r.key === 'words' ? 'Add' : 'Connect'}
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
