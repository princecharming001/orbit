import type { OwnWordsKey, Resume, TargetCompany, User, RecruitingGoals as UserGoals } from '@orbit/core';
import {
  currentJobInput,
  OWN_WORDS_MAX,
  OWN_WORDS_QUESTIONS,
  ownWordsOf,
  parseCurrentJob,
  TARGET_STATUS_LABELS,
  yearLabel,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Blocks,
  Brain,
  Check,
  ChevronDown,
  CircleUserRound,
  Download,
  FileText,
  Gauge,
  type LucideIcon,
  PenLine,
  Plus,
  Send,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { AccountSection, MemorySection, OutreachSection } from '../components/account/AccountSettings';
import { CompanyLogo } from '../components/CompanyLogo';
import { LinkedInLiveCard, WarmIntrosCard } from '../components/ConnectorCards';
import { AppMark, IntegrationRow, RowGroup, RowStatus } from '../components/IntegrationRow';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { openMorningBrief } from '../components/MorningBrief';
import { CalcomRow, FathomRow, MeetingAppRow } from '../components/NotesAppRows';
import { ResumeFacetList } from '../components/ResumeFacets';
import {
  CardFields,
  SettingsCard,
  SettingsHeader,
  SettingsRow,
  SettingsStack,
} from '../components/settings/kit';
import { OutreachCoach } from '../components/settings/OutreachCoach';
import { useWeeklyLimits, WeeklyTargetSlider } from '../components/WeeklyTargetSlider';
import { suggestCompanies } from '../data/companies';
import {
  cycleOptions,
  INDUSTRY_OPTIONS,
  LOCATION_OPTIONS,
  listField,
  ROLE_OPTIONS,
  suggestFrom,
} from '../data/options';
import { schoolDomainFor, suggestSchools } from '../data/schools';
import { db } from '../db/schema';
import { deleteAllData, exportAllData, exportFilename } from '../engine/account';
import { type Allowance, readAllowance, researchSpend } from '../engine/deepResearch';
import { demoResetPrompt, loadDemo } from '../engine/demo';
import { useFlag } from '../engine/flags';
import { connectAndSyncGoogle, disconnectGoogleAccount, markGoogleNeedsReauth } from '../engine/integrations';
import { checkIntroNote, introNoteBase, saveIntroNote } from '../engine/introNote';
import { liveLinkedInAvailable } from '../engine/linkedinLive';
import { setMorningBrief } from '../engine/morning';
import { saveOwnWords } from '../engine/ownWords';
import { saveResume } from '../engine/resume';
import { googleStatus, refreshSyncStatus, subscribeSyncStatus, syncStatusNow } from '../engine/serverSync';
import {
  LIMIT_RANGES,
  removeTargetCompany,
  restoreTargetCompany,
  saveGoals,
  setBriefTime,
  setReadReplyTone,
  setSchedulingLink,
  setTargetDeadline,
  setTargetPriority,
  setTargetStatus,
  splitList,
  updateLimits,
  updateProfile,
} from '../engine/settings';
import { addTargetCompanies } from '../engine/targets';
import { approvalStreaks, LADDER_KINDS, LADDER_WORDS, OFFER_AT, setAutoKind } from '../engine/trust';
import { fmtFailureTime } from '../integrations/anthropic';
import { currentGoogleToken, googleClientId } from '../integrations/google';
import { isAccountMode, isServerUser, startGoogleSignIn } from '../integrations/orbitApi';
import {
  DEFAULT_DAILY_REQUEST_CAP,
  envGoogleClientId,
  readPrefs,
  subscribePrefs,
  todaysLlmUsage,
  writePrefs,
} from '../integrations/prefs';
import { useSession } from '../state/session';
import {
  Button,
  cx,
  FunctionPicker,
  Input,
  Label,
  PageHeader,
  relDate,
  Select,
  Skeleton,
  SkeletonRows,
  Spinner,
  Switch,
  Textarea,
  useToast,
  useWorking,
  Working,
} from '../ui';
import { Suggest } from '../ui/Suggest';

/** The section with the LinkedIn import, the resume and the Claude key (its route keeps the older name). */
const INTEGRATIONS_LABEL = 'Integrations';

const BASE_SECTIONS = [
  ['profile', 'Profile'],
  ['goals', 'Goals'],
  ['integrations', INTEGRATIONS_LABEL],
  ['style', 'Writing style'],
  ['limits', 'Limits and schedule'],
  ['privacy', 'Data & privacy'],
] as const;

/** Account mode adds the Orbit account, outreach rules (autonomy, pause, postal address) and memory. */
const ACCOUNT_SECTIONS = [
  ['account', 'Account'],
  ['outreach', 'Outreach'],
  ['memory', 'Memory'],
] as const;

/** What Orbit remembers from the chat: on the account when signed in, in this browser otherwise. */
const MEMORY_SECTION = ['memory', 'Memory'] as const;

const SECTION_ICONS: Record<string, LucideIcon> = {
  profile: UserRound,
  goals: Target,
  integrations: Blocks,
  style: PenLine,
  limits: Gauge,
  privacy: ShieldCheck,
  account: CircleUserRound,
  outreach: Send,
  memory: Brain,
};

function sections(): readonly (readonly [string, string])[] {
  return isAccountMode() ? [...BASE_SECTIONS, ...ACCOUNT_SECTIONS] : [...BASE_SECTIONS, MEMORY_SECTION];
}

const SECTION_ALIASES: Record<string, string> = {
  writing: 'style',
  tone: 'style',
  sending: 'limits',
  schedule: 'limits',
  data: 'privacy',
  linkedin: 'integrations',
  google: 'integrations',
};

export function SettingsPage() {
  const { section = 'profile' } = useParams();
  const nav = useNavigate();
  const SECTIONS = sections();
  if (!SECTIONS.some(([k]) => k === section))
    // the words a student might guess ("writing", "tone") go to the section that has them
    return <Navigate to={`/settings/${SECTION_ALIASES[section] ?? 'profile'}`} replace />;
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid @3xl:grid-cols-[208px_minmax(0,1fr)] gap-x-10 gap-y-6 items-start">
        {/* on a phone the six sections are one menu, not three rows of buttons */}
        <label className="@3xl:hidden">
          <span className="sr-only">Settings section</span>
          <Select
            value={section}
            onChange={(e) => nav(`/settings/${e.target.value}`)}
            className="w-full"
            data-testid="settings-section-select"
          >
            {SECTIONS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
        <nav
          className="hidden @3xl:flex @3xl:flex-col @3xl:gap-0.5 min-w-0 sticky top-4"
          aria-label="Settings sections"
        >
          {SECTIONS.map(([k, l]) => {
            const Icon = SECTION_ICONS[k] ?? UserRound;
            return (
              <NavLink
                key={k}
                to={`/settings/${k}`}
                className={({ isActive }) =>
                  cx(
                    'group h-9 px-2.5 rounded-[9px] flex items-center gap-2.5 text-[13.5px] whitespace-nowrap transition-colors',
                    isActive
                      ? 'bg-canvas text-ink font-medium shadow-[var(--shadow-pill)]'
                      : 'text-ink-2 hover:bg-canvas-2 hover:text-ink',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      className={isActive ? 'text-ink' : 'text-ink-3 group-hover:text-ink-2'}
                      aria-hidden
                    />
                    {l}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="min-w-0 @container max-w-[760px]" key={section}>
          <div className="page-in">
            {section === 'profile' && <Profile />}
            {section === 'goals' && <Goals />}
            {section === 'integrations' && <Integrations />}
            {section === 'style' && <StyleCoach />}
            {section === 'limits' && <Limits />}
            {section === 'privacy' && <Privacy />}
            {section === 'account' && <AccountSection />}
            {section === 'outreach' && <OutreachSection />}
            {section === 'memory' && <MemorySection />}
          </div>
        </div>
      </div>
    </div>
  );
}

type ProfileForm = {
  fullName: string;
  email: string;
  school: string;
  schoolDomain: string;
  graduationYear: number;
  degree: string;
  majors: string;
  currentCity: string;
  linkedinUrl: string;
  timezone: string;
};

/**
 * Settings save as they are made, like Limits and schedule: an edit is written a moment after the typing stops, and
 * at once when the section closes or the tab hides, so leaving the page or reloading never loses it. `valid` holds a
 * save back (an empty name) and the page says why.
 */
function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<unknown>,
  valid = true,
): 'saved' | 'saving' | 'held' {
  const json = JSON.stringify(value);
  const [savedJson, setSavedJson] = useState(json);
  const latest = useRef({ value, json, save, valid, savedJson });
  latest.current = { value, json, save, valid, savedJson };
  const flush = () => {
    const l = latest.current;
    if (!l.valid || l.json === l.savedJson) return;
    latest.current.savedJson = l.json;
    l.save(l.value)
      .then(() => setSavedJson(l.json))
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!valid || json === savedJson) return;
    const t = setTimeout(flush, 500);
    return () => clearTimeout(t);
  });
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, []);
  return !valid ? 'held' : json === savedJson ? 'saved' : 'saving';
}

/** How an autosaving section stands. `quiet`: a second one on the page says nothing once saved (screen readers still hear it). */
function SaveState({
  state,
  held,
  quiet,
}: {
  state: 'saved' | 'saving' | 'held';
  held?: string;
  quiet?: boolean;
}) {
  return (
    <p
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors',
        state === 'held' ? 'bg-warn-soft text-warn' : 'bg-canvas-2 text-ink-3',
        quiet && state === 'saved' && 'sr-only',
      )}
      aria-live="polite"
      data-testid="autosave"
      data-state={state}
    >
      {state === 'held' ? (
        (held ?? 'Not saved yet.')
      ) : state === 'saving' ? (
        <>
          <Spinner className="h-3 w-3 border-[1.5px]" /> Saving…
        </>
      ) : quiet ? (
        'Saved'
      ) : (
        <>
          <Check size={13} className="text-good" /> Changes save as you make them
        </>
      )}
    </p>
  );
}

function Profile() {
  const user = useSession().user!;
  const [f, setF] = useState<ProfileForm>(() => ({
    fullName: user.fullName,
    email: user.email,
    school: user.school,
    schoolDomain: user.schoolDomain ?? '',
    graduationYear: user.graduationYear ?? 0,
    degree: user.degree ?? '',
    majors: user.majors.join(', '),
    currentCity: user.currentCity ?? '',
    linkedinUrl: user.linkedinUrl ?? '',
    timezone: user.timezone,
  }));
  // a profile link or photo LinkedIn fills in while this page is open shows up without a reload
  useEffect(() => {
    if (user.linkedinUrl && !f.linkedinUrl) setF((cur) => ({ ...cur, linkedinUrl: user.linkedinUrl! }));
  }, [user.linkedinUrl]);
  const nameMissing = !f.fullName.trim();
  const state = useAutosave(
    f,
    (v) =>
      updateProfile(user.id, {
        ...v,
        majors: splitList(v.majors),
        schoolDomain: v.schoolDomain || undefined,
        linkedinUrl: v.linkedinUrl || undefined,
        graduationYear: v.graduationYear || undefined,
        degree: v.degree || undefined,
      }),
    !nameMissing,
  );
  const zones = timeZones(f.timezone);
  const now = new Date();
  const firstYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  const grad = /\b(MBA|MS|MENG|PHD)\b/i.test(f.degree);
  const years = Array.from({ length: /PHD/i.test(f.degree) ? 6 : grad ? 2 : 4 }, (_, i) => firstYear + i);
  if (f.graduationYear && !years.includes(f.graduationYear)) years.unshift(f.graduationYear);
  return (
    <>
      <SettingsHeader
        title="Profile"
        description="Who you are, as every draft and intro introduces you."
        aside={<SaveState state={state} held="Add your name to save." />}
      />
      <SettingsStack>
        <SettingsCard title="You">
          <CardFields>
            <div className="@[40rem]:col-span-2">
              <Label htmlFor="profile-name-input">Full name</Label>
              <Input
                id="profile-name-input"
                value={f.fullName}
                onChange={(e) => setF({ ...f, fullName: e.target.value })}
                aria-invalid={nameMissing}
                aria-describedby={nameMissing ? 'profile-name-error' : undefined}
                data-testid="profile-name"
              />
              {nameMissing && (
                <p id="profile-name-error" className="text-[12px] text-bad mt-1">
                  Your name is used to sign every message. Add it to save.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="profile-linkedin">LinkedIn profile link</Label>
              <Input
                id="profile-linkedin"
                value={f.linkedinUrl}
                onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="profile-city">City</Label>
              <Input
                id="profile-city"
                value={f.currentCity}
                onChange={(e) => setF({ ...f, currentCity: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="profile-tz">Time zone</Label>
              <Select
                id="profile-tz"
                value={f.timezone}
                onChange={(e) => setF({ ...f, timezone: e.target.value })}
                className="w-full"
              >
                {/* the zones most students are in first, by the name people use; every other zone below */}
                <optgroup label="United States">
                  {COMMON_ZONES.map(([z, l]) => (
                    <option key={z} value={z}>
                      {l}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Other time zones">
                  {zones
                    .filter((z) => !COMMON_ZONES.some(([c]) => c === z))
                    .sort((x, y) => zoneLabel(x).localeCompare(zoneLabel(y)))
                    .map((z) => (
                      <option key={z} value={z}>
                        {zoneLabel(z)}
                      </option>
                    ))}
                </optgroup>
              </Select>
            </div>
          </CardFields>
        </SettingsCard>
        <SettingsCard title="School">
          <CardFields>
            <div>
              <Label htmlFor="profile-school">School</Label>
              <Suggest
                id="profile-school"
                value={f.school}
                onChange={(school) => setF({ ...f, school })}
                suggest={suggestSchools}
                minChars={2}
                onPick={(s) =>
                  void schoolDomainFor(s.value).then(
                    (d) => d && !f.schoolDomain && setF((cur) => ({ ...cur, schoolDomain: d })),
                  )
                }
                placeholder="Start typing your school"
                data-testid="profile-school"
              />
            </div>
            <div>
              <Label htmlFor="profile-domain">School email domain</Label>
              <Input
                id="profile-domain"
                value={f.schoolDomain}
                onChange={(e) => setF({ ...f, schoolDomain: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="profile-year">Graduation year</Label>
              {/* the same choice as in setup, with the year it makes you now */}
              <Select
                id="profile-year"
                value={f.graduationYear ? String(f.graduationYear) : ''}
                onChange={(e) => setF({ ...f, graduationYear: Number(e.target.value) })}
                className="w-full"
              >
                <option value="">Choose your year</option>
                {years.map((y) => (
                  <option key={y} value={String(y)}>
                    {y} ({yearLabel(y, f.degree || undefined, now)} now)
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="profile-degree">Degree</Label>
              <Select
                id="profile-degree"
                value={f.degree}
                onChange={(e) => setF({ ...f, degree: e.target.value })}
                className="w-full"
                data-testid="profile-degree"
              >
                <option value="">Not set</option>
                {['BS', 'BA', 'BBA', 'MS', 'MBA', 'MEng', 'PhD', 'Other'].map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="profile-majors">Majors</Label>
              <Input
                id="profile-majors"
                value={f.majors}
                onChange={(e) => setF({ ...f, majors: e.target.value })}
              />
            </div>
          </CardFields>
        </SettingsCard>
        <IntroNoteSection />
      </SettingsStack>
    </>
  );
}

/**
 * "Your three lines" (plan 23 §4.3): the note an introducer can forward, about the student in the third person. Every
 * intro ask reuses it, with a last line written for that ask. Empty goes back to the version Orbit writes.
 */
function IntroNoteSection() {
  const user = useSession().user!;
  const base = useLiveQuery(() => introNoteBase(user), [user.id]);
  const [text, setText] = useState<string>();
  useEffect(() => {
    if (base && text === undefined) setText(base.text);
  }, [base]);
  const state = useAutosave(
    text ?? '',
    (v) => (base && v !== base.text ? saveIntroNote(user.id, v) : Promise.resolve()),
    text !== undefined,
  );
  const problems = text ? checkIntroNote(text, user) : [];
  return (
    <SettingsCard
      id="intro-note"
      title="Your three lines"
      description="The note someone forwards when you ask them for an intro. Each ask adds one last line about why that person."
      aside={
        <span className="text-[12px] text-ink-3" aria-live="polite" data-testid="intro-note-saved">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}
        </span>
      }
    >
      <div className="p-5">
        <label htmlFor="intro-note-input" className="sr-only">
          Your three lines
        </label>
        <Textarea
          id="intro-note-input"
          value={text ?? ''}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="w-full"
          data-testid="settings-intro-note"
        />
        {problems.length > 0 && (
          <p className="text-[12.5px] text-warn mt-1.5" data-testid="settings-intro-note-problem">
            {problems[0]}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

/** "London (Europe)" rather than "Europe/London": the city first, the way people look for it. */
function zoneLabel(z: string): string {
  const parts = z.split('/');
  if (parts.length < 2) return z.replace(/_/g, ' ');
  const city = parts.slice(1).reverse().join(', ').replace(/_/g, ' ');
  return `${city} (${parts[0]!.replace(/_/g, ' ')})`;
}

/** Every time zone the browser knows, with the current one first if it is not in the list (an old "UTC"). */
const COMMON_ZONES: [string, string][] = [
  ['America/New_York', 'Eastern time (New York)'],
  ['America/Chicago', 'Central time (Chicago)'],
  ['America/Denver', 'Mountain time (Denver)'],
  ['America/Phoenix', 'Arizona (Phoenix)'],
  ['America/Los_Angeles', 'Pacific time (Los Angeles)'],
  ['America/Anchorage', 'Alaska (Anchorage)'],
  ['Pacific/Honolulu', 'Hawaii (Honolulu)'],
];

function timeZones(current: string): string[] {
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ??
      [];
  } catch {}
  if (!all.length)
    all = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC'];
  return all.includes(current) ? all : [current, ...all];
}

const roles = listField(ROLE_OPTIONS);
const industries = listField(INDUSTRY_OPTIONS);
const locations = listField(LOCATION_OPTIONS);
const cycles = cycleOptions();

function Goals() {
  const user = useSession().user!;
  // null: no goals saved (nothing to edit); undefined: still reading
  const goals = useLiveQuery(async () => (await db.goals.get(user.id)) ?? null, [user.id]);
  const tcs =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
  if (goals === undefined) return <FormLoading fields={5} />;
  if (!goals) return null;
  return <GoalsForm goals={goals} tcs={tcs} />;
}

function GoalsForm({ goals, tcs }: { goals: UserGoals; tcs: TargetCompany[] }) {
  const user = useSession().user!;
  // filled once from what is stored; saving as the student types never resets what they are typing
  const [f, setF] = useState(() => ({
    cycleLabel: goals.cycleLabel,
    targetRoles: goals.targetRoles.join(', '),
    targetFunctions: goals.targetFunctions,
    targetIndustries: goals.targetIndustries.join(', '),
    targetLocations: goals.targetLocations.join(', '),
  }));
  const [company, setCompany] = useState('');
  const toast = useToast();
  // "Evercore, Lazard" adds two companies
  const addCompany = async () => {
    // take the text now and clear the box at once, so a company typed while this one saves is kept
    const value = company;
    setCompany('');
    let r: Awaited<ReturnType<typeof addTargetCompanies>>;
    try {
      r = await addTargetCompanies(user.id, value);
    } catch (e) {
      setCompany((current) => current || value);
      throw e;
    }
    if (r.duplicates.length)
      toast.push({
        text: `${r.duplicates.join(', ')} ${r.duplicates.length === 1 ? 'is' : 'are'} already on your list.`,
      });
  };
  const split = splitList;
  // the ambition lives on the same row and may have changed elsewhere: saveGoals keeps the stored one
  const state = useAutosave(f, (v) =>
    saveGoals(user.id, {
      cycleLabel: v.cycleLabel,
      targetRoles: split(v.targetRoles),
      targetFunctions: v.targetFunctions,
      targetIndustries: split(v.targetIndustries),
      targetLocations: split(v.targetLocations),
    }),
  );
  return (
    <>
      <SettingsHeader
        title="Goals"
        description="What you are recruiting for. Orbit picks people and writes drafts around it."
        aside={<SaveState state={state} />}
      />
      <SettingsStack>
        <SettingsCard title="What you're going for">
          <CardFields>
            <div className="@[40rem]:col-span-2">
              <Label htmlFor="goals-cycle">Recruiting cycle</Label>
              <Suggest
                id="goals-cycle"
                value={f.cycleLabel}
                onChange={(cycleLabel) => setF({ ...f, cycleLabel })}
                suggest={(q) =>
                  suggestFrom(
                    cycles.map((c) => c.value),
                    q,
                  ).map((s) => cycles.find((c) => c.value === s.value) ?? s)
                }
                initial={cycles}
                minChars={0}
                data-testid="goals-cycle"
              />
            </div>
            <div className="@[40rem]:col-span-2">
              <Label>What kind of work</Label>
              <FunctionPicker
                value={f.targetFunctions}
                onChange={(targetFunctions) => setF({ ...f, targetFunctions })}
                testIdPrefix="settings-fn"
              />
            </div>
            <div className="@[40rem]:col-span-2">
              <Label htmlFor="goals-roles" hint="comma-separated">
                Target roles
              </Label>
              <Suggest
                id="goals-roles"
                value={f.targetRoles}
                onChange={(targetRoles) => setF({ ...f, targetRoles })}
                suggest={roles.suggest}
                onPick={(s) =>
                  setF((cur) => ({
                    ...cur,
                    targetRoles: roles.pick(cur.targetRoles, s.value),
                  }))
                }
                minChars={0}
                placeholder="e.g. Product Manager, Software Engineer"
              />
            </div>
            <div>
              <Label htmlFor="goals-industries">Industries</Label>
              <Suggest
                id="goals-industries"
                value={f.targetIndustries}
                onChange={(targetIndustries) => setF({ ...f, targetIndustries })}
                suggest={industries.suggest}
                onPick={(s) =>
                  setF((cur) => ({
                    ...cur,
                    targetIndustries: industries.pick(cur.targetIndustries, s.value),
                  }))
                }
                minChars={0}
                placeholder="e.g. Fintech, Consumer"
              />
            </div>
            <div>
              <Label htmlFor="goals-locations">Locations</Label>
              <Suggest
                id="goals-locations"
                value={f.targetLocations}
                onChange={(targetLocations) => setF({ ...f, targetLocations })}
                suggest={locations.suggest}
                onPick={(s) =>
                  setF((cur) => ({
                    ...cur,
                    targetLocations: locations.pick(cur.targetLocations, s.value),
                  }))
                }
                minChars={0}
                placeholder="e.g. New York City, Remote"
              />
            </div>
          </CardFields>
        </SettingsCard>
        <OwnWordsSection goals={goals} />
        <SettingsCard
          title="Target companies"
          description={
            tcs.length
              ? `${tcs.length} ${tcs.length === 1 ? 'company' : 'companies'} you're aiming for.`
              : 'Discover and drafts lean toward the companies you add here.'
          }
        >
          <div className="flex gap-2 p-4 bg-canvas-2/50">
            <Suggest
              className="flex-1 min-w-0"
              value={company}
              onChange={setCompany}
              suggest={(q) =>
                suggestCompanies(
                  q,
                  tcs.map((t) => t.nameRaw),
                )
              }
              minChars={1}
              placeholder="Add a company, like Stripe"
              aria-label="Add a target company"
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !(e.target as HTMLInputElement).getAttribute('aria-activedescendant')
                )
                  addCompany();
              }}
            />
            <Button variant="primary" onClick={addCompany} disabled={!company.trim()}>
              <Plus size={14} /> Add
            </Button>
          </div>
          {tcs.length > 0 && (
            <div
              className="hidden @[40rem]:grid grid-cols-[minmax(0,1fr)_128px_136px_148px_32px] gap-3 px-5 py-2 text-[11.5px] font-medium text-ink-3"
              aria-hidden
            >
              <span>Company</span>
              <span>Priority</span>
              <span>Application</span>
              <span>Deadline</span>
              <span />
            </div>
          )}
          {tcs.map((t) => (
            <div
              key={t.id}
              className="grid grid-cols-[minmax(0,1fr)_32px] @[40rem]:grid-cols-[minmax(0,1fr)_128px_136px_148px_32px] items-center gap-x-3 gap-y-2 px-5 py-2.5 text-[13.5px]"
              data-testid="settings-target-row"
            >
              <span className="font-medium min-w-0 inline-flex items-center gap-2.5">
                <CompanyLogo name={t.nameRaw} size={22} decorative />
                <span className="truncate">{t.nameRaw}</span>
              </span>
              <button
                type="button"
                className="@[40rem]:order-last justify-self-end text-ink-3 hover:text-bad hover:bg-bad-soft h-8 w-8 inline-flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={async () => {
                  const removed = await removeTargetCompany(t.id);
                  toast.push({
                    text: `Removed ${t.nameRaw} from your targets.`,
                    action: {
                      label: 'Undo',
                      onClick: () => restoreTargetCompany(removed ?? t),
                    },
                    ttl: 7000,
                  });
                }}
                aria-label={`Remove ${t.nameRaw}`}
                title={`Remove ${t.nameRaw} from your targets`}
              >
                <Trash2 size={14} />
              </button>
              <div className="col-span-2 @[40rem]:col-span-1 @[40rem]:contents grid grid-cols-3 gap-2">
                <Select
                  value={t.priority}
                  onChange={(e) => setTargetPriority(t.id, Number(e.target.value) as 1 | 2 | 3)}
                  className="h-8 w-full text-[12.5px]"
                  aria-label={`Priority for ${t.nameRaw}`}
                >
                  <option value={1}>Top priority</option>
                  <option value={2}>Normal</option>
                  <option value={3}>Low</option>
                </Select>
                <Select
                  value={t.status}
                  onChange={(e) => setTargetStatus(t.id, e.target.value as never)}
                  className="h-8 w-full text-[12.5px]"
                  aria-label={`Application status for ${t.nameRaw}`}
                >
                  {Object.entries(TARGET_STATUS_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Input
                  type="date"
                  value={t.deadline ?? ''}
                  onChange={(e) => setTargetDeadline(t.id, e.target.value || undefined)}
                  className={cx('h-8 w-full text-[12.5px] px-2', !t.deadline && 'text-ink-3')}
                  aria-label={`Application deadline for ${t.nameRaw}`}
                />
              </div>
            </div>
          ))}
        </SettingsCard>
      </SettingsStack>
    </>
  );
}

/** The order the written answers are shown in Settings: the same questions as setup (plan 24). */
const OWN_WORDS_ORDER: OwnWordsKey[] = [
  'aim',
  'success',
  'story',
  'proudOf',
  'wantToMeet',
  'networkingHard',
  'neverDo',
];

/**
 * Your goals, in your own words (plan 24): every written answer from setup, editable here, saved as it is typed. In
 * account mode a change also goes to the server, like the profile.
 */
function OwnWordsSection({ goals }: { goals: UserGoals }) {
  const user = useSession().user!;
  const [f, setF] = useState(() => {
    const w = ownWordsOf(goals);
    return {
      ...Object.fromEntries(OWN_WORDS_ORDER.map((k) => [k, w[k] ?? ''])),
      currentJob: currentJobInput(w.currentJob),
    } as Record<OwnWordsKey | 'currentJob', string>;
  });
  const state = useAutosave(f, (v) =>
    saveOwnWords(user, {
      ...Object.fromEntries(OWN_WORDS_ORDER.map((k) => [k, v[k]])),
      currentJob: parseCurrentJob(v.currentJob),
    }),
  );
  return (
    <SettingsCard
      title="In your own words"
      description="Drafts borrow these lines, so write them the way you would say them."
      aside={<SaveState state={state} quiet />}
      data-testid="settings-own-words"
    >
      <div className="space-y-5 p-5">
        {OWN_WORDS_ORDER.map((k) => {
          const q = OWN_WORDS_QUESTIONS[k];
          return (
            <div key={k}>
              <Label htmlFor={`goals-${k}`}>{q.label}</Label>
              <Textarea
                id={`goals-${k}`}
                rows={2}
                value={f[k]}
                maxLength={OWN_WORDS_MAX}
                placeholder={q.placeholder}
                onChange={(e) => setF((cur) => ({ ...cur, [k]: e.target.value }))}
                data-testid={`goals-${k}`}
              />
            </div>
          );
        })}
        <div>
          <Label htmlFor="goals-currentJob">A job you're going for now</Label>
          <Input
            id="goals-currentJob"
            value={f.currentJob}
            placeholder="https://jobs.lever.co/acme/123, or Stripe, PM intern"
            onChange={(e) => setF((cur) => ({ ...cur, currentJob: e.target.value }))}
            data-testid="goals-currentJob"
          />
        </div>
      </div>
    </SettingsCard>
  );
}

/**
 * Google for an Orbit account: the server holds the connection, so the row says what the server says (asked again when
 * Settings opens): connected with the address and the last sync, or signed out by Google with Sign in again, which
 * signs in with Google once more and puts the server's access back.
 */
function GoogleAccountRow() {
  const [status, setStatus] = useState(() => syncStatusNow());
  useEffect(() => subscribeSyncStatus(setStatus), []);
  useEffect(() => {
    void refreshSyncStatus().catch(() => undefined);
  }, []);
  const g = googleStatus(status);
  const signedOut = !!g && ['needs_reauth', 'revoked', 'error'].includes(g.status);
  return (
    <IntegrationRow
      testId="google-via-account"
      mark={<AppMark logo="google.com">G</AppMark>}
      name="Google"
      status={
        signedOut ? (
          <RowStatus tone="bad" testId="google-via-account-status">
            {g.status === 'error' ? 'The last sync did not go through' : 'Signed out by Google'}
            {g.lastSyncedAt ? ` · synced ${relDate(g.lastSyncedAt)}` : ''}
          </RowStatus>
        ) : (
          <RowStatus tone={g ? 'good' : 'muted'} testId="google-via-account-status">
            <Check size={12} /> Connected
            {g?.email ? ` as ${g.email}` : ' through your Orbit account'}
            {g?.lastSyncedAt ? ` · synced ${relDate(g.lastSyncedAt)}` : ''}
          </RowStatus>
        )
      }
      line={
        signedOut ? (
          'Orbit cannot read your email or calendar until you sign in with Google again'
        ) : (
          <NavLink to="/settings/account" className="underline underline-offset-2 hover:text-ink">
            Account settings
          </NavLink>
        )
      }
      actions={
        signedOut ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => startGoogleSignIn()}
            data-testid="google-via-account-signin"
          >
            Sign in again
          </Button>
        ) : undefined
      }
    />
  );
}

function Integrations() {
  const user = useSession().user!;
  const toast = useToast();
  const accountsQ = useLiveQuery(() => db.integrations.where('userId').equals(user.id).toArray(), [user.id]);
  const accounts = accountsQ ?? [];
  const google = accounts.find((a) => a.provider === 'google');
  const li = accounts.find((a) => a.provider === 'linkedin_csv');
  const resume = useLiveQuery(
    async () =>
      // "on file" once it is read too: the lines and the profile offer are written before parsedAt
      (await db.resumes.where('userId').equals(user.id).toArray())
        .filter((r) => r.isCurrent && r.parsedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [user.id],
  );
  const [clientId, setClientId] = useState(googleClientId() ?? '');
  const [busy, setBusy] = useState<string>();
  const token = currentGoogleToken();
  const builtIn = !!envGoogleClientId();
  const connect = async () => {
    try {
      setBusy('Waiting for Google…');
      const { warning } = await connectAndSyncGoogle(user, {
        clientId,
        onProgress: (p) => setBusy(`${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
      });
      toast.push(
        warning ? { text: warning, tone: 'bad', ttl: 10_000 } : { text: 'Google synced.', tone: 'good' },
      );
    } catch (e) {
      toast.push({
        text: String((e as Error).message ?? e),
        tone: 'bad',
        ttl: 7000,
      });
      if (google) await markGoogleNeedsReauth(user.id, String((e as Error).message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  // an Orbit account connected Google at sign-in: the browser's own Google sign-in is not needed
  const viaAccount = isServerUser(user.id);
  const googleOffered = builtIn || !!google;
  // until the accounts are read, a connected service would show as off: the rows show their shape instead
  const header = (
    <SettingsHeader
      title="Integrations"
      description="Where Orbit finds your people and what it knows about you."
    />
  );
  if (accountsQ === undefined)
    return (
      <>
        {header}
        <SkeletonRows rows={6} avatar={36} divided testId="integrations-loading" />
      </>
    );
  return (
    <div className="pb-10">
      {header}
      <RowGroup title="Your network">
        {viaAccount ? (
          <GoogleAccountRow />
        ) : (
          <IntegrationRow
            mark={<AppMark logo="google.com">G</AppMark>}
            name="Google"
            status={
              google ? (
                <RowStatus tone={token ? 'good' : 'muted'}>
                  <Check size={12} /> Connected
                  {google.externalAccountId ? ` as ${google.externalAccountId}` : ''} · synced{' '}
                  {google.lastSyncedAt ? relDate(google.lastSyncedAt) : 'never'}
                  {!token && ' · signed out, reconnect to sync'}
                </RowStatus>
              ) : undefined
            }
            line={
              googleOffered ? undefined : (
                <span data-testid="google-unavailable">
                  Not part of this version of Orbit. Send from your own mail app and press I sent it.
                </span>
              )
            }
            actions={
              googleOffered ? (
                <>
                  {google && (
                    <Button size="sm" variant="ghost" onClick={connect} disabled={!!busy}>
                      {busy ? (
                        <>
                          <Spinner /> {busy}
                        </>
                      ) : (
                        'Sync now'
                      )}
                    </Button>
                  )}
                  <Switch
                    checked={!!google}
                    label="Google"
                    busy={!!busy && !google}
                    disabled={!google && !clientId.trim()}
                    title={google ? 'Disconnect Google' : 'Connect Google'}
                    onChange={async (on) => {
                      if (on) return connect();
                      await disconnectGoogleAccount(user.id);
                      toast.push({
                        text: 'Disconnected. Imported mail stays until you delete your data.',
                      });
                    }}
                    data-testid="settings-google-switch"
                  />
                </>
              ) : undefined
            }
          >
            {!builtIn && (
              <details className="text-[12.5px]">
                <summary className="cursor-pointer text-ink-3 w-fit">
                  For developers: your own Google Cloud project
                </summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input
                    id="settings-client-id"
                    aria-label="OAuth client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="…apps.googleusercontent.com"
                    className="flex-1 min-w-0"
                  />
                  {!google && (
                    <Button size="sm" onClick={connect} disabled={!!busy || !clientId.trim()}>
                      Connect
                    </Button>
                  )}
                </div>
              </details>
            )}
          </IntegrationRow>
        )}
        <LinkedInLiveCard user={user} />
        {/* the file upload only for a build without live LinkedIn; with it, LinkedIn connects through its sign-in */}
        {!liveLinkedInAvailable(user) && (
          <IntegrationRow
            mark={
              <AppMark logo="linkedin.com" badge="CSV">
                csv
              </AppMark>
            }
            name="LinkedIn export"
            status={
              li ? (
                <RowStatus>
                  <Check size={12} /> {String((li.syncState as { rows?: number }).rows ?? 0)} connections
                  {li.lastSyncedAt ? ` · imported ${relDate(li.lastSyncedAt)}` : ''}
                </RowStatus>
              ) : undefined
            }
            line={
              <>
                Upload Connections.csv{' '}
                <details className="inline">
                  <summary className="inline cursor-pointer underline underline-offset-2 hover:text-ink">
                    How?
                  </summary>
                  <span className="block mt-1">
                    On LinkedIn: Settings, Data privacy, Get a copy of your data, Connections. Upload the file
                    it emails you; uploading again updates people, never doubles them.
                  </span>
                </details>
              </>
            }
            actions={<LinkedInImportButton label="Upload" testId="settings-linkedin" />}
          />
        )}
        <WarmIntrosCard user={user} />
      </RowGroup>
      <RowGroup title="Meeting notes">
        <FathomRow user={user} />
        <MeetingAppRow user={user} app="granola" />
        <MeetingAppRow user={user} app="fireflies" />
        <MeetingAppRow user={user} app="wispr" />
      </RowGroup>
      <RowGroup title="Scheduling">
        <CalcomRow user={user} />
      </RowGroup>
      <RowGroup title="About you">
        <ResumeRow user={user} resume={resume} />
        <ClaudeCard />
        <ResearchCard />
      </RowGroup>
    </div>
  );
}

/** "PDF", "DOCX": the file's kind, for the tile the resume row shows. */
function fileKind(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ['pdf', 'docx', 'txt', 'md'].includes(ext) ? ext.toUpperCase() : 'DOC';
}

/**
 * The resume on file: the file as a tile with its name and date, how many lines Orbit read from it, and (opened) those
 * lines, each one switchable and fixable, since drafts and intros quote them.
 */
function ResumeRow({ user, resume }: { user: User; resume?: Resume }) {
  const toast = useToast();
  const [reading, setReading] = useState(false);
  const [open, setOpen] = useState(false);
  const facets = useLiveQuery(
    async () => (resume ? await db.resumeFacets.where('resumeId').equals(resume.id).toArray() : []),
    [resume?.id],
  );
  const used = (facets ?? []).filter((f) => !f.excluded).length;
  return (
    <IntegrationRow
      mark={
        resume ? (
          <span
            className="relative inline-flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-[10px] bg-[#fff1ec] text-[#d4380d]"
            aria-hidden
          >
            <FileText size={15} strokeWidth={1.75} />
            <span className="mt-px text-[7.5px] font-bold tracking-wide">{fileKind(resume.filename)}</span>
          </span>
        ) : (
          <AppMark>
            <FileText size={15} />
          </AppMark>
        )
      }
      name="Resume"
      status={
        <span className="text-[12px]" data-testid="resume-on-file">
          {resume ? (
            <span className="text-good inline-flex items-center gap-1">
              <Check size={12} /> On file
            </span>
          ) : (
            <span className="text-ink-3">No resume yet</span>
          )}
        </span>
      }
      line={
        resume ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span className="truncate max-w-[22ch] font-medium text-ink-2" data-testid="resume-file-name">
              {resume.filename}
            </span>
            <span aria-hidden>·</span>
            <span>added {relDate(resume.createdAt)}</span>
            {facets && facets.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                  className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-ink hover:underline"
                  data-testid="resume-lines-toggle"
                >
                  {used} of {facets.length} lines used
                  <ChevronDown size={13} className={cx('transition-transform', open && 'rotate-180')} />
                </button>
              </>
            )}
          </span>
        ) : (
          'PDF, Word or text, up to 10 MB. Drafts mention what you have done.'
        )
      }
      actions={
        <label className="inline-flex rounded-full focus-within:ring-2 focus-within:ring-accent/40">
          <input
            type="file"
            accept=".pdf,.txt,.md,.docx"
            className="sr-only"
            disabled={reading}
            onChange={async (e) => {
              const input = e.target;
              const f = input.files?.[0];
              if (!f) return;
              setReading(true);
              try {
                await saveResume(user, f);
                toast.push({ text: 'Resume updated.', tone: 'good' });
              } catch (err) {
                toast.push({
                  text: err instanceof Error && err.message ? err.message : "That file couldn't be read.",
                  tone: 'bad',
                });
              } finally {
                setReading(false);
                // the same file can be picked again after a failure
                input.value = '';
              }
            }}
          />
          <span className="inline-flex items-center justify-center gap-1.5 rounded-full font-medium h-8 px-3 text-[13px] bg-canvas border border-line shadow-[var(--shadow-pill)] hover:bg-canvas-2 cursor-pointer">
            {reading ? (
              <>
                <Working /> Reading…
              </>
            ) : resume ? (
              'Replace'
            ) : (
              <>
                <Upload size={13} /> Upload
              </>
            )}
          </span>
        </label>
      }
    >
      {open && facets && facets.length > 0 && <ResumeFacetList facets={facets} readBy="Orbit" />}
    </IntegrationRow>
  );
}

/**
 * Deep research (docs/plan/20): how many people the student researched this month and what it cost. The About tab
 * shows only the count left; the dollars live here.
 */
function ResearchCard() {
  const { user } = useSession();
  const spend = useLiveQuery(() => (user ? researchSpend(user.id) : undefined), [user?.id]);
  const [left, setLeft] = useState<Allowance>();
  useEffect(() => {
    if (user)
      void readAllowance(user)
        .then(setLeft)
        .catch(() => undefined);
  }, [user?.id, spend?.runs]);
  if (!user) return null;
  return (
    <IntegrationRow
      mark={<AppMark>R</AppMark>}
      name="Deep research"
      status={<RowStatus>{left ? `${left.left} of ${left.limit} left this month` : 'Built in.'}</RowStatus>}
    >
      <p className="text-[12px] text-ink-3" data-testid="research-spend">
        {spend?.briefs ?? 0} {spend?.briefs === 1 ? 'person' : 'people'} researched, $
        {(spend?.usd ?? 0).toFixed(2)} this month
      </p>
    </IntegrationRow>
  );
}

/**
 * Claude is built in: the row says so with today's use, and its one switch shows Orbit's reasoning. A key saved by an
 * older build can be dropped for the built-in one.
 */
function ClaudeCard() {
  const tz = useSession().user?.timezone;
  const [prefs, setPrefs] = useState(readPrefs);
  // Stay in step with changes made by Claude calls and by Orbit open in another tab.
  useEffect(() => subscribePrefs(setPrefs), []);
  const usage = todaysLlmUsage(prefs);
  const reqCap = prefs.llmDailyRequestCap ?? DEFAULT_DAILY_REQUEST_CAP;
  const keySaved = !!prefs.anthropicApiKey;
  return (
    <IntegrationRow
      mark={<AppMark logo="claude.ai">AI</AppMark>}
      name="Claude"
      status={
        <RowStatus testId="ai-chat-row">
          <Check size={12} /> {keySaved ? 'Key saved.' : 'Built in.'} {usage.requests} of {reqCap} requests
          today
        </RowStatus>
      }
      actions={
        <>
          {keySaved && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPrefs(writePrefs({ anthropicApiKey: undefined }))}
              data-testid="ai-remove-key"
            >
              Use built-in
            </Button>
          )}
          <span className="text-[12.5px] text-ink-2">Show reasoning</span>
          <Switch
            checked={!!prefs.showReasoning}
            label="Show Orbit's reasoning"
            onChange={(on) => setPrefs(writePrefs({ showReasoning: on }))}
            data-testid="ai-reasoning-switch"
          />
        </>
      }
    >
      {prefs.lastLlmError && (
        <p className="text-[12px] text-bad" data-testid="ai-last-error">
          Last problem, {fmtFailureTime(prefs.lastLlmError.at, tz)}: {prefs.lastLlmError.message} Orbit used
          its templates instead.
        </p>
      )}
    </IntegrationRow>
  );
}

/** How drafts sound: the outreach coach, tuned by telling it what to change. */
function StyleCoach() {
  const user = useSession().user!;
  return (
    <div className="pb-10">
      <SettingsHeader
        title="Writing style"
        description="How your drafts sound. Tell the coach what to change and every draft after follows it."
      />
      <OutreachCoach user={user} />
    </div>
  );
}

/**
 * The trust ladder as it stands (plan 23 §4.9): each kind Orbit may send on its own, earned by approvals without an
 * edit, with a switch; and what it never sends on its own.
 */
function TrustLadder() {
  const user = useSession().user!;
  const on = useFlag('trustLadder');
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const streaks = useLiveQuery(() => approvalStreaks(user.id), [user.id]);
  if (!on || !settings || !streaks) return null;
  const auto = new Set(settings.autoKinds ?? []);
  return (
    <SettingsCard
      title="What Orbit sends on its own"
      description={`After you approve ${OFFER_AT} of a kind without changing a word, Orbit offers to send that kind itself, by email, in their morning. You see each one after it goes and can undo it for a minute.`}
      data-testid="settings-ladder"
      footer={
        <p className="mr-auto text-[12px] text-ink-3" data-testid="settings-ladder-never">
          Never on its own: first messages, intro asks, anything on LinkedIn.
        </p>
      }
    >
      {LADDER_KINDS.map((k) => {
        const w = LADDER_WORDS[k];
        const mine = auto.has(k);
        return (
          <div
            key={k}
            className="flex items-center gap-3 px-5 py-3.5 text-[13.5px]"
            data-testid="settings-ladder-row"
          >
            <span className="font-medium min-w-0 flex-1">{w.title}</span>
            <span
              className={cx('text-[12.5px]', mine ? 'text-good' : 'text-ink-3')}
              data-testid="settings-ladder-state"
            >
              {mine
                ? 'Orbit sends'
                : streaks[k].unedited >= OFFER_AT
                  ? 'earned, asks you'
                  : `${Math.min(streaks[k].unedited, OFFER_AT)} of ${OFFER_AT} approved`}
            </span>
            <Switch
              checked={mine}
              onChange={(v: boolean) => void setAutoKind(user.id, k, v)}
              label={`Orbit sends ${w.many} on its own`}
            />
          </div>
        );
      })}
    </SettingsCard>
  );
}

function Limits() {
  const user = useSession().user!;
  const settings = useLiveQuery(async () => (await db.settings.get(user.id)) ?? null, [user.id]);
  const limits = useWeeklyLimits(user.id);
  const [savedAt, setSavedAt] = useState<number>();
  if (settings === undefined) return <FormLoading fields={6} />;
  if (!settings) return null;
  const upd = async (p: Partial<typeof settings>) => {
    if ('schedulingLink' in p) await setSchedulingLink(user.id, p.schedulingLink);
    else await updateLimits(user.id, p);
    setSavedAt(Date.now());
  };
  return (
    <>
      <SettingsHeader
        title="Limits and schedule"
        description="How many people Orbit drafts for, how fast it sends, and when it checks in."
        aside={
          savedAt ? (
            <span
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-canvas-2 px-2.5 text-[12px] text-ink-3"
              aria-live="polite"
            >
              <Check size={13} className="text-good" /> Saved
            </span>
          ) : undefined
        }
      />
      <SettingsStack>
        <SettingsCard title="Weekly pace">
          <SettingsRow
            stack
            label="First messages a week"
            description="Orbit drafts this many first messages, spread over your sending days."
          >
            <WeeklyTargetSlider
              id="lim-week"
              value={settings.weeklyOutreachTarget}
              onChange={(v) => upd({ weeklyOutreachTarget: v })}
              testId="settings-weekly"
              limits={limits}
            />
          </SettingsRow>
        </SettingsCard>
        <SettingsCard
          title="Sending limits"
          description="Guard rails that keep your accounts in good standing."
          data-testid="limits-advanced"
        >
          <SettingsRow
            htmlFor="lim-gmail"
            label="Emails per day"
            description="At most, across everyone."
            control={
              <Input
                id="lim-gmail"
                type="number"
                min={1}
                max={LIMIT_RANGES.dailySendCapGmail[1]}
                value={settings.dailySendCapGmail}
                onChange={(e) => upd({ dailySendCapGmail: Number(e.target.value) })}
                className="w-24 h-9 text-right tabular-nums"
              />
            }
          />
          <SettingsRow
            htmlFor="lim-li"
            label="LinkedIn messages per day"
            description="At most, across everyone."
            control={
              <Input
                id="lim-li"
                type="number"
                min={1}
                max={LIMIT_RANGES.dailySendCapLinkedin[1]}
                value={settings.dailySendCapLinkedin}
                onChange={(e) => upd({ dailySendCapLinkedin: Number(e.target.value) })}
                className="w-24 h-9 text-right tabular-nums"
              />
            }
          />
          <SettingsRow
            htmlFor="lim-cool"
            label="Hours between messages to one person"
            control={
              <Input
                id="lim-cool"
                type="number"
                min={0}
                value={settings.perPersonCooldownHours}
                onChange={(e) => upd({ perPersonCooldownHours: Number(e.target.value) })}
                className="w-24 h-9 text-right tabular-nums"
              />
            }
          />
          <SettingsRow
            htmlFor="lim-bumps"
            label="Follow-ups without a reply"
            description="None, one or two."
            control={
              <Input
                id="lim-bumps"
                type="number"
                min={0}
                max={2}
                value={settings.maxBumps}
                onChange={(e) =>
                  upd({
                    maxBumps: Math.max(0, Math.min(2, Number(e.target.value))),
                  })
                }
                className="w-24 h-9 text-right tabular-nums"
              />
            }
          />
          <SettingsRow
            label="Warm up before messaging strangers on LinkedIn"
            description="A few days of viewing their profile and reacting to a post, by hand, before the message."
            control={
              <Switch
                checked={settings.warmUpEnabled}
                onChange={(on) => upd({ warmUpEnabled: on })}
                label="Warm up before messaging strangers on LinkedIn"
              />
            }
          />
          {settings.warmUpEnabled && (
            <SettingsRow
              htmlFor="lim-wdays"
              label="Warm-up length"
              description="In working days."
              control={
                <Input
                  id="lim-wdays"
                  type="number"
                  min={2}
                  max={10}
                  value={settings.warmUpDays}
                  onChange={(e) => upd({ warmUpDays: Number(e.target.value) })}
                  className="w-24 h-9 text-right tabular-nums"
                />
              }
            />
          )}
        </SettingsCard>
        <TrustLadder />
        <SettingsCard title="Morning brief" data-testid="settings-morning">
          <SettingsRow
            label="Show it once a day"
            description="What to decide today, when you first open Orbit."
            control={
              <Switch
                checked={settings.morningBrief !== false}
                onChange={(on) => void setMorningBrief(user.id, on).then(() => setSavedAt(Date.now()))}
                label="Show the morning brief once a day"
                data-testid="settings-morning-on"
              />
            }
          />
          {settings.morningBrief !== false && (
            <SettingsRow
              htmlFor="lim-brief"
              label="From"
              description="It waits until this time."
              control={
                <Input
                  id="lim-brief"
                  type="time"
                  value={settings.briefTimeLocal ?? '07:00'}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) void setBriefTime(user.id, v).then(() => setSavedAt(Date.now()));
                  }}
                  className="w-[124px] h-9"
                />
              }
            />
          )}
          <SettingsRow
            label="Today's brief"
            control={
              <Button size="sm" onClick={openMorningBrief} data-testid="settings-morning-show">
                Show it now
              </Button>
            }
          />
        </SettingsCard>
        <SettingsCard title="Closeness" data-testid="settings-closeness">
          <SettingsRow
            label="Read the tone of replies"
            description="Warm or short replies change how close someone shows. Only you see it."
            control={
              <Switch
                checked={settings.readReplyTone !== false}
                onChange={(on) => void setReadReplyTone(user.id, on).then(() => setSavedAt(Date.now()))}
                label="Read the tone of replies"
                data-testid="settings-reply-tone"
              />
            }
          />
        </SettingsCard>
      </SettingsStack>
    </>
  );
}

/**
 * Whether Google is part of this copy of Orbit for this student (a built-in or developer client ID, or an account
 * already connected), and whether the data is the demo's. Without Google, Settings says nothing about email or
 * calendar sync: Orbit never reads the student's email.
 */
function useSources(userId: string): { google: boolean; demo: boolean } {
  const accounts =
    useLiveQuery(() => db.integrations.where('userId').equals(userId).toArray(), [userId]) ?? [];
  return {
    google: !!googleClientId() || accounts.some((a) => a.provider === 'google'),
    demo: accounts.some((a) => a.provider === 'demo'),
  };
}

function Privacy() {
  const { user, signOut } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const sources = useSources(user?.id ?? '');
  const working = useWorking();
  if (!user) return null;
  const exportAll = () => working.run('export', 'Gathering your data…', downloadAll);
  const downloadAll = async () => {
    const out = await exportAllData();
    const blob = new Blob([JSON.stringify(out, null, 1)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFilename();
      a.click();
    } finally {
      // the click has started the download; release the blob on the next tick
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    toast.push({ text: 'Export downloaded.', tone: 'good' });
  };
  const leaves: [string, string, string?][] = [
    ...(sources.google
      ? ([['Google', 'your own Gmail and Calendar', 'google.com']] as [string, string, string][])
      : []),
    ['Claude', 'only for the features you turn on', 'claude.ai'],
    ['LinkedIn', 'through Unipile, if you connect it live', 'linkedin.com'],
    ['Village', 'a name and company per warm-intro lookup', 'village.do'],
    ['Company logos', "a company's web address, to DuckDuckGo's icon service", 'duckduckgo.com'],
  ];
  return (
    <>
      <SettingsHeader
        title="Data & privacy"
        description="Your people, notes, drafts and settings stay in this browser, not on a server."
      />
      <SettingsStack>
        <SettingsCard
          title="What leaves this browser"
          description="Only for the connections you use."
          footer={
            <p className="mr-auto text-[12px] text-ink-3">
              Your Claude key is kept apart from the rest, and only Orbit's own code
              {sources.google ? " and Google's sign-in" : ''} runs on this page.
            </p>
          }
        >
          <ul className="divide-y divide-line-2" data-testid="privacy-leaves">
            {leaves.map(([name, what, logo]) => (
              <li key={name} className="flex items-center gap-3 px-5 py-3 text-[13.5px]">
                <AppMark logo={logo}>{name[0]}</AppMark>
                <span className="font-medium w-32 shrink-0">{name}</span>
                <span className="text-ink-3 text-[12.5px] min-w-0">{what}</span>
              </li>
            ))}
          </ul>
        </SettingsCard>
        <SettingsCard title="Your data">
          <SettingsRow
            label="Download a copy"
            description={
              <span data-testid="export-contents">
                One file with everything Orbit keeps:{' '}
                {sources.google || sources.demo ? 'email text and headers, calendar events, ' : ''}
                people, notes, facts, drafts and what you sent. It does not include your Anthropic key.
              </span>
            }
            control={
              <Button onClick={exportAll} loading={working.busy === 'export'} disabled={!!working.busy}>
                {working.busy !== 'export' && <Download size={14} />} Download all my data
              </Button>
            }
          />
        </SettingsCard>
        <SettingsCard title="Danger zone" tone="danger">
          <DemoResetRow />
          <SettingsRow
            label="Delete all data"
            description="Everything Orbit keeps in this browser. This cannot be undone."
            control={
              <Button
                variant="ghost"
                className="text-bad hover:bg-bad-soft hover:text-bad border border-bad/25"
                loading={working.busy === 'delete'}
                disabled={!!working.busy}
                onClick={() => {
                  if (!confirm('Delete all Orbit data from this browser? This cannot be undone.')) return;
                  void working.run('delete', 'Deleting your data…', async () => {
                    await deleteAllData();
                    await signOut();
                    nav('/');
                  });
                }}
              >
                {working.busy !== 'delete' && <Trash2 size={14} />} Delete all data
              </Button>
            }
          />
        </SettingsCard>
      </SettingsStack>
    </>
  );
}

/** Replace everything with the demo: under Data & privacy, since it deletes what the student entered. */
function DemoResetRow() {
  const user = useSession().user!;
  const [busy, setBusy] = useState(false);
  return (
    <SettingsRow
      label="Reset to demo"
      description="Swap in a sample network. What you added is deleted."
      control={
        <Button
          variant="ghost"
          className="text-bad hover:bg-bad-soft hover:text-bad border border-bad/25"
          disabled={busy}
          onClick={async () => {
            const prompt =
              demoResetPrompt(user) ??
              'Reload the demo from scratch? Changes you made to the demo data are lost.';
            if (!confirm(prompt)) return;
            setBusy(true);
            await loadDemo({ reset: true });
            location.assign(`${import.meta.env.BASE_URL}today`);
          }}
          data-testid="settings-reset-demo"
        >
          {busy ? 'Loading demo…' : 'Reset to demo'}
        </Button>
      }
    />
  );
}

/** A settings form while its saved values load: a label and a field per row, never a blank page. */
function FormLoading({ fields }: { fields: number }) {
  return (
    <div className="space-y-5 max-w-xl loading-in" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2" style={{ opacity: 1 - (i / fields) * 0.5 }}>
          <Skeleton className="h-3" style={{ width: ['28%', '36%', '22%', '32%', '26%', '30%'][i % 6] }} />
          <Skeleton className="h-9 w-full rounded-[10px]" />
        </div>
      ))}
    </div>
  );
}
