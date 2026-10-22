/**
 * Settings, Integrations: the meeting notetaker (Fathom, Granola, Fireflies or Wispr Flow: notes from recorded
 * meetings, filed on each person; the student picks one) and Cal.com (booking links for drafts). Each connects by
 * signing in to the app, or with the student's own API key; either way the credentials stay in this browser.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { signInClients } from '../engine/appSignIn';
import {
  calStatus,
  connectCalcom,
  connectCalcomSignedIn,
  disconnectCalcom,
  refreshCalcom,
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
function useCanSignIn(app: 'calcom' | 'fathom', userId: string): boolean {
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
      line={
        status.available ? (
          <>
            Notes from your recorded meetings, filed on each person.{' '}
            <Link to="/notes/new" className="underline underline-offset-2 hover:text-ink">
              Or paste notes in Add note
            </Link>
          </>
        ) : (
          'Not part of this version of Orbit yet. Paste notes in Add note instead.'
        )
      }
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
              In Fathom: Settings, API Access, Generate API key.{' '}
              <a
                href={FATHOM_KEY_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                Open Fathom
              </a>
              . Kept in this browser only. Fathom must be recording your calls for notes to arrive.
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

const SIGN_IN_HINT: Record<Exclude<MeetingApp, 'fireflies'>, string> = {
  granola:
    "Opens Granola's sign-in. Every plan works; on the free plan Granola shares the last 30 days of notes.",
  wispr: "Opens Wispr Flow's sign-in. Needs Wispr Flow's Notetaker recording your calls.",
};

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
      line={
        status.available
          ? 'Notes from your recorded meetings, filed on each person.'
          : 'Not part of this version of Orbit yet. Paste notes in Add note instead.'
      }
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
      {meta.connect === 'sign_in' && status.available && !status.connected && !busy && (
        <p className="text-[12px] text-ink-3">{SIGN_IN_HINT[app as Exclude<MeetingApp, 'fireflies'>]}</p>
      )}
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

export function CalcomRow({ user }: { user: User }) {
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const toast = useToast();
  const status = useLiveQuery(() => calStatus(user), [user.id]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const canSignIn = useCanSignIn('calcom', user.id);
  if (!status) return null;
  const connect = async (key = '', signedIn = false) => {
    setError(undefined);
    setBusy(signedIn ? 'Waiting for Cal.com…' : 'Connecting…');
    try {
      const r = signedIn ? await connectCalcomSignedIn(user) : await connectCalcom(user, key);
      if (r.ok) {
        setAsking(false);
        toast.push({
          text: `Cal.com connected: ${r.eventTypes.length} event type${r.eventTypes.length === 1 ? '' : 's'}. Pick the one drafts offer under Limits and schedule.`,
          tone: 'good',
          ttl: 7000,
        });
      } else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const refresh = async () => {
    setError(undefined);
    setBusy('Refreshing…');
    try {
      const r = await refreshCalcom(user);
      if (!r.ok) setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <IntegrationRow
      testId="settings-calcom"
      mark={<AppMark logo="cal.com">Cal</AppMark>}
      name="Cal.com"
      status={
        status.connected ? (
          <RowStatus testId="settings-calcom-status">
            <Check size={12} /> Connected{status.username ? ` · cal.com/${status.username}` : ''} ·{' '}
            {status.eventTypes.length} event type{status.eventTypes.length === 1 ? '' : 's'}
          </RowStatus>
        ) : status.needsKey ? (
          <RowStatus tone="bad">Key no longer works</RowStatus>
        ) : undefined
      }
      line={
        status.available
          ? 'The booking link your drafts offer when you propose times'
          : 'Not part of this version of Orbit yet.'
      }
      actions={
        !status.available ? undefined : (
          <>
            {status.connected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={refresh}
                disabled={!!busy}
                data-testid="settings-calcom-refresh"
              >
                {busy ? <Spinner /> : 'Refresh'}
              </Button>
            )}
            <Switch
              checked={status.connected || asking}
              label="Cal.com"
              busy={!!busy && !status.connected}
              title={status.connected ? 'Disconnect Cal.com' : 'Connect Cal.com'}
              onChange={(on) => {
                if (status.connected) return void disconnectCalcom(user);
                if (!on) return setAsking(false);
                if (usesMockConnectors(user.id)) return void connect();
                // Cal.com's own sign-in when Orbit has it, else the key field
                if (canSignIn) return void connect('', true);
                setAsking(true);
              }}
              data-testid={status.connected ? 'settings-calcom-disconnect' : 'settings-calcom-connect'}
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
          data-testid="settings-calcom-use-key"
        >
          Use an API key instead
        </button>
      )}
      {asking && !status.connected && (
        <KeyField
          id="calcom-key"
          label="Cal.com API key"
          placeholder="cal_live_…"
          submitLabel="Connect"
          busy={busy}
          testId="settings-calcom"
          onSubmit={(k) => connect(k)}
          onCancel={() => setAsking(false)}
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
        <p className="text-[12.5px] text-bad" role="alert" data-testid="settings-calcom-error">
          {error}
        </p>
      )}
      {/* the link itself, in the same row: one of the event types above, or any other page */}
      {settings && (status.connected || !asking) && (
        <div className="max-w-xl" data-testid="settings-booking-link">
          <SchedulingLinkField
            user={user}
            compact
            value={settings.schedulingLink}
            onChange={(link) => void setSchedulingLink(user.id, link)}
          />
        </div>
      )}
    </IntegrationRow>
  );
}
