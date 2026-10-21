/**
 * Settings, Integrations: Fathom (notes from recorded meetings, filed on each person) and Cal.com (booking links for
 * drafts). Each is connected with the student's own API key, kept in this browser only.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { calStatus, connectCalcom, disconnectCalcom, refreshCalcom } from '../engine/calcom';
import { connectFathom, disconnectFathom, fathomStatus, syncFathom } from '../engine/fathom';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { Button, Input, relDate, Spinner, useToast } from '../ui';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';

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

export function FathomRow({ user }: { user: User }) {
  const toast = useToast();
  const status = useLiveQuery(() => fathomStatus(user), [user.id]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!status) return null;
  const done = (r: Awaited<ReturnType<typeof syncFathom>>) => {
    if (r.ok) {
      setAsking(false);
      toast.push({
        text: r.imported
          ? `Imported ${r.imported} meeting${r.imported === 1 ? '' : 's'} from Fathom onto the people in them.`
          : 'Fathom is up to date: no new meetings.',
        tone: 'good',
      });
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
      mark={<AppMark>F</AppMark>}
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
        !status.available ? undefined : status.connected ? (
          <>
            <Button size="sm" onClick={sync} disabled={!!busy} data-testid="settings-fathom-sync">
              {busy ? (
                <>
                  <Spinner /> {busy}
                </>
              ) : (
                'Sync now'
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => disconnectFathom(user)}
              disabled={!!busy}
              data-testid="settings-fathom-disconnect"
            >
              Disconnect
            </Button>
          </>
        ) : (
          !asking && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => (usesMockConnectors(user.id) ? connect() : setAsking(true))}
              disabled={!!busy}
              data-testid="settings-fathom-connect"
            >
              {busy ? <Spinner /> : 'Connect'}
            </Button>
          )
        )
      }
    >
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

export function CalcomRow({ user }: { user: User }) {
  const toast = useToast();
  const status = useLiveQuery(() => calStatus(user), [user.id]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!status) return null;
  const connect = async (key = '') => {
    setError(undefined);
    setBusy('Connecting…');
    try {
      const r = await connectCalcom(user, key);
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
      mark={<AppMark>Cal</AppMark>}
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
        status.available ? (
          <>
            Your booking links in drafts.{' '}
            {status.connected && (
              <Link to="/settings/limits" className="underline underline-offset-2 hover:text-ink">
                Choose the link
              </Link>
            )}
          </>
        ) : (
          'Not part of this version of Orbit yet.'
        )
      }
      actions={
        !status.available ? undefined : status.connected ? (
          <>
            <Button size="sm" onClick={refresh} disabled={!!busy} data-testid="settings-calcom-refresh">
              {busy ? <Spinner /> : 'Refresh'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => disconnectCalcom(user)}
              disabled={!!busy}
              data-testid="settings-calcom-disconnect"
            >
              Disconnect
            </Button>
          </>
        ) : (
          !asking && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => (usesMockConnectors(user.id) ? connect() : setAsking(true))}
              disabled={!!busy}
              data-testid="settings-calcom-connect"
            >
              {busy ? <Spinner /> : 'Connect'}
            </Button>
          )
        )
      }
    >
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
    </IntegrationRow>
  );
}
