/**
 * Map, Reach: "People who know {first}", the target's LinkedIn mutuals (the student's own connections LinkedIn says
 * are connected to them), closest to the student first, each with how close the student is to them and an "Ask
 * {mutual} for an intro" that drafts the request (the same intro draft flow as the routes). Shown whether or not a
 * route clears the bar, so someone in the student's second degree is never a dead end. Says plainly when LinkedIn is
 * not connected, is still looking, found no one, or failed (with a retry). The sample student's come from the demo.
 */
import type { Person, User } from '@orbit/core';
import { TIE_BAND_LABELS, tieBand } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { targetMutuals } from '../../engine/externalRoutes';
import { buildReachGraph, type MutualStanding, mutualStandings, userTieWeight } from '../../engine/graph';
import { subscribeHopEvidence } from '../../engine/hopEvidence';
import type { MutualsResult, MutualView } from '../../engine/linkedinLive';
import { subscribePairNotes } from '../../engine/pairNotes';
import { isServerUser } from '../../integrations/orbitApi';
import { useShowReasoning } from '../../state/showReasoning';
import { Avatar, Button, cx, LinkedInMark } from '../../ui';
import { PairNoteMenu } from './PairNoteMenu';
import { useClosenessKey } from './useCloseness';

const SHOWN = 5;
const TAP = 'pointer-coarse:min-h-11';

/** The target's mutuals: undefined while LinkedIn is asked; `retry` asks again after a failure. */
export function useTargetMutuals(
  user: User | undefined,
  target: Person | undefined,
): { result?: MutualsResult; retry: () => void } {
  const [state, setState] = useState<{ key: string; result?: MutualsResult }>();
  const [attempt, setAttempt] = useState(0);
  const key = user && target ? `${user.id}:${target.id}:${target.linkedinMemberId ?? ''}` : '';
  useEffect(() => {
    if (!key || !user || !target) return;
    let live = true;
    setState({ key });
    void targetMutuals(user, target).then((result) => live && setState({ key, result }));
    return () => {
      live = false;
    };
    // the target object changes on every read; who it is (and their member id) is what matters
  }, [key, attempt]);
  return {
    result: state?.key === key ? state.result : undefined,
    retry: () => setAttempt((a) => a + 1),
  };
}

interface Row {
  m: MutualView;
  person?: Person;
  /** the student's tie to them, 0–100; -1 for someone not in Orbit */
  score: number;
  /** plan 21: how good a way in they are, from both halves of the hop */
  standing?: MutualStanding;
}

/** How well a mutual knows the target, in the row's words (plan 21 §3.7). */
const knowWords = (band: MutualStanding['band'], first: string) =>
  band === 'close'
    ? `close to ${first}`
    : band === 'know'
      ? `knows ${first}`
      : band === 'connected'
        ? `connected to ${first}`
        : `unclear with ${first}`;

/**
 * Each mutual's standing (plan 21 §3.7): how close the student is to them and how well they know the target, from
 * the same graph the routes rank on. Recomputed when LinkedIn reads land or the student says something about a pair.
 * `notes` counts the student's own changes, so the list re-sorts for those and keeps its order otherwise.
 */
function useStandings(
  userId: string,
  targetId: string,
  ids: string[],
): { standing?: Map<string, MutualStanding>; notes: number } {
  const [state, setState] = useState<{ standing?: Map<string, MutualStanding>; notes: number }>({ notes: 0 });
  const key = ids.join('|');
  // the student's closeness to a mutual changing (a reply read, plan 27) re-ranks the list too
  const closeness = useClosenessKey(ids);
  useEffect(() => {
    if (!ids.length) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (theirs: boolean) => {
      const { g } = await buildReachGraph(userId);
      if (live)
        setState((s) => ({ standing: mutualStandings(g, targetId, ids), notes: s.notes + (theirs ? 1 : 0) }));
    };
    void run(false);
    const offE = subscribeHopEvidence(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(false), 1500);
    });
    const offN = subscribePairNotes(() => void run(true));
    return () => {
      live = false;
      clearTimeout(timer);
      offE();
      offN();
    };
  }, [userId, targetId, key, closeness]);
  return state;
}

export function ReachMutuals({
  user,
  target,
  onAsk,
}: {
  user: User;
  target: Person;
  /** draft an intro request from this person to the target */
  onAsk: (personId: string, score: number) => void;
}) {
  const reasons = useShowReasoning();
  const { result, retry } = useTargetMutuals(user, target);
  const [all, setAll] = useState(false);
  const ids = useMemo(
    () => (result?.mutuals ?? []).map((m) => m.personId).filter((id): id is string => !!id),
    [result],
  );
  const known = useLiveQuery(
    async () => new Map((await db.people.bulkGet(ids)).filter((p): p is Person => !!p).map((p) => [p.id, p])),
    [ids.join('|')],
  );
  const first = target.firstName || target.displayName;
  const { standing, notes } = useStandings(user.id, target.id, ids);
  // the order is set when the list (or the student's word on a pair) changes; LinkedIn reads that land while the
  // student reads it update the words, and the order on the next open, so rows never jump under their hand
  const order = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const [showBlocked, setShowBlocked] = useState(false);
  const { rows, blocked } = useMemo(() => {
    const all = (result?.mutuals ?? []).map((m): Row => {
      const person = m.personId ? known?.get(m.personId) : undefined;
      // a mutual is one of the student's LinkedIn connections, so at least that close
      const score = person ? Math.max(Math.round(userTieWeight(person) * 100), 12) : -1;
      return { m, person, score, standing: person ? standing?.get(person.id) : undefined };
    });
    const rowKey = (r: Row) => `${r.m.name}:${r.m.memberId ?? r.m.personId ?? ''}`;
    const value = (r: Row) => (r.standing ? r.standing.ask * r.standing.know : -1);
    const stamp = `${all.map(rowKey).join('|')}#${notes}#${standing ? 1 : 0}`;
    if (order.current.key !== stamp) {
      const sorted = [...all].sort(
        (a, b) => value(b) - value(a) || b.score - a.score || a.m.name.localeCompare(b.m.name),
      );
      order.current = { key: stamp, ids: sorted.map(rowKey) };
    }
    const pos = new Map(order.current.ids.map((k, i) => [k, i]));
    const sorted = [...all].sort((a, b) => (pos.get(rowKey(a)) ?? 0) - (pos.get(rowKey(b)) ?? 0));
    return {
      rows: sorted.filter((r) => !r.standing?.blocked),
      blocked: sorted.filter((r) => r.standing?.blocked),
    };
  }, [result, known, standing, notes]);

  const heading = (
    <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1.5">
      People who know {first}
      {result?.ok && rows.length > 0 ? ` · ${rows.length}` : ''}
    </div>
  );
  const note = (text: string, testId: string, extra?: ReactNode) => (
    <div data-testid="reach-mutuals">
      {heading}
      <p className="text-[12.5px] text-ink-3" data-testid={testId}>
        {text}
        {extra}
      </p>
    </div>
  );

  if (!result)
    return (
      <div data-testid="reach-mutuals" aria-busy="true">
        {heading}
        <p className="text-[12.5px] text-ink-3" data-testid="reach-mutuals-loading">
          Looking up who you know who knows {first}…
        </p>
      </div>
    );
  if (!result.ok) {
    // with an Orbit account LinkedIn is linked on the server, which this browser's lookup cannot see: say nothing
    if (result.reason === 'not_connected' && isServerUser(user.id)) return null;
    if (result.reason === 'not_connected')
      return note(
        `Connect LinkedIn to see which of your connections know ${first}. `,
        'reach-mutuals-connect',
        <Link to="/settings/integrations" className={cx('text-ink underline underline-offset-4', TAP)}>
          Connect LinkedIn
        </Link>,
      );
    if (result.reason === 'no_member_id')
      return note(
        target.linkedinUrl || target.linkedinSlug
          ? `LinkedIn could not match ${first}'s profile yet, so Orbit cannot list who you both know.`
          : `Orbit does not have ${first}'s LinkedIn profile, so it cannot look up who you both know.`,
        'reach-mutuals-no-profile',
      );
    if (result.reason === 'unconfigured') return note(result.message, 'reach-mutuals-unconfigured');
    // today's reads are used up: when they come back, and no Try again that cannot work
    if (result.reason === 'limit') return note(result.message, 'reach-mutuals-limit');
    return note(
      `${result.message} `,
      'reach-mutuals-error',
      <button
        type="button"
        className={cx('text-ink underline underline-offset-4', TAP)}
        onClick={retry}
        data-testid="reach-mutuals-retry"
      >
        Try again
      </button>,
    );
  }
  if (!rows.length && !blocked.length)
    return note(
      result.source === 'demo'
        ? `No one in the sample network knows ${first}.`
        : `None of your LinkedIn connections is connected to ${first}.`,
      'reach-mutuals-none',
    );
  return (
    <div data-testid="reach-mutuals">
      {heading}
      <ul className="space-y-2">
        {(all ? rows : rows.slice(0, SHOWN)).map(({ m, person, score, standing }) => {
          const name = person?.displayName ?? m.name;
          const mFirst = person?.firstName || name.split(' ')[0] || name;
          const url = m.url ?? person?.linkedinUrl;
          return (
            <li
              key={`${m.name}:${m.memberId ?? m.personId ?? ''}`}
              className="group flex items-center gap-2.5 text-[13px] min-w-0"
              data-testid="reach-mutual"
            >
              <Avatar name={name} src={m.pictureUrl ?? person?.photoUrl} id={person?.id ?? name} size={30} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  {person ? (
                    <Link to={`/people/${person.id}`} className="font-medium hover:underline truncate">
                      {name}
                    </Link>
                  ) : (
                    <span className="font-medium truncate">{name}</span>
                  )}
                  {url && /linkedin\.com/i.test(url) && <LinkedInMark url={url} name={name} />}
                </div>
                <div
                  className="text-[12px] text-ink-3"
                  title={`How close you are to them, and how well they know ${first}`}
                  data-testid="reach-mutual-closeness"
                >
                  {person
                    ? `You: ${TIE_BAND_LABELS[tieBand(score)].toLowerCase()} · ${score}${
                        standing
                          ? ` · ${knowWords(standing.band, first)} · ${Math.round(standing.know * 100)}`
                          : ''
                      }`
                    : 'Not in your Orbit yet'}
                </div>
                {person && standing && reasons && (
                  <div className="text-[12px] text-ink-3" data-testid="reach-mutual-evidence">
                    {mFirst} {standing.phrase}
                  </div>
                )}
                {person && (
                  <PairNoteMenu
                    userId={user.id}
                    aId={person.id}
                    bId={target.id}
                    aName={mFirst}
                    bName={first}
                    // on hover or focus with a mouse, always on touch: one correction per row without the clutter
                    className="block transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
                  />
                )}
              </div>
              {person && (
                <Button
                  size="sm"
                  variant="secondary"
                  className={cx('shrink-0', TAP)}
                  onClick={() => onAsk(person.id, score / 100)}
                  data-testid="reach-mutual-ask"
                >
                  Ask {mFirst} for an intro
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > SHOWN && (
        <button
          type="button"
          className={cx('mt-1.5 text-[12px] font-medium text-ink-2 hover:text-ink hover:underline', TAP)}
          onClick={() => setAll((v) => !v)}
          data-testid="reach-mutuals-more"
        >
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
      {blocked.length > 0 && (
        <div className="mt-1.5 text-[12px] text-ink-3" data-testid="reach-mutuals-blocked">
          <button
            type="button"
            className={cx('underline underline-offset-4 hover:text-ink', TAP)}
            onClick={() => setShowBlocked((v) => !v)}
          >
            {showBlocked ? 'Hide' : `${blocked.length} hidden: you said they don’t really know ${first}`}
          </button>
          {showBlocked && (
            <ul className="mt-1 space-y-1">
              {blocked.map(({ m, person }) =>
                person ? (
                  <li key={person.id}>
                    <PairNoteMenu
                      userId={user.id}
                      aId={person.id}
                      bId={target.id}
                      aName={person.firstName || person.displayName}
                      bName={first}
                    />
                  </li>
                ) : (
                  <li key={m.name}>{m.name}</li>
                ),
              )}
            </ul>
          )}
        </div>
      )}
      {reasons && (
        <p className="mt-1.5 text-[12px] text-ink-3">
          {result.source === 'demo' ? 'Sample connections from the demo.' : 'From your LinkedIn.'} Best way in
          first: how close you are to them, and how well they know {first}.
        </p>
      )}
    </div>
  );
}
