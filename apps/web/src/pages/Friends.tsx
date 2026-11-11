/**
 * Friends (plan 29 Part A, §A1; laid out again in the plan 37 follow-up): two Orbit users pool their networks as signal,
 * never content. The main column finds friends: a search for someone on Orbit, people on Orbit the student may know
 * (Add), and people in their People worth inviting (Invite). The side column holds the invite link for a group chat,
 * requests waiting, and the friends. Below the grids: each friend's row (ask for an intro, what you share, end), the
 * asks, and what you share. An account feature: in local mode the page is one paragraph and the Google sign-in.
 */
import type {
  Friend,
  FriendInvite,
  FriendShare,
  FriendShareMode,
  FriendSuggestion,
  InviteSuggestion,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AskIntroBox } from '../components/friends/AskIntroBox';
import { MyAskRow, ReceivedAskRow } from '../components/friends/AskRow';
import {
  FriendSearch,
  GhostTiles,
  GRID,
  InviteTile,
  SuggestionTile,
  TileSection,
  type TileState,
} from '../components/friends/Discover';
import { FriendRow } from '../components/friends/FriendRow';
import { InviteBox } from '../components/friends/InviteBox';
import { FriendsListSection, InviteLinkSection, RequestsSection } from '../components/friends/Rail';
import { db } from '../db/schema';
import {
  acceptFriend,
  askFriendForIntro,
  declineFriend,
  endFriendship,
  FRIENDS_NEEDS_ACCOUNT,
  FRIENDS_SUBTITLE,
  friendsAvailable,
  inviteFriend,
  inviteLink,
  invitePerson,
  listAsks,
  listFriends,
  previewShares,
  requestFriend,
  respondToAsk,
  searchOrbit,
  setShareMode,
  suggestFriends,
} from '../engine/friends';
import { isAccountMode, startGoogleSignIn } from '../integrations/orbitApi';
import { useSession } from '../state/session';
import { Button, Card, PageHeader, useToast, useWorking } from '../ui';

const TAP = 'pointer-coarse:min-h-11';

function Section({
  title,
  children,
  testId,
  id,
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
  id?: string;
}) {
  return (
    <section data-testid={testId} id={id} className="scroll-mt-6">
      <h2 className="text-[16px] font-semibold mb-3">{title}</h2>
      {children}
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
  // finding friends (plan 37 follow-up)
  const [suggested, setSuggested] = useState<{
    onOrbit: FriendSuggestion[];
    toInvite: InviteSuggestion[];
    moreOnOrbit?: boolean;
    moreToInvite?: boolean;
  }>();
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FriendSuggestion[]>();
  const [link, setLink] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const searchSeq = useRef(0);
  const tile = (id: string, state: TileState) => setTiles((t) => ({ ...t, [id]: state }));
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
  // who to add and who to invite, and the standing link, once per visit
  useEffect(() => {
    if (!user || !available) return;
    let live = true;
    void suggestFriends(user).then((r) => {
      if (!live) return;
      setSuggested(r.ok ? r.value : { onOrbit: [], toInvite: [] });
    });
    void inviteLink(user).then((r) => live && r.ok && setLink(r.value.link));
    return () => {
      live = false;
    };
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
  const search = async (q: string) => {
    setQuery(q);
    const seq = ++searchSeq.current;
    if (q.length < 2) return setResults(undefined);
    const r = await searchOrbit(user, q);
    if (seq !== searchSeq.current) return;
    setResults(r.ok ? r.value : []);
  };
  const add = async (s: FriendSuggestion) => {
    tile(s.userId, 'busy');
    const r = await requestFriend(user, s.userId);
    if (!r.ok) {
      tile(s.userId, 'none');
      return void toast.push({ text: r.message, tone: 'bad' });
    }
    tile(s.userId, 'requested');
    toast.push({
      text: `Request sent to ${s.name.split(' ')[0]}. You pool networks once they accept.`,
      tone: 'good',
    });
  };
  const acceptSuggested = async (s: FriendSuggestion) => {
    if (!s.friendshipId) return;
    tile(s.userId, 'busy');
    const r = await acceptFriend(user, { friendshipId: s.friendshipId }, mode, domains);
    if (!r.ok) {
      tile(s.userId, 'none');
      return void toast.push({ text: r.message, tone: 'bad' });
    }
    tile(s.userId, 'friends');
    toast.push({ text: `You and ${r.value.name} are friends on Orbit now.`, tone: 'good' });
    await refresh();
  };
  const invitePeople = async (s: InviteSuggestion) => {
    tile(s.personId, 'busy');
    const r = await invitePerson(user, s.personId);
    if (!r.ok) {
      tile(s.personId, 'none');
      return void toast.push({ text: r.message, tone: 'bad' });
    }
    tile(s.personId, 'invited');
    const first = s.name.split(' ')[0];
    if (r.value.status === 'sent') toast.push({ text: `Invite sent to ${first}.`, tone: 'good' });
    else if (r.value.status === 'linkedin')
      toast.push({ text: `Invite sent to ${first} on LinkedIn.`, tone: 'good' });
    else if (r.value.status === 'requested')
      toast.push({ text: `${first} is on Orbit already: the request is waiting on them.`, tone: 'good' });
    else {
      // no mail goes out from this copy: the student sends the link themselves
      try {
        await navigator.clipboard.writeText(r.value.link);
        toast.push({
          text: `Link for ${first} copied. Send it to them yourself.`,
          tone: 'neutral',
          ttl: 7000,
        });
      } catch {
        toast.push({ text: r.value.link, tone: 'neutral', ttl: 10_000 });
      }
    }
    await refresh();
  };
  const resetLink = async () => {
    setResetting(true);
    const r = await inviteLink(user, true);
    setResetting(false);
    if (!r.ok) return void toast.push({ text: r.message, tone: 'bad' });
    setLink(r.value.link);
    toast.push({ text: 'New link made. The old one no longer works.', tone: 'good' });
  };
  const openFriend = (f: Friend) => {
    document
      .querySelector(`[data-testid="friend-row"][data-friend-id="${f.userId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  const onOrbit = suggested?.onOrbit ?? [];
  const toInvite = suggested?.toInvite ?? [];
  /**
   * "Show more": the batch after the ones on screen. Someone invited in this visit has left the server's list, so
   * they are not counted as shown; anyone who comes back twice is dropped.
   */
  const loadMore = async (which: 'onOrbit' | 'toInvite') => {
    if (!user || !suggested) return;
    const stillListed =
      which === 'toInvite'
        ? suggested.toInvite.filter((x) => (tiles[x.personId] ?? 'none') === 'none').length
        : suggested.onOrbit.length;
    const r = await suggestFriends(user, { [which]: stillListed });
    if (!r.ok) return;
    setSuggested((cur) => {
      if (!cur) return cur;
      if (which === 'toInvite') {
        const have = new Set(cur.toInvite.map((x) => x.personId));
        return {
          ...cur,
          toInvite: [...cur.toInvite, ...r.value.toInvite.filter((x) => !have.has(x.personId))],
          moreToInvite: r.value.moreToInvite,
        };
      }
      const have = new Set(cur.onOrbit.map((x) => x.userId));
      return {
        ...cur,
        onOrbit: [...cur.onOrbit, ...r.value.onOrbit.filter((x) => !have.has(x.userId))],
        moreOnOrbit: r.value.moreOnOrbit,
      };
    });
  };
  const searching = query.length >= 2;
  return (
    <>
      <PageHeader title="Friends" subtitle={FRIENDS_SUBTITLE} />
      {code && (
        <Card className="mb-6" data-testid="friends-join">
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
      <div className="grid gap-x-12 gap-y-10 @4xl:grid-cols-[minmax(0,1fr)_300px] items-start">
        <div className="min-w-0 space-y-10">
          <FriendSearch onSearch={(q) => void search(q)} />
          {searching && (
            <section data-testid="friends-search-results">
              <h2 className="text-[16px] font-semibold mb-3">On Orbit</h2>
              {!results ? (
                <p className="text-[13px] text-ink-3">Looking…</p>
              ) : results.length ? (
                <ul className={GRID}>
                  {results.map((r) => (
                    <SuggestionTile
                      key={r.userId}
                      s={r}
                      state={tiles[r.userId] ?? 'none'}
                      onAdd={(x) => void add(x)}
                      onAccept={(x) => void acceptSuggested(x)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-[13.5px] text-ink-2 max-w-[62ch]" data-testid="friends-search-none">
                  {query.includes('@')
                    ? 'Nobody on Orbit uses that address. Invite them by email on the right, and they join with your request waiting.'
                    : 'Nobody by that name on Orbit you share a contact, a friend, a school or a company with. Try their email.'}
                </p>
              )}
            </section>
          )}
          <TileSection
            title="People on Orbit you may know"
            count={onOrbit.length}
            loading={!suggested}
            testId="friends-on-orbit"
            hasMore={suggested?.moreOnOrbit}
            onMore={() => loadMore('onOrbit')}
            empty={<GhostTiles label="Friends who join show up here" testId="friends-on-orbit-empty" />}
          >
            {(limit) =>
              onOrbit
                .slice(0, limit)
                .map((x) => (
                  <SuggestionTile
                    key={x.userId}
                    s={x}
                    state={tiles[x.userId] ?? 'none'}
                    onAdd={(y) => void add(y)}
                    onAccept={(y) => void acceptSuggested(y)}
                  />
                ))
            }
          </TileSection>
          <TileSection
            title="People you may want to invite"
            count={toInvite.length}
            loading={!suggested}
            testId="friends-to-invite"
            hasMore={suggested?.moreToInvite}
            onMore={() => loadMore('toInvite')}
            empty={<GhostTiles label="Everyone you know well is invited" />}
          >
            {(limit) =>
              toInvite
                .slice(0, limit)
                .map((x) => (
                  <InviteTile
                    key={x.personId}
                    s={x}
                    state={tiles[x.personId] ?? 'none'}
                    onInvite={(y) => void invitePeople(y)}
                  />
                ))
            }
          </TileSection>
          {friends.length > 0 && (
            <Section title="Your friends" testId="friends-section-friends" id="friends-manage">
              <ul className="divide-y divide-line-2 border-y border-line-2">
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
          )}
          {(received.length > 0 || mine.length > 0) && (
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
          )}
        </div>
        {/* on a phone the link, the requests and the friends come first, above the grids */}
        <aside className="min-w-0 order-first @4xl:order-none @4xl:sticky @4xl:top-6">
          <InviteLinkSection link={link} onReset={() => void resetLink()} resetting={resetting}>
            <div data-testid="friends-section-invite">
              <InviteBox
                pending={pending.filter((p) => p.direction === 'out')}
                onInvite={invite}
                onAccept={(i) => void accept(i)}
                onDecline={(i) => void decline(i)}
                busy={!!working.busy}
              />
            </div>
          </InviteLinkSection>
          <RequestsSection
            pending={pending}
            onAccept={(i) => void accept(i)}
            onDecline={(i) => void decline(i)}
            busy={!!working.busy}
          />
          <FriendsListSection friends={friends} loading={!loaded} onOpen={openFriend} />
        </aside>
      </div>
    </>
  );
}
