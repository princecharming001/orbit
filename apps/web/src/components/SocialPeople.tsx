/**
 * Instagram and X on people (plan 43 §3.4, §3.6, §3.7): a person's handles as links with "Not their account", the
 * "is this the same person" question with its evidence both ways, and "Check Instagram for {name}" / "Check X for
 * {name}" with what the check found. X's price is shown before anything is read. Everything here shows only for the
 * sources in use (engine/social.ts asks engine/sources.ts).
 */
import type { Person, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Instagram, Twitter } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db, type SocialAskRow, type SocialLinkRow } from '../db/schema';
import { buildReachGraph, type SocialBridge, socialBridgesIn } from '../engine/graph';
import {
  answerAsk,
  askEvidence,
  askQuestion,
  attachAccount,
  detachLink,
  handleOf,
  lookupSummary,
  type PickPerson,
  PLATFORM_NAME,
  type Platform,
  profileUrl,
  quoteLine,
  socialInUse,
  startCheck,
  useLatestLookup,
  useOpenAsks,
  usePersonLinks,
  type XQuote,
} from '../engine/social';
import { useSources } from '../engine/sources';
import { Button, Card, Modal, Spinner, useToast } from '../ui';

export function PlatformMark({ platform, size = 13 }: { platform: Platform; size?: number }) {
  return platform === 'instagram' ? (
    <Instagram size={size} aria-hidden />
  ) : (
    <Twitter size={size} aria-hidden />
  );
}

/** A person's Instagram and X handles, as links to the profiles, for the person page's header line. */
export function SocialHandles({ user, person }: { user: Pick<User, 'id'>; person: Pick<Person, 'id'> }) {
  const links = usePersonLinks(user.id, person.id);
  return (
    <>
      {links.map((l) => (
        <a
          key={l.id}
          href={profileUrl(l)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-ink"
          title={`${handleOf(l)} on ${PLATFORM_NAME[l.platform]}`}
          data-testid={`person-${l.platform}-handle`}
        >
          <PlatformMark platform={l.platform} /> {handleOf(l)}
        </a>
      ))}
    </>
  );
}

// ---- the question --------------------------------------------------------------------------------------------------

/** Both people, to pick which one stays when each has things of their own. Cannot be undone, and says so. */
export function PickPersonDialog({
  pick,
  onPick,
  onClose,
  busy,
}: {
  pick?: PickPerson;
  onPick: (personId: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Modal open={!!pick} onClose={onClose} title="Which one stays?" width={460}>
      <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="social-pick">
        <p>
          Both have things of their own, a chat, a note or a draft. Pick the one to keep: the other's messages
          and follows move to it. This one cannot be undone.
        </p>
        <ul className="divide-y divide-line-2 border-y border-line-2">
          {(pick?.pick ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
              <Link to={`/people/${p.id}`} className="font-medium text-ink hover:underline" onClick={onClose}>
                {p.name}
              </Link>
              <Button size="sm" onClick={() => onPick(p.id)} loading={busy} data-testid="social-pick-keep">
                Keep {p.name.split(' ')[0]}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * "Is @jchen_22 on Instagram the Jason Chen you know from Stripe?" with what speaks for and against it, and Yes / No.
 * The morning brief and the person page show the same card.
 */
export function SocialAskCard({
  user,
  ask,
  onAnswered,
  bare,
  hideQuestion,
}: {
  user: Pick<User, 'id'>;
  ask: SocialAskRow;
  onAnswered?: (answer: 'yes' | 'no') => void;
  /** inside another card (the brief's): no frame of its own */
  bare?: boolean;
  /** the card around it already asks the question */
  hideQuestion?: boolean;
}) {
  const toast = useToast();
  const person = useLiveQuery(() => db.people.get(ask.personId), [ask.personId]);
  const [busy, setBusy] = useState<'yes' | 'no' | 'pick'>();
  const [error, setError] = useState<string>();
  const [pick, setPick] = useState<PickPerson>();
  const ev = askEvidence(ask);
  const go = async (answer: 'yes' | 'no') => {
    setBusy(answer);
    setError(undefined);
    try {
      const r = await answerAsk(user.id, ask.id, answer);
      if (r.ok) {
        toast.push({
          text:
            answer === 'yes'
              ? `Attached @${ask.username ?? 'the account'} to ${person?.firstName ?? 'them'}.`
              : 'Got it. Orbit will not ask about that account again.',
        });
        onAnswered?.(answer);
      } else if ('pick' in r) setPick(r);
      else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const keep = async (personId: string) => {
    setBusy('pick');
    try {
      const r = await attachAccount(user.id, {
        platform: ask.platform,
        accountId: ask.accountId,
        personId,
        keep: personId,
      });
      if (r.ok) {
        setPick(undefined);
        await db.socialAsks.update(ask.id, { status: 'yes' });
        onAnswered?.('yes');
      } else setError(r.message);
    } finally {
      setBusy(undefined);
    }
  };
  const body = (
    <div className="text-[13.5px]" data-testid="social-ask">
      {!hideQuestion && (
        <p className="font-medium text-ink" data-testid="social-ask-question">
          {askQuestion(ask, person?.currentOrganizationRaw)}
        </p>
      )}
      {(ev.for.length > 0 || ev.against.length > 0) && (
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12.5px] text-ink-3">
          {ev.for.length > 0 && (
            <>
              <dt>For</dt>
              <dd data-testid="social-ask-for">{ev.for.join('. ')}.</dd>
            </>
          )}
          {ev.against.length > 0 && (
            <>
              <dt>Against</dt>
              <dd data-testid="social-ask-against">{ev.against.join('. ')}.</dd>
            </>
          )}
        </dl>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void go('yes')}
          loading={busy === 'yes'}
          disabled={!!busy}
          data-testid="social-ask-yes"
        >
          Yes, same person
        </Button>
        <Button
          size="sm"
          onClick={() => void go('no')}
          loading={busy === 'no'}
          disabled={!!busy}
          data-testid="social-ask-no"
        >
          No
        </Button>
        {ask.username && (
          <a
            href={profileUrl({ platform: ask.platform, username: ask.username, accountId: ask.accountId })}
            target="_blank"
            rel="noreferrer"
            className="text-[12.5px] text-ink-3 underline underline-offset-2 hover:text-ink"
          >
            See @{ask.username}
          </a>
        )}
      </div>
      {error && (
        <p className="mt-1.5 text-[12.5px] text-bad" role="alert">
          {error}
        </p>
      )}
      <PickPersonDialog
        pick={pick}
        onPick={(id) => void keep(id)}
        onClose={() => setPick(undefined)}
        busy={busy === 'pick'}
      />
    </div>
  );
  return bare ? body : <Card>{body}</Card>;
}

// ---- checks -------------------------------------------------------------------------------------------------------

/**
 * "Check Instagram for Jules" / "Check X for Jules": shown when the source is in use and Orbit knows their account for
 * sure. X asks with its price first; nothing is read until the student says go.
 */
export function SocialCheckButton({
  user,
  person,
  platform,
  size = 'sm',
}: {
  user: Pick<User, 'id'>;
  person: Pick<Person, 'id' | 'firstName' | 'displayName'>;
  platform: Platform;
  size?: 'sm' | 'md';
}) {
  const links = usePersonLinks(user.id, person.id);
  const lookup = useLatestLookup(user.id, person.id, platform);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<XQuote>();
  const [error, setError] = useState<string>();
  const has = links.some((l) => l.platform === platform);
  if (!has) return null;
  const running =
    lookup && (lookup.status === 'queued' || lookup.status === 'running' || lookup.status === 'waiting');
  const first = person.firstName || person.displayName;
  const go = async (confirm?: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await startCheck(user.id, platform, person.id, { confirm });
      if (!r.ok) setError(r.message);
      else if ('quote' in r) setQuote(r.quote);
      else setQuote(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-start">
      <Button
        size={size}
        onClick={() => void go()}
        loading={busy}
        disabled={busy || !!running}
        data-testid={`check-${platform}`}
      >
        {running ? (
          <>
            <Spinner /> Checking {PLATFORM_NAME[platform]}
          </>
        ) : (
          `Check ${PLATFORM_NAME[platform]} for ${first}`
        )}
      </Button>
      {error && (
        <span className="mt-1 text-[12.5px] text-bad" role="alert" data-testid={`check-${platform}-error`}>
          {error}
        </span>
      )}
      <Modal open={!!quote} onClose={() => setQuote(undefined)} title={`Check X for ${first}?`} width={440}>
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="x-quote">
          <p data-testid="x-quote-line">{quote ? quoteLine(quote) : ''}</p>
          <p className="text-[12.5px] text-ink-3">
            X charges for every person it shows. Orbit reads the list to the end or not at all, and it counts
            toward your monthly limit.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setQuote(undefined)}>
              Not now
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void go(true)} data-testid="x-quote-go">
              Go ahead
            </Button>
          </div>
        </div>
      </Modal>
    </span>
  );
}

/** What a finished check found: bridges as names that open their pages, or why there is none. */
export function SocialCheckResult({
  user,
  person,
  platform,
}: {
  user: Pick<User, 'id'>;
  person: Pick<Person, 'id' | 'firstName' | 'displayName'>;
  platform: Platform;
}) {
  const lookup = useLatestLookup(user.id, person.id, platform);
  const names = useLiveQuery(
    async () =>
      new Map(
        (await db.people.bulkGet((lookup?.result?.bridges ?? []).map((b) => b.personId)))
          .filter((p): p is Person => !!p)
          .map((p) => [p.id, p]),
      ),
    [lookup?.id, lookup?.status],
  );
  if (!lookup) return null;
  const first = person.firstName || person.displayName;
  const where = PLATFORM_NAME[platform];
  if (lookup.status !== 'done' && lookup.status !== 'failed')
    return (
      <p className="text-[12.5px] text-ink-3" data-testid={`check-${platform}-progress`}>
        Checking who you know who follows {first} on {where}.{' '}
        {platform === 'instagram'
          ? 'This can take a few hours on Instagram; Orbit tells you when it is done.'
          : ''}
      </p>
    );
  const none = lookupSummary(lookup, first);
  const bridges = lookup.result?.bridges ?? [];
  const onlyOneWay = !bridges.length && (lookup.result?.oneWay.length ?? 0) > 0;
  return (
    <div className="text-[13px] text-ink-2" data-testid={`check-${platform}-result`}>
      {bridges.map((b) => {
        const p = names?.get(b.personId);
        return (
          <p key={b.personId} data-testid={`check-${platform}-bridge`}>
            <Link to={`/people/${b.personId}`} className="font-medium text-ink hover:underline">
              {p?.firstName ?? b.name.split(' ')[0]}
            </Link>{' '}
            and{' '}
            <Link to={`/people/${person.id}`} className="font-medium text-ink hover:underline">
              {first}
            </Link>{' '}
            follow each other on {where}.
          </p>
        );
      })}
      {onlyOneWay && (
        <p className="text-ink-3" data-testid={`check-${platform}-weak`}>
          Only one-way follows on {where}: a weaker route, not enough for an intro on its own.
        </p>
      )}
      {none && (
        <p className="text-ink-3" data-testid={`check-${platform}-none`}>
          {none}
        </p>
      )}
      {lookup.result?.partial && bridges.length > 0 && (
        <p className="text-ink-3">{where} could not show all of it, so there may be more.</p>
      )}
    </div>
  );
}

/** "People who know {first}" on Instagram and X: each bridge with core's words, and that it is from that platform. */
export function SocialBridgeList({
  user,
  target,
  children,
}: {
  user: Pick<User, 'id'>;
  target: Pick<Person, 'id' | 'firstName' | 'displayName'>;
  children?: (b: SocialBridge, p: Person) => ReactNode;
}) {
  const [bridges, setBridges] = useState<SocialBridge[]>([]);
  const s = useSources(user.id);
  const stamp = useLiveQuery(
    async () => (await db.socialTies.where('bId').equals(target.id).count()) + (await db.socialLinks.count()),
    [target.id],
  );
  useEffect(() => {
    let live = true;
    void (async () => {
      const on = await socialInUse(user.id);
      if (!on.size) {
        if (live) setBridges([]);
        return;
      }
      const { g } = await buildReachGraph(user.id);
      if (live) setBridges(socialBridgesIn(g, target.id).filter((b) => on.has(b.platform)));
    })();
    return () => {
      live = false;
    };
  }, [user.id, target.id, stamp, s?.inUse.size, [...(s?.inUse ?? [])].join()]);
  const people = useLiveQuery(
    async () =>
      new Map(
        (await db.people.bulkGet(bridges.map((b) => b.personId)))
          .filter((p): p is Person => !!p)
          .map((p) => [p.id, p]),
      ),
    [bridges.map((b) => b.personId).join()],
  );
  if (!bridges.length) return null;
  return (
    <ul className="space-y-1" data-testid="social-bridges">
      {bridges.map((b) => {
        const p = people?.get(b.personId);
        if (!p) return null;
        return (
          <li
            key={`${b.platform}:${b.personId}`}
            className="flex items-start gap-2 text-[13px]"
            data-testid="social-bridge"
          >
            <span className="mt-[3px] text-ink-3">
              <PlatformMark platform={b.platform} />
            </span>
            <div className="min-w-0 flex-1">
              <Link to={`/people/${p.id}`} className="font-medium hover:underline">
                {p.displayName}
              </Link>
              <div className="text-[12px] text-ink-3" data-testid="social-bridge-evidence">
                {p.firstName} {b.phrase}
                {b.mutual ? '' : ' · a weaker route'} · from {PLATFORM_NAME[b.platform]}
              </div>
              {children?.(b, p)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---- the person page -----------------------------------------------------------------------------------------------

/**
 * The person page's Instagram and X card: their accounts with "Not their account", the open question about them, the
 * checks and what they found, and who follows them. Nothing shows for a source that is off.
 */
export function PersonSocialCard({ user, person }: { user: Pick<User, 'id'>; person: Person }) {
  const toast = useToast();
  const links = usePersonLinks(user.id, person.id);
  const asks = useOpenAsks(user.id, person.id);
  const s = useSources(user.id);
  const [detaching, setDetaching] = useState<SocialLinkRow>();
  const [busy, setBusy] = useState(false);
  const platforms = (['instagram', 'x'] as const).filter(
    (p) => s?.inUse.has(p) && links.some((l) => l.platform === p),
  );
  if (!links.length && !asks.length) return null;
  const first = person.firstName || person.displayName;
  const detach = async () => {
    if (!detaching) return;
    setBusy(true);
    try {
      const r = await detachLink(user.id, detaching.id);
      if (r.ok) toast.push({ text: `${handleOf(detaching)} is no longer attached to ${first}.` });
      else toast.push({ text: r.message, tone: 'bad' });
      setDetaching(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="person-social">
      <div className="font-medium mb-2">Instagram and X</div>
      {links.length > 0 && (
        <ul className="space-y-1.5 text-[13px]">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 min-w-0" data-testid="person-social-link">
              <span className="text-ink-3">
                <PlatformMark platform={l.platform} />
              </span>
              <a
                href={profileUrl(l)}
                target="_blank"
                rel="noreferrer"
                className="font-medium hover:underline truncate"
              >
                {handleOf(l)}
              </a>
              <span className="text-[12px] text-ink-3 shrink-0">
                {l.via === 'student' ? 'you said so' : l.via === 'proof' ? 'proven' : 'matched'}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 text-[12px] text-ink-3 underline underline-offset-2 hover:text-bad"
                onClick={() => setDetaching(l)}
                data-testid="person-social-detach"
              >
                Not their account
              </button>
            </li>
          ))}
        </ul>
      )}
      {asks.map((a) => (
        <div key={a.id} className="mt-3">
          <SocialAskCard user={user} ask={a} bare />
        </div>
      ))}
      {platforms.length > 0 && (
        <div className="mt-3 space-y-2">
          {platforms.map((p) => (
            <div key={p} className="space-y-1.5">
              <SocialCheckButton user={user} person={person} platform={p} />
              <SocialCheckResult user={user} person={person} platform={p} />
            </div>
          ))}
          <SocialBridgeList user={user} target={person} />
        </div>
      )}
      <Modal
        open={!!detaching}
        onClose={() => setDetaching(undefined)}
        title={`Is ${detaching ? handleOf(detaching) : ''} not ${first}?`}
        width={440}
      >
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="person-social-detach-confirm">
          <p>
            Orbit takes the account off {first}. Its messages move to a person of their own, the follows and
            paths it found go, and Orbit will not attach it to {first} again. Your own closeness rating of{' '}
            {first} stays.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDetaching(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void detach()}
              data-testid="person-social-detach-yes"
            >
              Not their account
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
