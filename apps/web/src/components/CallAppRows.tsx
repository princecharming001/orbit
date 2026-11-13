/**
 * Settings, Integrations: Zoom and Google Meet beside the meeting notetakers (notes from the call itself, see
 * engine/callNotes.ts), and under Scheduling the call link Orbit puts on the invites it books.
 *
 * Zoom signs in with Zoom; Meet asks Google for one more permission. Both need an Orbit account (the sample student
 * has made-up ones). Until Orbit's Zoom app keys are stored, the Zoom row only says it is not set up yet.
 */
import type { CallApp, MeetingLinkChoice, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db } from '../db/schema';
import {
  CALL_APP_META,
  callAppStatus,
  connectCallApp,
  disconnectCallApp,
  MEET_ROW_LINE,
  pullCallNotes,
  refreshCallApp,
  ZOOM_ROW_LINE,
} from '../engine/callNotes';
import { setMeetingLink } from '../engine/settings';
import { Button, cx, relDate, Spinner, Switch, useToast } from '../ui';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';

const LINE: Record<CallApp, string> = { zoom: ZOOM_ROW_LINE, google_meet: MEET_ROW_LINE };

/** "Filed notes from 1 call." or "No new notes from Zoom." */
function pulledText(name: string, imported: number): string {
  return imported
    ? `Filed notes from ${imported} call${imported === 1 ? '' : 's'} from ${name}.`
    : `${name} is on. Notes come in after your next call on it.`;
}

/** Zoom or Google Meet: a switch, where it stands, and one line on when notes come in. */
export function CallAppRow({ user, app }: { user: User; app: CallApp }) {
  const toast = useToast();
  const meta = CALL_APP_META[app];
  const status = useLiveQuery(() => callAppStatus(user, app), [user.id, app]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [params, setParams] = useSearchParams();
  const back = app === 'zoom' ? params.get('zoom') : null;
  const testId = `settings-${app === 'zoom' ? 'zoom' : 'meet'}`;
  useEffect(() => {
    void refreshCallApp(user, app).catch(() => undefined);
  }, [user.id, app]);
  // back from Zoom's sign-in: /settings?zoom=connected or ?zoom=failed
  useEffect(() => {
    if (!back) return;
    toast.push(
      back === 'connected'
        ? { text: 'Zoom is connected.', tone: 'good' }
        : { text: 'Zoom sign-in did not finish. Try again.', tone: 'bad' },
    );
    void refreshCallApp(user, app)
      .then(() => (back === 'connected' ? pullCallNotes(user, { apps: [app], firstLook: true }) : undefined))
      .catch(() => undefined);
    params.delete('zoom');
    setParams(params, { replace: true });
  }, [back]);
  if (!status) return null;
  const run = async (label: string, work: () => Promise<void>) => {
    setError(undefined);
    setBusy(label);
    try {
      await work();
    } finally {
      setBusy(undefined);
    }
  };
  const connect = () =>
    run(status.demo || app === 'google_meet' ? 'Connecting…' : 'Waiting for Zoom…', async () => {
      const r = await connectCallApp(user, app);
      if (!r.ok) setError(r.message);
      else if (!r.leaving) toast.push({ text: pulledText(meta.name, r.imported), tone: 'good' });
    });
  const sync = () =>
    run('Checking…', async () => {
      const r = await pullCallNotes(user, { apps: [app], firstLook: true });
      if (r.needs.length) setError(`${meta.name} needs you to connect again.`);
      else
        toast.push({
          text: r.imported ? pulledText(meta.name, r.imported) : `No new notes from ${meta.name}.`,
          tone: 'good',
        });
    });
  const available = status.supported && status.configured;
  const on = status.connected || status.needsReauth || status.needsConsent;
  let state: React.ReactNode;
  if (status.connected)
    state = (
      <RowStatus testId={`${testId}-status`}>
        <Check size={12} /> Connected
        {status.email ? ` · ${status.email}` : ''} · {status.meetings} call{status.meetings === 1 ? '' : 's'}
        {status.lastSyncedAt ? ` · checked ${relDate(status.lastSyncedAt)}` : ''}
      </RowStatus>
    );
  else if (status.needsReauth)
    state = (
      <RowStatus tone="bad" testId={`${testId}-status`}>
        {app === 'zoom' ? 'Zoom signed Orbit out. Sign in again.' : 'Google signed Orbit out. Sign in again.'}
      </RowStatus>
    );
  else if (status.needsConsent)
    state = (
      <RowStatus tone="bad" testId={`${testId}-status`}>
        Google has not allowed transcripts yet
      </RowStatus>
    );
  return (
    <IntegrationRow
      testId={testId}
      mark={<AppMark logo={meta.logo}>{meta.name[0]}</AppMark>}
      name={meta.name}
      status={state}
      line={
        !status.supported ? (
          <span data-testid={`${testId}-unavailable`}>Needs an Orbit account</span>
        ) : !status.configured ? (
          <span data-testid={`${testId}-not-set-up`}>Not set up yet</span>
        ) : (
          <span data-testid={`${testId}-line`}>{LINE[app]}</span>
        )
      }
      actions={
        !available ? undefined : (
          <>
            {status.connected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={sync}
                disabled={!!busy}
                data-testid={`${testId}-sync`}
              >
                {busy ? (
                  <>
                    <Spinner /> {busy}
                  </>
                ) : (
                  'Check now'
                )}
              </Button>
            )}
            {(status.needsReauth || status.needsConsent) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={connect}
                disabled={!!busy}
                data-testid={`${testId}-reconnect`}
              >
                {status.needsConsent ? 'Allow' : 'Sign in again'}
              </Button>
            )}
            <Switch
              checked={on}
              label={meta.name}
              busy={!!busy && !on}
              title={on ? `Turn ${meta.name} off` : `Turn ${meta.name} on`}
              onChange={(next) => {
                if (!next)
                  return void run('Turning off…', async () => {
                    const r = await disconnectCallApp(user, app);
                    if (!r.ok) setError(r.message);
                  });
                void connect();
              }}
              data-testid={on ? `${testId}-disconnect` : `${testId}-connect`}
            />
          </>
        )
      }
    >
      {error && (
        <p className="text-[12.5px] text-bad" role="alert" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
    </IntegrationRow>
  );
}

export const ZoomRow = ({ user }: { user: User }) => <CallAppRow user={user} app="zoom" />;
export const MeetRow = ({ user }: { user: User }) => <CallAppRow user={user} app="google_meet" />;

const CHOICES: { value: MeetingLinkChoice; label: string }[] = [
  { value: 'meet', label: 'Google Meet' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'none', label: 'None' },
];

/** The call link on invites Orbit books: Google Meet (the default), a Zoom meeting, or none. */
export function MeetingLinkRow({ user }: { user: User }) {
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const zoom = useLiveQuery(() => callAppStatus(user, 'zoom'), [user.id]);
  if (!settings) return null;
  const value: MeetingLinkChoice = settings.meetingLink ?? 'meet';
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 py-3.5"
      data-testid="settings-meeting-link"
    >
      <div className="w-full sm:w-40 shrink-0">
        <div className="text-[13.5px] font-medium text-ink" id="meeting-link-label">
          Call link on invites
        </div>
        <div className="text-[12px] text-ink-3">Added when Orbit books a call</div>
      </div>
      <div className="min-w-0 flex-1 max-w-xl">
        <div
          className="flex flex-wrap gap-x-5 gap-y-1"
          role="radiogroup"
          aria-labelledby="meeting-link-label"
        >
          {CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={value === c.value}
              onClick={() => void setMeetingLink(user.id, c.value)}
              className={cx(
                'inline-flex items-center gap-1.5 py-1 text-[13.5px] underline-offset-4',
                value === c.value ? 'font-medium text-ink underline' : 'text-ink-3 hover:text-ink',
              )}
              data-testid={`settings-meeting-link-${c.value}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {value === 'zoom' && zoom && !zoom.connected && (
          <p className="mt-1 text-[12px] text-ink-3" data-testid="settings-meeting-link-hint">
            Zoom is not connected, so invites get a Google Meet link until it is.
          </p>
        )}
      </div>
    </div>
  );
}
