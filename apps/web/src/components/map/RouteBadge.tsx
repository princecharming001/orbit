import { REACH_BAND_LABELS, type ReachPath } from '@orbit/core';
import { isColdDirect, type WarmReachPath } from '../../engine/graph';
import { Chip } from '../../ui';

/** A route's strength out of 100: the chance the introduction happens, from every hop. */
export const routeScore = (p: { score: number }) => Math.round(Math.max(0, Math.min(1, p.score)) * 100);

export const ROUTE_SCORE_WHY =
  'Strength out of 100: how likely this intro is to happen. Your tie to the first person, times how well each pair along the way knows each other, a little less for each extra hop.';

const DIRECT_WHY =
  'Your own tie to them out of 100: how well you know each other, from how much you have been in touch and how recently.';
const COLD_WHY = 'No one you know is connected to them yet, so a first note would be a cold one.';

/**
 * The route's badge, the same on the Map, the company page and the plan (plan 23 §4.2): "Direct · 68" when the
 * student writes to someone they know, "Strong route · 74" through someone, "Cold tie · 12" for a faint tie of their
 * own, "Weaker route · 30" for a LinkedIn-only first hop, "Cold" with no way in. Hover gives the why.
 */
export function RouteBadge({
  path,
  className,
  testId = 'route-badge',
}: {
  path?: WarmReachPath | ReachPath;
  className?: string;
  testId?: string;
}) {
  if (!path)
    return (
      <Chip className={className} title={COLD_WHY} data-testid={testId}>
        Cold
      </Chip>
    );
  const score = routeScore(path);
  if (isColdDirect(path))
    return (
      <Chip className={className} title={ROUTE_SCORE_WHY} data-testid={testId}>
        Cold tie · {score}
      </Chip>
    );
  if (path.hops.length === 1)
    return (
      <Chip className={className} tone="good" title={DIRECT_WHY} data-testid={testId}>
        Direct · {score}
      </Chip>
    );
  if ((path as WarmReachPath).weak)
    return (
      <Chip
        className={className}
        title={`${(path as WarmReachPath).reason ?? ''} ${ROUTE_SCORE_WHY}`.trim()}
        data-testid={testId}
      >
        Weaker route · {score}
      </Chip>
    );
  return (
    <Chip
      className={className}
      tone={path.band === 'strong' ? 'good' : path.band === 'possible' ? 'warn' : 'neutral'}
      title={ROUTE_SCORE_WHY}
      data-testid={testId}
    >
      {REACH_BAND_LABELS[path.band]} · {score}
    </Chip>
  );
}
