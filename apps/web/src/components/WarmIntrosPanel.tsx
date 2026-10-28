/**
 * Map panels: warm intro paths from Village (the sample student's from the demo graph) above Orbit's own routes,
 * each with the warmth in a word, the hops, and an "Ask X for an intro" action. Shows nothing when warm intros are
 * off or there are none, so the local routes stand alone.
 */
import type { Person, User } from '@orbit/core';
import { useEffect, useState } from 'react';
import { type WarmIntro, warmIntrosFor } from '../engine/warmIntros';
import { Button, Chip, cx } from '../ui';

/** Warm intro paths to a person or a company (undefined while they load; empty when warm intros are off). */
export function useWarmIntros(
  user: User | undefined,
  target?: Person,
  company?: string,
): WarmIntro[] | undefined {
  const [intros, setIntros] = useState<WarmIntro[]>();
  const key = target ? `p:${target.id}` : company ? `c:${company}` : '';
  useEffect(() => {
    if (!key || !user) return;
    setIntros(undefined);
    const ctrl = new AbortController();
    let live = true;
    warmIntrosFor(user, target ? { person: target } : { company }, { signal: ctrl.signal })
      .then((r) => live && setIntros(r))
      .catch(() => live && setIntros([]));
    return () => {
      live = false;
      ctrl.abort();
    };
    // the target object changes on every live read; only who it is matters here
  }, [key, user?.id]);
  return intros;
}

export function WarmIntrosPanel({
  user,
  target,
  company,
  onAsk,
  isAsking,
  className,
}: {
  user: User;
  target?: Person;
  company?: string;
  /** draft an intro request from this person to that one (the map's own "Ask X for an intro") */
  onAsk: (connectorId: string, targetId: string, warmth: number) => void;
  /** that request is being drafted: its button spins */
  isAsking?: (connectorId: string, targetId: string) => boolean;
  className?: string;
}) {
  const intros = useWarmIntros(user, target, company);
  if (!intros?.length) return null;
  return (
    <div className={cx('space-y-1.5', className)} data-testid="map-warm-intros">
      <div className="text-[12px] uppercase tracking-wide text-ink-3">Warm intros · {intros.length}</div>
      <ul className="space-y-2">
        {intros.map((w) => {
          const first = w.introducer.name.split(' ')[0] ?? w.introducer.name;
          const canAsk =
            !!w.introducer.personId && !!w.targetPersonId && w.introducer.personId !== w.targetPersonId;
          return (
            <li
              key={`${w.introducer.name}:${w.hops.join('>')}`}
              className="border border-line rounded-[12px] p-3 text-[13px]"
              data-testid="map-warm-intro"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{w.introducer.name}</span>
                <Chip
                  tone={w.warmthWord === 'warm' ? 'good' : w.warmthWord === 'good' ? 'accent' : 'neutral'}
                >
                  {w.warmthWord}
                </Chip>
              </div>
              {w.hops.length > 1 && <div className="mt-1 text-ink-2">{w.hops.join(' → ')}</div>}
              {w.note && <div className="text-[12px] text-ink-3">{w.note}</div>}
              {canAsk && (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => onAsk(w.introducer.personId!, w.targetPersonId!, w.warmth)}
                  loading={isAsking?.(w.introducer.personId!, w.targetPersonId!)}
                  data-testid="map-warm-intro-ask"
                >
                  Ask {first} for an intro
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
