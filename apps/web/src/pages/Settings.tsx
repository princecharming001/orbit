import type { StyleCard, TargetCompany, RecruitingGoals as UserGoals } from '@orbit/core';
import { defaultStyleCard, STYLE_SOURCE_WORDS, TARGET_STATUS_LABELS, yearLabel } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Download, FileText, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { chatMode } from '../chat/agent/mode';
import { AccountSection, MemorySection, OutreachSection } from '../components/account/AccountSettings';
import { LinkedInLiveCard, WarmIntrosCard } from '../components/ConnectorCards';
import { AppMark, IntegrationRow, RowGroup, RowStatus } from '../components/IntegrationRow';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { openMorningBrief } from '../components/MorningBrief';
import { CalcomRow, FathomRow } from '../components/NotesAppRows';
import { ResumeFacetList } from '../components/ResumeFacets';
import { SchedulingLinkField } from '../components/SchedulingLinkField';
import { WeeklyTargetSlider } from '../components/WeeklyTargetSlider';
import { db } from '../db/schema';
import { deleteAllData, exportAllData, exportFilename } from '../engine/account';
import { demoResetPrompt, loadDemo } from '../engine/demo';
import { connectAndSyncGoogle, disconnectGoogleAccount, markGoogleNeedsReauth } from '../engine/integrations';
import { setMorningBrief } from '../engine/morning';
import { saveResume } from '../engine/resume';
import {
  removeTargetCompany,
  restoreTargetCompany,
  saveGoals,
  setBriefTime,
  setSchedulingLink,
  setTargetDeadline,
  setTargetPriority,
  setTargetStatus,
  splitList,
  updateLimits,
  updateProfile,
} from '../engine/settings';
import {
  addStyleSample,
  applyStylePreset,
  learnStyle,
  removeStyleSample,
  sampleCounts,
  updateStyle,
} from '../engine/style';
import { addTargetCompanies } from '../engine/targets';
import { fmtFailureTime, MODEL, testApiKey } from '../integrations/anthropic';
import { currentGoogleToken, googleClientId } from '../integrations/google';
import { isAccountMode, isServerUser } from '../integrations/orbitApi';
import {
  DEFAULT_DAILY_REQUEST_CAP,
  DEFAULT_DAILY_TOKEN_CAP,
  envGoogleClientId,
  type LlmFeature,
  llmFeatures,
  readPrefs,
  subscribePrefs,
  todaysLlmUsage,
  updatePrefs,
  writePrefs,
} from '../integrations/prefs';
import { sharedClaudeUrl } from '../integrations/shared-claude';
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
  Spinner,
  Switch,
  Textarea,
  useToast,
} from '../ui';

/** The section with the LinkedIn import, the resume and the Claude key (its route keeps the older name). */
const INTEGRATIONS_LABEL = 'LinkedIn, resume & AI';

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

function sections(): readonly (readonly [string, string])[] {
  return isAccountMode() ? [...BASE_SECTIONS, ...ACCOUNT_SECTIONS] : BASE_SECTIONS;
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
      <div className="grid @3xl:grid-cols-[200px_minmax(0,1fr)] gap-6 items-start">
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
        <nav className="hidden @3xl:flex @3xl:flex-col @3xl:gap-0.5 min-w-0" aria-label="Settings sections">
          {SECTIONS.map(([k, l]) => (
            <NavLink
              key={k}
              to={`/settings/${k}`}
              className={({ isActive }) =>
                cx(
                  'h-9 px-3 rounded-lg flex items-center text-[14px] whitespace-nowrap border @3xl:border-0',
                  isActive || (k === 'profile' && section === 'profile')
                    ? 'bg-canvas-2 font-medium border-line'
                    : 'text-ink-2 hover:bg-canvas-2 border-transparent',
                )
              }
            >
              {l}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          {section === 'profile' && <Profile />}
          {section === 'goals' && <Goals />}
          {section === 'integrations' && <Integrations />}
          {section === 'style' && <Style />}
          {section === 'limits' && <Limits />}
          {section === 'privacy' && <Privacy />}
          {section === 'account' && <AccountSection />}
          {section === 'outreach' && <OutreachSection />}
          {section === 'memory' && <MemorySection />}
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

function SaveState({ state, held }: { state: 'saved' | 'saving' | 'held'; held?: string }) {
  return (
    <p className="text-[12px] text-ink-3 flex items-center gap-1.5" aria-live="polite" data-testid="autosave">
      {state === 'held' ? (
        <span className="text-warn">{held ?? 'Not saved yet.'}</span>
      ) : state === 'saving' ? (
        'Saving…'
      ) : (
        <>
          <Check size={13} className="text-good" /> Changes here save as you make them.
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
    <Section className="grid @[40rem]:grid-cols-2 gap-4">
      <div className="@[40rem]:col-span-2">
        <SaveState state={state} held="Your name is missing, so nothing on this page is saved yet." />
      </div>
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
        <Input id="profile-email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
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
        <Label htmlFor="profile-school">School</Label>
        <Input
          id="profile-school"
          value={f.school}
          onChange={(e) => setF({ ...f, school: e.target.value })}
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
        <Label
          htmlFor="profile-degree"
          hint="so messages call you a junior, a senior or an MBA student correctly"
        >
          Degree
        </Label>
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
      <div>
        <Label htmlFor="profile-city">City</Label>
        <Input
          id="profile-city"
          value={f.currentCity}
          onChange={(e) => setF({ ...f, currentCity: e.target.value })}
        />
      </div>
      <div>
        <Label htmlFor="profile-tz" hint="times in your messages use it">
          Time zone
        </Label>
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
    </Section>
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

function Goals() {
  const user = useSession().user!;
  const goals = useLiveQuery(() => db.goals.get(user.id), [user.id]);
  const tcs =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
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
    freeText: goals.freeText ?? '',
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
      freeText: v.freeText,
    }),
  );
  return (
    <div className="space-y-4">
      <Section className="grid @[40rem]:grid-cols-2 gap-4">
        <div className="@[40rem]:col-span-2">
          <SaveState state={state} />
        </div>
        <div className="@[40rem]:col-span-2">
          <Label htmlFor="goals-cycle">Recruiting cycle</Label>
          <Input
            id="goals-cycle"
            value={f.cycleLabel}
            onChange={(e) => setF({ ...f, cycleLabel: e.target.value })}
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
          <Label htmlFor="goals-roles">Target roles</Label>
          <Input
            id="goals-roles"
            value={f.targetRoles}
            onChange={(e) => setF({ ...f, targetRoles: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="goals-industries">Industries</Label>
          <Input
            id="goals-industries"
            value={f.targetIndustries}
            onChange={(e) => setF({ ...f, targetIndustries: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="goals-locations">Locations</Label>
          <Input
            id="goals-locations"
            value={f.targetLocations}
            onChange={(e) => setF({ ...f, targetLocations: e.target.value })}
          />
        </div>
        <div className="@[40rem]:col-span-2">
          <Label htmlFor="goals-free" hint="what matters to you in a team or a firm">
            Anything else?
          </Label>
          <Textarea
            id="goals-free"
            rows={2}
            value={f.freeText}
            onChange={(e) => setF({ ...f, freeText: e.target.value })}
          />
        </div>
      </Section>
      <Section>
        <Label>Target companies</Label>
        <div className="flex gap-2 mb-3">
          <Input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Add a company"
            aria-label="Add a target company"
            onKeyDown={(e) => {
              if (e.key === 'Enter') addCompany();
            }}
          />
          <Button onClick={addCompany}>Add</Button>
        </div>
        <ul className="divide-y divide-line text-[13.5px]">
          {tcs.map((t) => (
            <li key={t.id} className="py-2 flex flex-wrap items-end gap-2">
              <span className="font-medium min-w-0 flex-1 basis-32 truncate self-center">{t.nameRaw}</span>
              <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
                Priority
                <Select
                  value={t.priority}
                  onChange={(e) => setTargetPriority(t.id, Number(e.target.value) as 1 | 2 | 3)}
                  className="h-8 text-[12px] text-ink"
                  aria-label={`Priority for ${t.nameRaw}`}
                >
                  <option value={1}>Top priority</option>
                  <option value={2}>Normal</option>
                  <option value={3}>Low</option>
                </Select>
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
                Application
                <Select
                  value={t.status}
                  onChange={(e) => setTargetStatus(t.id, e.target.value as never)}
                  className="h-8 text-[12px] text-ink"
                  aria-label={`Application status for ${t.nameRaw}`}
                >
                  {Object.entries(TARGET_STATUS_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-ink-3">
                Deadline
                <Input
                  type="date"
                  value={t.deadline ?? ''}
                  onChange={(e) => setTargetDeadline(t.id, e.target.value || undefined)}
                  className="h-8 text-[12px] w-36 text-ink"
                  aria-label={`Application deadline for ${t.nameRaw}`}
                />
              </label>
              <button
                className="text-ink-3 hover:text-bad p-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={async () => {
                  const removed = await removeTargetCompany(t.id);
                  toast.push({
                    text: `Removed ${t.nameRaw} from your targets.`,
                    action: { label: 'Undo', onClick: () => restoreTargetCompany(removed ?? t) },
                    ttl: 7000,
                  });
                }}
                aria-label={`Remove ${t.nameRaw}`}
                title={`Remove ${t.nameRaw} from your targets`}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Integrations() {
  const user = useSession().user!;
  const toast = useToast();
  const accounts =
    useLiveQuery(() => db.integrations.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
  const google = accounts.find((a) => a.provider === 'google');
  const li = accounts.find((a) => a.provider === 'linkedin_csv');
  const resume = useLiveQuery(
    async () =>
      (await db.resumes.where('userId').equals(user.id).toArray())
        .filter((r) => r.isCurrent)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [user.id],
  );
  const facets =
    useLiveQuery(
      () => (resume ? db.resumeFacets.where('resumeId').equals(resume.id).toArray() : []),
      [resume?.id],
    ) ?? [];
  const [showFacets, setShowFacets] = useState(false);
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
      toast.push({ text: String((e as Error).message ?? e), tone: 'bad', ttl: 7000 });
      if (google) await markGoogleNeedsReauth(user.id, String((e as Error).message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  // an Orbit account connected Google at sign-in: the browser's own Google sign-in is not needed
  const viaAccount = isServerUser(user.id);
  const googleOffered = builtIn || !!google;
  return (
    <div>
      <RowGroup title="Your network">
        {viaAccount ? (
          <IntegrationRow
            testId="google-via-account"
            mark={<AppMark logo="google.com">G</AppMark>}
            name="Google"
            status={
              <RowStatus>
                <Check size={12} /> Connected through your Orbit account
              </RowStatus>
            }
            line={
              <NavLink to="/settings/account" className="underline underline-offset-2 hover:text-ink">
                Account settings
              </NavLink>
            }
          />
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
              googleOffered ? (
                'Email and meetings you already have'
              ) : (
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
                      toast.push({ text: 'Disconnected. Imported mail stays until you delete your data.' });
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
        <WarmIntrosCard user={user} />
      </RowGroup>
      <RowGroup title="Meetings">
        <FathomRow user={user} />
        <CalcomRow user={user} />
      </RowGroup>
      <RowGroup title="About you">
        <IntegrationRow
          mark={
            <AppMark>
              <FileText size={15} />
            </AppMark>
          }
          name="Resume"
          status={
            <span className="text-[12px]" data-testid="resume-on-file">
              {resume ? (
                <span className="text-good inline-flex items-center gap-1">
                  <Check size={12} /> On file: {resume.filename}, added {relDate(resume.createdAt)}
                </span>
              ) : (
                <span className="text-ink-3">No resume yet</span>
              )}
            </span>
          }
          line="Finds shared backgrounds and describes you in first messages"
          actions={
            <label className="inline-flex rounded-full focus-within:ring-2 focus-within:ring-accent/40">
              <input
                type="file"
                accept=".pdf,.txt,.md,.docx"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setBusy('Parsing resume…');
                  await saveResume(user, f);
                  setBusy(undefined);
                  toast.push({ text: 'Resume updated.', tone: 'good' });
                }}
              />
              <span className="inline-flex items-center justify-center gap-1.5 rounded-full font-medium h-8 px-3 text-[13px] bg-canvas border border-line shadow-[var(--shadow-pill)] hover:bg-canvas-2 cursor-pointer">
                {resume ? 'Replace' : 'Upload'}
              </span>
            </label>
          }
        >
          {facets.length > 0 && (
            <>
              <button
                type="button"
                className="text-[12.5px] underline underline-offset-2 text-ink-3 hover:text-ink"
                aria-expanded={showFacets}
                onClick={() => setShowFacets((v) => !v)}
                data-testid="settings-resume-facets"
              >
                {showFacets ? 'Hide what Orbit read' : 'Check what Orbit read'}
              </button>
              {showFacets && (
                <ResumeFacetList
                  facets={facets}
                  readBy={resume?.parseSource === 'llm' ? 'Claude' : 'Orbit'}
                />
              )}
            </>
          )}
        </IntegrationRow>
        <ClaudeCard />
      </RowGroup>
    </div>
  );
}

const AI_FEATURES: { key: LlmFeature; label: string; sends: string }[] = [
  {
    key: 'drafts',
    label: 'Write drafts',
    sends:
      'When Orbit drafts a message, your profile and what Orbit knows about the recipient (name, role, saved facts, the last message in the thread) are sent to Anthropic.',
  },
  {
    key: 'emailTriage',
    label: 'Read synced email',
    sends:
      'The text of emails is sent to Anthropic to sort them: threads Orbit cannot place on its own, and each new message in a conversation with someone you are networking with. Off by default.',
  },
  {
    key: 'notes',
    label: 'Extract meeting notes',
    sends: 'The full text of each note or transcript you add is sent to Anthropic.',
  },
  { key: 'resume', label: 'Parse your resume', sends: 'Your resume text is sent to Anthropic.' },
  {
    key: 'summaries',
    label: 'Summarize people',
    sends: "A person's saved facts and recent interactions are sent to Anthropic.",
  },
  {
    key: 'chat',
    label: 'Chat on the home page',
    sends:
      'What you type in the chat, a short summary of your day and pipeline, and whatever Claude looks up with its tools (people, drafts, notes you ask about) are sent to Anthropic. On by default once a key is saved; without it the chat understands a fixed set of commands.',
  },
];

function ClaudeCard() {
  const tz = useSession().user?.timezone;
  const sources = useSources(useSession().user?.id ?? '');
  const [prefs, setPrefs] = useState(readPrefs);
  const [apiKey, setApiKey] = useState(prefs.anthropicApiKey ?? '');
  const [keyStatus, setKeyStatus] = useState<string>();
  // Stay in step with changes made by Claude calls and by Orbit open in another tab.
  useEffect(() => subscribePrefs(setPrefs), []);
  const update = (p: Parameters<typeof writePrefs>[0]) => setPrefs(writePrefs(p));
  const features = llmFeatures(prefs);
  const usage = todaysLlmUsage(prefs);
  const reqCap = prefs.llmDailyRequestCap ?? DEFAULT_DAILY_REQUEST_CAP;
  const tokCap = prefs.llmDailyTokenCap ?? DEFAULT_DAILY_TOKEN_CAP;
  const keySaved = !!prefs.anthropicApiKey;
  // without a key, the chat can still run on Orbit's shared access, so its switch stays usable
  const shared = !keySaved && !!sharedClaudeUrl();
  return (
    <IntegrationRow
      mark={<AppMark logo="claude.ai">AI</AppMark>}
      name="Claude"
      status={
        keySaved ? (
          <RowStatus>
            <Check size={12} /> Key saved.
          </RowStatus>
        ) : undefined
      }
      line={
        shared
          ? 'Included for the chat; your own key lifts the daily limit'
          : 'Optional: Orbit writes drafts on its own without it'
      }
    >
      <div className="space-y-2">
        <details className="text-[12.5px]" open={!!keyStatus}>
          <summary className="cursor-pointer text-ink-3 hover:text-ink w-fit">
            {keySaved ? 'Change or remove your key' : 'Use your own Anthropic key'}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              className="max-w-sm flex-1 min-w-0"
              aria-label="Anthropic API key"
            />
            <Button
              size="sm"
              disabled={!apiKey.trim() && !keySaved}
              onClick={async () => {
                update({ anthropicApiKey: apiKey.trim() || undefined });
                if (!apiKey.trim()) return setKeyStatus('Removed.');
                setKeyStatus('Testing…');
                const r = await testApiKey();
                setPrefs(readPrefs());
                setKeyStatus(r.ok ? 'Works.' : r.error);
              }}
            >
              {apiKey.trim() || !keySaved ? 'Save and test' : 'Remove key'}
            </Button>
          </div>
          {keyStatus && (
            <p className={cx('mt-1', keyStatus === 'Works.' ? 'text-good' : 'text-ink-3')}>{keyStatus}</p>
          )}
          {shared && (
            <p className="mt-1 text-ink-3" data-testid="ai-shared-note">
              Until you add a key, the chat uses Orbit's shared Claude access, with a daily limit.
            </p>
          )}
        </details>
        <details className="text-[12.5px]" data-testid="ai-permissions">
          <summary className="cursor-pointer text-ink-3 hover:text-ink w-fit">What Claude may read</summary>
          <fieldset className="mt-2 space-y-1.5" disabled={!keySaved && !shared} data-testid="ai-usage">
            <legend className="sr-only">What Claude may read</legend>
            {/* reading synced email only exists where Google does */}
            {AI_FEATURES.filter((f) => f.key !== 'emailTriage' || sources.google).map((f) => (
              <label
                key={f.key}
                className={cx(
                  'flex items-start gap-2 text-[13px]',
                  !keySaved && !(shared && f.key === 'chat') && 'opacity-60',
                )}
                title={f.sends}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!keySaved && !(shared && f.key === 'chat')}
                  data-testid={`ai-feature-${f.key}`}
                  checked={features[f.key]}
                  onChange={(e) => {
                    const on = e.target.checked;
                    // only this one switch changes; the others keep whatever is stored, even if set in another tab
                    setPrefs(
                      updatePrefs((cur) => ({ ...cur, llmFeatures: { ...llmFeatures(cur), [f.key]: on } })),
                    );
                  }}
                />
                <span>
                  <span className="font-medium text-ink">{f.label}</span>
                  <span className="block text-[12px] text-ink-3">{f.sends}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </details>
        <p className="text-[12px] text-ink-3" data-testid="ai-chat-row">
          Chat: {chatMode() === 'llm' ? `Claude, ${MODEL}` : 'Orbit commands only'} · today {usage.requests}{' '}
          of {reqCap} requests
        </p>
        <details className="text-[12.5px]" data-testid="ai-advanced">
          <summary className="cursor-pointer text-ink-3 hover:text-ink w-fit">
            Daily limits and privacy
          </summary>
          <p className="text-[12px] text-ink-3 mt-2">
            Model: {MODEL}. The key is kept in this browser only, separate from your Orbit data and never in
            the export. Any script running on this page could read it, so Orbit only allows its own code
            {sources.google ? " and Google's sign-in script" : ''} to run here.
          </p>
          <div className="mt-3 grid @[40rem]:grid-cols-2 gap-3 max-w-lg items-start">
            <div>
              <Label htmlFor="ai-req">Requests per day</Label>
              <Input
                id="ai-req"
                type="number"
                min={0}
                value={reqCap}
                data-testid="ai-cap-requests"
                onChange={(e) =>
                  update({ llmDailyRequestCap: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                }
              />
            </div>
            <div>
              <Label htmlFor="ai-tok">Tokens per day</Label>
              <Input
                id="ai-tok"
                type="number"
                min={0}
                step={10000}
                value={tokCap}
                onChange={(e) =>
                  update({ llmDailyTokenCap: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                }
              />
            </div>
          </div>
          <p className="text-[12px] text-ink-3 mt-2">
            Orbit stops calling Claude for the rest of the day at either limit and uses its own drafts
            instead.
          </p>
          <p className="text-[12px] text-ink-3 mt-2" data-testid="ai-usage-today">
            Today: {usage.requests} of {reqCap} requests,{' '}
            {(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} of{' '}
            {tokCap.toLocaleString('en-US')} tokens.
          </p>
        </details>
        {prefs.lastLlmError && (
          <p className="text-[12px] text-bad" data-testid="ai-last-error">
            Last problem, {fmtFailureTime(prefs.lastLlmError.at, tz)}: {prefs.lastLlmError.message} Orbit used
            its templates instead.
          </p>
        )}
      </div>
    </IntegrationRow>
  );
}

const FORMALITY_WORDS = (f: number) =>
  f >= 0.75 ? 'Formal' : f >= 0.5 ? 'Polite' : f >= 0.3 ? 'Friendly' : 'Casual';

const GREETING_CHOICES = ['Hi {first},', 'Hey {first},', 'Hello {first},', '{first},', 'Dear {first},'];
const SIGNOFF_WORDS = ['Best', 'Thanks', 'Thanks so much', 'Cheers', 'Best regards', 'Kind regards'];
const AVOID_SUGGESTIONS = [
  'I hope this email finds you well',
  'pick your brain',
  'circle back',
  'Dear Sir or Madam',
];

/** A sample first message in the student's style, so every change shows what it does. */
function stylePreview(card: StyleCard, user: { firstName: string; school?: string }): string {
  const greet = (card.greetingPatterns[0] ?? 'Hi {first},').replace('{first}', 'Sarah');
  const c = (a: string, b: string) => (card.contractions ? a : b);
  const school = user.school?.trim() || 'school';
  const lines = [
    `${c("I'm", 'I am')} a junior at ${school} and ${c("I'd", 'I would')} love to hear how you got into product at Notion.`,
  ];
  if (card.avgMessageWords >= 80)
    lines.push(
      `Your post on onboarding stuck with me, and ${c("I'm", 'I am')} trying to work out which teams to aim for.`,
    );
  if (card.avgMessageWords >= 120)
    lines.push(`I know your time is valuable, so ${c("I'll", 'I will')} keep it to a few questions.`);
  lines.push(
    `Would you have 15 minutes next week?${card.exclamationsPerMessage >= 0.5 ? ' Thanks so much!' : ''}`,
  );
  if (card.emoji) lines[lines.length - 1] += ' 🙂';
  const sign = card.signoffs[0] ?? `Best,\n${user.firstName}`;
  return `${greet}\n\n${lines.join(' ')}\n\n${sign}`;
}

/** A row of removable chips with a field to add one. */
function ChipList({
  items,
  onChange,
  placeholder,
  suggestions = [],
  testId,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  suggestions?: string[];
  testId: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (v: string) => {
    const t = v.trim();
    if (t && !items.some((i) => i.toLowerCase() === t.toLowerCase())) onChange([...items, t]);
    setDraft('');
  };
  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <span
            key={it}
            className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-canvas-2 text-[12.5px]"
          >
            {it}
            <button
              type="button"
              className="h-5 w-5 inline-flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-line-2"
              onClick={() => onChange(items.filter((x) => x !== it))}
              aria-label={`Remove ${it}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={placeholder}
          className="h-7 min-w-[180px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          aria-label={placeholder}
        />
      </div>
      {suggestions.filter((sug) => !items.includes(sug)).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
          {suggestions
            .filter((sug) => !items.includes(sug))
            .map((sug) => (
              <button key={sug} type="button" className="hover:text-ink" onClick={() => add(sug)}>
                + {sug}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** One labelled line of the style: the label on the left, the control on the right, no box around it. */
function StyleRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid @[40rem]:grid-cols-[160px_minmax(0,1fr)] gap-x-6 gap-y-1.5 py-3.5">
      <div>
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-ink-3 mt-0.5">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Style() {
  const user = useSession().user!;
  const profile = useLiveQuery(() => db.styles.get(user.id), [user.id]);
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const counts = useLiveQuery(() => sampleCounts(user), [user.id, profile?.updatedAt]);
  const toast = useToast();
  const [learning, setLearning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const card = profile?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName);
  const [notes, setNotes] = useState<string>();
  const set = (patch: Partial<StyleCard>) => void updateStyle(user, patch);
  const signWord = (card.signoffs[0] ?? '').split('\n')[0]!.replace(/,$/, '');
  const signName = (card.signoffs[0] ?? '').split('\n').slice(1).join('\n') || user.firstName;
  const learned = card.builtFromCount > 0;
  const from = card.sources
    ? (Object.entries(card.sources) as [keyof typeof STYLE_SOURCE_WORDS, number][])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${STYLE_SOURCE_WORDS[k]}`)
        .join(', ')
    : `${card.builtFromCount} sent emails`;
  const learn = async () => {
    setLearning(true);
    try {
      const r = await learnStyle(user);
      toast.push(
        r.ok
          ? { text: `Learned your voice from ${r.learnedFrom} messages.`, tone: 'good' }
          : { text: r.reason, ttl: 8000 },
      );
    } finally {
      setLearning(false);
    }
  };
  return (
    <div className="max-w-[720px]" data-testid="style-page">
      {/* what a first message sounds like right now */}
      <section className="pb-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-medium">How your drafts sound</h2>
          <span className="text-[12px] text-ink-3" data-testid="style-provenance">
            {learned ? `Learned from ${from}` : card.custom ? 'Set by you' : 'A starting style'}
            {card.custom && learned ? ', adjusted by you' : ''}
          </span>
        </div>
        <pre
          className="mt-3 whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-ink-2 border-l-2 border-line pl-4"
          data-testid="style-preview"
        >
          {stylePreview(card, user)}
        </pre>
      </section>

      {/* learning */}
      <section className="py-6 border-t border-line-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-medium">Learn your voice</h2>
            <p className="text-[12.5px] text-ink-3 mt-0.5">
              From messages you actually wrote. Your own changes below are kept.
            </p>
          </div>
          <Button variant="primary" onClick={learn} disabled={learning} data-testid="style-learn">
            {learning ? 'Learning…' : learned ? 'Learn again' : 'Learn from my messages'}
          </Button>
        </div>
        <ul className="mt-3 text-[13px] divide-y divide-line-2" data-testid="style-sources">
          <li className="flex items-center justify-between py-2">
            <span>Sent emails</span>
            <span className="text-ink-3">
              {counts?.emailAvailable ? (
                `${counts.email}`
              ) : (
                <NavLink to="/settings/integrations" className="text-accent">
                  Connect Gmail
                </NavLink>
              )}
            </span>
          </li>
          <li className="flex items-center justify-between py-2">
            <span>LinkedIn messages you sent</span>
            <span className="text-ink-3">
              {counts?.linkedinAvailable ? (
                counts.linkedin ? (
                  `${counts.linkedin}`
                ) : (
                  'read when you learn'
                )
              ) : (
                <NavLink to="/settings/integrations" className="text-accent">
                  Connect LinkedIn
                </NavLink>
              )}
            </span>
          </li>
          <li className="flex items-center justify-between py-2">
            <span>Drafts you edited and sent</span>
            <span className="text-ink-3">{counts?.orbit ?? 0}</span>
          </li>
          <li className="py-2">
            <div className="flex items-center justify-between">
              <span>Examples you paste</span>
              <span className="flex items-center gap-3 text-ink-3">
                {profile?.samples?.length ?? 0}
                <button
                  type="button"
                  className="text-accent"
                  onClick={() => setPasting((v) => !v)}
                  data-testid="style-paste-open"
                >
                  {pasting ? 'Done' : 'Add'}
                </button>
              </span>
            </div>
            {pasting && (
              <div className="mt-2 space-y-2">
                <Textarea
                  rows={4}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder="Paste an email or LinkedIn message you wrote"
                  aria-label="Paste an example message"
                  data-testid="style-paste"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!paste.trim()}
                    onClick={async () => {
                      const r = await addStyleSample(user, paste);
                      if (!r.ok) return toast.push({ text: r.reason });
                      setPaste('');
                      toast.push({ text: 'Added. Press Learn to use it.', tone: 'good' });
                    }}
                    data-testid="style-paste-add"
                  >
                    Add example
                  </Button>
                </div>
                {(profile?.samples ?? []).map((sample, i) => (
                  <div key={sample} className="flex items-start gap-2 text-[12.5px] text-ink-2">
                    <span className="line-clamp-2 flex-1">{sample}</span>
                    <button
                      type="button"
                      className="text-ink-3 hover:text-ink"
                      onClick={() => removeStyleSample(user.id, i)}
                      aria-label="Remove this example"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </li>
        </ul>
      </section>

      {/* every part, by hand */}
      <section className="py-6 border-t border-line-2" data-testid="style-controls">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium">Make it yours</h2>
          <span className="text-[12px] text-ink-3 flex items-center gap-2">
            Start from
            {(['warm', 'direct', 'formal'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className="h-7 px-2.5 rounded-full hover:bg-canvas-2 hover:text-ink capitalize"
                onClick={async () => {
                  if (
                    (card.custom || learned) &&
                    !confirm(`Start over from the ${p} style? Your "never say" list and notes stay.`)
                  )
                    return;
                  await applyStylePreset(user, p);
                }}
                data-testid={`style-preset-${p}`}
              >
                {p}
              </button>
            ))}
          </span>
        </div>
        <div className="mt-2 divide-y divide-line-2">
          <StyleRow label="Greeting">
            <div className="flex flex-wrap gap-1.5">
              {[...new Set([...GREETING_CHOICES, ...card.greetingPatterns])].map((g) => {
                const on = card.greetingPatterns[0] === g;
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() =>
                      set({ greetingPatterns: [g, ...card.greetingPatterns.filter((x) => x !== g)] })
                    }
                    className={cx(
                      'h-8 px-3 rounded-full border text-[13px]',
                      on ? 'border-ink bg-ink text-white' : 'border-line hover:bg-canvas-2',
                    )}
                    aria-pressed={on}
                  >
                    {g.replace('{first}', 'Sarah')}
                  </button>
                );
              })}
            </div>
          </StyleRow>
          <StyleRow label="Sign-off">
            <div className="flex flex-wrap items-center gap-1.5">
              {[...new Set([...SIGNOFF_WORDS, signWord].filter(Boolean))].map((w) => {
                const on = signWord === w;
                return (
                  <button
                    key={w}
                    type="button"
                    onClick={() => set({ signoffs: [`${w},\n${signName}`, ...card.signoffs.slice(1)] })}
                    className={cx(
                      'h-8 px-3 rounded-full border text-[13px]',
                      on ? 'border-ink bg-ink text-white' : 'border-line hover:bg-canvas-2',
                    )}
                    aria-pressed={on}
                  >
                    {w}
                  </button>
                );
              })}
              <input
                defaultValue={signName}
                key={signName}
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value.trim() !== signName &&
                  set({
                    signoffs: [`${signWord || 'Best'},\n${e.target.value.trim()}`, ...card.signoffs.slice(1)],
                  })
                }
                className="h-8 w-40 px-3 rounded-full border border-line bg-canvas text-[13px]"
                aria-label="Name under the sign-off"
                data-testid="style-sign-name"
              />
            </div>
          </StyleRow>
          <StyleRow label="Tone" hint={FORMALITY_WORDS(card.formality)}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(card.formality * 100)}
              onChange={(e) => set({ formality: Number(e.target.value) / 100 })}
              className="w-full accent-ink"
              aria-label="Tone, from casual to formal"
              data-testid="style-formality"
            />
            <div className="flex justify-between text-[11px] text-ink-3">
              <span>Casual</span>
              <span>Formal</span>
            </div>
          </StyleRow>
          <StyleRow label="Length" hint={`About ${card.avgMessageWords} words`}>
            <input
              type="range"
              min={40}
              max={180}
              step={10}
              value={Math.min(180, Math.max(40, card.avgMessageWords))}
              onChange={(e) => set({ avgMessageWords: Number(e.target.value) })}
              className="w-full accent-ink"
              aria-label="Message length in words"
              data-testid="style-length"
            />
            <div className="flex justify-between text-[11px] text-ink-3">
              <span>Short</span>
              <span>Detailed</span>
            </div>
          </StyleRow>
          <StyleRow label="Details">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={card.contractions}
                  onChange={(e) => set({ contractions: e.target.checked })}
                  data-testid="style-contractions"
                />
                Contractions ("I'm", "you're")
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={card.exclamationsPerMessage >= 0.5}
                  onChange={(e) => set({ exclamationsPerMessage: e.target.checked ? 0.6 : 0 })}
                />
                Exclamation points
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={card.emoji}
                  onChange={(e) => set({ emoji: e.target.checked })}
                />
                Emoji
              </label>
            </div>
          </StyleRow>
          <StyleRow label="Phrases you use" hint="Orbit's AI works them in">
            <ChipList
              items={card.characteristicPhrases}
              onChange={(characteristicPhrases) => set({ characteristicPhrases })}
              placeholder="Add a phrase"
              testId="style-phrases"
            />
          </StyleRow>
          <StyleRow label="Never say" hint="Left out of every draft">
            <ChipList
              items={card.avoid}
              onChange={(avoid) => set({ avoid })}
              placeholder="Add a phrase"
              suggestions={AVOID_SUGGESTIONS}
              testId="style-avoid"
            />
          </StyleRow>
          <StyleRow label="Notes for Orbit" hint="Anything else about how you write">
            <Textarea
              rows={3}
              value={notes ?? (card.custom ? card.notes : '')}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== undefined && set({ notes: notes.trim() })}
              placeholder="e.g. Keep it humble, never mention GPA, mention I'm a first-gen student when it fits"
              aria-label="Notes for Orbit about how you write"
              data-testid="style-notes"
            />
          </StyleRow>
        </div>
      </section>
    </div>
  );
}

function Limits() {
  const user = useSession().user!;
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const [savedAt, setSavedAt] = useState<number>();
  if (!settings) return null;
  const upd = async (p: Partial<typeof settings>) => {
    if ('schedulingLink' in p) await setSchedulingLink(user.id, p.schedulingLink);
    else await updateLimits(user.id, p);
    setSavedAt(Date.now());
  };
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-3" aria-live="polite">
        Changes here save as you make them.
        {savedAt ? <span className="text-good"> Saved.</span> : null}
      </p>
      <section className="grid @[40rem]:grid-cols-2 gap-4 items-start pt-2">
        <h2 className="@[40rem]:col-span-2 text-[13px] font-medium text-ink -mb-1">Weekly goal</h2>
        <div>
          <Label htmlFor="lim-week">First messages a week</Label>
          <WeeklyTargetSlider
            id="lim-week"
            value={settings.weeklyOutreachTarget}
            onChange={(v) => upd({ weeklyOutreachTarget: v })}
            testId="settings-weekly"
          />
          <p className="text-[12px] text-ink-3 mt-1">
            Your goal for new people each week. Ask the chat how your week is going to see your count.
          </p>
        </div>
        <details className="@[40rem]:col-span-2 text-[13px]" data-testid="limits-advanced">
          <summary className="cursor-pointer text-ink-2 w-fit">
            Advanced: how often Orbit lets you write (most students never change these)
          </summary>
          <p className="text-[12px] text-ink-3 mt-1 mb-3">
            They keep you from writing to someone twice in a row too soon, and from sending more in a day than
            reads as a mass email.
          </p>
          <div className="grid @[40rem]:grid-cols-2 gap-4 items-start">
            <div>
              <Label htmlFor="lim-cool">Hours between messages to the same person</Label>
              <Input
                id="lim-cool"
                type="number"
                min={0}
                value={settings.perPersonCooldownHours}
                onChange={(e) => upd({ perPersonCooldownHours: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label htmlFor="lim-gmail">Emails per day, at most</Label>
              <Input
                id="lim-gmail"
                type="number"
                min={1}
                max={50}
                value={settings.dailySendCapGmail}
                onChange={(e) => upd({ dailySendCapGmail: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label htmlFor="lim-li">LinkedIn messages per day, at most</Label>
              <Input
                id="lim-li"
                type="number"
                min={1}
                max={30}
                value={settings.dailySendCapLinkedin}
                onChange={(e) => upd({ dailySendCapLinkedin: Number(e.target.value) })}
              />
            </div>
            <div className="@[40rem]:col-span-2">
              <Label htmlFor="lim-bumps">Follow-ups when someone has not replied</Label>
              <Input
                id="lim-bumps"
                type="number"
                min={0}
                max={2}
                value={settings.maxBumps}
                onChange={(e) => upd({ maxBumps: Math.max(0, Math.min(2, Number(e.target.value))) })}
                className="max-w-[120px]"
              />
              <p className="text-[12px] text-ink-3 mt-1">
                1 suits most people. With 2, Orbit may suggest a short, polite last note, which is normal in
                finance and consulting.
              </p>
            </div>
            <div className="@[40rem]:col-span-2 border-t border-line pt-4">
              <label className="flex items-start gap-2 text-[13.5px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={settings.warmUpEnabled}
                  onChange={(e) => upd({ warmUpEnabled: e.target.checked })}
                />
                <span>
                  <strong className="font-medium">Warm up before messaging strangers on LinkedIn.</strong>{' '}
                  <span className="text-ink-2">
                    A few small steps over a few days, like viewing their profile and reacting to a post. You
                    do each one yourself; Orbit opens the right page and never acts on LinkedIn for you.
                  </span>
                </span>
              </label>
              <div className="mt-3 max-w-xs">
                <Label htmlFor="lim-wdays" hint="weekends are skipped">
                  Warm-up length in working days
                </Label>
                <Input
                  id="lim-wdays"
                  type="number"
                  min={2}
                  max={10}
                  value={settings.warmUpDays}
                  onChange={(e) => upd({ warmUpDays: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        </details>
      </section>
      <section className="grid @[40rem]:grid-cols-2 gap-4 items-start border-t border-line-2 pt-6">
        <h2 className="@[40rem]:col-span-2 text-[13px] font-medium text-ink -mb-1">Your schedule</h2>
        <p className="@[40rem]:col-span-2 text-[12.5px] text-ink-3">
          Today's list is rebuilt the first time you open Orbit each day. Orbit runs in your browser, so it
          does not send reminders when it is closed.
        </p>
        <div
          className="@[40rem]:col-span-2 flex flex-wrap items-end gap-x-6 gap-y-3"
          data-testid="settings-morning"
        >
          <label className="flex items-start gap-2 text-[13.5px] max-w-md">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.morningBrief !== false}
              onChange={(e) =>
                void setMorningBrief(user.id, e.target.checked).then(() => setSavedAt(Date.now()))
              }
              data-testid="settings-morning-on"
            />
            <span>
              <strong className="font-medium">Morning brief.</strong>{' '}
              <span className="text-ink-2">
                Once a day, a short deck in the corner: your week in numbers, each decision waiting on you,
                and what is worth doing today.
              </span>
            </span>
          </label>
          <div>
            <Label htmlFor="lim-brief">From</Label>
            <Input
              id="lim-brief"
              type="time"
              value={settings.briefTimeLocal ?? '07:00'}
              onChange={(e) => {
                const v = e.target.value;
                if (v) void setBriefTime(user.id, v).then(() => setSavedAt(Date.now()));
              }}
              className="w-[120px]"
            />
          </div>
          <Button size="sm" onClick={openMorningBrief} data-testid="settings-morning-show">
            Show it now
          </Button>
        </div>
        <div className="@[40rem]:col-span-2">
          <SchedulingLinkField
            user={user}
            value={settings.schedulingLink}
            onChange={(link) => upd({ schedulingLink: link })}
          />
        </div>
      </section>
    </div>
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
  if (!user) return null;
  const exportAll = async () => {
    const out = await exportAllData();
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
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
  return (
    <div className="max-w-[720px]">
      <Section>
        <h2 className="text-[15px] font-medium">Where your data lives</h2>
        <p className="text-[13.5px] text-ink-2 mt-1.5">
          Your people, notes, drafts and settings stay in this browser, not on a server. They leave it only
          for the connections you use:
        </p>
        <ul className="mt-2 text-[13px] text-ink-2 divide-y divide-line-2" data-testid="privacy-leaves">
          {sources.google && (
            <li className="py-2 flex justify-between gap-4">
              <span>Google</span>
              <span className="text-ink-3 text-right">your own Gmail and Calendar</span>
            </li>
          )}
          <li className="py-2 flex justify-between gap-4">
            <span>Claude</span>
            <span className="text-ink-3 text-right">only for the features you turn on</span>
          </li>
          <li className="py-2 flex justify-between gap-4">
            <span>LinkedIn</span>
            <span className="text-ink-3 text-right">through Unipile, if you connect it live</span>
          </li>
          <li className="py-2 flex justify-between gap-4">
            <span>Village</span>
            <span className="text-ink-3 text-right">a name and company per warm-intro lookup</span>
          </li>
          <li className="py-2 flex justify-between gap-4">
            <span>Company logos</span>
            <span className="text-ink-3 text-right">
              a company's web address, to DuckDuckGo's icon service
            </span>
          </li>
        </ul>
        <p className="text-[12px] text-ink-3 mt-2">
          Your Claude key is kept apart from the rest, and only Orbit's own code
          {sources.google ? " and Google's sign-in" : ''} runs on this page.
        </p>
      </Section>
      <Section>
        <h2 className="text-[15px] font-medium">Your copy</h2>
        <p className="text-[13px] text-ink-2 mt-1.5" data-testid="export-contents">
          One file with everything Orbit keeps:{' '}
          {sources.google || sources.demo ? 'email text and headers, calendar events, ' : ''}people, notes,
          facts, drafts and what you sent. It does not include your Anthropic key.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <Button onClick={exportAll}>
            <Download size={14} /> Download all my data
          </Button>
          <Button
            variant="ghost"
            className="text-bad hover:bg-bad-soft hover:text-bad"
            onClick={async () => {
              if (!confirm('Delete all Orbit data from this browser? This cannot be undone.')) return;
              await deleteAllData();
              await signOut();
              nav('/');
            }}
          >
            <Trash2 size={14} /> Delete all data
          </Button>
        </div>
      </Section>
      <DemoResetCard />
    </div>
  );
}

/** Replace everything with the demo: under Data & privacy, since it deletes what the student entered. */
function DemoResetCard() {
  const user = useSession().user!;
  const [busy, setBusy] = useState(false);
  return (
    <Section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium">Demo data</h2>
          <p className="text-[13px] text-ink-2 mt-0.5">
            Swap in a sample network. What you added is deleted.
          </p>
        </div>
        <Button
          variant="ghost"
          className="text-bad hover:bg-bad-soft hover:text-bad"
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
      </div>
    </Section>
  );
}

/** A settings section without a box: a hairline between sections and room around the content. */
function Section({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx('py-6 border-b border-line-2 last:border-b-0 first:pt-0', className)}>
      {children}
    </section>
  );
}
