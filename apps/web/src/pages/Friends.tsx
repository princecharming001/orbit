/**
 * Friends (plan 29 Part A, §A1): two Orbit users pool their networks as signal, never content. Four stacked sections:
 * your friends, invite a friend, asks (theirs of you and yours of them), and what you share. An account feature: in
 * local mode the page is one paragraph and the Google sign-in, since nothing leaves the browser without an account.
 */
import type { Friend, FriendInvite, FriendShare, FriendShareMode } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AskIntroBox } from '../components/friends/AskIntroBox';
import { MyAskRow, ReceivedAskRow } from '../components/friends/AskRow';
import { FriendRow } from '../components/friends/FriendRow';
import { InviteBox } from '../components/friends/InviteBox';
import { SharePreview } from '../components/friends/SharePreview';
import { ShareSettings } from '../components/friends/ShareSettings';
import { db } from '../db/schema';
import {
  acceptFriend,
  askFriendForIntro,
  declineFriend,
  endFriendship,
  FRIENDS_EMPTY,
  FRIENDS_NEEDS_ACCOUNT,
  FRIENDS_WHAT_CROSSES,
  friendsAvailable,
  inviteFriend,
  listAsks,
  listFriends,
  previewShares,
  respondToAsk,
  setShareMode,
} from '../engine/friends';
import { isAccountMode, startGoogleSignIn } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Button, Card, PageHeader, SkeletonRows, useToast, useWorking } from '../ui';

const TAP = 'pointer-coarse:min-h-11';

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section data-testid={testId}>
      <h2 className="text-[13px] uppercase tracking-wide text-ink-3 mb-2">{title}</h2>
      <Card>{children}</Card>
    </section>
  );
}

/** Local mode, or an account-capable build before sign-in: the reason in one paragraph, then the sign-in. */
function NeedsAccount() {
  return (
    <>
      <PageHeader title="Friends" />
      <Card>
        <p className="text-[14px] text-ink-2 max-w-[62ch]" data-testid="friends-needs-account">
          {FRIENDS_NEEDS_ACCOUNT}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {isAccountMode() ? (
            <Button
              variant="dark"
              className={TAP}
              onClick={() => startGoogleSignIn()}
              data-testid="ob-google-signin"
            >
              Continue with Google
            </Button>
          ) : (
            <p className="text-[13px] text-ink-3" data-testid="friends-no-server">
              This copy of Orbit has no server to sign in to, so Friends is not available here.
            </p>
          )}
        </div>
      </Card>
    </>
  );
}

export function FriendsPage() {
  const { user, settings } = useSession();
  const toast = useToast();
  const working = useWorking();
  const [params, setParams] = useSearchParams();
  const { code } = useParams();
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<FriendInvite[]>([]);
  const [preview, setPreview] = useState<{
    mode: FriendShareMode;
    domains: string[];
    shares: FriendShare[];
    total: number;
  }>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [asking, setAsking] = useState<{ friend: Friend; target?: string }>();
  const userId = user?.id ?? '';
  const available = friendsAvailable(user);

  const friends = useLiveQuery(
    () => (userId ? db.friends.where('ownerId').equals(userId).sortBy('name') : []),
    [userId],
    [] as Friend[],
  );
  const asks = useLiveQuery(
    () => (userId ? db.friendAsks.where('ownerId').equals(userId).toArray() : []),
    [userId],
    [],
  );
  const received = useMemo(
    () =>
      asks
        .filter((a) => a.friendUserId === userId)
        .sort(
          (a, b) =>
            Number(a.status !== 'asked') - Number(b.status !== 'asked') ||
            b.createdAt.localeCompare(a.createdAt),
        ),
    [asks, userId],
  );
  const mine = useMemo(
    () => asks.filter((a) => a.askerUserId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [asks, userId],
  );
  const mode: FriendShareMode = preview?.mode ?? settings?.friendShareMode ?? 'all';
  const domains = preview?.domains ?? settings?.friendShareDomains ?? [];

  const refresh = async () => {
    if (!user || !available) return;
    const [f, p] = await Promise.all([listFriends(user), previewShares(user)]);
    if (f.ok) setPending(f.value.pending);
    else if (f.reason !== 'network') toast.push({ text: f.message, tone: 'bad' });
    if (p.ok)
      setPreview({
        mode: p.value.mode,
        domains: p.value.companyDomains,
        shares: p.value.shares,
        total: p.value.total,
      });
    await listAsks(user);
    setLoaded(true);
  };
  useEffect(() => {
    void refresh();
  }, [userId, available]);

  // "Ask Ana" from the Map or a company page: the ask box opens for that friend with the person filled in
  useEffect(() => {
    const askFor = params.get('ask');
    if (!askFor || !friends.length) return;
    const f = friends.find((x) => x.userId === askFor);
    if (f) setAsking({ friend: f, target: params.get('target') ?? undefined });
    setParams((p) => {
      p.delete('ask');
      p.delete('target');
      return p;
    });
  }, [params, friends]);

  if (!user) return null;
  if (!available) return <NeedsAccount />;

  const invite = async (email?: string) => {
    const r = await inviteFriend(user, email);
    if (!r.ok) {
      toast.push({ text: r.message, tone: 'bad' });
      return undefined;
    }
    await refresh();
    return { link: r.value.link, status: r.value.status };
  };
  const accept = (inv: FriendInvite) =>
    working.run(`accept:${inv.id}`, 'Accepting…', async () => {
      const r = await acceptFriend(user, { friendshipId: inv.id }, mode, domains);
      if (!r.ok) return void toast.push({ text: r.message, tone: 'bad' });
      toast.push({ text: `You and ${r.value.name} are friends on Orbit now.`, tone: 'good' });
      await refresh();
    });
  const acceptCode = () =>
    working.run('accept:code', 'Accepting…', async () => {
      const r = await acceptFriend(user, { code }, mode, domains);
      if (!r.ok) return void toast.push({ text: r.message, tone: 'bad' });
      toast.push({ text: `You and ${r.value.name} are friends on Orbit now.`, tone: 'good' });
      setParams({});
      await refresh();
    });
  const decline = (inv: FriendInvite) =>
    working.run(`decline:${inv.id}`, 'Declining…', async () => {
      const r = await declineFriend(user, { friendshipId: inv.id });
      if (!r.ok) return void toast.push({ text: r.message, tone: 'bad' });
      await refresh();
    });
  const end = (f: Friend) =>
    working.run(`end:${f.friendshipId}`, 'Ending…', async () => {
      const r = await endFriendship(user, f.friendshipId);
      if (!r.ok) return void toast.push({ text: r.message, tone: 'bad' });
      toast.push({
        text: `Ended. ${f.name.split(' ')[0]} no longer sees your people, and you no longer see theirs.`,
        tone: 'neutral',
      });
      await refresh();
    });
  const share = (m: FriendShareMode, d: string[], f?: Friend) =>
    working.run(`share:${f?.friendshipId ?? 'all'}`, 'Saving…', async () => {
      const r = await setShareMode(user, m, { friendshipId: f?.friendshipId, companyDomains: d });
      if (!r.ok) return void toast.push({ text: r.message, tone: 'bad' });
      if (!f) setPreview((p) => (p ? { ...p, mode: m, domains: d, total: r.value.shares } : p));
      await refresh();
    });
  const sendAsk = async (friend: Friend, target: FriendShare, note: string) => {
    const r = await askFriendForIntro(user, friend.userId, target.personId, note);
    if (!r.ok) {
      toast.push({ text: r.message, tone: 'bad' });
      return false;
    }
    toast.push({
      text: `Asked ${friend.name.split(' ')[0]} to introduce you to ${target.displayName.split(' ')[0]}. It waits on them; nothing was sent to ${target.displayName.split(' ')[0]}.`,
      tone: 'good',
      ttl: 7000,
    });
    return true;
  };
  const respond = async (askRow: { id: string }, action: 'forward' | 'decline') => {
    const r = await respondToAsk(user, askRow.id, action);
    if (!r.ok) {
      toast.push({ text: r.message, tone: 'bad' });
      return undefined;
    }
    if (action === 'decline') toast.push({ text: 'Declined. No reason owed.', tone: 'neutral' });
    return r.value;
  };

  return (
    <>
      <PageHeader title="Friends" subtitle={FRIENDS_WHAT_CROSSES} />
      <div className="space-y-6">
        {code && (
          <Card data-testid="friends-join">
            <p className="text-[14px]">
              You were invited to pool networks. Accepting shares your people the same way (
              {mode === 'none'
                ? 'nothing yet'
                : mode === 'all'
                  ? 'everyone you know'
                  : 'only at your chosen companies'}
              ). Change it any time below.
            </p>
            <Button
              variant="primary"
              className={`mt-3 ${TAP}`}
              onClick={() => void acceptCode()}
              loading={working.busy === 'accept:code'}
              data-testid="friends-join-accept"
            >
              Accept
            </Button>
          </Card>
        )}
        <Section title="Your friends" testId="friends-section-friends">
          {!loaded && !friends.length ? (
            <SkeletonRows rows={2} />
          ) : friends.length ? (
            <ul className="divide-y divide-line-2">
              {friends.map((f) => (
                <FriendRow
                  key={f.friendshipId}
                  friend={f}
                  onAsk={(friend) => setAsking({ friend })}
                  onShareMode={(friend, m) => void share(m, friend.myCompanyDomains, friend)}
                  onEnd={(friend) => void end(friend)}
                  busy={!!working.busy}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-ink-2 max-w-[62ch]" data-testid="friends-empty">
              {FRIENDS_EMPTY}
            </p>
          )}
          {asking && (
            <AskIntroBox
              user={user}
              friend={asking.friend}
              initialTarget={asking.target}
              onSend={(t, n) => sendAsk(asking.friend, t, n)}
              onClose={() => setAsking(undefined)}
              busy={!!working.busy}
            />
          )}
        </Section>
        <Section title="Invite a friend" testId="friends-section-invite">
          <InviteBox
            pending={pending}
            onInvite={invite}
            onAccept={(i) => void accept(i)}
            onDecline={(i) => void decline(i)}
            busy={!!working.busy}
          />
        </Section>
        <Section title="Asks" testId="friends-section-asks">
          <div className="grid gap-5 @3xl:grid-cols-2">
            <div>
              <div className="text-[12.5px] text-ink-3 mb-1">Friends asked you</div>
              {received.length ? (
                <ul className="divide-y divide-line-2" data-testid="friend-asks-received">
                  {received.map((a) => (
                    <ReceivedAskRow
                      key={a.id}
                      ask={a}
                      user={user}
                      onRespond={respond}
                      busy={!!working.busy}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-3">Nobody has asked you for an intro yet.</p>
              )}
            </div>
            <div>
              <div className="text-[12.5px] text-ink-3 mb-1">You asked</div>
              {mine.length ? (
                <ul className="divide-y divide-line-2" data-testid="friend-asks-mine">
                  {mine.map((a) => (
                    <MyAskRow key={a.id} ask={a} />
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-3">
                  Ask a friend for an intro from their row above, the Map or a company page.
                </p>
              )}
            </div>
          </div>
        </Section>
        <Section title="What you share" testId="friends-section-share">
          <ShareSettings
            userId={user.id}
            friends={friends}
            mode={mode}
            domains={domains}
            total={preview?.total ?? 0}
            onMode={(m, d) => void share(m, d)}
            onPreview={() => setPreviewOpen((v) => !v)}
            busy={!!working.busy}
          />
          {previewOpen && preview && (
            <div className="mt-4 border-t border-line-2 pt-4">
              <SharePreview
                mode={preview.mode}
                shares={preview.shares}
                total={preview.total}
                friendFirst={friends.length === 1 ? friends[0]!.name.split(' ')[0] : undefined}
              />
              <Button
                size="sm"
                variant="ghost"
                className={`mt-2 ${TAP}`}
                onClick={() => setPreviewOpen(false)}
              >
                Close
              </Button>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
