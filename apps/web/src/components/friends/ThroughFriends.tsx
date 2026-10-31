/**
 * "Through friends" (plan 29 §A1, §A5): on the Map, in Reach and on a company page, the people a friend on Orbit can
 * reach for the student, drawn like a Village path with a friend badge: "Dan Lee · via Ana (friend): she knows Dan
 * well". Ask opens the Friends tab with the ask to that friend started; the friend forwards, never Orbit.
 */
import type { Person, User } from '@orbit/core';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type FriendRoute, friendRoutes, friendsAvailable, throughFriendsLine } from '../../engine/friends';
import { Avatar, Button, Chip, cx } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';

/** The friend routes to a person or a company; undefined while they load, empty with none or no account. */
export function useFriendRoutes(
  user: User | undefined,
  target: { person?: Person; company?: string; domain?: string },
): FriendRoute[] | undefined {
  const [routes, setRoutes] = useState<FriendRoute[]>();
  const key = target.person ? `p:${target.person.id}` : target.company ? `c:${target.company}` : '';
  useEffect(() => {
    if (!user || !key) return;
    if (!friendsAvailable(user)) {
      setRoutes([]);
      return;
    }
    let live = true;
    setRoutes(undefined);
    const t = target.person
      ? { personId: target.person.id }
      : { company: target.company!, ...(target.domain ? { domain: target.domain } : {}) };
    void friendRoutes(user, t)
      .then((r) => live && setRoutes(r))
      .catch(() => live && setRoutes([]));
    return () => {
      live = false;
    };
  }, [user?.id, key]);
  return routes;
}

/** The badge a friend route carries: "via Ana · 77", the score out of 100 as every route shows it. */
export function FriendRouteBadge({ route, className }: { route: FriendRoute; className?: string }) {
  return (
    <Chip
      tone="accent"
      className={className}
      title={`Through ${route.friend.name}, a friend on Orbit: ${route.friend.first} ${route.phrase}. The chance the intro happens, out of 100.`}
      data-testid="route-badge-friend"
    >
      via {route.friend.first} · {Math.round(route.p * 100)}
    </Chip>
  );
}

export function ThroughFriends({
  user,
  target,
  className,
  limit = 6,
}: {
  user: User | undefined;
  target: { person?: Person; company?: string; domain?: string };
  className?: string;
  limit?: number;
}) {
  const nav = useNavigate();
  const routes = useFriendRoutes(user, target);
  const [all, setAll] = useState(false);
  if (!routes?.length) return null;
  // one row per person reached, the best friend route for each
  const seen = new Set<string>();
  const rows = routes.filter((r) => {
    if (seen.has(r.target.nodeId)) return false;
    seen.add(r.target.nodeId);
    return true;
  });
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className={cx('space-y-1.5', className)} data-testid="reach-through-friends">
      <div className="text-[12.5px] font-medium text-ink-2">{throughFriendsLine(rows)}</div>
      <ul className="space-y-1.5">
        {shown.map((r) => (
          <li
            key={r.pathId}
            className="flex items-center gap-2 text-[13px] min-w-0"
            data-testid="reach-friend-route"
          >
            <Avatar name={r.target.name} id={r.target.nodeId} size={22} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{r.target.name}</span>
              <span className="text-ink-3">
                {' · '}
                {r.friend.first} (friend) {r.phrase}
              </span>
            </span>
            <FriendRouteBadge route={r} className="h-5" />
            <Button
              size="sm"
              variant="secondary"
              className={cx('shrink-0', TAP)}
              onClick={() =>
                nav(
                  `/friends?ask=${encodeURIComponent(r.friend.userId)}&target=${encodeURIComponent(
                    r.target.sharedPersonId ?? r.target.name,
                  )}`,
                )
              }
              data-testid="reach-friend-ask"
            >
              Ask {r.friend.first}
            </Button>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button
          type="button"
          className={cx('text-[12px] font-medium text-ink-2 hover:text-ink hover:underline', TAP)}
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
