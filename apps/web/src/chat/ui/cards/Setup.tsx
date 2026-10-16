/**
 * Setup widgets inside a chat message: connect Google, connect LinkedIn (live, or the export), add a Claude key,
 * upload a resume. Each one calls the same engine functions Settings uses and reads its status live, so what the card shows
 * is always what Orbit holds now. A saved key is never shown back.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, TriangleAlert, Upload } from 'lucide-react';
import { type DragEvent, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { connectAndSyncGoogle, markGoogleNeedsReauth } from '../../../engine/integrations';
import { connectionsText, importLinkedInExport } from '../../../engine/linkedin';
import { connectLinkedInLive, LIVE_SOON, syncLinkedInLive } from '../../../engine/linkedinLive';
import { saveResume } from '../../../engine/resume';
import { testApiKey } from '../../../integrations/anthropic';
import { googleClientId } from '../../../integrations/google';
import { subscribePrefs, writePrefs } from '../../../integrations/prefs';
import { useSession } from '../../../state/session';
import { Button, cx, Input, relDate, Spinner } from '../../../ui';
import {
  type ClaudeKeySetup,
  type GoogleSetup,
  type LinkedinSetup,
  type ResumeSetup,
  readSetupStatus,
  type SetupStatus,
} from '../../setupStatus';
import type { SetupWhat } from '../../types';
import { GlassCard } from './ResultCard';

type StatusOf<W extends SetupWhat> = Extract<SetupStatus, { what: W }>;

/** The live status of one widget; `initial` (what the tool read) shows until the first read lands. */
function useSetupStatus<W extends SetupWhat>(what: W, initial?: SetupStatus): StatusOf<W> | undefined {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  // keys and the Google client id live in the browser prefs, which Dexie does not watch
  useEffect(() => subscribePrefs(() => setTick((t) => t + 1)), []);
  const live = useLiveQuery(
    () => (user ? readSetupStatus(user.id, what) : undefined),
    [user?.id, what, tick],
  ) as StatusOf<W> | undefined;
  return live ?? (initial?.what === what ? (initial as StatusOf<W>) : undefined);
}

function Shell({ what, title, children }: { what: SetupWhat; title: string; children: ReactNode }) {
  return (
    <GlassCard kind="setup" className="max-w-[560px]">
      <div data-testid={`setup-${what}`}>
        <div className="font-semibold text-[14px] mb-1">{title}</div>
        {children}
      </div>
    </GlassCard>
  );
}

function Good({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="mt-2 text-[13px] text-good flex items-start gap-1.5" role="status" data-testid={testId}>
      <Check size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="mt-2 text-[13px] text-bad flex items-start gap-1.5" role="alert" data-testid={testId}>
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

const linkClass =
  'font-medium text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink';

export function SetupCard({ what, status }: { what: SetupWhat; status?: SetupStatus }) {
  const { user } = useSession();
  if (!user) return null;
  switch (what) {
    case 'google':
      return <GoogleWidget user={user} initial={status} />;
    case 'linkedin':
      return <LinkedinWidget user={user} initial={status} />;
    case 'claude_key':
      return <ClaudeKeyWidget initial={status} />;
    case 'resume':
      return <ResumeWidget user={user} initial={status} />;
  }
}

// ---------- Google ----------

/** What Google or the engine said, in plain words. */
function googleProblem(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (/popup|closed|cancel|access_denied/i.test(raw))
    return 'The Google window was closed before sign-in finished. Press Connect Google to try again.';
  if (/client id/i.test(raw))
    return 'Orbit needs a Google client ID before it can open the sign-in. Paste one below.';
  if (/script|network|failed to fetch|load/i.test(raw))
    return 'Orbit could not reach Google. Check your connection and try again.';
  return raw.trim() ? raw.trim() : 'Google did not connect. Try again.';
}

function GoogleWidget({ user, initial }: { user: User; initial?: SetupStatus }) {
  const status = useSetupStatus('google', initial) as GoogleSetup | undefined;
  const [clientId, setClientId] = useState(googleClientId() ?? '');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [justSynced, setJustSynced] = useState(false);
  const fieldId = useId();
  if (!status)
    return (
      <Shell what="google" title="Connect Google">
        {null}
      </Shell>
    );
  const builtIn = status.builtInClient;
  const canConnect = !!clientId.trim() || status.clientIdConfigured;
  const connect = async () => {
    setError(undefined);
    setWarning(undefined);
    setJustSynced(false);
    try {
      setBusy('Waiting for Google…');
      const r = await connectAndSyncGoogle(user, {
        clientId: builtIn ? undefined : clientId,
        onProgress: (p) => setBusy(`${p.phase}${p.total > 1 ? ` ${p.done} of ${p.total}` : ''}…`),
      });
      setWarning(r.warning);
      setJustSynced(true);
    } catch (e) {
      setError(googleProblem(e));
      if (status.connected) await markGoogleNeedsReauth(user.id, String((e as Error)?.message ?? e));
    } finally {
      setBusy(undefined);
    }
  };
  const asEmail = status.email ? ` as ${status.email}` : '';
  return (
    <Shell what="google" title={status.connected ? 'Google is connected' : 'Connect Google'}>
      {status.demo ? (
        <p className="text-[13.5px] text-ink-2" data-testid="google-demo">
          This is the demo, so the mail and calendar you see are samples. Once you start with your own data,
          connect Google here and Orbit reads your real replies and booked chats.
        </p>
      ) : status.connected ? (
        <>
          <p className="text-[13.5px] text-ink-2">
            Connected{asEmail}
            {status.lastSyncedAt ? `, last sync ${relDate(status.lastSyncedAt)}` : ''}. Orbit now sees replies
            to your messages and the coffee chats you book, and moves your pipeline for you.
            {!status.signedIn &&
              ' Google asks you to sign in again after about an hour, so reconnect to sync now.'}
            {status.needsReauth && ' The last sync did not go through.'}
          </p>
          <div className="mt-3">
            <Button
              variant={status.signedIn && !status.needsReauth ? 'secondary' : 'primary'}
              size="sm"
              onClick={connect}
              disabled={!!busy}
              data-testid="google-connect"
            >
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : (
                'Reconnect and sync now'
              )}
            </Button>
          </div>
          {justSynced && !error && <Good testId="google-synced">Google synced.</Good>}
        </>
      ) : (
        <>
          <p className="text-[13.5px] text-ink-2">
            Orbit finds the people you already email and meet, notices replies, and sends the emails you
            approve. Google opens a sign-in window; Orbit reads mail and calendar only on this device.
          </p>
          {!status.clientIdConfigured && (
            <p className="mt-2 text-[13px] text-ink-2" data-testid="google-needs-client">
              Google is not set up in this copy of Orbit. To connect it you need an OAuth client ID from your
              own Google Cloud project (APIs and Services, Credentials, Web application, with this site as an
              authorised JavaScript origin). Paste it below, or{' '}
              <Link to="/settings/integrations" className={linkClass}>
                open Settings
              </Link>
              .
            </p>
          )}
          {!builtIn && (
            <div className="mt-3">
              <label htmlFor={fieldId} className="block text-[12.5px] font-medium text-ink-2 mb-1">
                Google OAuth client ID
              </label>
              <Input
                id={fieldId}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="…apps.googleusercontent.com"
                autoComplete="off"
                spellCheck={false}
                data-testid="google-client-id"
              />
            </div>
          )}
          <div className="mt-3">
            <Button
              variant="primary"
              onClick={connect}
              disabled={!!busy || !canConnect}
              data-testid="google-connect"
            >
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : (
                'Connect Google'
              )}
            </Button>
          </div>
        </>
      )}
      {error && <Problem testId="google-error">{error}</Problem>}
      {warning && (
        <p className="mt-2 text-[13px] text-warn" data-testid="google-warning">
          {warning}
        </p>
      )}
    </Shell>
  );
}

// ---------- LinkedIn ----------

interface ImportDone {
  imported: number;
  updated: number;
  skipped: number;
  recommended: number;
  /** a live sync rather than an export upload */
  live?: boolean;
}

function LinkedinWidget({ user, initial }: { user: User; initial?: SetupStatus }) {
  const status = useSetupStatus('linkedin', initial) as LinkedinSetup | undefined;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [soon, setSoon] = useState(false);
  const [done, setDone] = useState<ImportDone>();
  const [over, setOver] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const run = useCallback(
    async (file: File) => {
      setError(undefined);
      setDone(undefined);
      setBusy('Reading the file…');
      try {
        const csv = await connectionsText(file);
        const r = await importLinkedInExport(user, csv, (d, t) => setBusy(`Importing ${d} of ${t}…`));
        if (r.imported + r.updated === 0)
          setError(
            'Orbit found nobody in that file. Upload Connections.csv from the LinkedIn export, or the whole ZIP.',
          );
        else setDone(r);
      } catch (e) {
        setError(String((e as Error)?.message ?? e) || 'That file could not be imported.');
      } finally {
        setBusy(undefined);
      }
    },
    [user],
  );
  const live = status?.live;
  const connectLive = useCallback(async () => {
    setError(undefined);
    setDone(undefined);
    setSoon(false);
    setBusy('Opening LinkedIn…');
    try {
      const r = await connectLinkedInLive(user, {
        onProgress: (n) => setBusy(`Bringing in your connections… ${n} so far`),
      });
      if (r.ok)
        setDone({
          imported: r.added,
          updated: Math.max(0, r.rows - r.added),
          skipped: 0,
          recommended: 0,
          live: true,
        });
      else if (r.reason === 'unconfigured') setSoon(true);
      else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  }, [user]);
  const syncLive = useCallback(async () => {
    setError(undefined);
    setDone(undefined);
    setSoon(false);
    setBusy('Syncing your connections…');
    try {
      const r = await syncLinkedInLive(user, {
        onProgress: (n) => setBusy(`Syncing your connections… ${n} so far`),
      });
      if (r.ok)
        setDone({
          imported: r.added,
          updated: r.updated,
          skipped: 0,
          recommended: r.recommended,
          live: true,
        });
      else if (r.reason === 'unconfigured') setSoon(true);
      else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  }, [user]);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !busy) void run(f);
  };
  const people = status?.people ?? 0;
  const liveOffered = !!live?.available && !soon;
  // with live connect on offer, the export is the secondary path, one tap away
  const uploadOpen = !liveOffered || showUpload;
  const dropzone = (
    <label
      className={cx(
        'mt-3 flex flex-col items-center justify-center gap-1 rounded-[14px] border border-dashed px-4 py-5 text-center cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-accent/40',
        over ? 'border-accent bg-accent-soft' : 'border-line hover:bg-canvas-2/60',
        busy && 'opacity-60 pointer-events-none',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid="linkedin-dropzone"
    >
      <input
        type="file"
        accept=".csv,.zip,text/csv"
        className="sr-only"
        disabled={!!busy}
        data-testid="linkedin-file"
        aria-label="Connections.csv or the LinkedIn export ZIP"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void run(f);
        }}
      />
      {busy ? (
        <span className="inline-flex items-center gap-2 text-[13.5px]" role="status">
          <Spinner /> {busy}
        </span>
      ) : (
        <>
          <Upload size={18} className="text-ink-3" aria-hidden />
          <span className="text-[13.5px] font-medium">
            Drop the file here, or <span className="text-accent">choose a file</span>
          </span>
          <span className="text-[12px] text-ink-3">Connections.csv or the LinkedIn export ZIP</span>
        </>
      )}
    </label>
  );
  const exportHow = (
    <p className="text-[13.5px] text-ink-2">
      On LinkedIn: Settings &gt; Data privacy &gt; Get a copy of your data &gt; Connections. LinkedIn emails
      you a file; drop Connections.csv or the whole ZIP here. Uploading again later is safe, people already in
      Orbit are updated, not doubled.
    </p>
  );
  return (
    <Shell
      what="linkedin"
      title={
        live?.connected
          ? 'LinkedIn is connected'
          : liveOffered
            ? 'Connect your LinkedIn'
            : 'Import your LinkedIn connections'
      }
    >
      {live?.connected ? (
        <div data-testid="linkedin-live-connected">
          <p className="text-[13.5px] text-ink-2">
            Synced live{live.rows !== undefined ? `, ${live.rows} connections` : ''}
            {live.lastSyncedAt ? `, last sync ${relDate(live.lastSyncedAt)}` : ''}. Orbit syncs again by
            itself once a day when you open it.
            {live.error ? ' The last sync did not go through.' : ''}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant={live.error ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => void syncLive()}
              disabled={!!busy}
              data-testid="linkedin-live-sync"
            >
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : (
                'Sync now'
              )}
            </Button>
          </div>
        </div>
      ) : liveOffered ? (
        <div data-testid="linkedin-live">
          <p className="text-[13.5px] text-ink-2">
            Sign in to LinkedIn once and Orbit brings in everyone you are connected to, then keeps them in
            sync. Read only, and you can disconnect any time.
          </p>
          <div className="mt-3">
            <Button
              variant="primary"
              onClick={() => void connectLive()}
              disabled={!!busy}
              data-testid="linkedin-live-connect"
            >
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : (
                'Connect LinkedIn'
              )}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {soon && (
            <p className="text-[13.5px] text-ink-2 mb-2" role="status" data-testid="linkedin-live-soon">
              {LIVE_SOON}
            </p>
          )}
          {exportHow}
        </>
      )}
      {soon && live?.connected && (
        <p className="mt-2 text-[13px] text-ink-2" role="status" data-testid="linkedin-live-soon">
          {LIVE_SOON}
        </p>
      )}
      {liveOffered && (
        <div className="mt-3">
          {uploadOpen ? (
            <>
              <div className="text-[12.5px] font-medium text-ink-3">
                Or upload your LinkedIn export instead
              </div>
              {exportHow}
            </>
          ) : (
            <button
              type="button"
              className="text-[13px] font-medium text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
              onClick={() => setShowUpload(true)}
              data-testid="linkedin-show-upload"
            >
              Upload an export instead
            </button>
          )}
        </div>
      )}
      {uploadOpen && dropzone}
      {done && (
        <div data-testid="linkedin-done">
          <Good>
            {done.imported} {done.imported === 1 ? 'person' : 'people'} added, {done.updated} updated
            {done.skipped ? `, ${done.skipped} rows skipped` : ''}.
            {done.recommended > 0
              ? ` ${done.recommended} worth a coffee chat ${done.recommended === 1 ? 'is' : 'are'} on Discover.`
              : done.live
                ? ' Orbit keeps them in sync from now on.'
                : ' Add your target companies so Orbit can say who to meet first.'}
          </Good>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            <Link to="/map" className={linkClass}>
              Show the map
            </Link>
            <Link to="/people?view=list" className={linkClass}>
              See my people
            </Link>
            {done.recommended > 0 ? (
              <Link to="/discover" className={linkClass}>
                See who to meet
              </Link>
            ) : (
              <Link to="/settings/goals" className={linkClass}>
                Set your goals
              </Link>
            )}
          </div>
        </div>
      )}
      {error && <Problem testId="linkedin-error">{error}</Problem>}
      {!done && !error && !busy && status && people > 0 && !live?.connected && (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="linkedin-status">
          {people} {people === 1 ? 'person' : 'people'} in Orbit
          {status.lastImportedAt ? `, last import ${relDate(status.lastImportedAt)}` : ''}.
        </p>
      )}
    </Shell>
  );
}

// ---------- Claude key ----------

function ClaudeKeyWidget({ initial }: { initial?: SetupStatus }) {
  const status = useSetupStatus('claude_key', initial) as ClaudeKeySetup | undefined;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const fieldId = useId();
  const saved = !!status?.keySaved;
  const save = async () => {
    const value = key.trim();
    if (!value) return;
    // the key leaves the field the moment it is saved; nothing here ever shows it again
    setKey('');
    setBusy(true);
    setResult(undefined);
    try {
      writePrefs({ anthropicApiKey: value });
      const r = await testApiKey();
      setResult(
        r.ok
          ? { ok: true, text: 'Saved, and it works. Claude can now chat and write your drafts.' }
          : {
              ok: false,
              text: `Saved, but the test failed: ${r.error ?? 'Anthropic did not answer'}. Paste the key again to replace it.`,
            },
      );
    } catch (e) {
      setResult({ ok: false, text: String((e as Error)?.message ?? 'The test did not run.') });
    } finally {
      setBusy(false);
    }
  };
  const remove = () => {
    writePrefs({ anthropicApiKey: undefined });
    setResult({ ok: true, text: 'Key removed.' });
  };
  return (
    <Shell what="claude_key" title="Add your Claude key">
      <p className="text-[13.5px] text-ink-2">
        {status?.sharedAccess
          ? 'Without a key, Orbit uses its shared Claude access, which has a daily limit. Your own key lifts the limit and lets Claude write your drafts too. Anthropic bills your account for what Claude does.'
          : 'Without a key, Orbit answers from built-in commands and writes drafts on its own. Your own key lets Claude chat and write your drafts. Anthropic bills your account for what Claude does.'}{' '}
        The key stays in this browser.
      </p>
      {saved && !result && (
        <Good testId="claude-key-saved">A key is saved in this browser. Paste a new one to replace it.</Good>
      )}
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor={fieldId} className="sr-only">
          Anthropic API key
        </label>
        <Input
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-…"
          className="flex-1 min-w-[200px]"
          data-testid="claude-key-input"
        />
        <Button type="submit" variant="primary" disabled={busy || !key.trim()} data-testid="claude-key-save">
          {busy ? (
            <>
              <Spinner /> Testing…
            </>
          ) : (
            'Save and test'
          )}
        </Button>
        {saved && !busy && (
          <Button variant="ghost" onClick={remove} data-testid="claude-key-remove">
            Remove key
          </Button>
        )}
      </form>
      {result &&
        (result.ok ? (
          <Good testId="claude-key-result">{result.text}</Good>
        ) : (
          <Problem testId="claude-key-result">{result.text}</Problem>
        ))}
    </Shell>
  );
}

// ---------- Resume ----------

function ResumeWidget({ user, initial }: { user: User; initial?: SetupStatus }) {
  const status = useSetupStatus('resume', initial) as ResumeSetup | undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ filename: string; lines: number }>();
  const run = async (file: File) => {
    setError(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      const { resume, facets } = await saveResume(user, file);
      setDone({ filename: resume.filename, lines: facets.length });
    } catch (e) {
      setError(String((e as Error)?.message ?? e) || 'That resume could not be read.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell what="resume" title="Add your resume">
      <p className="text-[13.5px] text-ink-2">
        Orbit reads your resume for what you have done, to find people with a shared background and to
        describe you in first messages. PDF, Word (.docx) or plain text, up to 10 MB.
      </p>
      {status?.onFile && !done && (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="resume-status">
          On file: {status.filename}
          {status.addedAt ? `, added ${relDate(status.addedAt)}` : ''}.
        </p>
      )}
      <label className="mt-3 inline-flex rounded-full focus-within:ring-2 focus-within:ring-accent/40">
        <input
          type="file"
          accept=".pdf,.txt,.md,.docx"
          className="sr-only"
          disabled={busy}
          data-testid="resume-file"
          aria-label="Resume file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void run(f);
          }}
        />
        <span
          className={cx(
            'inline-flex items-center justify-center gap-1.5 rounded-full font-medium h-9 px-4 text-[14px] bg-accent text-white hover:bg-accent-2 cursor-pointer',
            busy && 'opacity-60 pointer-events-none',
          )}
        >
          {busy ? (
            <>
              <Spinner /> Reading your resume…
            </>
          ) : status?.onFile ? (
            'Upload a newer resume'
          ) : (
            'Choose your resume'
          )}
        </span>
      </label>
      {done && (
        <div data-testid="resume-done">
          <Good>
            Saved {done.filename} and read {done.lines} {done.lines === 1 ? 'line' : 'lines'} from it.
          </Good>
          <p className="mt-2 text-[13px]">
            <Link to="/settings/integrations" className={linkClass}>
              Check what Orbit read
            </Link>
          </p>
        </div>
      )}
      {error && <Problem testId="resume-error">{error}</Problem>}
    </Shell>
  );
}
