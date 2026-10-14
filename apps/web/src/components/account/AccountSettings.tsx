import type { Goal, MemoryItem } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, LogOut, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../db/schema';
import { deleteAccount, exportAccount, signOutHere } from '../../engine/accountMode';
import { activeGoals, GOAL_KIND_LABELS } from '../../engine/goals';
import { forget, listMemories, MEMORY_KIND_LABELS } from '../../engine/memory';
import {
  AUTONOMY_TEXT,
  type AutonomyLevel,
  outreachSettings,
  pauseOutreach,
  setAutonomy,
  setPostalAddress,
} from '../../engine/outreach';
import { startGoogleSignIn } from '../../integrations/orbitApi';
import { useAccount } from '../../state/account';
import { useSession } from '../../state/session';
import { Button, Card, cx, Input, Label, relDate, Select, Spinner, Textarea, useToast } from '../../ui';

function download(json: string, name: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function SignInCard() {
  return (
    <Card data-testid="settings-account-signin">
      <div className="font-medium">Orbit account</div>
      <p className="text-[13px] text-ink-2 mt-1">
        Sign in with Google so Orbit can read your email on its server, keep your network current while this
        tab is closed, research people and find new ones. You approve every message before it goes anywhere.
      </p>
      <Button
        variant="primary"
        className="mt-3"
        onClick={() => startGoogleSignIn()}
        data-testid="settings-google-signin"
      >
        Continue with Google
      </Button>
    </Card>
  );
}

/** Settings, Account: who is signed in, sign out, download everything, delete the account. */
export function AccountSection() {
  const account = useAccount();
  const { signOut } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!account.signedIn) return <SignInCard />;
  const doExport = async () => {
    setBusy('export');
    setError(undefined);
    try {
      const r = await exportAccount();
      if (!r.ok) setError(r.message);
      else {
        download(r.json, `orbit-account-${new Date().toISOString().slice(0, 10)}.json`);
        toast.push({ text: 'Export downloaded.', tone: 'good' });
      }
    } finally {
      setBusy(undefined);
    }
  };
  const doDelete = async () => {
    setBusy('delete');
    setError(undefined);
    try {
      const r = await deleteAccount();
      if (!r.ok) {
        setError(r.message);
        return;
      }
      await signOut();
      nav('/');
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="space-y-4" data-testid="settings-account">
      <Card>
        <div className="font-medium">Signed in</div>
        <p className="text-[13.5px] text-ink-2 mt-1" data-testid="settings-account-email">
          {account.user?.email}
        </p>
        <p className="text-[12.5px] text-ink-3 mt-1">
          Signing out stops syncing on this device. What is already here stays until you delete it.
        </p>
        <Button
          className="mt-3"
          onClick={async () => {
            await signOutHere();
            toast.push({ text: 'Signed out. Orbit stopped syncing on this device.' });
          }}
          data-testid="settings-sign-out"
        >
          <LogOut size={14} /> Sign out
        </Button>
      </Card>
      <Card>
        <div className="font-medium">Your data</div>
        <p className="text-[13px] text-ink-2 mt-1">
          One file with everything Orbit's server keeps for you: people, threads, notes, drafts, goals and
          memories. Keep it private.
        </p>
        <Button className="mt-3" onClick={doExport} disabled={!!busy} data-testid="settings-account-export">
          {busy === 'export' ? <Spinner /> : <Download size={14} />} Download my data
        </Button>
      </Card>
      <Card className="border-bad/30">
        <div className="font-medium text-bad">Delete my account</div>
        <p className="text-[13px] text-ink-2 mt-1">
          This removes everything Orbit keeps for you, on its server and in this browser, stops reading your
          Gmail, and unlinks LinkedIn. It cannot be undone. Type DELETE to confirm.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            aria-label="Type DELETE to confirm"
            className="w-40"
            data-testid="settings-delete-confirm"
          />
          <Button
            variant="danger"
            disabled={confirmText !== 'DELETE' || !!busy}
            onClick={doDelete}
            data-testid="settings-delete-account"
          >
            {busy === 'delete' ? <Spinner /> : <Trash2 size={14} />} Delete my account
          </Button>
        </div>
      </Card>
      {error ? (
        <p className="text-[13px] text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Settings, Outreach: the autonomy level (and per goal), a pause, and the postal address for sales email. */
export function OutreachSection() {
  const { user } = useSession();
  const account = useAccount();
  const toast = useToast();
  const settings = useLiveQuery(() => (user ? outreachSettings(user.id) : undefined), [user?.id]);
  const goals = useLiveQuery(() => (user ? activeGoals(user.id) : []), [user?.id]) ?? [];
  const [until, setUntil] = useState('');
  const [postal, setPostal] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (settings && postal === undefined) setPostal(settings.postalAddress ?? '');
    if (settings?.quietUntil) setUntil(settings.quietUntil);
  }, [settings, postal]);
  if (!user || !settings) return null;
  if (!account.signedIn) return <SignInCard />;
  const level = (settings.autonomyLevel ?? 0) as AutonomyLevel;
  const choose = async (l: AutonomyLevel, goal?: Goal) => {
    setError(undefined);
    const r = await setAutonomy(user, l, goal?.id);
    if (!r.ok) setError(r.message);
    else toast.push({ text: `${goal ? `${goal.title}: ` : ''}${AUTONOMY_TEXT[l].title}.` });
  };
  const sales = goals.some((g) => g.kind === 'sales');
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4" data-testid="settings-outreach">
      <Card>
        <div className="font-medium">How much Orbit may do</div>
        <div className="mt-3 space-y-2" role="radiogroup" aria-label="Autonomy">
          {([0, 1, 2] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={level === l}
              onClick={() => choose(l)}
              className={cx(
                'w-full text-left rounded-lg border px-3 py-2.5 transition-colors',
                level === l ? 'border-ink bg-canvas-2' : 'border-line hover:bg-canvas-2/60',
              )}
              data-testid={`autonomy-${l}`}
            >
              <div className="text-[14px] font-medium">{AUTONOMY_TEXT[l].title}</div>
              <div className="text-[12.5px] text-ink-3">{AUTONOMY_TEXT[l].body}</div>
            </button>
          ))}
        </div>
        {goals.length ? (
          <div className="mt-4 space-y-2">
            <div className="text-[12.5px] text-ink-3">For one goal</div>
            {goals.map((g) => (
              <label key={g.id} className="flex flex-wrap items-center justify-between gap-2 text-[13.5px]">
                <span>
                  {g.title} <span className="text-ink-3">· {GOAL_KIND_LABELS[g.kind]}</span>
                </span>
                <Select
                  value={g.autonomyLevel === undefined ? '' : String(g.autonomyLevel)}
                  onChange={(e) =>
                    e.target.value !== '' && choose(Number(e.target.value) as AutonomyLevel, g)
                  }
                  className="h-8 text-[13px]"
                  aria-label={`How much Orbit may do for ${g.title}`}
                >
                  <option value="">Same as above</option>
                  {([0, 1, 2] as const).map((l) => (
                    <option key={l} value={String(l)}>
                      {AUTONOMY_TEXT[l].title}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
        ) : null}
      </Card>
      <Card>
        <div className="font-medium">Pause outreach</div>
        <p className="text-[13px] text-ink-2 mt-1">
          {settings.quietUntil && settings.quietUntil >= today
            ? `Paused until ${settings.quietUntil}. Nothing is drafted or sent until then.`
            : 'Going on vacation or exams? Nothing is drafted or sent until the date you pick.'}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={until}
            min={today}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="Pause until"
            className="w-44"
            data-testid="settings-pause-until"
          />
          <Button
            disabled={!until}
            onClick={async () => {
              const r = await pauseOutreach(user, until);
              if (!r.ok) setError(r.message);
              else toast.push({ text: `Outreach paused until ${until}.` });
            }}
            data-testid="settings-pause"
          >
            Pause
          </Button>
          {settings.quietUntil ? (
            <Button
              variant="ghost"
              onClick={async () => {
                const r = await pauseOutreach(user, null);
                if (!r.ok) setError(r.message);
                else {
                  setUntil('');
                  toast.push({ text: 'Outreach is back on.' });
                }
              }}
            >
              Resume now
            </Button>
          ) : null}
        </div>
      </Card>
      <Card>
        <Label htmlFor="settings-postal" hint={sales ? 'Required for sales email' : 'For sales email'}>
          Postal address
        </Label>
        <p className="text-[12.5px] text-ink-3 mb-2">
          The law asks commercial email to carry the sender's postal address. Orbit adds it to sales messages
          and will not send a sales email without it.
        </p>
        <Textarea
          id="settings-postal"
          rows={2}
          value={postal ?? ''}
          onChange={(e) => setPostal(e.target.value)}
          onBlur={() => setPostalAddress(user.id, postal ?? '')}
          placeholder="123 College Ave, Ithaca, NY 14850"
          data-testid="settings-postal"
        />
      </Card>
      {error ? (
        <p className="text-[13px] text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Settings, Memory: what Orbit remembers from your chats, each with a delete. */
export function MemorySection() {
  const { user } = useSession();
  const account = useAccount();
  const toast = useToast();
  const [items, setItems] = useState<MemoryItem[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!user) return;
    const r = await listMemories(user);
    if (r.ok) setItems(r.memories);
    else setError(r.message);
  }, [user]);
  useEffect(() => {
    if (account.signedIn) void load();
  }, [load, account.signedIn]);
  const people = useLiveQuery(async () => {
    const ids = [...new Set((items ?? []).map((m) => m.personId).filter((x): x is string => !!x))];
    const rows = ids.length ? await db.people.bulkGet(ids) : [];
    return new Map(rows.filter((p) => !!p).map((p) => [p!.id, p!.displayName]));
  }, [items]);
  if (!user) return null;
  if (!account.signedIn) return <SignInCard />;
  return (
    <Card data-testid="settings-memory">
      <div className="font-medium">What Orbit remembers</div>
      <p className="text-[13px] text-ink-2 mt-1">
        Things you told Orbit that it keeps for later chats, like how you like to meet. Delete anything you'd
        rather it forgot.
      </p>
      {error ? (
        <p className="mt-3 text-[13px] text-bad" role="alert">
          {error}
        </p>
      ) : !items ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : !items.length ? (
        <p className="mt-3 text-[13px] text-ink-3" data-testid="memory-empty">
          Nothing yet. Tell the chat something like "I prefer morning calls" and it shows up here.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {items.map((m) => (
            <li key={m.id} className="py-2.5 flex items-start gap-3" data-testid="memory-item">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] text-ink">{m.text}</div>
                <div className="text-[12px] text-ink-3">
                  {MEMORY_KIND_LABELS[m.kind] ?? 'Note'}
                  {m.personId && people?.get(m.personId) ? ` · ${people.get(m.personId)}` : ''} ·{' '}
                  {relDate(m.lastSeenAt ?? m.createdAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete: ${m.text}`}
                onClick={async () => {
                  const r = await forget(user, m.id);
                  if (!r.ok) {
                    toast.push({ text: r.message });
                    return;
                  }
                  setItems((xs) => xs?.filter((x) => x.id !== m.id));
                  toast.push({ text: 'Deleted from memory.' });
                }}
                data-testid="memory-delete"
              >
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
