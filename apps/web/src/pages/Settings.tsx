import { buildStyleCard, defaultStyleCard, newId, TARGET_STATUS_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Download, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { LinkedInImportButton } from '../components/LinkedInImport';
import { db, wipeDatabase } from '../db/schema';
import { demoResetPrompt, loadDemo } from '../engine/demo';
import { saveResume } from '../engine/resume';
import { syncGoogle } from '../engine/sync';
import { addTargetCompany } from '../engine/targets';
import { fmtFailureTime, hasLlm, MODEL, testApiKey } from '../integrations/anthropic';
import {
  connectGoogle,
  currentGoogleToken,
  disconnectGoogle,
  googleClientId,
  googleScopeWarning,
} from '../integrations/google';
import {
  clearPrefs,
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
import { useSession } from '../state/session';
import {
  Button,
  Card,
  cx,
  FunctionPicker,
  Input,
  Label,
  PageHeader,
  relDate,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '../ui';

const SECTIONS = [
  ['profile', 'Profile'],
  ['goals', 'Goals'],
  ['integrations', 'Integrations'],
  ['style', 'Writing style'],
  ['limits', 'Limits and schedule'],
  ['privacy', 'Data & privacy'],
] as const;

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
  if (!SECTIONS.some(([k]) => k === section))
    // the words a student might guess ("writing", "tone") go to the section that has them
    return <Navigate to={`/settings/${SECTION_ALIASES[section] ?? 'profile'}`} replace />;
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid md:grid-cols-[200px_minmax(0,1fr)] gap-6 items-start">
        <nav
          className="flex flex-wrap md:flex-nowrap md:flex-col gap-1 md:gap-0.5 min-w-0"
          aria-label="Settings sections"
        >
          {SECTIONS.map(([k, l]) => (
            <NavLink
              key={k}
              to={`/settings/${k}`}
              className={({ isActive }) =>
                cx(
                  'h-9 px-3 rounded-lg flex items-center text-[14px] whitespace-nowrap border md:border-0',
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
  majors: string;
  currentCity: string;
  linkedinUrl: string;
  timezone: string;
};
const unsavedProfile = new Map<string, ProfileForm>();

function Profile() {
  const user = useSession().user!;
  const [f, setF] = useState<ProfileForm>(
    () =>
      unsavedProfile.get(user.id) ?? {
        fullName: user.fullName,
        email: user.email,
        school: user.school,
        schoolDomain: user.schoolDomain ?? '',
        graduationYear: user.graduationYear ?? 0,
        majors: user.majors.join(', '),
        currentCity: user.currentCity ?? '',
        linkedinUrl: user.linkedinUrl ?? '',
        timezone: user.timezone,
      },
  );
  const toast = useToast();
  const nameMissing = !f.fullName.trim();
  const [saved, setSaved] = useState(() =>
    JSON.stringify({
      fullName: user.fullName,
      email: user.email,
      school: user.school,
      schoolDomain: user.schoolDomain ?? '',
      graduationYear: user.graduationYear ?? 0,
      majors: user.majors.join(', '),
      currentCity: user.currentCity ?? '',
      linkedinUrl: user.linkedinUrl ?? '',
      timezone: user.timezone,
    }),
  );
  const dirty = saved !== JSON.stringify(f);
  // an edit not saved yet survives a visit to another settings tab (it is kept until saved or the page reloads)
  useEffect(() => {
    if (dirty) unsavedProfile.set(user.id, f);
    else unsavedProfile.delete(user.id);
  }, [dirty, f, user.id]);
  const zones = timeZones(f.timezone);
  return (
    <Card className="grid sm:grid-cols-2 gap-4">
      <div className="sm:col-span-2">
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
        <Input
          id="profile-year"
          type="number"
          value={f.graduationYear}
          onChange={(e) => setF({ ...f, graduationYear: Number(e.target.value) })}
        />
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
          <optgroup label="All time zones">
            {zones
              .filter((z) => !COMMON_ZONES.some(([c]) => c === z))
              .map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
          </optgroup>
        </Select>
      </div>
      <div className="sm:col-span-2">
        <Button
          variant="primary"
          disabled={nameMissing}
          onClick={async () => {
            if (nameMissing) return;
            const [first, ...rest] = f.fullName.trim().split(/\s+/);
            await db.users.update(user.id, {
              ...f,
              fullName: f.fullName.trim(),
              firstName: first ?? '',
              lastName: rest.join(' '),
              majors: f.majors
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean),
              schoolDomain: f.schoolDomain || undefined,
              linkedinUrl: f.linkedinUrl || undefined,
            });
            setSaved(JSON.stringify(f));
            toast.push({ text: 'Saved.', tone: 'good' });
          }}
        >
          Save
        </Button>
        {dirty && <span className="ml-3 text-[12px] text-warn">Unsaved changes</span>}
      </div>
    </Card>
  );
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
  const [f, setF] = useState({
    cycleLabel: '',
    targetRoles: '',
    targetFunctions: [] as string[],
    targetIndustries: '',
    targetLocations: '',
    freeText: '',
  });
  const [company, setCompany] = useState('');
  const toast = useToast();
  const addCompany = async () => {
    const r = await addTargetCompany(user.id, company);
    if (r === 'duplicate') toast.push({ text: `${company.trim()} is already on your list.` });
    if (r === 'added') setCompany('');
  };
  useEffect(() => {
    if (goals)
      setF({
        cycleLabel: goals.cycleLabel,
        targetRoles: goals.targetRoles.join(', '),
        targetFunctions: goals.targetFunctions,
        targetIndustries: goals.targetIndustries.join(', '),
        targetLocations: goals.targetLocations.join(', '),
        freeText: goals.freeText ?? '',
      });
  }, [goals]);
  const split = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className="space-y-4">
      <Card className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Label htmlFor="goals-cycle">Recruiting cycle</Label>
          <Input
            id="goals-cycle"
            value={f.cycleLabel}
            onChange={(e) => setF({ ...f, cycleLabel: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Functions</Label>
          <FunctionPicker
            value={f.targetFunctions}
            onChange={(targetFunctions) => setF({ ...f, targetFunctions })}
            testIdPrefix="settings-fn"
          />
        </div>
        <div>
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
        <div className="sm:col-span-2">
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
        <div className="sm:col-span-2">
          <Button
            variant="primary"
            onClick={async () => {
              await db.goals.put({
                userId: user.id,
                cycleLabel: f.cycleLabel,
                targetRoles: split(f.targetRoles),
                targetFunctions: f.targetFunctions,
                targetIndustries: split(f.targetIndustries),
                targetLocations: split(f.targetLocations),
                freeText: f.freeText,
                ambition: goals?.ambition ?? 2,
              });
              toast.push({ text: 'Saved.', tone: 'good' });
            }}
          >
            Save
          </Button>
        </div>
      </Card>
      <Card>
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
                  onChange={(e) =>
                    db.targetCompanies.update(t.id, { priority: Number(e.target.value) as 1 | 2 | 3 })
                  }
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
                  onChange={(e) =>
                    db.targetCompanies.update(t.id, {
                      status: e.target.value as never,
                      statusChangedAt: new Date().toISOString(),
                    })
                  }
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
                  onChange={(e) => db.targetCompanies.update(t.id, { deadline: e.target.value || undefined })}
                  className="h-8 text-[12px] w-36 text-ink"
                  aria-label={`Application deadline for ${t.nameRaw}`}
                />
              </label>
              <button
                className="text-ink-3 hover:text-bad p-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={async () => {
                  await db.targetCompanies.delete(t.id);
                  toast.push({
                    text: `Removed ${t.nameRaw} from your targets.`,
                    action: { label: 'Undo', onClick: () => db.targetCompanies.put(t) },
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
      </Card>
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
  const [clientId, setClientId] = useState(googleClientId() ?? '');
  const [busy, setBusy] = useState<string>();
  const token = currentGoogleToken();
  const builtIn = !!envGoogleClientId();
  const connect = async () => {
    try {
      writePrefs({ googleClientId: clientId.trim() || undefined });
      setBusy('Waiting for Google…');
      const t = await connectGoogle();
      await db.integrations.put({
        id: google?.id ?? newId('int'),
        userId: user.id,
        provider: 'google',
        externalAccountId: t.email,
        status: 'active',
        scopes: t.scopes ?? [],
        syncState: google?.syncState ?? {},
        connectedAt: google?.connectedAt ?? new Date().toISOString(),
      });
      await syncGoogle(user, {
        onProgress: (p) => setBusy(`${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
      });
      const missing = googleScopeWarning(t.scopes);
      toast.push(
        missing ? { text: missing, tone: 'bad', ttl: 10_000 } : { text: 'Google synced.', tone: 'good' },
      );
    } catch (e) {
      toast.push({ text: String((e as Error).message ?? e), tone: 'bad', ttl: 7000 });
      if (google)
        await db.integrations.update(google.id, {
          status: 'needs_reauth',
          lastError: String((e as Error).message ?? e),
        });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Card className={cx(!builtIn && !google && 'order-last')}>
        <div className="font-medium">Google (Gmail and Calendar)</div>
        {builtIn || google ? (
          <p className="text-[13px] text-ink-2 mt-0.5">
            Finds the people you already email and meet, notices replies, and sends the emails you approve.
            Google asks you to sign in again after about an hour; Orbit reminds you when it needs that.
          </p>
        ) : (
          <p className="text-[13px] text-ink-2 mt-0.5" data-testid="google-unavailable">
            Not part of this version of Orbit. Everything else works without it: you add people by hand or
            from LinkedIn, send each email from your own mail app or Gmail and press I sent it, and when
            someone replies you move their chat in Pipeline.
          </p>
        )}
        {google && (
          <p className="text-[12px] mt-1 inline-flex flex-wrap items-center gap-1 text-good">
            <Check size={13} /> Connected
            {google.externalAccountId ? ` as ${google.externalAccountId}` : ''} · last sync{' '}
            {google.lastSyncedAt ? relDate(google.lastSyncedAt) : 'never'}
            {!token && <span className="text-ink-3"> · signed out, reconnect to sync</span>}
          </p>
        )}
        {(builtIn || google) && (
          <div className="mt-3 flex gap-2 flex-wrap">
            <Button variant="primary" onClick={connect} disabled={!!busy || !clientId.trim()}>
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : google ? (
                'Reconnect and sync now'
              ) : (
                'Connect Google'
              )}
            </Button>
            {google && (
              <Button
                variant="ghost"
                onClick={async () => {
                  disconnectGoogle();
                  await db.integrations.delete(google.id);
                  toast.push({ text: 'Disconnected. Imported mail stays until you delete your data.' });
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
        )}
        {!builtIn && (
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-ink-3">
              For developers: connect your own Google Cloud project
            </summary>
            <div className="mt-2">
              <Label
                htmlFor="settings-client-id"
                hint="Google Cloud, APIs and Services, Credentials, OAuth client (Web), with this site as an authorised JavaScript origin"
              >
                OAuth client ID
              </Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="settings-client-id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="…apps.googleusercontent.com"
                  className="flex-1 min-w-0"
                />
                {!google && (
                  <Button onClick={connect} disabled={!!busy || !clientId.trim()}>
                    Connect Google
                  </Button>
                )}
              </div>
            </div>
          </details>
        )}
      </Card>
      <Card>
        <div className="font-medium">LinkedIn export</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          Brings in everyone you are connected to. On LinkedIn: Me, Settings and Privacy, Data privacy, Get a
          copy of your data, then Connections. LinkedIn emails you a file; upload Connections.csv from it
          here. Uploading again later is safe: people already in Orbit are updated, not doubled.
        </p>
        {li && (
          <p className="text-[12px] mt-1 text-good flex items-center gap-1">
            <Check size={13} /> {String((li.syncState as { rows?: number }).rows ?? 0)} connections ·{' '}
            {li.lastSyncedAt ? `imported ${relDate(li.lastSyncedAt)}` : ''}
          </p>
        )}
        <LinkedInImportButton label="Upload Connections.csv" testId="settings-linkedin" className="mt-3" />
      </Card>
      <Card>
        <div className="font-medium">Resume</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          Upload a newer resume any time. Orbit reads it again for what you have done, to find people with a
          shared background and to describe you in first messages.
        </p>
        <label className="mt-3 inline-flex rounded-lg focus-within:ring-2 focus-within:ring-accent/40">
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
          <span className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium h-9 px-3.5 text-[14px] bg-canvas border border-line hover:bg-canvas-2 cursor-pointer">
            Upload resume
          </span>
        </label>
      </Card>
      <Card>
        <div className="font-medium">Meeting notes</div>
        <ul className="text-[13px] text-ink-2 mt-1 space-y-1 list-disc pl-5">
          <li>
            <strong className="font-medium text-ink">Type or dictate</strong> in Add note after a chat. Your
            phone's or computer's dictation works in any Orbit text box.
          </li>
          <li>
            <strong className="font-medium text-ink">Notes from a notetaker app</strong> (Granola, Otter,
            Fathom and similar): copy the note or export the transcript as text, then paste or upload it in
            Add note.
          </li>
        </ul>
      </Card>
      <ClaudeCard />
      <Card>
        <div className="font-medium">Demo data</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          Replace everything with the demo mailbox and network. Useful to see the full product before
          connecting your own accounts.
        </p>
        <Button
          className="mt-3"
          variant="danger"
          onClick={async () => {
            const prompt =
              demoResetPrompt(user) ??
              'Reload the demo from scratch? Changes you made to the demo data are lost.';
            if (!confirm(prompt)) return;
            setBusy('Loading demo…');
            await loadDemo({ reset: true });
            setBusy(undefined);
            location.assign(`${import.meta.env.BASE_URL}today`);
          }}
        >
          Reset to demo
        </Button>
      </Card>
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
];

function ClaudeCard() {
  const tz = useSession().user?.timezone;
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
  return (
    <Card>
      <div className="font-medium">Claude (optional)</div>
      <p className="text-[13px] text-ink-2 mt-0.5">
        You do not need this: Orbit writes every draft on its own, for free. If you already pay for an
        Anthropic account (the company behind the Claude AI model), add its API key and Claude can write
        drafts instead; Anthropic bills that account. You choose what Claude may read.
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-…"
          className="max-w-md"
          aria-label="Anthropic API key"
        />
        <Button
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
        <p className={cx('text-[12px] mt-1', keyStatus === 'Works.' ? 'text-good' : 'text-ink-3')}>
          {keyStatus}
        </p>
      )}
      {hasLlm() && !keyStatus && <p className="text-[12px] mt-1 text-good">Key saved.</p>}
      <fieldset className="mt-4 space-y-2" disabled={!keySaved} data-testid="ai-usage">
        <legend className="text-[13px] font-medium">What Claude may do</legend>
        {AI_FEATURES.map((f) => (
          <label
            key={f.key}
            className={cx('flex items-start gap-2 text-[13.5px]', !keySaved && 'opacity-60')}
          >
            <input
              type="checkbox"
              className="mt-1"
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
              <strong className="font-medium">{f.label}.</strong>{' '}
              <span className="text-ink-2">{f.sends}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <details className="mt-4 text-[13px]" data-testid="ai-advanced">
        <summary className="cursor-pointer text-ink-3">Advanced: daily limits, usage and privacy</summary>
        <p className="text-[12px] text-ink-3 mt-2">
          Model: {MODEL}. The key is kept in this browser only, separate from your Orbit data and never in the
          export. Any script running on this page could read it, so Orbit only allows its own code and
          Google's sign-in script to run here.
        </p>
        <div className="mt-3 grid sm:grid-cols-2 gap-3 max-w-lg items-start">
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
          Orbit stops calling Claude for the rest of the day at either limit and uses its own drafts instead.
          A token is roughly three quarters of a word, counting what is sent and what comes back.
        </p>
        <p className="text-[12px] text-ink-3 mt-2" data-testid="ai-usage-today">
          Today: {usage.requests} of {reqCap} requests,{' '}
          {(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} of{' '}
          {tokCap.toLocaleString('en-US')} tokens.
        </p>
      </details>
      {prefs.lastLlmError && (
        <p className="text-[12px] text-bad mt-1" data-testid="ai-last-error">
          Last problem, {fmtFailureTime(prefs.lastLlmError.at, tz)}: {prefs.lastLlmError.message} Orbit used
          its templates instead.
        </p>
      )}
    </Card>
  );
}

const FORMALITY_WORDS = (f: number) =>
  f >= 0.75 ? 'Formal' : f >= 0.5 ? 'Polite and fairly formal' : f >= 0.3 ? 'Friendly and polite' : 'Casual';

function Style() {
  const user = useSession().user!;
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const style = useLiveQuery(() => db.styles.get(user.id), [user.id]);
  const toast = useToast();
  const card = style?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName);
  const learned = card.builtFromCount > 0;
  const example = (g: string) => g.replace(/\{first\}/g, 'Sarah');
  // learning needs sent mail, which only Google can provide: without it the button is not offered at all
  const google = useLiveQuery(
    () =>
      db.integrations
        .where('userId')
        .equals(user.id)
        .filter((i) => i.provider === 'google')
        .first(),
    [user.id],
  );
  return (
    <div className="space-y-4">
      <Card>
        <div className="font-medium">How your drafts sound</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          {learned
            ? `Learned from ${card.builtFromCount} emails you sent.`
            : google
              ? 'Set by the style you pick below, or learned from emails you sent.'
              : 'Set by the style you pick below.'}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13.5px] mt-3">
          <dt className="text-ink-3">Greeting</dt>
          <dd>{card.greetingPatterns.map(example).join(' or ')}</dd>
          <dt className="text-ink-3">Sign-off</dt>
          <dd className="whitespace-pre-line">
            {learned
              ? card.signoffs[0]
              : settings?.tonePreset === 'formal'
                ? `"Kind regards, ${user.firstName}" for most emails. "Best regards" and your full name for finance, consulting and recruiters.`
                : `"Thanks, ${user.firstName}" for most messages. "Best" and your full name for finance and consulting emails, "Best regards" for recruiters.`}
          </dd>
          <dt className="text-ink-3">Tone</dt>
          <dd>
            {FORMALITY_WORDS(card.formality)}, {card.contractions ? 'with' : 'without'} contractions like
            "I'm"{card.emoji ? ', emoji allowed' : ''}
          </dd>
          <dt className="text-ink-3">Length</dt>
          <dd>Short sentences, about {card.avgMessageWords} words a message at most</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2 items-center">
          <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
            Style
            <Select
              value={settings?.tonePreset ?? 'warm'}
              onChange={(e) => db.settings.update(user.id, { tonePreset: e.target.value as never })}
              disabled={learned}
              title={learned ? 'Drafts follow the style learned from your sent mail' : undefined}
            >
              <option value="warm">Warm</option>
              <option value="direct">Direct</option>
              <option value="formal">Formal</option>
            </Select>
          </label>
          {google && (
            <Button
              onClick={async () => {
                const sent = await db.messages
                  .where('userId')
                  .equals(user.id)
                  .filter((m) => m.direction === 'outbound' && !m.isAutomated)
                  .toArray();
                if (sent.length < 5)
                  return toast.push({
                    text: 'Orbit needs at least 5 emails you sent to learn from. Sync Google again later.',
                  });
                await db.styles.put({
                  userId: user.id,
                  card: buildStyleCard(
                    sent.map((m) => m.bodyText),
                    user.firstName,
                    settings?.tonePreset,
                  ),
                  updatedAt: new Date().toISOString(),
                });
                toast.push({ text: 'Learned from your sent mail.', tone: 'good' });
              }}
            >
              Learn from my sent mail
            </Button>
          )}
          {style && (
            <Button variant="ghost" onClick={() => db.styles.delete(user.id)}>
              Use the picked style instead
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function Limits() {
  const user = useSession().user!;
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const [savedAt, setSavedAt] = useState<number>();
  if (!settings) return null;
  const upd = async (p: Partial<typeof settings>) => {
    await db.settings.update(user.id, p);
    setSavedAt(Date.now());
  };
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-3" aria-live="polite">
        Changes here save as you make them.
        {savedAt ? <span className="text-good"> Saved.</span> : null}
      </p>
      <Card className="grid sm:grid-cols-2 gap-4 items-start">
        <div className="sm:col-span-2 font-medium -mb-1">Sending limits</div>
        <div>
          <Label htmlFor="lim-week">First messages a week</Label>
          <Input
            id="lim-week"
            type="number"
            min={1}
            max={30}
            value={settings.weeklyOutreachTarget}
            onChange={(e) =>
              upd({
                weeklyOutreachTarget: Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 1))),
              })
            }
          />
          <p className="text-[12px] text-ink-3 mt-1">Your goal for new people each week, shown on Today.</p>
        </div>
        <details className="sm:col-span-2 text-[13px]" data-testid="limits-advanced">
          <summary className="cursor-pointer text-ink-2 w-fit">
            Advanced: how often Orbit lets you write (most students never change these)
          </summary>
          <p className="text-[12px] text-ink-3 mt-1 mb-3">
            They keep you from writing to someone twice in a row too soon, and from sending more in a day than
            reads as a mass email.
          </p>
          <div className="grid sm:grid-cols-2 gap-4 items-start">
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
            <div className="sm:col-span-2">
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
            <div className="sm:col-span-2 border-t border-line pt-4">
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
                <Label htmlFor="lim-wdays">Warm-up length in days</Label>
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
      </Card>
      <Card className="grid sm:grid-cols-2 gap-4 items-start">
        <div className="sm:col-span-2 font-medium -mb-1">Your schedule</div>
        <p className="sm:col-span-2 text-[13px] text-ink-2">
          Today's list is rebuilt the first time you open Orbit each day. Orbit runs in your browser, so it
          does not send reminders when it is closed.
        </p>
        <div className="sm:col-span-2">
          <Label htmlFor="lim-sched" optional hint="Calendly, Cal.com or a Google booking page">
            Scheduling link
          </Label>
          <Input
            id="lim-sched"
            value={settings.schedulingLink ?? ''}
            onChange={(e) => upd({ schedulingLink: e.target.value || undefined })}
            placeholder="https://cal.com/you/20min"
          />
          <p className="text-[12px] text-ink-3 mt-1">Orbit adds it when you propose times for a chat.</p>
        </div>
      </Card>
    </div>
  );
}

function Privacy() {
  const { user, signOut } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  if (!user) return null;
  const exportAll = async () => {
    const tables = db.tables.map((t) => t.name);
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = await db.table(t).toArray();
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    } finally {
      // the click has started the download; release the blob on the next tick
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    toast.push({ text: 'Export downloaded.', tone: 'good' });
  };
  return (
    <div className="space-y-4">
      <Card>
        <div className="font-medium">What Orbit stores (in this browser only)</div>
        <ul className="text-[13px] text-ink-2 mt-2 list-disc pl-5 space-y-1">
          <li>Your profile, goals, and your resume with what Orbit read from it.</li>
          <li>
            Email threads with people (bodies with quotes stripped), calendar events, LinkedIn connections,
            meeting notes.
          </li>
          <li>
            What Orbit works out from those: the people you know and how well, who knows whom, where each chat
            stands, what you know about each person, today's cards, your drafts, and a record of what you
            sent.
          </li>
          <li>
            If you added them: your Anthropic API key and Claude settings, kept apart from the rest. Only
            Orbit's own code and Google's sign-in can run on this page, so no other site can read them.
          </li>
        </ul>
        <p className="text-[13px] text-ink-2 mt-2">
          Nothing leaves your device except: calls you trigger to Google (your own account), to Anthropic
          (with your key, only for the features you turned on in Integrations), and the pages you open on
          LinkedIn.
        </p>
      </Card>
      <Card>
        <p className="text-[13px] text-ink-2" data-testid="export-contents">
          The download is one file with everything Orbit stores about your network: full email text and
          headers, calendar events, notes, people, facts, drafts and what you sent. Keep it as private as your
          inbox. It does not include your Anthropic key.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <Button onClick={exportAll}>
            <Download size={14} /> Download all my data
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (!confirm('Delete all Orbit data from this browser? This cannot be undone.')) return;
              disconnectGoogle();
              await clearPrefs();
              await wipeDatabase();
              await signOut();
              nav('/');
            }}
          >
            <Trash2 size={14} /> Delete all data
          </Button>
        </div>
      </Card>
    </div>
  );
}
