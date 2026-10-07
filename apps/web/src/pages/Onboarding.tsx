import { newId } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { db } from '../db/schema';
import { generateBrief, recommendationsRefresh } from '../engine/brief';
import { importConnectionsCsv } from '../engine/linkedin';
import { saveResume } from '../engine/resume';
import { syncGoogle } from '../engine/sync';
import { addTargetCompany } from '../engine/targets';
import { connectGoogle, googleClientId } from '../integrations/google';
import { readPrefs, writePrefs } from '../integrations/prefs';
import { useSession } from '../state/session';
import { Button, Card, cx, FunctionPicker, Input, Label, Select, Spinner, Textarea, useToast } from '../ui';

const STEPS = [2, 3, 4, 5, 6, 7, 8] as const;
const TITLES: Record<number, string> = {
  2: 'About you',
  3: "What you're recruiting for",
  4: 'Resume',
  5: 'Connect Google',
  6: 'LinkedIn',
  7: 'Meeting notes',
  8: 'Preferences',
};

export function Onboarding() {
  const { step: stepParam } = useParams();
  const step = Number(stepParam ?? 2);
  const nav = useNavigate();
  const { user } = useSession();
  const toast = useToast();
  if (!user) return null;
  const idx = STEPS.indexOf(step as (typeof STEPS)[number]);
  // An unknown step (an old link, a typo) goes back to where the user actually is.
  if (idx === -1)
    return (
      <Navigate
        to={
          user.onboardingCompletedAt
            ? '/today'
            : `/onboarding/${Math.min(8, Math.max(2, user.onboardingStep))}`
        }
        replace
      />
    );
  const go = async (next: number) => {
    await db.users.update(user.id, { onboardingStep: Math.max(user.onboardingStep, next) });
    nav(`/onboarding/${next}`);
  };
  const finish = async () => {
    await db.users.update(user.id, { onboardingStep: 11, onboardingCompletedAt: new Date().toISOString() });
    const fresh = (await db.users.get(user.id))!;
    await recommendationsRefresh(fresh);
    await generateBrief(fresh, 'welcome');
    nav('/today');
  };
  return (
    <div className="min-h-full bg-canvas-2/60">
      <div className="max-w-[760px] mx-auto px-5 py-8">
        <div className="flex items-center gap-2 mb-8">
          <Logo /> <span className="font-semibold">Orbit</span>
          <span className="text-ink-3 text-[13px] ml-2">Setup</span>
        </div>
        <ol className="flex items-center gap-2 mb-6 overflow-x-auto">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={cx(
                'flex items-center gap-2 text-[12px] whitespace-nowrap',
                i <= idx ? 'text-ink' : 'text-ink-3',
              )}
            >
              <span
                className={cx(
                  'w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] font-semibold',
                  i < idx ? 'bg-good text-white' : i === idx ? 'bg-ink text-white' : 'bg-line text-ink-3',
                )}
              >
                {i < idx ? <Check size={12} /> : i + 1}
              </span>
              {TITLES[s]}
              {i < STEPS.length - 1 && <span className="w-6 h-px bg-line" />}
            </li>
          ))}
        </ol>
        <Card className="p-6">
          <h1 className="text-[20px] font-semibold mb-1">{TITLES[step]}</h1>
          {step === 2 && <StepAbout onNext={() => go(3)} />}
          {step === 3 && <StepGoals onNext={() => go(4)} onBack={() => nav('/onboarding/2')} />}
          {step === 4 && <StepResume onNext={() => go(5)} onBack={() => nav('/onboarding/3')} />}
          {step === 5 && <StepGoogle onNext={() => go(6)} onBack={() => nav('/onboarding/4')} />}
          {step === 6 && <StepLinkedIn onNext={() => go(7)} onBack={() => nav('/onboarding/5')} />}
          {step === 7 && <StepNotes onNext={() => go(8)} onBack={() => nav('/onboarding/6')} />}
          {step === 8 && (
            <StepPrefs
              onNext={finish}
              onBack={() => nav('/onboarding/7')}
              toast={(t) => toast.push({ text: t })}
            />
          )}
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
  skip,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  disabled?: boolean;
  skip?: () => void;
}) {
  return (
    <div className="mt-6 flex items-center gap-2">
      {onBack && (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      )}
      <span className="ml-auto flex gap-2">
        {skip && (
          <Button variant="ghost" onClick={skip}>
            Skip for now
          </Button>
        )}
        <Button variant="primary" onClick={onNext} disabled={disabled}>
          {nextLabel}
        </Button>
      </span>
    </div>
  );
}

function StepAbout({ onNext }: { onNext: () => void }) {
  const user = useSession().user!;
  const [f, setF] = useState({
    fullName: user.fullName,
    email: user.email,
    school: user.school,
    schoolDomain: user.schoolDomain ?? '',
    graduationYear: user.graduationYear ?? new Date().getFullYear() + 1,
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
  const ok = f.fullName.trim() && f.email.includes('@') && f.school.trim();
  return (
    <div className="grid sm:grid-cols-2 gap-4 mt-4">
      <div className="sm:col-span-2">
        <Label>Full name</Label>
        <Input
          value={f.fullName}
          onChange={(e) => setF({ ...f, fullName: e.target.value })}
          placeholder="Alex Rivera"
          data-testid="ob-name"
        />
      </div>
      <div>
        <Label hint="the one you recruit from">Email</Label>
        <Input
          type="email"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
          placeholder="alex@cornell.edu"
          data-testid="ob-email"
        />
      </div>
      <div>
        <Label>LinkedIn URL</Label>
        <Input
          value={f.linkedinUrl}
          onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })}
          placeholder="linkedin.com/in/…"
        />
      </div>
      <div>
        <Label>School</Label>
        <Input
          value={f.school}
          onChange={(e) => setF({ ...f, school: e.target.value })}
          placeholder="Cornell University"
          data-testid="ob-school"
        />
      </div>
      <div>
        <Label hint="to spot alumni">School email domain</Label>
        <Input
          value={f.schoolDomain}
          onChange={(e) => setF({ ...f, schoolDomain: e.target.value })}
          placeholder="cornell.edu"
        />
      </div>
      <div>
        <Label>Graduation year</Label>
        <Input
          type="number"
          value={f.graduationYear}
          onChange={(e) => setF({ ...f, graduationYear: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>Degree</Label>
        <Select value={f.degree} onChange={(e) => setF({ ...f, degree: e.target.value })} className="w-full">
          {['BS', 'BA', 'BBA', 'MS', 'MBA', 'MEng', 'PhD', 'Other'].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Major(s)</Label>
        <Input
          value={f.majors}
          onChange={(e) => setF({ ...f, majors: e.target.value })}
          placeholder="Computer Science, Economics"
        />
      </div>
      <div>
        <Label>Current city</Label>
        <Input
          value={f.currentCity}
          onChange={(e) => setF({ ...f, currentCity: e.target.value })}
          placeholder="Ithaca, NY"
        />
      </div>
      <div className="sm:col-span-2">
        <Nav onNext={save} disabled={!ok} />
      </div>
    </div>
  );
}

function StepGoals({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
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
    ambition: 2 as 1 | 2 | 3,
  });
  const [company, setCompany] = useState('');
  useEffect(() => {
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
  const addCompany = async () => {
    const r = await addTargetCompany(user.id, company);
    if (r === 'duplicate') return setCompanyNote(`${company.trim()} is already on your list.`);
    setCompanyNote('');
    if (r === 'added') setCompany('');
  };
  const save = async () => {
    await db.goals.put({
      userId: user.id,
      cycleLabel: f.cycleLabel.trim() || 'This cycle',
      targetRoles: f.targetRoles
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      targetFunctions: f.targetFunctions,
      targetIndustries: f.targetIndustries
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      targetLocations: f.targetLocations
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      freeText: f.freeText,
      ambition: f.ambition,
    });
    await db.settings.update(user.id, { weeklyOutreachTarget: { 1: 2, 2: 4, 3: 7 }[f.ambition] });
    onNext();
  };
  return (
    <div className="mt-4 space-y-4">
      <div>
        <Label>Recruiting cycle</Label>
        <Input
          value={f.cycleLabel}
          onChange={(e) => setF({ ...f, cycleLabel: e.target.value })}
          data-testid="ob-cycle"
        />
      </div>
      <div>
        <Label>Functions</Label>
        <FunctionPicker
          value={f.targetFunctions}
          onChange={(targetFunctions) => setF({ ...f, targetFunctions })}
          testIdPrefix="ob-fn"
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <Label>Target roles</Label>
          <Input
            value={f.targetRoles}
            onChange={(e) => setF({ ...f, targetRoles: e.target.value })}
            placeholder="SWE intern, APM intern"
          />
        </div>
        <div>
          <Label>Industries</Label>
          <Input
            value={f.targetIndustries}
            onChange={(e) => setF({ ...f, targetIndustries: e.target.value })}
            placeholder="Fintech, AI, Consumer"
          />
        </div>
        <div>
          <Label>Locations</Label>
          <Input
            value={f.targetLocations}
            onChange={(e) => setF({ ...f, targetLocations: e.target.value })}
            placeholder="NYC, SF, Remote"
          />
        </div>
        <div>
          <Label>How hard are you going?</Label>
          <Select
            value={f.ambition}
            onChange={(e) => setF({ ...f, ambition: Number(e.target.value) as 1 | 2 | 3 })}
            className="w-full"
          >
            <option value={1}>Steady · 2 new people a week</option>
            <option value={2}>Focused · 4 a week</option>
            <option value={3}>All in · 7 a week</option>
          </Select>
        </div>
      </div>
      <div>
        <Label hint="add as many as you like">Target companies</Label>
        <div className="flex gap-2">
          <Input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCompany())}
            placeholder="Stripe"
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
              className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 h-7 text-[13px]"
            >
              <button
                className={cx('text-[11px] font-semibold', t.priority === 1 ? 'text-accent' : 'text-ink-3')}
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
                className="text-ink-3 hover:text-ink"
                onClick={() => db.targetCompanies.delete(t.id)}
                aria-label={`Remove ${t.nameRaw}`}
                title={`Remove ${t.nameRaw}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
      <div>
        <Label hint="optional">Anything else?</Label>
        <Textarea
          rows={2}
          value={f.freeText}
          onChange={(e) => setF({ ...f, freeText: e.target.value })}
          placeholder="I care most about payments infrastructure and small teams."
        />
      </div>
      <Nav onBack={onBack} onNext={save} disabled={!f.targetFunctions.length} />
    </div>
  );
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
        messages. PDF, DOCX text, or TXT.
      </p>
      <label className="mt-4 flex items-center justify-center gap-2 border border-dashed border-line rounded-[12px] h-28 cursor-pointer hover:bg-canvas-2">
        <input
          type="file"
          accept=".pdf,.txt,.md,.docx"
          className="hidden"
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
          <Label hint="uncheck anything that's wrong">
            Extracted ({resume?.parseSource === 'llm' ? 'with Claude' : 'built-in parser'})
          </Label>
          <ul className="space-y-2 max-h-72 overflow-y-auto scroll-thin pr-1">
            {facets.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={f.confirmed || f.confirmed === false}
                  onChange={(e) => db.resumeFacets.update(f.id, { confirmed: e.target.checked })}
                />
                <span>
                  <span className="text-ink-3 uppercase text-[10px] tracking-wide mr-1.5">
                    {f.kind.replace('_', ' ')}
                  </span>
                  {f.title ? <strong className="font-medium">{f.title}</strong> : null}
                  {f.organizationName ? ` · ${f.organizationName}` : ''}{' '}
                  <span className="text-ink-2">{f.text.slice(0, 140)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Nav onBack={onBack} onNext={onNext} skip={onNext} />
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
        scopes: [],
        syncState: {},
        connectedAt: new Date().toISOString(),
      });
      if (t.email && !user.email) await db.users.update(user.id, { email: t.email });
      const fresh = (await db.users.get(user.id))!;
      await syncGoogle(fresh, {
        onProgress: (p) => setBusy(`${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
      });
      setBusy(undefined);
    } catch (e) {
      setBusy(undefined);
      setError(String((e as Error).message ?? e));
    }
  };
  return (
    <div className="mt-4">
      <p className="text-ink-2 text-[14px]">
        Orbit reads threads with real people (never newsletters) and your calendar to track chats and write
        with context. Sending only happens after you approve a draft. Everything stays in this browser.
      </p>
      <div className="mt-4">
        <Label hint="from Google Cloud → Credentials (Web application). Add this site as an authorised JavaScript origin.">
          OAuth client ID
        </Label>
        <Input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="1234567890-abc.apps.googleusercontent.com"
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={connect} disabled={!!busy || !clientId.trim()}>
          {busy ? (
            <>
              <Spinner /> {busy}
            </>
          ) : account ? (
            'Reconnect & sync'
          ) : (
            'Connect Google'
          )}
        </Button>
        {account && (
          <span className="text-[13px] text-good inline-flex items-center gap-1">
            <Check size={14} /> Connected{account.externalAccountId ? ` as ${account.externalAccountId}` : ''}
          </span>
        )}
      </div>
      {error && <p className="text-bad text-[13px] mt-2">{error}</p>}
      <p className="text-[12px] text-ink-3 mt-3">
        No client ID yet? Skip this and try the demo mailbox from Settings, or import LinkedIn next.
      </p>
      <Nav onBack={onBack} onNext={onNext} skip={onNext} />
    </div>
  );
}

function StepLinkedIn({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const user = useSession().user!;
  const [busy, setBusy] = useState<string>();
  const [result, setResult] = useState<string>();
  const onFile = async (f: File) => {
    setBusy('Importing…');
    const r = await importConnectionsCsv(user, await f.text(), (d, t) => setBusy(`Importing ${d}/${t}…`));
    await db.integrations.put({
      id: newId('int'),
      userId: user.id,
      provider: 'linkedin_csv',
      status: 'active',
      scopes: [],
      syncState: { rows: r.imported + r.updated },
      connectedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    });
    setBusy(undefined);
    setResult(
      `${r.imported} people added, ${r.updated} updated${r.skipped ? `, ${r.skipped} rows skipped` : ''}.`,
    );
  };
  return (
    <div className="mt-4">
      <p className="text-ink-2 text-[14px]">
        LinkedIn has no API for your connections, so Orbit uses the export LinkedIn gives you. It takes about
        ten minutes and lands in your email.
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
          When the email arrives, download the ZIP and upload{' '}
          <code className="bg-canvas-2 px-1 rounded">Connections.csv</code> here.
        </li>
      </ol>
      <label className="mt-4 flex items-center justify-center gap-2 border border-dashed border-line rounded-[12px] h-24 cursor-pointer hover:bg-canvas-2">
        <input
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          data-testid="ob-linkedin"
        />
        {busy ? <Spinner /> : <Upload size={16} className="text-ink-3" />}{' '}
        <span className="text-[14px]">{busy ?? 'Upload Connections.csv'}</span>
      </label>
      {result && (
        <p className="text-good text-[13px] mt-2 inline-flex items-center gap-1">
          <Check size={14} /> {result}
        </p>
      )}
      <Nav onBack={onBack} onNext={onNext} skip={onNext} />
    </div>
  );
}

function StepNotes({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div className="mt-4 space-y-3 text-[14px] text-ink-2">
      <p>
        After a chat, Orbit wants what was said so the thank-you is specific and the profile remembers. Three
        ways in:
      </p>
      <ul className="space-y-2 list-disc pl-5">
        <li>
          <strong className="font-medium text-ink">Granola:</strong> open the note → Share → copy, then paste
          it into <em>Add note</em>. (Granola's email share and API arrive with the hosted version.)
        </li>
        <li>
          <strong className="font-medium text-ink">Voice:</strong> Wispr Flow (or any dictation) types
          straight into the capture box. Orbit nudges you right after a chat ends.
        </li>
        <li>
          <strong className="font-medium text-ink">Typed or uploaded:</strong> .txt / .md files work too.
        </li>
      </ul>
      <p className="text-[13px] text-ink-3">
        Orbit extracts advice, offers (like "happy to refer you"), hooks to mention later, and anything you
        promised, then schedules the follow-ups.
      </p>
      <Nav onBack={onBack} onNext={onNext} />
    </div>
  );
}

function StepPrefs({
  onNext,
  onBack,
  toast,
}: {
  onNext: () => void;
  onBack: () => void;
  toast: (t: string) => void;
}) {
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
    toast('Preparing your first brief…');
    await onNext();
    setBusy(false);
  };
  return (
    <div className="mt-4 grid sm:grid-cols-2 gap-4">
      <div>
        <Label>Brief time</Label>
        <Input
          type="time"
          value={f.briefTimeLocal}
          onChange={(e) => setF({ ...f, briefTimeLocal: e.target.value })}
        />
      </div>
      <div>
        <Label hint="until Orbit learns from your sent mail">Tone</Label>
        <Select
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
        <Label hint="Calendly, Cal.com, Google appointment page">Scheduling link</Label>
        <Input
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
          <strong className="font-medium">Warm up cold LinkedIn targets first.</strong>{' '}
          <span className="text-ink-2">
            Before messaging someone you've never interacted with, Orbit schedules a few days of genuine
            engagement with their posts (done by you, with deep links) so your message doesn't arrive cold.
          </span>
        </span>
      </label>
      <div className="sm:col-span-2">
        <Label hint="optional · stored only in this browser">Anthropic API key for Claude drafting</Label>
        <Input
          type="password"
          value={f.apiKey}
          onChange={(e) => setF({ ...f, apiKey: e.target.value })}
          placeholder="sk-ant-…"
        />
        <p className="text-[12px] text-ink-3 mt-1">
          Without a key, Orbit uses its built-in templates. With one, Claude ({'claude-opus-5-5'}) writes your
          drafts, up to 50 requests a day. Reading synced email, notes and your resume with Claude stays off
          until you turn it on in Settings.
        </p>
      </div>
      <div className="sm:col-span-2">
        <Nav onBack={onBack} onNext={save} nextLabel={busy ? 'Finishing…' : 'Finish setup'} disabled={busy} />
      </div>
    </div>
  );
}
