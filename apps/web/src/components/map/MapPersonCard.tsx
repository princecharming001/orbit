import type { Person, ReachPath } from '@orbit/core';
import { RELATIONSHIP_LABELS, STAGE_LABELS, TIE_BAND_LABELS, tieBand } from '@orbit/core';
import { Link } from 'react-router-dom';
import { Avatar, Chip, cx } from '../../ui';
import { LogoText } from '../CompanyLogo';
import { StrengthDots } from '../people/shared';

/** "Mar 2023": when a tie began or was last touched, said at the grain a glance needs. */
function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** "today", "3 days ago", "5 weeks ago", "Mar 2023": how long since the student last heard from or wrote to them. */
export function lastTouchText(iso: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return monthYear(iso);
}

/**
 * What a route says about the hovered person: how the one before them knows them, and who they can introduce the
 * student to next. Nothing when they are not on the route.
 */
export function routeRole(
  id: string,
  route: ReachPath | undefined,
  nameOf: (id: string) => string,
): { into?: string; next?: string } | undefined {
  if (!route) return undefined;
  const k = route.hops.findIndex((h) => h.toId === id);
  if (k < 0) return undefined;
  const nextHop = route.hops[k + 1];
  return { into: route.hops[k]!.text || undefined, next: nextHop ? nameOf(nextHop.toId) : undefined };
}

/**
 * The card a dot on the map shows on hover or focus: who they are (title, company, LinkedIn headline), how close the
 * student is to them and since when, their stage, and, on a warm path, what their step on it is.
 */
export function MapPersonCard({
  person,
  stage,
  route,
  nameOf,
  touch,
}: {
  person: Person;
  stage?: string;
  route?: ReachPath;
  nameOf: (id: string) => string;
  touch: boolean;
}) {
  const score = person.tieScore ?? Math.round(person.strength * 100);
  const band = person.tieBand ?? tieBand(score);
  // the headline is worth a line only when it says more than the title already does
  const headline =
    person.headline &&
    !(person.currentTitle && person.headline.toLowerCase().startsWith(person.currentTitle.toLowerCase()))
      ? person.headline
      : undefined;
  const how = [
    person.isAlumni ? `${person.school ?? 'Your school'} alum` : undefined,
    person.relationshipType !== 'unknown' && person.relationshipType !== 'alumni'
      ? RELATIONSHIP_LABELS[person.relationshipType]
      : undefined,
    person.linkedinConnectedOn ? `LinkedIn since ${monthYear(person.linkedinConnectedOn)}` : undefined,
  ].filter(Boolean);
  const role = routeRole(person.id, route, nameOf);
  return (
    <div data-testid="map-person-card">
      <div className="flex items-start gap-2.5">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={36} />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{person.displayName}</div>
          {/* the company on a line of its own, so a long title never cuts it off */}
          {person.currentTitle && (
            <div className="text-[12px] text-ink-3 truncate">{person.currentTitle}</div>
          )}
          {person.currentOrganizationRaw && (
            <LogoText person={person} className="text-[12px] text-ink-2">
              <span data-testid="map-tooltip-company">{person.currentOrganizationRaw}</span>
            </LogoText>
          )}
        </div>
        <Link
          to={`/people/${person.id}`}
          className={cx(
            'text-[12px] text-accent shrink-0 pointer-events-auto',
            // a thumb-sized target that does not make the card any taller
            touch
              ? 'inline-flex items-center justify-center min-h-11 min-w-11 -my-2 -mr-2 px-2'
              : '@[40rem]:hidden',
          )}
          data-testid="map-open-person"
        >
          Open
        </Link>
      </div>
      {headline && (
        <p className="mt-2 text-[12px] text-ink-2 leading-snug line-clamp-2" data-testid="map-card-headline">
          {headline}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5" data-testid="map-card-closeness">
          <StrengthDots v={person.strength} />
          <span className="text-ink-2">{TIE_BAND_LABELS[band]}</span>
          <span>· {score}/100</span>
        </span>
        {stage ? <Chip>{STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage}</Chip> : null}
      </div>
      {(how.length > 0 || person.lastInteractionAt) && (
        <div className="mt-1 text-[12px] text-ink-3 truncate">
          {[
            ...how,
            person.lastInteractionAt ? `last talked ${lastTouchText(person.lastInteractionAt)}` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {role && (
        <div className="mt-2 pt-2 border-t border-line text-[12px] text-ink-2" data-testid="map-card-route">
          {role.into && <div className="line-clamp-2">{role.into}</div>}
          {role.next && <div className="text-ink-3">Can introduce you to {role.next}</div>}
        </div>
      )}
    </div>
  );
}
