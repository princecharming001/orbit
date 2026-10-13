/**
 * Settings, Integrations: live LinkedIn (Unipile) and warm intros (Village). Both use the same engine functions the
 * chat does (engine/linkedinLive.ts, engine/warmIntros.ts); the sample student's run on the mock connector.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  connectLinkedInLive,
  disconnectLinkedInLive,
  LIVE_SOON,
  linkedInLiveStatus,
  syncLinkedInLive,
} from '../engine/linkedinLive';
import { setWarmIntros, villageAvailable, villageOffered } from '../engine/warmIntros';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { subscribePrefs } from '../integrations/prefs';
import { Button, Card, Modal, relDate, Spinner, useToast } from '../ui';

export function LinkedInLiveCard({ user }: { user: User }) {
  const toast = useToast();
  const status = useLiveQuery(() => linkedInLiveStatus(user), [user.id]);
  const [busy, setBusy] = useState<string>();
  const [soon, setSoon] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  if (!status) return null;
  const connect = async () => {
    setError(undefined);
    setBusy('Opening LinkedIn…');
    try {
      const r = await connectLinkedInLive(user, {
        onProgress: (n) => setBusy(`Bringing in your connections… ${n}`),
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
    <Card>
      <div data-testid="settings-linkedin-live">
        <div className="font-medium">LinkedIn (live)</div>
        {!status.available ? (
          <p className="text-[13px] text-ink-2 mt-0.5" data-testid="settings-linkedin-live-unavailable">
            Not part of this version of Orbit yet. Upload your LinkedIn export below instead.
          </p>
        ) : (
          <p className="text-[13px] text-ink-2 mt-0.5">
            Sign in to LinkedIn once and Orbit keeps your connections in sync, so there is no export to upload
            again. Read only, through Unipile. Orbit syncs once a day when you open it, and you can disconnect
            any time.
          </p>
        )}
        {status.connected && (
          <p
            className="text-[12px] mt-1 inline-flex flex-wrap items-center gap-1 text-good"
            data-testid="settings-linkedin-live-status"
          >
            <Check size={13} /> Connected
            {status.rows !== undefined ? ` · ${status.rows} connections` : ''} · last synced{' '}
            {status.lastSyncedAt ? relDate(status.lastSyncedAt) : 'never'}
            {status.error && <span className="text-bad"> · the last sync did not go through</span>}
          </p>
        )}
        {soon && (
          <p className="text-[13px] text-ink-2 mt-2" role="status" data-testid="settings-linkedin-live-soon">
            {LIVE_SOON}
          </p>
        )}
        {error && (
          <p className="text-[13px] text-bad mt-2" role="alert" data-testid="settings-linkedin-live-error">
            {error}
          </p>
        )}
        {status.available && (
          <div className="mt-3 flex gap-2 flex-wrap">
            {status.connected ? (
              <>
                <Button onClick={sync} disabled={!!busy} data-testid="settings-linkedin-live-sync">
                  {busy ? (
                    <>
                      <Spinner /> {busy}
                    </>
                  ) : (
                    'Sync now'
                  )}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirming(true)}
                  disabled={!!busy}
                  data-testid="settings-linkedin-live-disconnect"
                >
                  Disconnect
                </Button>
              </>
            ) : (
              !soon && (
                <Button
                  variant="primary"
                  onClick={connect}
                  disabled={!!busy}
                  data-testid="settings-linkedin-live-connect"
                >
                  {busy ? (
                    <>
                      <Spinner /> {busy}
                    </>
                  ) : (
                    'Connect LinkedIn'
                  )}
                </Button>
              )
            )}
          </div>
        )}
      </div>
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
    </Card>
  );
}

/** Warm intros from Village: what it does, and on or off. */
export function WarmIntrosCard({ user }: { user: User }) {
  const [, setTick] = useState(0);
  // the choice lives in this browser's prefs, which Dexie does not watch
  useEffect(() => subscribePrefs(() => setTick((t) => t + 1)), []);
  const offered = villageOffered(user);
  const on = villageAvailable(user);
  return (
    <Card>
      <div data-testid="settings-warm-intros">
        <div className="flex items-center gap-2">
          <div className="font-medium">Warm intros (Village)</div>
          <span
            className={on ? 'text-[12px] text-good inline-flex items-center gap-1' : 'text-[12px] text-ink-3'}
            data-testid="settings-warm-intros-status"
          >
            {on ? (
              <>
                <Check size={13} /> On
              </>
            ) : (
              'Off'
            )}
          </span>
        </div>
        <p className="text-[13px] text-ink-2 mt-0.5">
          When you look for a way to reach someone or a company, Village adds real warm intro paths: who could
          introduce you, how warm the path is, and each step. Orbit's own routes from your network always show
          too. Looking someone up sends their name and company to Village.
        </p>
        {!offered ? (
          <p className="text-[12.5px] text-ink-3 mt-2">Not part of this version of Orbit yet.</p>
        ) : usesMockConnectors(user.id) ? (
          <p className="text-[12.5px] text-ink-3 mt-2">
            On for the demo, with sample paths from its network.
          </p>
        ) : (
          <div className="mt-3">
            <Button
              variant={on ? 'ghost' : 'primary'}
              onClick={() => setWarmIntros(!on)}
              data-testid="settings-warm-intros-toggle"
            >
              {on ? 'Turn off warm intros' : 'Turn on warm intros'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
