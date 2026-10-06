import { buildStyleCard, defaultStyleCard, newId } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Download, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { db, wipeDatabase } from '../db/schema';
import { loadDemo } from '../engine/demo';
import { importConnectionsCsv } from '../engine/linkedin';
import { saveResume } from '../engine/resume';
import { syncGoogle } from '../engine/sync';
import { hasLlm, testApiKey } from '../integrations/anthropic';
import { connectGoogle, currentGoogleToken, disconnectGoogle, googleClientId } from '../integrations/google';
import { readPrefs, writePrefs } from '../integrations/prefs';
import { useSession } from '../state/session';
import { Button, Card, cx, Input, Label, PageHeader, Select, Spinner, Textarea, useToast } from '../ui';

const SECTIONS = [
  ['profile', 'Profile'],
  ['goals', 'Goals'],
  ['integrations', 'Integrations'],
  ['style', 'Writing style'],
  ['limits', 'Sending limits'],
  ['privacy', 'Data & privacy'],
] as const;

export function SettingsPage() {
  const { section = 'profile' } = useParams();
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid md:grid-cols-[200px_1fr] gap-6 items-start">
        <nav className="flex md:flex-col gap-0.5 overflow-x-auto">
          {SECTIONS.map(([k, l]) => (
            <NavLink
              key={k}
              to={`/settings/${k}`}
              className={({ isActive }) =>
                cx(
                  'h-9 px-3 rounded-lg flex items-center text-[14px] whitespace-nowrap',
                  isActive || (k === 'profile' && section === 'profile')
                    ? 'bg-canvas-2 font-medium'
                    : 'text-ink-2 hover:bg-canvas-2',
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

function Profile() {
  const user = useSession().user!;
  const [f, setF] = useState({
    fullName: user.fullName,
    email: user.email,
    school: user.school,
    schoolDomain: user.schoolDomain ?? '',
    graduationYear: user.graduationYear ?? 0,
    majors: user.majors.join(', '),
    currentCity: user.currentCity ?? '',
    linkedinUrl: user.linkedinUrl ?? '',
    timezone: user.timezone,
  });
  const toast = useToast();
  return (
    <Card className="grid sm:grid-cols-2 gap-4">
      <div className="sm:col-span-2">
        <Label>Full name</Label>
        <Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
      </div>
      <div>
        <Label>Email</Label>
        <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </div>
      <div>
        <Label>LinkedIn URL</Label>
        <Input value={f.linkedinUrl} onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })} />
      </div>
      <div>
        <Label>School</Label>
        <Input value={f.school} onChange={(e) => setF({ ...f, school: e.target.value })} />
      </div>
      <div>
        <Label>School email domain</Label>
        <Input value={f.schoolDomain} onChange={(e) => setF({ ...f, schoolDomain: e.target.value })} />
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
        <Label>Majors</Label>
        <Input value={f.majors} onChange={(e) => setF({ ...f, majors: e.target.value })} />
      </div>
      <div>
        <Label>City</Label>
        <Input value={f.currentCity} onChange={(e) => setF({ ...f, currentCity: e.target.value })} />
      </div>
      <div>
        <Label>Timezone</Label>
        <Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
      </div>
      <div className="sm:col-span-2">
        <Button
          variant="primary"
          onClick={async () => {
            const [first, ...rest] = f.fullName.trim().split(/\s+/);
            await db.users.update(user.id, {
              ...f,
              firstName: first ?? '',
              lastName: rest.join(' '),
              majors: f.majors
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean),
              schoolDomain: f.schoolDomain || undefined,
              linkedinUrl: f.linkedinUrl || undefined,
            });
            toast.push({ text: 'Saved.', tone: 'good' });
          }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

function Goals() {
  const user = useSession().user!;
  const goals = useLiveQuery(() => db.goals.get(user.id), [user.id]);
  const tcs =
    useLiveQuery(() => db.targetCompanies.where('userId').equals(user.id).toArray(), [user.id]) ?? [];
  const [f, setF] = useState({
    cycleLabel: '',
    targetRoles: '',
    targetFunctions: '',
    targetIndustries: '',
    targetLocations: '',
    freeText: '',
  });
  const [company, setCompany] = useState('');
  const toast = useToast();
  useEffect(() => {
    if (goals)
      setF({
        cycleLabel: goals.cycleLabel,
        targetRoles: goals.targetRoles.join(', '),
        targetFunctions: goals.targetFunctions.join(', '),
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
          <Label>Cycle</Label>
          <Input value={f.cycleLabel} onChange={(e) => setF({ ...f, cycleLabel: e.target.value })} />
        </div>
        <div>
          <Label hint="swe, pm, ib, consulting, data, design, finance, marketing, research, vc, ops">
            Functions
          </Label>
          <Input
            value={f.targetFunctions}
            onChange={(e) => setF({ ...f, targetFunctions: e.target.value })}
          />
        </div>
        <div>
          <Label>Roles</Label>
          <Input value={f.targetRoles} onChange={(e) => setF({ ...f, targetRoles: e.target.value })} />
        </div>
        <div>
          <Label>Industries</Label>
          <Input
            value={f.targetIndustries}
            onChange={(e) => setF({ ...f, targetIndustries: e.target.value })}
          />
        </div>
        <div>
          <Label>Locations</Label>
          <Input
            value={f.targetLocations}
            onChange={(e) => setF({ ...f, targetLocations: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Notes</Label>
          <Textarea rows={2} value={f.freeText} onChange={(e) => setF({ ...f, freeText: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Button
            variant="primary"
            onClick={async () => {
              await db.goals.put({
                userId: user.id,
                cycleLabel: f.cycleLabel,
                targetRoles: split(f.targetRoles),
                targetFunctions: split(f.targetFunctions).map((x) => x.toLowerCase()),
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
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && company.trim()) {
                await db.targetCompanies.add({
                  id: newId('tc'),
                  userId: user.id,
                  nameRaw: company.trim(),
                  priority: 2,
                  status: 'researching',
                });
                setCompany('');
              }
            }}
          />
          <Button
            onClick={async () => {
              if (company.trim()) {
                await db.targetCompanies.add({
                  id: newId('tc'),
                  userId: user.id,
                  nameRaw: company.trim(),
                  priority: 2,
                  status: 'researching',
                });
                setCompany('');
              }
            }}
          >
            Add
          </Button>
        </div>
        <table className="w-full text-[13.5px]">
          <tbody className="divide-y divide-line">
            {tcs.map((t) => (
              <tr key={t.id}>
                <td className="py-2 font-medium">{t.nameRaw}</td>
                <td>
                  <Select
                    value={t.priority}
                    onChange={(e) =>
                      db.targetCompanies.update(t.id, { priority: Number(e.target.value) as 1 | 2 | 3 })
                    }
                    className="h-7 text-[12px]"
                  >
                    <option value={1}>Top priority</option>
                    <option value={2}>Normal</option>
                    <option value={3}>Low</option>
                  </Select>
                </td>
                <td>
                  <Select
                    value={t.status}
                    onChange={(e) =>
                      db.targetCompanies.update(t.id, {
                        status: e.target.value as never,
                        statusChangedAt: new Date().toISOString(),
                      })
                    }
                    className="h-7 text-[12px]"
                  >
                    {['researching', 'applied', 'interviewing', 'offer', 'closed'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  <Input
                    type="date"
                    value={t.deadline ?? ''}
                    onChange={(e) =>
                      db.targetCompanies.update(t.id, { deadline: e.target.value || undefined })
                    }
                    className="h-7 text-[12px] w-36"
                  />
                </td>
                <td className="text-right">
                  <button
                    className="text-ink-3 hover:text-bad"
                    onClick={() => db.targetCompanies.delete(t.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const [apiKey, setApiKey] = useState(readPrefs().anthropicApiKey ?? '');
  const [busy, setBusy] = useState<string>();
  const [keyStatus, setKeyStatus] = useState<string>();
  const token = currentGoogleToken();
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
        scopes: [],
        syncState: google?.syncState ?? {},
        connectedAt: google?.connectedAt ?? new Date().toISOString(),
      });
      await syncGoogle(user, {
        onProgress: (p) => setBusy(`${p.phase} ${p.total > 1 ? `${p.done}/${p.total}` : ''}`),
      });
      toast.push({ text: 'Google synced.', tone: 'good' });
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
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium">Google (Gmail + Calendar)</div>
            <p className="text-[13px] text-ink-2 mt-0.5">
              Reads threads with people and your calendar; sends only what you approve. Browser-only token,
              re-consent about every hour of use.
            </p>
            {google && (
              <p className="text-[12px] mt-1 inline-flex items-center gap-1 text-good">
                <Check size={13} /> Connected
                {google.externalAccountId ? ` as ${google.externalAccountId}` : ''} · last sync{' '}
                {google.lastSyncedAt ? new Date(google.lastSyncedAt).toLocaleString() : 'never'}
                {!token && ' · session expired'}
              </p>
            )}
          </div>
        </div>
        <div className="mt-3">
          <Label hint="Google Cloud → APIs & Services → Credentials → OAuth client (Web). Authorised JavaScript origin: this site's origin.">
            OAuth client ID
          </Label>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="…apps.googleusercontent.com"
          />
        </div>
        <div className="mt-3 flex gap-2 flex-wrap">
          <Button variant="primary" onClick={connect} disabled={!!busy || !clientId.trim()}>
            {busy ? (
              <>
                <Spinner /> {busy}
              </>
            ) : google ? (
              'Reconnect & sync now'
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
                toast.push({ text: 'Disconnected. Imported mail stays until you wipe data.' });
              }}
            >
              Disconnect
            </Button>
          )}
        </div>
      </Card>
      <Card>
        <div className="font-medium">LinkedIn export</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          Upload Connections.csv from LinkedIn's "Get a copy of your data". Re-uploading is safe; existing
          people are updated.
        </p>
        {li && (
          <p className="text-[12px] mt-1 text-good inline-flex items-center gap-1">
            <Check size={13} /> {String((li.syncState as { rows?: number }).rows ?? 0)} connections ·{' '}
            {li.lastSyncedAt ? new Date(li.lastSyncedAt).toLocaleDateString() : ''}
          </p>
        )}
        <label className="mt-3 inline-flex">
          <input
            type="file"
            accept=".csv"
            className="hidden"
            data-testid="settings-linkedin"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy('Importing LinkedIn…');
              const r = await importConnectionsCsv(user, await f.text());
              await db.integrations.put({
                id: li?.id ?? newId('int'),
                userId: user.id,
                provider: 'linkedin_csv',
                status: 'active',
                scopes: [],
                syncState: { rows: r.imported + r.updated },
                connectedAt: li?.connectedAt ?? new Date().toISOString(),
                lastSyncedAt: new Date().toISOString(),
              });
              setBusy(undefined);
              toast.push({ text: `${r.imported} added, ${r.updated} updated.`, tone: 'good' });
            }}
          />
          <span className="inline-flex items-center justify-center gap-1.5 rounded-lg font-medium h-9 px-3.5 text-[14px] bg-canvas border border-line hover:bg-canvas-2 cursor-pointer">
            Upload Connections.csv
          </span>
        </label>
      </Card>
      <Card>
        <div className="font-medium">Resume</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          Replace your resume any time; facets are re-extracted.
        </p>
        <label className="mt-3 inline-flex">
          <input
            type="file"
            accept=".pdf,.txt,.md"
            className="hidden"
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
            <strong className="font-medium text-ink">Granola:</strong> copy the note and paste it into Add
            note; Orbit recognises the Summary/Transcript layout. Granola's API, webhooks and email share
            connect when Orbit has a server.
          </li>
          <li>
            <strong className="font-medium text-ink">Wispr Flow:</strong> dictate into any Orbit text box.
            Wispr has no dictation API; the capture box is the integration.
          </li>
          <li>
            <strong className="font-medium text-ink">Fathom / Otter / Fireflies:</strong> export the
            transcript as text and upload it from Add note.
          </li>
        </ul>
      </Card>
      <Card>
        <div className="font-medium">Claude (optional)</div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          Paste your own Anthropic API key to have Claude draft messages, parse your resume and extract notes.
          Stored only in this browser. Without it, Orbit's templates do the work. Model: claude-opus-5-5.
        </p>
        <div className="mt-3 flex gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-…"
            className="max-w-md"
          />
          <Button
            onClick={async () => {
              writePrefs({ anthropicApiKey: apiKey.trim() || undefined });
              if (!apiKey.trim()) return setKeyStatus('Removed.');
              setKeyStatus('Testing…');
              const r = await testApiKey();
              setKeyStatus(r.ok ? 'Works.' : r.error);
            }}
          >
            Save & test
          </Button>
        </div>
        {keyStatus && (
          <p className={cx('text-[12px] mt-1', keyStatus === 'Works.' ? 'text-good' : 'text-ink-3')}>
            {keyStatus}
          </p>
        )}
        {hasLlm() && !keyStatus && <p className="text-[12px] mt-1 text-good">Key saved.</p>}
      </Card>
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
            if (!confirm('This wipes your current data and loads the demo. Continue?')) return;
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

function Style() {
  const user = useSession().user!;
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const style = useLiveQuery(() => db.styles.get(user.id), [user.id]);
  const toast = useToast();
  const card = style?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <div className="font-medium">Your style card</div>
          <span className="text-[12px] text-ink-3">
            {card.builtFromCount
              ? `Learned from ${card.builtFromCount} sent emails`
              : `Preset: ${settings?.tonePreset}`}
          </span>
        </div>
        <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[13.5px] mt-3">
          <dt className="text-ink-3">Greeting</dt>
          <dd className="whitespace-pre-line">{card.greetingPatterns.join(' / ')}</dd>
          <dt className="text-ink-3">Sign-off</dt>
          <dd className="whitespace-pre-line">{card.signoffs[0]}</dd>
          <dt className="text-ink-3">Formality</dt>
          <dd>{Math.round(card.formality * 100)} / 100</dd>
          <dt className="text-ink-3">Sentences</dt>
          <dd>
            ~{card.avgSentenceWords} words · messages ~{card.avgMessageWords} words
          </dd>
          <dt className="text-ink-3">Contractions</dt>
          <dd>
            {card.contractions ? 'yes' : 'no'} · exclamations {card.exclamationsPerMessage.toFixed(1)} per
            message · emoji {card.emoji ? 'yes' : 'no'}
          </dd>
        </dl>
        <div className="mt-4 flex gap-2 items-center">
          <Select
            value={settings?.tonePreset ?? 'warm'}
            onChange={(e) => db.settings.update(user.id, { tonePreset: e.target.value as never })}
          >
            <option value="warm">Warm</option>
            <option value="direct">Direct</option>
            <option value="formal">Formal</option>
          </Select>
          <Button
            onClick={async () => {
              const sent = await db.messages
                .where('userId')
                .equals(user.id)
                .filter((m) => m.direction === 'outbound' && !m.isAutomated)
                .toArray();
              if (sent.length < 5)
                return toast.push({
                  text: 'Need at least 5 sent emails to learn from. Connect Google first.',
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
              toast.push({ text: 'Rebuilt from your sent mail.', tone: 'good' });
            }}
          >
            Rebuild from sent mail
          </Button>
          {style && (
            <Button variant="ghost" onClick={() => db.styles.delete(user.id)}>
              Use preset instead
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
  const toast = useToast();
  if (!settings) return null;
  const upd = (p: Partial<typeof settings>) => db.settings.update(user.id, p);
  return (
    <Card className="grid sm:grid-cols-2 gap-4">
      <div>
        <Label>Weekly outreach target</Label>
        <Input
          type="number"
          min={0}
          max={30}
          value={settings.weeklyOutreachTarget}
          onChange={(e) => upd({ weeklyOutreachTarget: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>Brief time</Label>
        <Input
          type="time"
          value={settings.briefTimeLocal}
          onChange={(e) => upd({ briefTimeLocal: e.target.value })}
        />
      </div>
      <div>
        <Label>Daily cap · Gmail</Label>
        <Input
          type="number"
          min={1}
          max={50}
          value={settings.dailySendCapGmail}
          onChange={(e) => upd({ dailySendCapGmail: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>Daily cap · LinkedIn</Label>
        <Input
          type="number"
          min={1}
          max={30}
          value={settings.dailySendCapLinkedin}
          onChange={(e) => upd({ dailySendCapLinkedin: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>Hours between messages to the same person</Label>
        <Input
          type="number"
          min={0}
          value={settings.perPersonCooldownHours}
          onChange={(e) => upd({ perPersonCooldownHours: Number(e.target.value) })}
        />
      </div>
      <div>
        <Label>Max follow-ups per thread</Label>
        <Input
          type="number"
          min={0}
          max={2}
          value={settings.maxBumps}
          onChange={(e) => upd({ maxBumps: Math.max(0, Math.min(2, Number(e.target.value))) })}
        />
        <p className="text-[12px] text-ink-3 mt-1">
          One bump for most people; a second, graceful last word only in finance and consulting.
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
            <strong className="font-medium">LinkedIn warm-up before cold outreach.</strong>{' '}
            <span className="text-ink-2">
              A few days of viewing, reacting and one real comment, done by you via deep links. Orbit never
              automates LinkedIn.
            </span>
          </span>
        </label>
        <div className="mt-3 max-w-xs">
          <Label>Warm-up length (days)</Label>
          <Input
            type="number"
            min={2}
            max={10}
            value={settings.warmUpDays}
            onChange={(e) => upd({ warmUpDays: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="sm:col-span-2">
        <Label>Scheduling link</Label>
        <Input
          value={settings.schedulingLink ?? ''}
          onChange={(e) => upd({ schedulingLink: e.target.value || undefined })}
          placeholder="https://cal.com/you/20min"
          onBlur={() => toast.push({ text: 'Saved.' })}
        />
      </div>
    </Card>
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
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `orbit-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast.push({ text: 'Export downloaded.', tone: 'good' });
  };
  return (
    <div className="space-y-4">
      <Card>
        <div className="font-medium">What Orbit stores (in this browser only)</div>
        <ul className="text-[13px] text-ink-2 mt-2 list-disc pl-5 space-y-1">
          <li>Your profile, goals, resume text and extracted facets.</li>
          <li>
            Email threads with people (bodies with quotes stripped), calendar events, LinkedIn connections,
            meeting notes.
          </li>
          <li>
            Derived data: people, closeness scores, inferred connections, stages, facts, suggestions, drafts,
            the audit trail of what was sent.
          </li>
          <li>Optional secrets in localStorage: your Anthropic API key and Google OAuth client ID.</li>
        </ul>
        <p className="text-[13px] text-ink-2 mt-2">
          Nothing leaves your device except: calls you trigger to Google (your own account), to Anthropic
          (with your key), and the pages you open on LinkedIn.
        </p>
      </Card>
      <Card className="flex flex-wrap gap-2 items-center">
        <Button onClick={exportAll}>
          <Download size={14} /> Export everything (JSON)
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (!confirm('Delete all Orbit data from this browser? This cannot be undone.')) return;
            disconnectGoogle();
            localStorage.removeItem('orbit.prefs.v1');
            await wipeDatabase();
            await signOut();
            nav('/');
          }}
        >
          <Trash2 size={14} /> Delete all data
        </Button>
      </Card>
    </div>
  );
}
