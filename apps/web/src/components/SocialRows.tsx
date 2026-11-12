/**
 * Instagram and X in Settings, Integrations, under Network (plan 43 §3.1, §4, §5), and the setup the onboarding steps
 * and the chat's setup cards use too. Shown only when this Orbit offers the source (engine/sources.ts) and the student
 * has an Orbit account (or is the sample student).
 *
 * Each row has one switch and the four states of plan 43 §3.1, as the Texts row does: Not connected, On (what is
 * being read, step by step), Off (kept, left out of closeness and paths) and Removed ("Remove what Orbit took"
 * deletes it). Instagram says plainly what the risk is before the student signs in, asks before a different account
 * replaces the old one, and has the friends' switch, off by default. X shows what Orbit stores before the sign-in and
 * what it has spent this month; it has no friends' switch, because X data is never shared.
 */
import type { User } from '@orbit/core';
import { Check, Instagram, Twitter } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  connectInstagram,
  connectX,
  INSTAGRAM_RISK,
  instagramProgress,
  type Platform,
  refreshInstagram,
  refreshX,
  setShareFollows,
  switchSocial,
  useShareFollows,
  useSocialOffered,
  useSocialStatus,
  X_CONSENT_LINES,
  X_CONSENT_MORE,
} from '../engine/social';
import { loadSources, useSources } from '../engine/sources';
import { Button, Modal, Spinner, Switch, useToast } from '../ui';
import { AppMark, IntegrationRow, RowStatus } from './IntegrationRow';

const usd = (n: number) => `$${n < 10 && n % 1 ? n.toFixed(2) : Math.round(n)}`;

/** What Orbit reads from Instagram and what leaves the browser, for the row and the privacy list. */
export const INSTAGRAM_PRIVACY =
  "Through Unipile, signed in as you: who you follow, who follows you and your chats. For chats with people you are not reaching out to, only when and which way, never the words. Kept until you remove it; others' follow lists 30 days.";
export const X_PRIVACY =
  "With X's own sign-in: who you follow, who follows you back and 30 days of messages. Kept 30 days, never shared with friends, nothing posted.";

function useSocialState(userId: string, p: Platform) {
  const s = useSources(userId);
  return s?.states[p] ?? 'not_connected';
}

function RemoveConfirm({
  open,
  name,
  onClose,
  onRemove,
  busy,
  testId,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
  onRemove: () => void;
  busy: boolean;
  testId: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title={`Remove what Orbit took from ${name}?`} width={440}>
      <div className="space-y-3 text-[13.5px] text-ink-2" data-testid={`${testId}-confirm`}>
        <p>
          Orbit deletes the messages, the follows and the paths it found through {name}, and the {name}{' '}
          accounts it attached to your people. People only {name} knew, with nothing else in Orbit, are
          removed too. Everyone else stays. Your answers to "is this the same person" are kept so you are not
          asked again.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onRemove} loading={busy} data-testid={`${testId}-confirm-remove`}>
            Remove
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RemoveLink({
  onClick,
  disabled,
  testId,
}: {
  onClick: () => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="text-[12.5px] text-ink-3 underline underline-offset-2 hover:text-bad"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      Remove what Orbit took
    </button>
  );
}

// ---- Instagram ----------------------------------------------------------------------------------------------------

/**
 * The risk note and the Connect button: under the Settings row, as the onboarding step, and in the chat's card.
 * `replace` answers "a different account" yes.
 */
export function InstagramSetup({
  user,
  onDone,
  onCancel,
  connectLabel = 'Connect Instagram',
}: {
  user: Pick<User, 'id'>;
  onDone?: (status: string) => void;
  onCancel?: () => void;
  connectLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const r = await connectInstagram(user.id);
      if (!r.ok) setError(r.message);
      else onDone?.(r.status);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-[13px] text-ink-2" data-testid="instagram-setup">
      <p className="leading-[1.5]" data-testid="instagram-risk">
        {INSTAGRAM_RISK}
      </p>
      <p className="mt-2 leading-[1.5] text-ink-3">
        You sign in on Unipile's page with your Instagram username and password, and a code if you use
        two-step sign-in. Sign in with Facebook does not work there. Reading who you follow takes a day or
        two, 25 at a time.
      </p>
      {error && (
        <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="instagram-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={go} loading={busy} data-testid="instagram-connect">
          {busy ? 'Waiting for Instagram' : connectLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function InstagramRow({ user }: { user: User }) {
  const toast = useToast();
  const offered = useSocialOffered(user.id, 'instagram');
  const state = useSocialState(user.id, 'instagram');
  const status = useSocialStatus(user.id, 'instagram');
  const share = useShareFollows(user.id);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [params, setParams] = useSearchParams();
  const back = params.get('instagram');
  // read where it stands when the row shows, and while the first days' reading goes on
  const reading = state === 'on' && status?.status === 'active' && !!instagramProgress(status);
  useEffect(() => {
    if (!offered) return;
    void refreshInstagram(user.id);
    if (!reading) return;
    const t = setInterval(() => void refreshInstagram(user.id), 3000);
    return () => clearInterval(t);
  }, [offered, user.id, reading]);
  // back from Unipile's page (its success and failure links come to /settings?instagram=...)
  useEffect(() => {
    if (!offered || !back) return;
    toast.push(
      back === 'connected'
        ? { text: 'Instagram is connected. Orbit is reading it now.', tone: 'good' }
        : { text: 'Instagram sign-in did not finish. Try again.', tone: 'bad' },
    );
    void loadSources(user.id);
    void refreshInstagram(user.id);
    params.delete('instagram');
    setParams(params, { replace: true });
  }, [offered, back]);
  if (!offered) return null;
  const st = status?.status;
  // until the first status read lands, the switch the student set is what the row shows
  const connected = st
    ? st === 'active' || st === 'needs_reauth' || st === 'parked' || st === 'different_account'
    : state === 'on' || state === 'off';
  const on = state === 'on' && connected;
  const off = state === 'off';
  const run = async (label: string, fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) => {
    setError(undefined);
    setBusy(label);
    try {
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'That did not work. Try again.');
      else if (done) toast.push({ text: done });
    } finally {
      setBusy(undefined);
    }
  };
  const switchTo = (next: boolean) => {
    if (next && (state === 'off' || state === 'on') && connected)
      return run(
        'Turning on',
        () => switchSocial(user.id, 'instagram', 'on'),
        'Instagram is on. It counts in closeness and paths again.',
      );
    if (next) {
      setSetup(true);
      return;
    }
    return run(
      'Turning off',
      () => switchSocial(user.id, 'instagram', 'off'),
      'Instagram is off. Kept, and left out of closeness and paths.',
    );
  };
  const progress = instagramProgress(status);
  const handle = status?.username ? ` · @${status.username}` : '';
  let line: ReactNode;
  if (busy)
    line = (
      <RowStatus tone="muted" testId="settings-instagram-status">
        <Spinner /> {busy}
      </RowStatus>
    );
  else if (st === 'different_account')
    line = (
      <RowStatus tone="bad" testId="settings-instagram-status">
        A different Instagram account signed in{handle}
      </RowStatus>
    );
  else if (on && st === 'needs_reauth')
    line = (
      <RowStatus tone="bad" testId="settings-instagram-status">
        On{handle} · Instagram asked to confirm it is you. Sign in again.
      </RowStatus>
    );
  else if (on && st === 'parked')
    line = (
      <RowStatus tone="muted" testId="settings-instagram-status">
        On{handle} · Paused after three weeks away. Sign in again to read it.
      </RowStatus>
    );
  else if (on)
    line = (
      <RowStatus tone="good" testId="settings-instagram-status">
        <Check size={12} /> On{handle}
        {progress ? ` · ${progress}` : ' · up to date'}
      </RowStatus>
    );
  else if (off)
    line = (
      <RowStatus tone="muted" testId="settings-instagram-status">
        Off · kept, left out of closeness and paths
      </RowStatus>
    );
  else
    line = (
      <RowStatus tone="muted" testId="settings-instagram-status">
        {state === 'removed' ? 'Removed · nothing from Instagram is kept' : 'Not connected'}
      </RowStatus>
    );
  return (
    <>
      <IntegrationRow
        testId="settings-instagram"
        mark={
          <AppMark logo="instagram.com">
            <Instagram size={16} aria-hidden />
          </AppMark>
        }
        name="Instagram"
        status={line}
        line={<span data-testid="settings-instagram-privacy">{INSTAGRAM_PRIVACY}</span>}
        actions={
          <>
            {(st === 'needs_reauth' || st === 'parked') && state === 'on' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  run(
                    'Waiting for Instagram',
                    () => connectInstagram(user.id),
                    'Signed in to Instagram again.',
                  )
                }
                data-testid="settings-instagram-reauth"
              >
                Sign in again
              </Button>
            )}
            <Switch
              checked={on}
              label="Instagram"
              busy={!!busy}
              title={on ? 'Turn Instagram off' : 'Turn Instagram on'}
              onChange={(next) => void switchTo(next)}
              data-testid="settings-instagram-switch"
            />
          </>
        }
      >
        {st === 'different_account' && (
          <div className="text-[13px] text-ink-2" data-testid="settings-instagram-different">
            <p>This is a different Instagram account. Replace the old one?</p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Orbit removes what came from the old account, then reads the new one.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!!busy}
                onClick={() =>
                  run(
                    'Replacing',
                    () => connectInstagram(user.id, { replace: true }),
                    'Replaced. Orbit is reading the new account.',
                  )
                }
                data-testid="settings-instagram-replace"
              >
                Replace the old one
              </Button>
            </div>
          </div>
        )}
        {setup && !on && (
          <InstagramSetup
            user={user}
            onCancel={() => setSetup(false)}
            onDone={(s) => {
              setSetup(false);
              if (s !== 'different_account')
                toast.push({ text: 'Instagram is connected. Orbit is reading it now.', tone: 'good' });
            }}
          />
        )}
        {(on || off) && !setup && (
          <div className="space-y-2">
            {on && (
              <label
                className="flex items-start justify-between gap-3 text-[13px] text-ink-2"
                data-testid="settings-instagram-share"
              >
                <span className="min-w-0">
                  Let my Orbit friends find paths through who I follow on Instagram
                  <span className="block text-[12.5px] text-ink-3">
                    Only friends you accepted, and only to find a way in. Off unless you turn it on.
                  </span>
                </span>
                <Switch
                  checked={share}
                  label="Let my Orbit friends find paths through who I follow on Instagram"
                  busy={busy === 'Saving'}
                  onChange={(next) => void run('Saving', () => setShareFollows(user.id, next))}
                  data-testid="settings-instagram-share-switch"
                />
              </label>
            )}
            <RemoveLink
              onClick={() => setConfirming(true)}
              disabled={!!busy}
              testId="settings-instagram-remove"
            />
          </div>
        )}
        {error && (
          <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="settings-instagram-error">
            {error}
          </p>
        )}
      </IntegrationRow>
      <RemoveConfirm
        open={confirming}
        name="Instagram"
        busy={busy === 'Removing'}
        onClose={() => setConfirming(false)}
        onRemove={() =>
          void run(
            'Removing',
            () => switchSocial(user.id, 'instagram', 'removed'),
            'Removed what Orbit took from Instagram.',
          ).then(() => setConfirming(false))
        }
        testId="settings-instagram"
      />
    </>
  );
}

// ---- X ------------------------------------------------------------------------------------------------------------

/** What Orbit stores from X, said before the sign-in, and the one button that agrees and signs in. */
export function XConsent({
  user,
  onDone,
  onCancel,
}: {
  user: Pick<User, 'id'>;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const r = await connectX(user.id, agreed);
      if (!r.ok) setError(r.message);
      else if (!r.leaving) onDone?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-[13px] text-ink-2" data-testid="x-consent">
      <p className="font-medium text-ink">What Orbit stores from X</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4" data-testid="x-consent-lines">
        {X_CONSENT_LINES.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="mt-2 text-[12.5px] text-ink-3">{X_CONSENT_MORE}</p>
      <label className="mt-3 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-[3px]"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          data-testid="x-consent-agree"
        />
        <span>I agree that Orbit stores this from my X account.</span>
      </label>
      {error && (
        <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="x-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={go}
          disabled={!agreed}
          loading={busy}
          data-testid="x-connect"
        >
          Sign in with X
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function XRow({ user }: { user: User }) {
  const toast = useToast();
  const offered = useSocialOffered(user.id, 'x');
  const state = useSocialState(user.id, 'x');
  const status = useSocialStatus(user.id, 'x');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [params, setParams] = useSearchParams();
  const back = params.get('x');
  useEffect(() => {
    if (offered) void refreshX(user.id);
  }, [offered, user.id]);
  // back from X's consent screen: /settings?x=connected or ?x=failed
  useEffect(() => {
    if (!offered || !back) return;
    toast.push(
      back === 'connected'
        ? { text: 'X is connected.', tone: 'good' }
        : { text: 'X sign-in did not finish. Try again.', tone: 'bad' },
    );
    void loadSources(user.id);
    void refreshX(user.id);
    params.delete('x');
    setParams(params, { replace: true });
  }, [offered, back]);
  if (!offered) return null;
  const st = status?.status;
  const connected = st ? st === 'active' || st === 'needs_reauth' : state === 'on' || state === 'off';
  const on = state === 'on' && connected;
  const off = state === 'off';
  const run = async (label: string, fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) => {
    setError(undefined);
    setBusy(label);
    try {
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'That did not work. Try again.');
      else if (done) toast.push({ text: done });
    } finally {
      setBusy(undefined);
    }
  };
  const switchTo = (next: boolean) => {
    if (next && state === 'off' && connected)
      return run('Turning on', () => switchSocial(user.id, 'x', 'on'), 'X is on. It counts in paths again.');
    if (next) {
      setConsent(true);
      return;
    }
    return run(
      'Turning off',
      () => switchSocial(user.id, 'x', 'off'),
      'X is off. Kept until it expires, and left out of closeness and paths.',
    );
  };
  const spend = status ? `${usd(status.spentThisMonthUsd)} of ${usd(status.limitUsd)} this month` : '';
  let line: ReactNode;
  if (busy)
    line = (
      <RowStatus tone="muted" testId="settings-x-status">
        <Spinner /> {busy}
      </RowStatus>
    );
  else if (on && st === 'needs_reauth')
    line = (
      <RowStatus tone="bad" testId="settings-x-status">
        On{status?.username ? ` · @${status.username}` : ''} · X signed Orbit out. Sign in again.
      </RowStatus>
    );
  else if (on)
    line = (
      <RowStatus tone="good" testId="settings-x-status">
        <Check size={12} /> On{status?.username ? ` · @${status.username}` : ''} · {spend}
        {status?.orbitLimitReached ? " · Orbit's X budget is used up this month" : ''}
      </RowStatus>
    );
  else if (off)
    line = (
      <RowStatus tone="muted" testId="settings-x-status">
        Off · kept until it expires, left out of closeness and paths
      </RowStatus>
    );
  else
    line = (
      <RowStatus tone="muted" testId="settings-x-status">
        {state === 'removed' ? 'Removed · nothing from X is kept' : 'Not connected'}
      </RowStatus>
    );
  return (
    <>
      <IntegrationRow
        testId="settings-x"
        mark={
          <AppMark logo="x.com">
            <Twitter size={16} aria-hidden />
          </AppMark>
        }
        name="X"
        status={line}
        line={<span data-testid="settings-x-privacy">{X_PRIVACY}</span>}
        actions={
          <>
            {on && st === 'needs_reauth' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => setConsent(true)}
                data-testid="settings-x-reauth"
              >
                Sign in again
              </Button>
            )}
            <Switch
              checked={on}
              label="X"
              busy={!!busy}
              title={on ? 'Turn X off' : 'Turn X on'}
              onChange={(next) => void switchTo(next)}
              data-testid="settings-x-switch"
            />
          </>
        }
      >
        {consent && (!on || st === 'needs_reauth') && (
          <XConsent
            user={user}
            onCancel={() => setConsent(false)}
            onDone={() => {
              setConsent(false);
              toast.push({ text: 'X is connected.', tone: 'good' });
            }}
          />
        )}
        {(on || off) && !consent && (
          <RemoveLink onClick={() => setConfirming(true)} disabled={!!busy} testId="settings-x-remove" />
        )}
        {error && (
          <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="settings-x-error">
            {error}
          </p>
        )}
      </IntegrationRow>
      <RemoveConfirm
        open={confirming}
        name="X"
        busy={busy === 'Removing'}
        onClose={() => setConfirming(false)}
        onRemove={() =>
          void run(
            'Removing',
            () => switchSocial(user.id, 'x', 'removed'),
            'Removed what Orbit took from X.',
          ).then(() => setConfirming(false))
        }
        testId="settings-x"
      />
    </>
  );
}
