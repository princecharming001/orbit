/**
 * Settings, Integrations rows: live LinkedIn (Unipile) and warm intros (Village). Both use the same engine functions the
 * chat does (engine/linkedinLive.ts, engine/warmIntros.ts); the sample student's run on the mock connector.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  checkLinkedInAccount,
  connectLinkedInLive,
  disconnectLinkedInLive,
  LIVE_SOON,
  linkedInLiveStatus,
  liveLinkedInAccount,
  syncLinkedInLive,
} from '../engine/linkedinLive';
import { setWarmIntros, villageAvailable, villageOffered } from '../engine/warmIntros';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { subscribePrefs } from '../integrations/prefs';
import { type LinkedInLedger, linkedInLedger, unipileConfigured } from '../integrations/unipile';
import { checkVillage, subscribeVillageHealth, villageHealth, villageRefused } from '../integrations/village';
import { Button, Modal, relDate, Spinner, Switch, useToast } from '../ui';
import { EnrichmentStatusLine } from './EnrichmentStatus';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';

/**
 * How much of today's LinkedIn reads Orbit has used for this account (plan 21 §6): profiles, posts and searches each
 * have about 100 a day, and checking how well people know each other stops before Orbit risks the account.
 */
function LinkedInReadsLine({ user }: { user: User }) {
  const [ledger, setLedger] = useState<LinkedInLedger>();
  useEffect(() => {
    if (usesMockConnectors(user.id) || !unipileConfigured()) return;
    let live = true;
    void (async () => {
      const row = await liveLinkedInAccount(user.id);
      if (!row?.externalAccountId || !row.accessToken) return;
      const r = await linkedInLedger(row.externalAccountId, { token: row.accessToken });
      if (live && r.ok) setLedger(r.value);
    })();
    return () => {
      live = false;
    };
  }, [user.id]);
  if (!ledger) return null;
  const part = (label: string, u: { used: number; limit: number }) => `${label} ${u.used} of ${u.limit}`;
  return (
    <p className="text-[12.5px] text-ink-3" data-testid="settings-linkedin-reads">
      LinkedIn reads today: {part('profiles', ledger.profile)} · {part('posts', ledger.posts)} ·{' '}
      {part('searches', ledger.search)}. Orbit stops for the day before LinkedIn would mind.
    </p>
  );
}

export function LinkedInLiveCard({ user }: { user: User }) {
  const toast = useToast();
  const status = useLiveQuery(() => linkedInLiveStatus(user), [user.id]);
  const [busy, setBusy] = useState<string>();
  const [soon, setSoon] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  // the switch says what Unipile says: signed out by LinkedIn, or gone, is shown as such (the row updates itself)
  useEffect(() => {
    void checkLinkedInAccount(user).catch(() => undefined);
  }, [user.id]);
  if (!status) return null;
  const connect = async () => {
    setError(undefined);
    setBusy('Opening LinkedIn…');
    try {
      const r = await connectLinkedInLive(user, {
        onProgress: (n) => setBusy(`Reading your connections… ${n}`),
      });
      if (r.ok) toast.push({ text: `LinkedIn connected: ${r.added} new, ${r.rows} in all.`, tone: 'good' });
      else if (r.reason === 'unconfigured') setSoon(true);
      else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const sync = async () => {
    setError(undefined);
    setBusy('Syncing…');
    try {
      const r = await syncLinkedInLive(user, { onProgress: (n) => setBusy(`Syncing… ${n}`) });
      if (r.ok) toast.push({ text: `LinkedIn synced: ${r.added} new, ${r.updated} updated.`, tone: 'good' });
      else if (r.reason === 'unconfigured') setSoon(true);
      else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const disconnect = async () => {
    setConfirming(false);
    const r = await disconnectLinkedInLive(user);
    if (r.ok) toast.push({ text: 'LinkedIn disconnected. Everyone already imported stays.' });
  };
  return (
    <>
      <IntegrationRow
        testId="settings-linkedin-live"
        mark={
          <AppMark logo="linkedin.com" tone="linkedin">
            in
          </AppMark>
        }
        name="LinkedIn (live)"
        status={
          status.connected ? (
            status.signedOut ? (
              <RowStatus tone="bad" testId="settings-linkedin-live-status">
                Signed out by LinkedIn · last synced{' '}
                {status.lastSyncedAt ? relDate(status.lastSyncedAt) : 'never'}
              </RowStatus>
            ) : (
              <RowStatus tone={status.error ? 'bad' : 'good'} testId="settings-linkedin-live-status">
                <Check size={12} /> Connected
                {status.rows !== undefined ? ` · ${status.rows} connections` : ''} · last synced{' '}
                {status.lastSyncedAt ? relDate(status.lastSyncedAt) : 'never'}
                {status.error && ' · the last sync did not go through'}
              </RowStatus>
            )
          ) : busy ? (
            <RowStatus testId="settings-linkedin-live-status">
              <Spinner /> {busy}
            </RowStatus>
          ) : undefined
        }
        line={
          status.available ? (
            'Sync your connections and send the messages you approve'
          ) : (
            <span data-testid="settings-linkedin-live-unavailable">
              Not part of this version of Orbit yet. Upload your export instead.
            </span>
          )
        }
        actions={
          !status.available ? undefined : (
            <>
              {status.signedOut && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={connect}
                  disabled={!!busy}
                  data-testid="settings-linkedin-live-signin"
                >
                  {busy ? (
                    <>
                      <Spinner /> {busy}
                    </>
                  ) : (
                    'Sign in again'
                  )}
                </Button>
              )}
              {status.connected && !status.signedOut && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={sync}
                  disabled={!!busy}
                  data-testid="settings-linkedin-live-sync"
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
              {(status.connected || !soon) && (
                <Switch
                  checked={status.connected}
                  label="LinkedIn"
                  busy={!!busy && !status.connected}
                  disabled={!!busy && status.connected}
                  title={status.connected ? 'Disconnect LinkedIn' : 'Connect LinkedIn'}
                  onChange={(on) => (on ? connect() : setConfirming(true))}
                  data-testid={
                    status.connected ? 'settings-linkedin-live-disconnect' : 'settings-linkedin-live-connect'
                  }
                />
              )}
            </>
          )
        }
      >
        {status.connected && <EnrichmentStatusLine user={user} />}
        {status.connected && <LinkedInReadsLine user={user} />}
        {soon && (
          <p className="text-[12.5px] text-ink-2" role="status" data-testid="settings-linkedin-live-soon">
            {LIVE_SOON}
          </p>
        )}
        {(error ?? (status.connected ? status.error : undefined)) && (
          <p className="text-[12.5px] text-bad" role="alert" data-testid="settings-linkedin-live-error">
            {error ?? status.error}
          </p>
        )}
      </IntegrationRow>
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Disconnect LinkedIn?" width={440}>
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="settings-linkedin-live-confirm">
          <p>
            Orbit stops syncing your LinkedIn connections and Unipile unlinks the account. Everyone already in
            Orbit stays, with their notes and chats.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={disconnect}
              data-testid="settings-linkedin-live-confirm-disconnect"
            >
              Disconnect
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * Warm intros from Village: what it does, and on or off. Turned on, Orbit asks its server whether Village is set up
 * there (a key and the account email), and says "Village isn't set up" rather than "On" when it is not.
 */
export function WarmIntrosCard({ user }: { user: User }) {
  const [, setTick] = useState(0);
  // the choice lives in this browser's prefs, which Dexie does not watch; Village's health is kept in memory
  useEffect(() => subscribePrefs(() => setTick((t) => t + 1)), []);
  useEffect(() => subscribeVillageHealth(() => setTick((t) => t + 1)), []);
  const offered = villageOffered(user);
  const on = villageAvailable(user);
  const mock = usesMockConnectors(user.id);
  useEffect(() => {
    if (on && !mock) void checkVillage();
  }, [on, mock]);
  const notSetUp = on && !mock && villageHealth() === 'unconfigured';
  const refused = on && !mock && villageRefused();
  return (
    <IntegrationRow
      testId="settings-warm-intros"
      mark={<AppMark logo="village.do">V</AppMark>}
      name="Warm intros (Village)"
      status={
        <RowStatus tone={on && !notSetUp && !refused ? 'good' : 'muted'} testId="settings-warm-intros-status">
          {notSetUp ? (
            "Village isn't set up"
          ) : refused ? (
            "Village isn't accepting Orbit's key"
          ) : on ? (
            <>
              <Check size={12} /> On
            </>
          ) : (
            'Off'
          )}
        </RowStatus>
      }
      line={
        !offered
          ? 'Not part of this version of Orbit yet.'
          : mock
            ? 'On for the demo, with sample paths.'
            : notSetUp
              ? "Orbit's server has no Village key yet, so there are no intro paths from it. Your own routes still work."
              : refused
                ? 'Village refused the key on its last lookup, so Orbit stops asking it until tomorrow. Your own routes still work.'
                : 'Intro paths from Village; it sees the names you look up'
      }
      actions={
        offered ? (
          <Switch
            checked={on}
            label="Warm intros from Village"
            // the demo has sample paths and keeps them on
            disabled={usesMockConnectors(user.id)}
            title={
              usesMockConnectors(user.id)
                ? 'On for the demo'
                : on
                  ? 'Turn warm intros off'
                  : 'Turn warm intros on'
            }
            onChange={(next) => setWarmIntros(next)}
            data-testid="settings-warm-intros-toggle"
          />
        ) : undefined
      }
    />
  );
}
