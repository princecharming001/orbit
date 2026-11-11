/**
 * Settings, Integrations: the meeting notetaker (Fathom, Granola, Fireflies or Wispr Flow: notes from recorded
 * meetings, filed on each person; the student picks one) and Cal.com or Calendly (booking links for drafts). Each
 * connects by signing in to the app, with the student's own API key, or for the booking apps with the link alone;
 * credentials stay in this browser.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { db } from '../db/schema';
import { signInClients } from '../engine/appSignIn';
import {
  type CalResult,
  connectCalcom,
  connectSchedSignedIn,
  connectSchedulingLink,
  disconnectScheduling,
  refreshScheduling,
  SCHED_NAME,
  type SchedApp,
  schedStatus,
} from '../engine/calcom';
import {
  connectFathom,
  connectFathomSignedIn,
  disconnectFathom,
  fathomStatus,
  syncFathom,
} from '../engine/fathom';
import {
  connectMeetingApp,
  disconnectMeetingApp,
  FIREFLIES_KEY_URL,
  MEETING_APP_META,
  type MeetingApp,
  meetingAppStatus,
  syncMeetingApp,
} from '../engine/meetingApps';
import { setSchedulingLink } from '../engine/settings';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { Button, Input, relDate, Spinner, Switch, useToast } from '../ui';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';
import { SchedulingLinkField } from './SchedulingLinkField';

/** This copy of Orbit can sign in to the app (its OAuth client is set), so Connect opens the app's own sign-in. */
function useCanSignIn(app: 'calcom' | 'fathom' | 'calendly', userId: string): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (usesMockConnectors(userId)) return;
    let live = true;
    void signInClients().then((c) => live && setCan(!!c[app]));
    return () => {
      live = false;
    };
  }, [app, userId]);
  return can;
}

export const FATHOM_KEY_URL = 'https://fathom.video/customize#api-access-header';
export const CALCOM_KEY_URL = 'https://app.cal.com/settings/developer/api-keys';

/** A key field that opens under a row when the student presses Connect. */
function KeyField({
  id,
  label,
  placeholder,
  hint,
  busy,
  onSubmit,
  onCancel,
  submitLabel,
  testId,
}: {
  id: string;
  label: string;
  placeholder: string;
  hint: React.ReactNode;
  busy?: string;
  onSubmit: (key: string) => void;
  onCancel: () => void;
  submitLabel: string;
  testId: string;
}) {
  const [key, setKey] = useState('');
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) onSubmit(key.trim());
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 max-w-sm"
          data-testid={`${testId}-key`}
        />
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!key.trim() || !!busy}
          data-testid={`${testId}-save`}
        >
          {busy ? (
            <>
              <Spinner /> {busy}
            </>
          ) : (
            submitLabel
          )}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={!!busy}>
          Cancel
        </Button>
      </div>
      <p className="text-[12px] text-ink-3">{hint}</p>
    </form>
  );
}

/** "Granola is on now, so Fathom is off. Imported 3 meetings onto the people in them." */
function importedText(name: string, r: { imported: number; switchedOff?: string[] }): string {
  const off = r.switchedOff?.length
    ? `${name} is on now, so ${r.switchedOff.join(' and ')} ${r.switchedOff.length === 1 ? 'is' : 'are'} off. `
    : '';
  return (
    off +
    (r.imported
      ? `Imported ${r.imported} meeting${r.imported === 1 ? '' : 's'} from ${name} onto the people in them.`
      : `${name} is up to date: no new meetings.`)
  );
}

export function FathomRow({ user }: { user: User }) {
  const toast = useToast();
  const status = useLiveQuery(() => fathomStatus(user), [user.id]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const canSignIn = useCanSignIn('fathom', user.id);
  if (!status) return null;
  const done = (r: Awaited<ReturnType<typeof connectFathom>>) => {
    if (r.ok) {
      setAsking(false);
      toast.push({ text: importedText('Fathom', r), tone: 'good' });
    } else setError(r.message);
  };
  const connect = async (key = '') => {
    setError(undefined);
    setBusy('Importing…');
    try {
      done(await connectFathom(user, key));
    } finally {
      setBusy(undefined);
    }
  };
  const signIn = async () => {
    setError(undefined);
    setBusy('Waiting for Fathom…');
    try {
      done(await connectFathomSignedIn(user));
    } finally {
      setBusy(undefined);
    }
  };
  const sync = async () => {
    setError(undefined);
    setBusy('Syncing…');
    try {
      done(await syncFathom(user));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <IntegrationRow
      testId="settings-fathom"
      mark={
        <AppMark logo="fathom.ai" dark>
          F
        </AppMark>
      }
      name="Fathom"
      status={
        status.connected ? (
          <RowStatus testId="settings-fathom-status">
            <Check size={12} /> Connected · {status.meetings} meeting{status.meetings === 1 ? '' : 's'}
            {status.lastSyncedAt ? ` · synced ${relDate(status.lastSyncedAt)}` : ''}
          </RowStatus>
        ) : status.needsKey ? (
          <RowStatus tone="bad">Key no longer works</RowStatus>
        ) : undefined
      }
      line={status.available ? undefined : 'Not available yet'}
      actions={
        !status.available ? undefined : (
          <>
            {status.connected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={sync}
                disabled={!!busy}
                data-testid="settings-fathom-sync"
              >
                {busy ? (
                  <>
                    <Spinner /> {busy}
                  </>
                ) : (
                  'Sync now'
                )}
              </Button>
            )}
            {/* on asks for the key in place (the demo connects straight away); off disconnects */}
            <Switch
              checked={status.connected || asking}
              label="Fathom"
              busy={!!busy && !status.connected}
              title={status.connected ? 'Disconnect Fathom' : 'Connect Fathom'}
              onChange={(on) => {
                if (status.connected) return void disconnectFathom(user);
                if (!on) return setAsking(false);
                if (usesMockConnectors(user.id)) return void connect();
                // Fathom's own sign-in when Orbit has it, else the key field
                if (canSignIn) return void signIn();
                setAsking(true);
              }}
              data-testid={status.connected ? 'settings-fathom-disconnect' : 'settings-fathom-connect'}
            />
          </>
        )
      }
    >
      {canSignIn && !status.connected && !asking && (
        <button
          type="button"
          className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
          onClick={() => setAsking(true)}
          data-testid="settings-fathom-use-key"
        >
          Use an API key instead
        </button>
      )}
      {asking && !status.connected && (
        <KeyField
          id="fathom-key"
          label="Fathom API key"
          placeholder="Fathom API key"
          submitLabel="Connect and import"
          busy={busy}
          testId="settings-fathom"
          onSubmit={(k) => connect(k)}
          onCancel={() => setAsking(false)}
          hint={
            <>
              In Fathom: Settings, API Access.{' '}
              <a
                href={FATHOM_KEY_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Open Fathom
              </a>
            </>
          }
        />
      )}
      {error && (
        <p className="text-[12.5px] text-bad" role="alert" data-testid="settings-fathom-error">
          {error}
        </p>
      )}
      {status.connected && status.error && !error && (
        <p className="text-[12.5px] text-bad">The last sync did not go through: {status.error}</p>
      )}
    </IntegrationRow>
  );
}

/** Granola, Fireflies or Wispr Flow: a meeting notetaker that is not Fathom. */
export function MeetingAppRow({ user, app }: { user: User; app: MeetingApp }) {
  const toast = useToast();
  const meta = MEETING_APP_META[app];
  const status = useLiveQuery(() => meetingAppStatus(user, app), [user.id, app]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!status) return null;
  const testId = `settings-${app}`;
  const run = async (label: string, work: () => ReturnType<typeof syncMeetingApp>) => {
    setError(undefined);
    setBusy(label);
    try {
      const r = await work();
      if (r.ok) {
        setAsking(false);
        toast.push({ text: importedText(meta.name, r), tone: 'good' });
      } else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const connect = (key = '') =>
    run(
      meta.connect === 'sign_in' && !usesMockConnectors(user.id) ? `Waiting for ${meta.name}…` : 'Importing…',
      () => connectMeetingApp(user, app, key),
    );
  return (
    <IntegrationRow
      testId={testId}
      mark={<AppMark logo={meta.logo}>{meta.name[0]}</AppMark>}
      name={meta.name}
      status={
        status.connected ? (
          <RowStatus testId={`${testId}-status`}>
            <Check size={12} /> Connected · {status.meetings} meeting{status.meetings === 1 ? '' : 's'}
            {status.lastSyncedAt ? ` · synced ${relDate(status.lastSyncedAt)}` : ''}
          </RowStatus>
        ) : status.needsKey ? (
          <RowStatus tone="bad">{meta.connect === 'key' ? 'Key no longer works' : 'Sign in again'}</RowStatus>
        ) : undefined
      }
      line={status.available ? undefined : 'Not available yet'}
      actions={
        !status.available ? undefined : (
          <>
            {status.connected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => run('Syncing…', () => syncMeetingApp(user, app))}
                disabled={!!busy}
                data-testid={`${testId}-sync`}
              >
                {busy ? (
                  <>
                    <Spinner /> {busy}
                  </>
                ) : (
                  'Sync now'
                )}
              </Button>
            )}
            {/* on: the app's sign-in, or the key field (the demo connects straight away); off disconnects */}
            <Switch
              checked={status.connected || asking}
              label={meta.name}
              busy={!!busy && !status.connected}
              title={status.connected ? `Disconnect ${meta.name}` : `Connect ${meta.name}`}
              onChange={(on) => {
                if (status.connected) return void disconnectMeetingApp(user, app);
                if (!on) return setAsking(false);
                if (usesMockConnectors(user.id) || meta.connect === 'sign_in') return void connect();
                setAsking(true);
              }}
              data-testid={status.connected ? `${testId}-disconnect` : `${testId}-connect`}
            />
          </>
        )
      }
    >
      {asking && !status.connected && (
        <KeyField
          id={`${app}-key`}
          label={`${meta.name} API key`}
          placeholder={`${meta.name} API key`}
          submitLabel="Connect and import"
          busy={busy}
          testId={testId}
          onSubmit={(k) => connect(k)}
          onCancel={() => setAsking(false)}
          hint={
            <>
              In Fireflies: Settings, Developer settings, API key.{' '}
              <a
                href={FIREFLIES_KEY_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Open Fireflies
              </a>
              . Kept in this browser only. Fireflies must be joining your calls for notes to arrive.
            </>
          }
        />
      )}
      {error && (
        <p className="text-[12.5px] text-bad" role="alert" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
      {status.connected && status.error && !error && (
        <p className="text-[12.5px] text-bad">The last sync did not go through: {status.error}</p>
      )}
    </IntegrationRow>
  );
}

const SCHED_LINK: Record<SchedApp, { host: string; logo: string; initials: string }> = {
  calcom: { host: 'cal.com', logo: 'cal.com', initials: 'Cal' },
  calendly: { host: 'calendly.com', logo: 'calendly.com', initials: 'Cy' },
};

/** "cal.com/" then the username, typed in one line: the quickest way to connect, no key and no sign-in. */
function BookingPageField({
  app,
  busy,
  onSubmit,
  onCancel,
  extra,
}: {
  app: SchedApp;
  busy?: string;
  onSubmit: (page: string) => void;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  const [page, setPage] = useState('');
  const { host } = SCHED_LINK[app];
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (page.trim()) onSubmit(page.trim());
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 max-w-sm flex-1 items-baseline border-b border-line focus-within:border-ink">
          <span className="text-[13.5px] text-ink-3">{host}/</span>
          <input
            id={`${app}-page`}
            // biome-ignore lint/a11y/noAutofocus: the field opens because the student just asked to connect
            autoFocus
            value={page}
            onChange={(e) => setPage(e.target.value)}
            placeholder="your-name"
            aria-label={`Your ${SCHED_NAME[app]} link or username`}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[13.5px] text-ink outline-none placeholder:text-ink-4"
            data-testid={`settings-${app}-page`}
          />
        </label>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!page.trim() || !!busy}
          data-testid={`settings-${app}-page-save`}
        >
          {busy ? (
            <>
              <Spinner /> {busy}
            </>
          ) : (
            'Connect'
          )}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={!!busy}>
          Cancel
        </Button>
      </div>
      <p className="text-[12px] text-ink-3">
        Paste your booking link or type your username. Orbit reads the event types on your public page; no key
        needed.{extra ? <> {extra}</> : null}
      </p>
    </form>
  );
}

/**
 * Cal.com or Calendly: connect with the booking link alone (the public event types, no key), by signing in to the
 * app when Orbit's client for it is set, or, for Cal.com, with an API key. The event types fill the "Link in
 * drafts" picker below the rows.
 */
export function SchedulingRow({ user, app }: { user: User; app: SchedApp }) {
  const toast = useToast();
  const status = useLiveQuery(() => schedStatus(user, app), [user.id, app]);
  const [asking, setAsking] = useState<'page' | 'key'>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const canSignIn = useCanSignIn(app, user.id);
  if (!status) return null;
  const name = SCHED_NAME[app];
  const { host, logo, initials } = SCHED_LINK[app];
  const done = (r: CalResult) => {
    if (r.ok) {
      setAsking(undefined);
      const n = r.eventTypes.length;
      toast.push({
        text: n
          ? `${name} connected: ${n} event type${n === 1 ? '' : 's'}. Pick the one drafts offer just below.`
          : `${name} connected. Drafts offer your booking page.`,
        tone: 'good',
        ttl: 7000,
      });
    } else setError(r.message);
  };
  const run = async (label: string, go: () => Promise<CalResult>) => {
    setError(undefined);
    setBusy(label);
    try {
      done(await go());
    } finally {
      setBusy(undefined);
    }
  };
  const refresh = async () => {
    setError(undefined);
    setBusy('Refreshing…');
    try {
      const r = await refreshScheduling(user, app);
      if (!r.ok) setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const n = status.eventTypes.length;
  return (
    <IntegrationRow
      testId={`settings-${app}`}
      mark={<AppMark logo={logo}>{initials}</AppMark>}
      name={name}
      status={
        status.connected ? (
          <RowStatus testId={`settings-${app}-status`}>
            <Check size={12} /> Connected{status.username ? ` · ${host}/${status.username}` : ''}
            {n ? ` · ${n} event type${n === 1 ? '' : 's'}` : ''}
          </RowStatus>
        ) : status.needsKey ? (
          <RowStatus tone="bad">Needs you to connect again</RowStatus>
        ) : undefined
      }
      line={status.available ? undefined : 'Not available yet'}
      actions={
        !status.available ? undefined : (
          <>
            {status.connected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={refresh}
                disabled={!!busy}
                data-testid={`settings-${app}-refresh`}
              >
                {busy ? <Spinner /> : 'Refresh'}
              </Button>
            )}
            <Switch
              checked={status.connected || !!asking}
              label={name}
              busy={!!busy && !status.connected}
              title={status.connected ? `Disconnect ${name}` : `Connect ${name}`}
              onChange={(on) => {
                if (status.connected) return void disconnectScheduling(user, app);
                if (!on) return setAsking(undefined);
                if (usesMockConnectors(user.id))
                  return void run('Connecting…', () => connectSchedulingLink(user, app, ''));
                // the app's own sign-in when Orbit has it, else the booking link
                if (canSignIn) return void run(`Waiting for ${name}…`, () => connectSchedSignedIn(user, app));
                setAsking('page');
              }}
              data-testid={status.connected ? `settings-${app}-disconnect` : `settings-${app}-connect`}
            />
          </>
        )
      }
    >
      {canSignIn && !status.connected && !asking && (
        <button
          type="button"
          className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
          onClick={() => setAsking('page')}
          data-testid={`settings-${app}-use-link`}
        >
          Use your booking link instead
        </button>
      )}
      {asking === 'page' && !status.connected && (
        <BookingPageField
          app={app}
          busy={busy}
          onSubmit={(page) => void run('Reading…', () => connectSchedulingLink(user, app, page))}
          onCancel={() => setAsking(undefined)}
          extra={
            app === 'calcom' ? (
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink"
                onClick={() => setAsking('key')}
                data-testid="settings-calcom-use-key"
              >
                Hidden event types too? Use an API key.
              </button>
            ) : undefined
          }
        />
      )}
      {asking === 'key' && app === 'calcom' && !status.connected && (
        <KeyField
          id="calcom-key"
          label="Cal.com API key"
          placeholder="cal_live_…"
          submitLabel="Connect"
          busy={busy}
          testId="settings-calcom"
          onSubmit={(k) => void run('Connecting…', () => connectCalcom(user, k))}
          onCancel={() => setAsking('page')}
          hint={
            <>
              In Cal.com: Settings, Developer, API keys, New.{' '}
              <a
                href={CALCOM_KEY_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Open Cal.com
              </a>
              . Kept in this browser only.
            </>
          }
        />
      )}
      {error && (
        <p className="text-[12.5px] text-bad" role="alert" data-testid={`settings-${app}-error`}>
          {error}
        </p>
      )}
    </IntegrationRow>
  );
}

export const CalcomRow = ({ user }: { user: User }) => <SchedulingRow user={user} app="calcom" />;
export const CalendlyRow = ({ user }: { user: User }) => <SchedulingRow user={user} app="calendly" />;

/** The one link drafts add when proposing times: picked from the connected apps' event types, or typed in. */
export function BookingLinkRow({ user }: { user: User }) {
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  if (!settings) return null;
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 py-3.5"
      data-testid="settings-booking-link"
    >
      <div className="w-full sm:w-40 shrink-0">
        <div className="text-[13.5px] font-medium text-ink">Link in drafts</div>
        <div className="text-[12px] text-ink-3">Added when you propose times</div>
      </div>
      <div className="min-w-0 flex-1 max-w-xl">
        <SchedulingLinkField
          user={user}
          compact
          value={settings.schedulingLink}
          onChange={(link) => void setSchedulingLink(user.id, link)}
        />
      </div>
    </div>
  );
}
