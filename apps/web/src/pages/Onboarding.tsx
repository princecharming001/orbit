import { newId, yearLabel } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Minus, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { db } from '../db/schema';
import { generateBrief, recommendationsRefresh } from '../engine/brief';
import { connectionsText, importConnectionsCsv } from '../engine/linkedin';
import { saveResume } from '../engine/resume';
import { syncGoogle } from '../engine/sync';
import { addTargetCompanies } from '../engine/targets';
import { connectGoogle, googleClientId, googleScopeWarning } from '../integrations/google';
import { envGoogleClientId, readPrefs, writePrefs } from '../integrations/prefs';
import { useSession } from '../state/session';
import { Button, Card, cx, FunctionPicker, Input, Label, Select, Spinner, Textarea } from '../ui';

/**
 * Internal step numbers (stored in `user.onboardingStep`); the address shows the number minus one. Step 7 (a page
 * about meeting notes with nothing to set up) is now a tip on the last step, and Connect Google is only a step on a
 * copy of Orbit where Google sign-in is set up: a step that can only say "not available" is not shown.
 */
function visibleSteps(): number[] {
  return googleClientId() ? [2, 3, 4, 5, 6, 8] : [2, 3, 4, 6, 8];
}
const TITLES: Record<number, string> = {
  2: 'About you',
  3: "What you're recruiting for",
  4: 'Resume',
  5: 'Connect Google',
  6: 'LinkedIn',
  8: 'Preferences',
};
/** Steps the student may skip; the stepper marks a skipped one as skipped, never as done. */
const OPTIONAL = new Set([4, 5, 6]);

/** The address of an internal onboarding step: step 2 (About you) is /onboarding/1. */
export function onboardingPath(step: number): string {
  return `/onboarding/${Math.min(8, Math.max(2, step)) - 1}`;
}

export function Onboarding() {
  const { step: stepParam } = useParams();
  const step = Number(stepParam ?? 1) + 1;
  const nav = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  // what the optional steps actually produced, so a skipped step never shows a done check
  const did = useLiveQuery(async () => {
    if (!user) return {};
    const [resume, ints] = await Promise.all([
      db.resumes.where('userId').equals(user.id).first(),
      db.integrations.where('userId').equals(user.id).toArray(),
    ]);
    return {
      4: !!resume,
      5: ints.some((i) => i.provider === 'google'),
      6: ints.some((i) => i.provider === 'linkedin_csv'),
    } as Record<number, boolean>;
  }, [user?.id]);
  const STEPS = visibleSteps();
  const stepperRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // each step opens at its title, not scrolled down to where the last step's Continue button was
    void step;
    window.scrollTo(0, 0);
    stepperRef.current
      ?.querySelector('[aria-current="step"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [step]);
  if (!user) return null;
  const idx = STEPS.indexOf(step);
  // a step that is not shown here (Meeting notes, Google without sign-in) moves on to the next one that is
  const hiddenNext = idx === -1 && step >= 2 && step <= 8 ? STEPS.find((x) => x > step) : undefined;
  if (idx === -1 && hiddenNext && !user.onboardingCompletedAt)
    return <Navigate to={onboardingPath(hiddenNext)} replace />;
  // An unknown step (an old link, a typo) goes back to where the user actually is.
  if (idx === -1)
    return (
      <Navigate to={user.onboardingCompletedAt ? '/today' : onboardingPath(user.onboardingStep)} replace />
    );
  const after = (s: number) => STEPS.find((x) => x > s) ?? 8;
  const before = (s: number) => [...STEPS].reverse().find((x) => x < s) ?? 2;
  const go = async (next: number) => {
    await db.users.update(user.id, { onboardingStep: Math.max(user.onboardingStep, next) });
    nav(onboardingPath(next), { state: { fromStep: step } });
  };
  // Back is the browser's Back when the step before is where the student came from, so the browser's own Back
  // button afterwards keeps going back instead of returning to the step just left
  const back = (to: number) => {
    if ((location.state as { fromStep?: number } | null)?.fromStep === to) nav(-1);
    else nav(onboardingPath(to), { replace: true });
  };
  const finish = async () => {
    await db.users.update(user.id, { onboardingStep: 11, onboardingCompletedAt: new Date().toISOString() });
    const fresh = (await db.users.get(user.id))!;
    await recommendationsRefresh(fresh);
    await generateBrief(fresh, 'welcome');
    nav('/today');
  };
  const status = (s: number, i: number): 'done' | 'skipped' | 'current' | 'todo' =>
    i === idx ? 'current' : i > idx ? 'todo' : OPTIONAL.has(s) && !did?.[s] ? 'skipped' : 'done';
  return (
    <div className="min-h-full bg-canvas-2/60">
      <div className="max-w-[760px] mx-auto px-4 sm:px-5 py-6 sm:py-8">
        <div className="flex items-center gap-2 mb-6">
          <Link to="/" className="inline-flex items-center gap-2" title="Back to the Orbit home page">
            <Logo /> <span className="font-semibold">Orbit</span>
          </Link>
          <span className="text-ink-3 text-[13px] ml-2">Setup</span>
        </div>
        <div className="mb-5">
          <p className="text-[13px] text-ink-2" data-testid="ob-progress">
            Step {idx + 1} of {STEPS.length}
            {OPTIONAL.has(step) ? <span className="text-ink-3"> · optional</span> : null}
          </p>
          {/* a phone has no room for the names under the bar: say what is left, and which steps are optional */}
          {idx < STEPS.length - 1 && (
            <p className="sm:hidden text-[12px] text-ink-3 mt-0.5" data-testid="ob-coming-up">
              Next:{' '}
              {STEPS.slice(idx + 1)
                .map((x) => `${TITLES[x]}${OPTIONAL.has(x) ? ' (optional)' : ''}`)
                .join(', ')}
            </p>
          )}
          <ol
            ref={stepperRef}
            className="mt-2 grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}
            aria-label="Setup steps"
          >
            {STEPS.map((s, i) => {
              const st = status(s, i);
              return (
                <li
                  key={s}
                  aria-current={st === 'current' ? 'step' : undefined}
                  className="min-w-0"
                  data-testid={`ob-step-${i + 1}`}
                  data-status={st}
                >
                  <span
                    className={cx(
                      'block h-1.5 rounded-full',
                      st === 'done'
                        ? 'bg-good'
                        : st === 'current'
                          ? 'bg-ink'
                          : st === 'skipped'
                            ? 'bg-line [background-image:repeating-linear-gradient(90deg,#c7cbd3_0_4px,transparent_4px_8px)]'
                            : 'bg-line',
                    )}
                  />
                  <span
                    className={cx(
                      'mt-1.5 hidden sm:flex items-start gap-1 text-[11.5px] leading-tight',
                      st === 'current' ? 'text-ink font-medium' : 'text-ink-3',
                    )}
                  >
                    {st === 'done' && <Check size={12} className="text-good shrink-0 mt-px" aria-hidden />}
                    {st === 'skipped' && <Minus size={12} className="shrink-0 mt-px" aria-hidden />}
                    <span className="min-w-0">{TITLES[s]}</span>
                  </span>
                  <span className="sr-only">
                    {TITLES[s]}: {st === 'current' ? 'current step' : st === 'todo' ? 'not started' : st}
                  </span>
                </li>
              );
            })}
          </ol>
          {STEPS.some((s, i) => status(s, i) === 'skipped') && (
            <p className="mt-2 text-[12px] text-ink-3">
              Skipped steps stay open: add a resume or your LinkedIn connections any time in Settings.
            </p>
          )}
        </div>
        <Card className="p-5 sm:p-6">
          <h1 className="text-[20px] font-semibold mb-1">{TITLES[step]}</h1>
          {step === 2 && <StepAbout onNext={() => go(after(2))} />}
          {step === 3 && <StepGoals onNext={() => go(after(3))} onBack={() => back(before(3))} />}
          {step === 4 && <StepResume onNext={() => go(after(4))} onBack={() => back(before(4))} />}
          {step === 5 && <StepGoogle onNext={() => go(after(5))} onBack={() => back(before(5))} />}
          {step === 6 && <StepLinkedIn onNext={() => go(after(6))} onBack={() => back(before(6))} />}
          {step === 8 && <StepPrefs onNext={finish} onBack={() => back(before(8))} />}
        </Card>
      </div>
    </div>
  );
}

function Nav({
  onBack,
  onNext,
  nextLabel = 'Continue',
  disabled,
  disabledHint,
  skip,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  disabled?: boolean;
  /** says what is missing while Continue is disabled */
  disabledHint?: string;
  /** an optional step with nothing done yet: the one button reads "Skip for now" */
  skip?: boolean;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <span className="ml-auto flex gap-2">
          <Button variant={skip ? 'secondary' : 'primary'} onClick={onNext} disabled={disabled}>
            {skip ? 'Skip for now' : nextLabel}
          </Button>
        </span>
      </div>
      {disabled && disabledHint && (
        <p className="mt-2 text-[12px] text-ink-3 text-right" data-testid="ob-missing">
          {disabledHint}
        </p>
      )}
    </div>
  );
}

/** The school domain an email implies ("umich.edu" for jpark@umich.edu), or '' for a non-school address. */
function autoDomain(email: string): string {
  return /@([\w.-]+\.edu)$/i.exec(email.trim())?.[1]?.toLowerCase() ?? '';
}

function StepAbout({ onNext }: { onNext: () => void }) {
  const user = useSession().user!;
  const [f, setF] = useState({
    fullName: user.fullName,
    email: user.email,
    school: user.school,
    schoolDomain: user.schoolDomain ?? '',
    // no default: a guessed year would call a sophomore a junior in every message
    graduationYear: user.graduationYear ? String(user.graduationYear) : '',
    degree: user.degree ?? 'BS',
    majors: user.majors.join(', '),
    currentCity: user.currentCity ?? '',
    linkedinUrl: user.linkedinUrl ?? '',
  });
  const save = async () => {
    const [first, ...rest] = f.fullName.trim().split(/\s+/);
    await db.users.update(user.id, {
      fullName: f.fullName.trim(),
      firstName: first ?? '',
      lastName: rest.join(' '),
      email: f.email.trim().toLowerCase(),
      school: f.school.trim(),
      schoolDomain:
        f.schoolDomain.trim().toLowerCase() || (f.email.includes('@') ? f.email.split('@')[1] : undefined),
      graduationYear: Number(f.graduationYear),
      degree: f.degree,
      majors: f.majors
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      currentCity: f.currentCity,
      linkedinUrl: f.linkedinUrl || undefined,
    });
    onNext();
  };
  const missing = [
    !f.fullName.trim() && 'your name',
    !f.email.includes('@') && 'your email',
    !f.school.trim() && 'your school',
    !f.graduationYear && 'your graduation year',
  ].filter(Boolean) as string[];
  const now = new Date();
  const firstYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  // the years someone in a program now can graduate in: four for a bachelor's, more for a PhD
  const grad = /\b(MBA|MS|MENG|PHD)\b/i.test(f.degree);
  const span = /PHD/i.test(f.degree) ? 6 : grad ? 2 : 4;
  const years = Array.from({ length: span }, (_, i) => firstYear + i);
  // a year saved earlier stays selectable, even one outside this list
  if (f.graduationYear && !years.includes(Number(f.graduationYear))) years.unshift(Number(f.graduationYear));
  return (
    <div className="grid sm:grid-cols-2 gap-4 mt-4">
      <p className="sm:col-span-2 text-[13px] text-ink-2 -mt-1">
        Orbit uses this to sign your messages and to spot alumni from your school.
      </p>
      <div className="sm:col-span-2">
        <Label htmlFor="ob-name" required>
          Full name
        </Label>
        <Input
          id="ob-name"
          value={f.fullName}
          onChange={(e) => setF({ ...f, fullName: e.target.value })}
          placeholder="e.g. Alex Rivera"
          autoComplete="name"
          data-testid="ob-name"
        />
      </div>
      <div>
        <Label htmlFor="ob-email" required hint="the one you recruit from">
          Email
        </Label>
        <Input
          id="ob-email"
          type="email"
          value={f.email}
          onChange={(e) => {
            const email = e.target.value;
            // a school address fills in the school's domain, unless the student typed one of their own
            const domain = /@([\w.-]+\.edu)$/i.exec(email.trim())?.[1]?.toLowerCase() ?? '';
            const auto = !f.schoolDomain || f.schoolDomain === autoDomain(f.email);
            setF({ ...f, email, schoolDomain: auto ? domain : f.schoolDomain });
          }}
          placeholder="e.g. alex@cornell.edu"
          autoComplete="email"
          data-testid="ob-email"
        />
      </div>
      <div>
        <Label htmlFor="ob-li" optional>
          LinkedIn profile link
        </Label>
        <Input
          id="ob-li"
          value={f.linkedinUrl}
          onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })}
          placeholder="e.g. linkedin.com/in/alex-rivera"
        />
      </div>
      <div>
        <Label htmlFor="ob-school" required>
          School
        </Label>
        <Input
          id="ob-school"
          value={f.school}
          onChange={(e) => setF({ ...f, school: e.target.value })}
          placeholder="e.g. Cornell University"
          data-testid="ob-school"
        />
      </div>
      <div>
        <Label htmlFor="ob-domain" optional hint="to spot alumni">
          School email domain
        </Label>
        <Input
          id="ob-domain"
          value={f.schoolDomain}
          onChange={(e) => setF({ ...f, schoolDomain: e.target.value })}
          placeholder="e.g. cornell.edu"
        />
      </div>
      <div>
        <Label htmlFor="ob-year" required>
          Graduation year
        </Label>
        <Select
          id="ob-year"
          value={f.graduationYear}
          onChange={(e) => setF({ ...f, graduationYear: e.target.value })}
          className="w-full"
          data-testid="ob-year"
        >
          <option value="">Choose your year</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y} ({yearLabel(y, f.degree, now)} now)
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label
          htmlFor="ob-degree"
          optional
          hint="so messages call you a junior, a senior or an MBA student correctly"
        >
          Degree
        </Label>
        <Select
          id="ob-degree"
          value={f.degree}
          onChange={(e) => setF({ ...f, degree: e.target.value })}
          className="w-full"
        >
          {['BS', 'BA', 'BBA', 'MS', 'MBA', 'MEng', 'PhD', 'Other'].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="ob-majors" optional>
          Major(s)
        </Label>
        <Input
          id="ob-majors"
          value={f.majors}
          onChange={(e) => setF({ ...f, majors: e.target.value })}
          placeholder="e.g. Economics, Computer Science"
        />
      </div>
      <div>
        <Label htmlFor="ob-city" optional>
          Current city
        </Label>
        <Input
          id="ob-city"
          value={f.currentCity}
          onChange={(e) => setF({ ...f, currentCity: e.target.value })}
          placeholder="e.g. Ithaca, NY"
        />
      </div>
      <div className="sm:col-span-2">
        <Nav
          onNext={save}
          disabled={missing.length > 0}
          disabledHint={`Add ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} to continue.`}
        />
      </div>
    </div>
  );
}

/** Example answers that fit the first function the student picked, so a banker is not shown tech examples. */
const GOAL_EXAMPLES: Record<string, { roles: string; industries: string; company: string; free: string }> = {
  ib: {
    roles: 'e.g. Summer analyst',
    industries: 'e.g. Healthcare, Tech, Industrials',
    company: 'e.g. Evercore',
    free: 'e.g. I want a group with a strong deal flow and good mentorship.',
  },
  finance: {
    roles: 'e.g. Summer analyst',
    industries: 'e.g. Asset management, Equity research',
    company: 'e.g. Blackstone',
    free: 'e.g. I care most about learning to build models from day one.',
  },
  consulting: {
    roles: 'e.g. Summer associate, Business analyst intern',
    industries: 'e.g. Healthcare, Strategy',
    company: 'e.g. McKinsey',
    free: 'e.g. I want broad exposure before I pick an industry.',
  },
  vc: {
    roles: 'e.g. Investment intern',
    industries: 'e.g. Fintech, Climate',
    company: 'e.g. Sequoia',
    free: 'e.g. I want to see early-stage deals up close.',
  },
  default: {
    roles: 'e.g. Software engineering intern, Product intern',
    industries: 'e.g. Fintech, AI, Consumer',
    company: 'e.g. Stripe',
    free: 'e.g. I care most about payments infrastructure and small teams.',
  },
};

function StepGoals({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  // null once read and absent; undefined only while loading
  const goals = useLiveQuery(async () => (await db.goals.get(user.id)) ?? null, [user.id]);
  const tcs =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
  const [f, setF] = useState({
    cycleLabel: '',
    targetRoles: '',
    targetFunctions: [] as string[],
    targetIndustries: '',
    targetLocations: '',
    freeText: '',
    ambition: 2 as 1 | 2 | 3,
  });
  const [company, setCompany] = useState('');
  const loaded = useRef(false);
  useEffect(() => {
    // fill the form once from what is stored; later saves (Back, Continue) must not reset what is being typed
    if (goals === undefined || loaded.current) return;
    loaded.current = true;
    if (goals)
      setF({
        cycleLabel: goals.cycleLabel,
        targetRoles: goals.targetRoles.join(', '),
        targetFunctions: goals.targetFunctions,
        targetIndustries: goals.targetIndustries.join(', '),
        targetLocations: goals.targetLocations.join(', '),
        freeText: goals.freeText ?? '',
        ambition: goals.ambition,
      });
    else setF((x) => ({ ...x, cycleLabel: `Summer ${new Date().getFullYear() + 1} internship` }));
  }, [goals]);
  const [companyNote, setCompanyNote] = useState('');
  // "Evercore, Lazard" adds two companies
  const addCompany = async () => {
    if (!company.trim()) return;
    const r = await addTargetCompanies(user.id, company);
    setCompanyNote(
      r.duplicates.length
        ? `${r.duplicates.join(', ')} ${r.duplicates.length === 1 ? 'is' : 'are'} already on your list.`
        : '',
    );
    setCompany('');
  };
  const split = (x: string) =>
    x
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  /** Keep what is on screen, whichever way the student leaves the step (a company typed but not added included). */
  const persist = async () => {
    if (company.trim()) await addCompany();
    await db.goals.put({
      userId: user.id,
      cycleLabel: f.cycleLabel.trim() || 'This cycle',
      targetRoles: split(f.targetRoles),
      targetFunctions: f.targetFunctions,
      targetIndustries: split(f.targetIndustries),
      targetLocations: split(f.targetLocations),
      freeText: f.freeText,
      ambition: f.ambition,
    });
    await db.settings.update(user.id, { weeklyOutreachTarget: { 1: 2, 2: 4, 3: 7 }[f.ambition] });
  };
  const ex = GOAL_EXAMPLES[f.targetFunctions[0] ?? ''] ?? GOAL_EXAMPLES.default!;
  return (
    <div className="mt-4 space-y-4">
      <div>
        <Label htmlFor="ob-cycle">Recruiting cycle</Label>
        <Input
          id="ob-cycle"
          value={f.cycleLabel}
          onChange={(e) => setF({ ...f, cycleLabel: e.target.value })}
          data-testid="ob-cycle"
        />
      </div>
      <div>
        <Label required hint="pick one or more">
          What kind of work
        </Label>
        <FunctionPicker
          value={f.targetFunctions}
          onChange={(targetFunctions) => setF({ ...f, targetFunctions })}
          testIdPrefix="ob-fn"
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Label htmlFor="ob-roles" optional>
            Target roles
          </Label>
          <Input
            id="ob-roles"
            value={f.targetRoles}
            onChange={(e) => setF({ ...f, targetRoles: e.target.value })}
            placeholder={ex.roles}
            data-testid="ob-roles"
          />
        </div>
        <div>
          <Label htmlFor="ob-industries" optional>
            Industries
          </Label>
          <Input
            id="ob-industries"
            value={f.targetIndustries}
            onChange={(e) => setF({ ...f, targetIndustries: e.target.value })}
            placeholder={ex.industries}
          />
        </div>
        <div>
          <Label htmlFor="ob-locations" optional>
            Locations
          </Label>
          <Input
            id="ob-locations"
            value={f.targetLocations}
            onChange={(e) => setF({ ...f, targetLocations: e.target.value })}
            placeholder="e.g. New York, San Francisco, Remote"
          />
        </div>
        <div>
          <Label htmlFor="ob-ambition">First messages a week</Label>
          <Select
            id="ob-ambition"
            value={f.ambition}
            onChange={(e) => setF({ ...f, ambition: Number(e.target.value) as 1 | 2 | 3 })}
            className="w-full"
          >
            <option value={1}>2 a week (steady)</option>
            <option value={2}>4 a week (focused)</option>
            <option value={3}>7 a week (all in)</option>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="ob-company" optional hint="add as many as you like, separated by commas">
          Target companies
        </Label>
        <div className="flex gap-2">
          <Input
            id="ob-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              addCompany();
            }}
            placeholder={ex.company}
            data-testid="ob-company"
          />
          <Button onClick={addCompany}>Add</Button>
        </div>
        {companyNote && (
          <p className="text-[12px] text-ink-3 mt-1" role="status">
            {companyNote}
          </p>
        )}
        <div className="flex flex-wrap gap-2 mt-2">
          {tcs.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-full border border-line pl-1 pr-1 h-8 text-[13px]"
            >
              <button
                className={cx(
                  'h-7 w-7 rounded-full text-[13px] font-semibold hover:bg-canvas-2',
                  t.priority === 1 ? 'text-accent' : 'text-ink-3',
                )}
                title={
                  t.priority === 1 ? 'Top priority. Click to make it a normal target' : 'Mark as top priority'
                }
                aria-label={
                  t.priority === 1 ? `Make ${t.nameRaw} a normal target` : `Mark ${t.nameRaw} as top priority`
                }
                aria-pressed={t.priority === 1}
                onClick={() => db.targetCompanies.update(t.id, { priority: t.priority === 1 ? 2 : 1 })}
              >
                {t.priority === 1 ? '★' : '☆'}
              </button>
              {t.nameRaw}
              <button
                className="h-7 w-7 rounded-full text-ink-3 hover:text-ink hover:bg-canvas-2"
                onClick={() => db.targetCompanies.delete(t.id)}
                aria-label={`Remove ${t.nameRaw}`}
                title={`Remove ${t.nameRaw}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {tcs.length > 0 && (
          <p className="text-[12px] text-ink-3 mt-1.5">Tap the star to mark a company as a top priority.</p>
        )}
      </div>
      <div>
        <Label htmlFor="ob-free" optional>
          Anything else?
        </Label>
        <Textarea
          id="ob-free"
          rows={2}
          value={f.freeText}
          onChange={(e) => setF({ ...f, freeText: e.target.value })}
          placeholder={ex.free}
        />
      </div>
      <Nav
        onBack={async () => {
          await persist();
          onBack();
        }}
        onNext={async () => {
          await persist();
          onNext();
        }}
        disabled={!f.targetFunctions.length}
        disabledHint="Pick at least one kind of work to continue."
      />
    </div>
  );
}

const FACET_LABELS: Record<string, string> = {
  experience: 'Experience',
  education: 'Education',
  project: 'Project',
  skill_group: 'Skills',
  interest: 'Interests',
  summary: 'Summary',
};

/** The facet's text without repeating its title or organization (the parse often carries both). */
export function facetDetail(f: { title?: string; organizationName?: string; text: string }): string {
  let t = f.text.trim();
  for (const part of [f.title, f.organizationName].filter(Boolean) as string[]) {
    const re = new RegExp(`^${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,·:-]*`, 'i');
    t = t.replace(re, '').trim();
  }
  // what is left of "Treasurer, Club soccer." once the role and the club are shown is a full stop: nothing to show
  return /\w/.test(t) ? t : '';
}

function StepResume({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const resume = useLiveQuery(
    () =>
      db.resumes
        .where('userId')
        .equals(user.id)
        .filter((r) => r.isCurrent)
        .first(),
    [user.id],
  );
  const facets =
    useLiveQuery(
      () => (resume ? db.resumeFacets.where('resumeId').equals(resume.id).toArray() : []),
      [resume?.id],
    ) ?? [];
  const onFile = async (f: File) => {
    setBusy(true);
    setError(undefined);
    try {
      await saveResume(user, f);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4">
      <p className="text-ink-2 text-[14px]">
        Orbit uses your resume to find people with overlapping experience and to describe you in first
        messages. PDF, Word (.docx) or plain text, up to 10 MB.
      </p>
      <label className="mt-4 flex items-center justify-center gap-2 border border-dashed border-line rounded-[12px] h-28 cursor-pointer hover:bg-canvas-2 focus-within:ring-2 focus-within:ring-accent/40">
        <input
          type="file"
          accept=".pdf,.txt,.md,.docx"
          className="sr-only"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          data-testid="ob-resume"
        />
        {busy ? <Spinner /> : <Upload size={16} className="text-ink-3" />}{' '}
        <span className="text-[14px]">
          {busy ? 'Reading…' : resume ? `Replace ${resume.filename}` : 'Upload your resume'}
        </span>
      </label>
      {error && <p className="text-bad text-[13px] mt-2">{error}</p>}
      {facets.length > 0 && (
        <div className="mt-4">
          <Label hint="uncheck anything that's wrong and Orbit won't use it">
            {resume?.parseSource === 'llm'
              ? 'What Claude read from your resume'
              : 'What Orbit read from your resume'}
          </Label>
          <ul className="space-y-2 max-h-72 overflow-y-auto scroll-thin pr-1">
            {facets.map((f) => (
              <li
                key={f.id}
                className={`flex items-start gap-2 text-[13px] ${f.excluded ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={!f.excluded}
                  aria-label={`Use ${f.title ?? FACET_LABELS[f.kind] ?? 'this line'}`}
                  data-testid="ob-facet-toggle"
                  onChange={(e) =>
                    db.resumeFacets.update(f.id, { excluded: !e.target.checked, confirmed: e.target.checked })
                  }
                />
                <span className="min-w-0">
                  <span className="text-ink-3 text-[12px] mr-1.5">{FACET_LABELS[f.kind] ?? 'Other'}</span>
                  <strong className="font-medium">
                    {[f.title, f.organizationName !== f.title ? f.organizationName : undefined]
                      .filter(Boolean)
                      .join(' · ')}
                  </strong>
                  {/* what they did on its own line, so the employer and the first bullet never run together */}
                  {facetDetail(f) && <span className="block text-ink-2">{facetDetail(f).slice(0, 140)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Nav onBack={onBack} onNext={onNext} skip={!resume} />
    </div>
  );
}

function StepGoogle({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
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
      writePrefs({ googleClientId: clientId.trim() || undefined });
      setBusy('Waiting for Google…');
      const t = await connectGoogle();
      await db.integrations.put({
        id: account?.id ?? newId('int'),
        userId: user.id,
        provider: 'google',
        externalAccountId: t.email,
        status: 'active',
        scopes: t.scopes ?? [],
        syncState: {},
        connectedAt: new Date().toISOString(),
      });
      if (t.email && !user.email) await db.users.update(user.id, { email: t.email });
      const fresh = (await db.users.get(user.id))!;
      await syncGoogle(fresh, {
        onProgress: (p) => setBusy(`${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
      });
      setBusy(undefined);
      setError(googleScopeWarning(t.scopes));
    } catch (e) {
      setBusy(undefined);
      setError(String((e as Error).message ?? e));
    }
  };
  // A copy of Orbit set up with its own Google sign-in needs nothing from the student but a click. Without one, the
  // client ID field is for someone who runs their own copy, so it waits behind "Advanced".
  const builtIn = !!envGoogleClientId();
  return (
    <div className="mt-4">
      <p className="text-ink-2 text-[14px]">
        With Google connected, Orbit finds the people you already email and meet, notices replies, and can
        send the messages you approve. It reads conversations with real people, never newsletters. Everything
        stays in this browser.
      </p>
      {builtIn || account ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={connect} disabled={!!busy || !clientId.trim()}>
            {busy ? (
              <>
                <Spinner /> {busy}
              </>
            ) : account ? (
              'Reconnect and sync'
            ) : (
              'Connect Google'
            )}
          </Button>
          {account && (
            <span className="text-[13px] text-good inline-flex items-center gap-1">
              <Check size={14} /> Connected
              {account.externalAccountId ? ` as ${account.externalAccountId}` : ''}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-canvas-2 p-3 text-[13.5px]" data-testid="ob-google-unavailable">
          <p className="font-medium">Google sign-in is not set up on this copy of Orbit.</p>
          <p className="text-ink-2 mt-1">
            That is fine: skip this step. You can add people by hand or import your LinkedIn connections next,
            and approved emails open in your mail app.
          </p>
        </div>
      )}
      {error && <p className="text-bad text-[13px] mt-2">{error}</p>}
      {!builtIn && (
        <details className="mt-4 text-[13px]">
          <summary className="cursor-pointer text-ink-3">
            For developers: connect your own Google Cloud project
          </summary>
          <div className="mt-2">
            <Label
              htmlFor="ob-client-id"
              hint="Google Cloud, APIs and Services, Credentials, OAuth client (Web application), with this site as an authorised JavaScript origin"
            >
              OAuth client ID
            </Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="ob-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="1234567890-abc.apps.googleusercontent.com"
                className="flex-1 min-w-0"
              />
              <Button onClick={connect} disabled={!!busy || !clientId.trim()}>
                Connect Google
              </Button>
            </div>
          </div>
        </details>
      )}
      <Nav onBack={onBack} onNext={onNext} skip={!account} />
    </div>
  );
}

function StepLinkedIn({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  // an import done earlier (before Back, or on another visit) still shows, so the step never looks undone
  const earlier = useLiveQuery(
    () =>
      db.integrations
        .where('userId')
        .equals(user.id)
        .filter((i) => i.provider === 'linkedin_csv')
        .first(),
    [user.id],
  );
  const onFile = async (f: File) => {
    setBusy('Importing…');
    setError(undefined);
    try {
      const r = await importConnectionsCsv(user, await connectionsText(f), (d, t) =>
        setBusy(`Importing ${d}/${t}…`),
      );
      if (r.imported + r.updated === 0) {
        setError(
          'Orbit found nobody in that file. Upload Connections.csv from the LinkedIn export, or the ZIP.',
        );
        return;
      }
      await db.integrations.put({
        id: earlier?.id ?? newId('int'),
        userId: user.id,
        provider: 'linkedin_csv',
        status: 'active',
        scopes: [],
        syncState: { rows: r.imported + r.updated },
        connectedAt: earlier?.connectedAt ?? new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
      setResult(
        `${r.imported} people added, ${r.updated} updated${r.skipped ? `, ${r.skipped} rows skipped` : ''}.`,
      );
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  const doneBefore =
    !result && earlier
      ? `${String((earlier.syncState as { rows?: number }).rows ?? 0)} connections imported.`
      : '';
  return (
    <div className="mt-4">
      <p className="text-ink-2 text-[14px]">
        Bring in everyone you are connected to on LinkedIn, so Orbit can spot alumni and people at your target
        companies. LinkedIn sends the file by email, usually within ten minutes, so you can also skip this now
        and upload it later from Settings.
      </p>
      <ol className="mt-3 space-y-1.5 text-[13.5px] text-ink-2 list-decimal pl-5">
        <li>
          On LinkedIn:{' '}
          <strong className="font-medium text-ink">
            Me → Settings &amp; Privacy → Data privacy → Get a copy of your data
          </strong>
          .
        </li>
        <li>
          Choose <strong className="font-medium text-ink">Connections</strong> (and Messages if you like) and
          request the archive.
        </li>
        <li>
          When the email arrives, download the ZIP and upload it here as it is, or just{' '}
          <code className="bg-canvas-2 px-1 rounded">Connections.csv</code> from inside it.
        </li>
      </ol>
      <label className="mt-4 flex items-center justify-center gap-2 border border-dashed border-line rounded-[12px] h-24 cursor-pointer hover:bg-canvas-2 focus-within:ring-2 focus-within:ring-accent/40">
        <input
          type="file"
          accept=".csv,.zip"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onFile(f);
          }}
          data-testid="ob-linkedin"
        />
        {busy ? <Spinner /> : <Upload size={16} className="text-ink-3" />}{' '}
        <span className="text-[14px]">
          {busy ?? (earlier ? 'Upload a newer export' : 'Upload the ZIP or Connections.csv')}
        </span>
      </label>
      {(result || doneBefore) && (
        <p
          className="text-good text-[13px] mt-2 inline-flex items-center gap-1"
          data-testid="ob-linkedin-done"
        >
          <Check size={14} /> {result || doneBefore}
        </p>
      )}
      {error && (
        <p className="text-bad text-[13px] mt-2" role="alert">
          {error}
        </p>
      )}
      <Nav onBack={onBack} onNext={onNext} skip={!result && !earlier} />
    </div>
  );
}

function StepPrefs({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const [f, setF] = useState({
    briefTimeLocal: '07:00',
    tonePreset: 'warm' as 'warm' | 'direct' | 'formal',
    schedulingLink: '',
    warmUpEnabled: true,
    apiKey: readPrefs().anthropicApiKey ?? '',
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings)
      setF((x) => ({
        ...x,
        briefTimeLocal: settings.briefTimeLocal,
        tonePreset: settings.tonePreset,
        schedulingLink: settings.schedulingLink ?? '',
        warmUpEnabled: settings.warmUpEnabled,
      }));
  }, [settings]);
  const save = async () => {
    setBusy(true);
    await db.settings.update(user.id, {
      briefTimeLocal: f.briefTimeLocal,
      tonePreset: f.tonePreset,
      schedulingLink: f.schedulingLink || undefined,
      warmUpEnabled: f.warmUpEnabled,
    });
    writePrefs({ anthropicApiKey: f.apiKey.trim() || undefined });
    await onNext();
    setBusy(false);
  };
  return (
    <div className="mt-4 grid sm:grid-cols-2 gap-4">
      <p className="sm:col-span-2 text-[13px] text-ink-2 -mt-1">
        All of these can be changed later in Settings.
      </p>
      <div>
        <Label htmlFor="ob-tone" hint="how your drafts sound">
          Writing style
        </Label>
        <Select
          id="ob-tone"
          value={f.tonePreset}
          onChange={(e) => setF({ ...f, tonePreset: e.target.value as never })}
          className="w-full"
        >
          <option value="warm">Warm</option>
          <option value="direct">Direct</option>
          <option value="formal">Formal</option>
        </Select>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="ob-sched" optional hint="Calendly, Cal.com or a Google booking page">
          Scheduling link
        </Label>
        <Input
          id="ob-sched"
          value={f.schedulingLink}
          onChange={(e) => setF({ ...f, schedulingLink: e.target.value })}
          placeholder="https://cal.com/you/20min"
        />
      </div>
      <label className="sm:col-span-2 flex items-start gap-2 text-[13.5px]">
        <input
          type="checkbox"
          className="mt-1"
          checked={f.warmUpEnabled}
          onChange={(e) => setF({ ...f, warmUpEnabled: e.target.checked })}
        />
        <span>
          <strong className="font-medium">Warm up before messaging strangers on LinkedIn.</strong>{' '}
          <span className="text-ink-2">
            For someone you only have on LinkedIn and have never talked to, Orbit first suggests a few small
            steps over a few days, like reacting to one of their posts, so your name is familiar when your
            message arrives. You do each step yourself; Orbit opens the right LinkedIn page.
          </span>
        </span>
      </label>
      <details className="sm:col-span-2 text-[13.5px]">
        <summary className="cursor-pointer text-ink-2">
          Optional, not needed: drafts written by an AI model
        </summary>
        <div className="mt-2">
          <p className="text-[12.5px] text-ink-3 mb-2">
            You can skip this. Orbit writes every draft on its own, for free. If you already pay for an
            Anthropic account (the company behind the Claude AI model), you can paste its API key and Claude
            writes the drafts instead; Anthropic bills that account. The key stays in this browser. Reading
            your email, notes or resume with Claude stays off until you turn it on in Settings.
          </p>
          <Label htmlFor="ob-key" optional>
            Anthropic API key
          </Label>
          <Input
            id="ob-key"
            type="password"
            value={f.apiKey}
            onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            placeholder="Starts with sk-ant-"
          />
        </div>
      </details>
      <p
        className="sm:col-span-2 text-[13px] text-ink-2 rounded-lg bg-canvas-2 p-3"
        data-testid="ob-notes-tip"
      >
        <strong className="font-medium text-ink">After each chat, add a note.</strong> Type, dictate or paste
        what you learned, what they offered and what you promised. Orbit drafts your thank-you from it and
        remembers it for next time. Add note is always one tap away: at the foot of the menu on a laptop, at
        the top of the screen on a phone, and on each person's page.
      </p>
      <div className="sm:col-span-2">
        <Nav onBack={onBack} onNext={save} nextLabel={busy ? 'Finishing…' : 'Finish setup'} disabled={busy} />
      </div>
    </div>
  );
}
