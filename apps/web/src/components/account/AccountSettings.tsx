import type { Goal, MemoryItem } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Brain, Download, LogOut, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db } from '../../db/schema';
import { deleteAccount, exportAccount, signOutHere } from '../../engine/accountMode';
import { activeGoals, GOAL_KIND_LABELS } from '../../engine/goals';
import { forget, listMemories, MEMORY_KIND_LABELS, memoryOnServer } from '../../engine/memory';
import { localMemories, toMemoryItem } from '../../engine/memoryLocal';
import {
  AUTONOMY_TEXT,
  type AutonomyLevel,
  outreachSettings,
  pauseOutreach,
  setAutonomy,
  setPostalAddress,
} from '../../engine/outreach';
import {
  acceptResumeProposal,
  describeResumeProfile,
  dismissResumeProposal,
  resumeProposal,
} from '../../engine/resume';
import { useAccount } from '../../state/account';
import { useSession } from '../../state/session';
import {
  Button,
  cx,
  Input,
  relDate,
  Select,
  Spinner,
  Textarea,
  useToast,
  useWorking,
  Working,
} from '../../ui';
import { SettingsCard, SettingsHeader, SettingsRow, SettingsStack } from '../settings/kit';

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

/**
 * An account kept in this browser (never signed in to an Orbit account): Google may well be connected here already,
 * so nothing asks for it again. An Orbit account is a separate, server-side account, and signing in to it from here
 * would hide everything kept in this browser, so these sections say plainly what runs where instead.
 */
function BrowserAccount() {
  const { user } = useSession();
  return (
    <>
      <SettingsHeader title="Account" description="Who you are signed in as." />
      <SettingsCard data-testid="settings-browser-account">
        <SettingsRow
          label={<AccountIdentity email={user?.email} />}
          description={
            <>
              Kept in this browser. Download or delete it under{' '}
              <Link to="/settings/privacy" className="underline underline-offset-2 hover:text-ink">
                Data &amp; privacy
              </Link>
              .
            </>
          }
        />
      </SettingsCard>
    </>
  );
}

/** The signed-in address with a round initial, the way the account row starts. */
function AccountIdentity({ email }: { email?: string }) {
  return (
    <span className="flex items-center gap-3">
      <span
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent uppercase"
        aria-hidden
      >
        {(email ?? '?')[0]}
      </span>
      <span className="min-w-0 truncate font-medium" data-testid="settings-account-email">
        {email}
      </span>
    </span>
  );
}

/** The postal address commercial email carries (kept in this browser, so it works with any account). */
function PostalAddressCard({ userId, sales, initial }: { userId: string; sales: boolean; initial?: string }) {
  const [postal, setPostal] = useState(initial ?? '');
  return (
    <SettingsCard
      title="Postal address"
      description="The law asks commercial email to carry the sender's postal address. Orbit adds it to sales messages and will not send a sales email without it."
      aside={
        <span className="text-[12px] text-ink-3">
          {sales ? 'Required for sales email' : 'For sales email'}
        </span>
      }
    >
      <div className="p-5">
        <label htmlFor="settings-postal" className="sr-only">
          Postal address
        </label>
        <Textarea
          id="settings-postal"
          rows={2}
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          onBlur={() => setPostalAddress(userId, postal)}
          placeholder="123 College Ave, Ithaca, NY 14850"
          data-testid="settings-postal"
        />
      </div>
    </SettingsCard>
  );
}

/** Settings, Account: who is signed in, sign out, download everything, delete the account. */
export function AccountSection() {
  const account = useAccount();
  const { signOut } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!account.signedIn) return <BrowserAccount />;
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
    <div data-testid="settings-account">
      <SettingsHeader title="Account" description="Your Orbit account, and everything it keeps for you." />
      <SettingsStack>
        <SettingsCard>
          <SettingsRow
            label={<AccountIdentity email={account.user?.email} />}
            description="Signing out stops syncing on this device. What is already here stays until you delete it."
            control={
              <Button
                loading={signingOut}
                onClick={async () => {
                  setSigningOut(true);
                  try {
                    await signOutHere();
                    toast.push({ text: 'Signed out. Orbit stopped syncing on this device.' });
                  } finally {
                    setSigningOut(false);
                  }
                }}
                data-testid="settings-sign-out"
              >
                {!signingOut && <LogOut size={14} />} Sign out
              </Button>
            }
          />
          <SettingsRow
            label="Download your data"
            description="One file with everything Orbit's server keeps for you: people, threads, notes, drafts, goals and memories. Keep it private."
            control={
              <Button onClick={doExport} disabled={!!busy} data-testid="settings-account-export">
                {busy === 'export' ? <Spinner /> : <Download size={14} />} Download my data
              </Button>
            }
          />
        </SettingsCard>
        <SettingsCard title="Danger zone" tone="danger">
          <SettingsRow
            label="Delete my account"
            description="Removes everything Orbit keeps for you, on its server and in this browser, stops reading your Gmail and unlinks LinkedIn. It cannot be undone. Type DELETE to confirm."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                aria-label="Type DELETE to confirm"
                className="w-40 h-9"
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
          </SettingsRow>
        </SettingsCard>
        {error ? (
          <p className="text-[13px] text-bad" role="alert">
            {error}
          </p>
        ) : null}
      </SettingsStack>
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
  const [error, setError] = useState<string>();
  // the choice shows as made at once; the server confirms it a moment later (or the error says it did not take)
  const [pending, setPending] = useState<{ l: AutonomyLevel; goalId?: string }>();
  const working = useWorking();
  useEffect(() => {
    if (settings?.quietUntil) setUntil(settings.quietUntil);
  }, [settings]);
  if (!user || !settings) return null;
  const sales = goals.some((g) => g.kind === 'sales');
  // an account kept in this browser: the student sends every message; sending on its own runs on the server
  const header = (
    <SettingsHeader title="Outreach" description="How much Orbit may do on its own, and when it holds off." />
  );
  if (!account.signedIn)
    return (
      <div data-testid="settings-outreach">
        {header}
        <SettingsStack>
          <SettingsCard title="How much Orbit may do" data-testid="settings-outreach-browser">
            <p className="px-5 py-4 text-[13px] text-ink-2">
              You approve and send every message yourself. Sending on its own and pausing outreach run on
              Orbit's server, which an account kept in this browser does not use.
            </p>
          </SettingsCard>
          <PostalAddressCard userId={user.id} sales={sales} initial={settings.postalAddress} />
        </SettingsStack>
      </div>
    );
  const level = (settings.autonomyLevel ?? 0) as AutonomyLevel;
  const choose = async (l: AutonomyLevel, goal?: Goal) => {
    setError(undefined);
    setPending({ l, goalId: goal?.id });
    try {
      const r = await setAutonomy(user, l, goal?.id);
      if (!r.ok) setError(r.message);
      else toast.push({ text: `${goal ? `${goal.title}: ` : ''}${AUTONOMY_TEXT[l].title}.` });
    } finally {
      setPending(undefined);
    }
  };
  const shown = pending && !pending.goalId ? pending.l : level;
  const today = new Date().toISOString().slice(0, 10);
  const paused = !!settings.quietUntil && settings.quietUntil >= today;
  return (
    <div data-testid="settings-outreach">
      {header}
      <SettingsStack>
        <SettingsCard title="How much Orbit may do">
          <div className="space-y-2 p-4" role="radiogroup" aria-label="Autonomy">
            {([0, 1, 2] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={shown === l}
                onClick={() => choose(l)}
                className={cx(
                  'w-full text-left rounded-[10px] border px-3.5 py-3 flex items-start gap-3 transition-colors',
                  shown === l ? 'border-ink bg-canvas-2/60' : 'border-line hover:bg-canvas-2/60',
                )}
                data-testid={`autonomy-${l}`}
              >
                <span
                  className={cx(
                    'mt-0.5 h-4 w-4 shrink-0 rounded-full border-[1.5px] inline-flex items-center justify-center',
                    shown === l ? 'border-ink' : 'border-line',
                  )}
                  aria-hidden
                >
                  {shown === l && <span className="h-2 w-2 rounded-full bg-ink" />}
                </span>
                <span className="min-w-0">
                  <span className="text-[13.5px] font-medium flex items-center gap-2">
                    {AUTONOMY_TEXT[l].title}
                    {pending && !pending.goalId && pending.l === l && <Working />}
                  </span>
                  <span className="block text-[12.5px] text-ink-3 mt-0.5">{AUTONOMY_TEXT[l].body}</span>
                </span>
              </button>
            ))}
          </div>
          {goals.map((g) => (
            <SettingsRow
              key={g.id}
              label={g.title}
              description={GOAL_KIND_LABELS[g.kind]}
              control={
                <Select
                  value={
                    pending?.goalId === g.id
                      ? String(pending.l)
                      : g.autonomyLevel === undefined
                        ? ''
                        : String(g.autonomyLevel)
                  }
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
              }
            />
          ))}
        </SettingsCard>
        <SettingsCard title="Pause outreach">
          <SettingsRow
            label={paused ? `Paused until ${settings.quietUntil}` : 'Pause until'}
            description={
              paused
                ? 'Nothing is drafted or sent until then.'
                : 'Going on vacation or exams? Nothing is drafted or sent until the date you pick.'
            }
            control={
              <>
                <Input
                  type="date"
                  value={until}
                  min={today}
                  onChange={(e) => setUntil(e.target.value)}
                  aria-label="Pause until"
                  className="w-40 h-9"
                  data-testid="settings-pause-until"
                />
                <Button
                  disabled={!until || !!working.busy}
                  loading={working.busy === 'pause'}
                  onClick={() =>
                    working.run('pause', 'Pausing outreach…', async () => {
                      const r = await pauseOutreach(user, until);
                      if (!r.ok) setError(r.message);
                      else toast.push({ text: `Outreach paused until ${until}.` });
                    })
                  }
                  data-testid="settings-pause"
                >
                  Pause
                </Button>
                {settings.quietUntil ? (
                  <Button
                    variant="ghost"
                    disabled={!!working.busy}
                    loading={working.busy === 'resume'}
                    onClick={() =>
                      working.run('resume', 'Turning outreach back on…', async () => {
                        const r = await pauseOutreach(user, null);
                        if (!r.ok) setError(r.message);
                        else {
                          setUntil('');
                          toast.push({ text: 'Outreach is back on.' });
                        }
                      })
                    }
                  >
                    Resume now
                  </Button>
                ) : null}
              </>
            }
          />
        </SettingsCard>
        <PostalAddressCard userId={user.id} sales={sales} initial={settings.postalAddress} />
        {error ? (
          <p className="text-[13px] text-bad" role="alert">
            {error}
          </p>
        ) : null}
      </SettingsStack>
    </div>
  );
}

/** Settings, Memory: what Orbit remembers from your chats, each with a delete; and what your resume says. */
export function MemorySection() {
  const { user } = useSession();
  const account = useAccount();
  const toast = useToast();
  const [deleting, setDeleting] = useState<string>();
  const onServer = !!user && memoryOnServer(user);
  const [serverItems, setServerItems] = useState<MemoryItem[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!user || !memoryOnServer(user)) return;
    const r = await listMemories(user);
    if (r.ok) setServerItems(r.memories);
    else setError(r.message);
  }, [user]);
  useEffect(() => {
    if (account.signedIn) void load();
  }, [load, account.signedIn]);
  // in this browser the list follows the chat as it remembers things
  const localItems = useLiveQuery(
    async () => (user && !onServer ? (await localMemories(user.id)).map(toMemoryItem) : undefined),
    [user?.id, onServer],
  );
  const items = onServer ? serverItems : localItems;
  const people = useLiveQuery(async () => {
    const ids = [...new Set((items ?? []).map((m) => m.personId).filter((x): x is string => !!x))];
    const rows = ids.length ? await db.people.bulkGet(ids) : [];
    return new Map(rows.filter((p) => !!p).map((p) => [p!.id, p!.displayName]));
  }, [items]);
  if (!user) return null;
  return (
    <>
      <SettingsHeader
        title="Memory"
        description={`Things you told Orbit that it keeps for later chats, like how you like to meet or the roles you are going for.${onServer ? '' : ' Kept in this browser only.'}`}
      />
      <SettingsStack>
        <ResumeProfileOffer userId={user.id} />
        <SettingsCard
          title="What Orbit remembers"
          description="Delete anything you'd rather it forgot."
          aside={
            items?.length ? <span className="text-[12px] text-ink-3">{items.length} saved</span> : undefined
          }
          data-testid="settings-memory"
        >
          {error ? (
            <p className="px-5 py-4 text-[13px] text-bad" role="alert">
              {error}
            </p>
          ) : !items ? (
            <div className="px-5 py-4">
              <Spinner />
            </div>
          ) : !items.length ? (
            <div className="px-5 py-8 text-center" data-testid="memory-empty">
              <Brain size={20} strokeWidth={1.5} className="mx-auto text-ink-3" aria-hidden />
              <p className="mt-2 text-[13.5px] font-medium">Nothing yet</p>
              <p className="mt-1 text-[12.5px] text-ink-3 max-w-sm mx-auto">
                Tell the chat something like "I prefer morning calls" or "I'm targeting PM internships in New
                York" and it shows up here.
              </p>
            </div>
          ) : (
            items.map((m) => (
              <div key={m.id} className="group px-5 py-3 flex items-start gap-3" data-testid="memory-item">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] text-ink">{m.text}</div>
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    {MEMORY_KIND_LABELS[m.kind] ?? 'Note'}
                    {m.personId && people?.get(m.personId) ? ` · ${people.get(m.personId)}` : ''} ·{' '}
                    {relDate(m.lastSeenAt ?? m.createdAt)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-ink-3 hover:text-bad hover:bg-bad-soft"
                  aria-label={`Delete: ${m.text}`}
                  loading={deleting === m.id}
                  disabled={!!deleting}
                  onClick={async () => {
                    setDeleting(m.id);
                    try {
                      const r = await forget(user, m.id);
                      if (!r.ok) {
                        toast.push({ text: r.message, tone: 'bad' });
                        return;
                      }
                      setServerItems((xs) => xs?.filter((x) => x.id !== m.id));
                      toast.push({ text: 'Deleted from memory.' });
                    } finally {
                      setDeleting(undefined);
                    }
                  }}
                  data-testid="memory-delete"
                >
                  {deleting !== m.id && <Trash2 size={14} />}
                </Button>
              </div>
            ))
          )}
        </SettingsCard>
      </SettingsStack>
    </>
  );
}

/**
 * Your resume names a school, majors or a graduation year your profile does not: use them, or say no. Orbit never
 * changes the profile on its own, and never offers an employer as the school.
 */
export function ResumeProfileOffer({ userId }: { userId: string }) {
  const toast = useToast();
  const working = useWorking();
  const offer = useLiveQuery(async () => {
    // read again whenever the resume, the profile or the offer changes
    await Promise.all([db.kv.get(`resumeProfile:${userId}`), db.users.get(userId)]);
    return (await resumeProposal(userId)) ?? null;
  }, [userId]);
  if (!offer) return null;
  return (
    <SettingsCard
      data-testid="resume-profile-offer"
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void dismissResumeProposal(userId)}
            data-testid="resume-profile-dismiss"
          >
            Keep my profile
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={working.busy === 'accept'}
            onClick={() =>
              working.run('accept', 'Updating your profile…', async () => {
                await acceptResumeProposal(userId);
                toast.push({ text: 'Profile updated from your resume.', tone: 'good' });
              })
            }
            data-testid="resume-profile-accept"
          >
            Use it
          </Button>
        </>
      }
    >
      <SettingsRow
        label="From your resume"
        description={`Your resume says ${describeResumeProfile(offer)}. Use that in your profile? Drafts introduce you with it.`}
      />
    </SettingsCard>
  );
}
