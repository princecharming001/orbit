/**
 * Discover's cards: a new person a LinkedIn search found (FoundCardView), a person already in the network
 * (NetworkCardView), and the compact proactive pick in "Suggested for you" (SuggestionCard). Every card leads with
 * its most specific reason, shows Match, Reach and Reply odds as segmented meters, and has one main action.
 */
import { Bookmark, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DiscoverCard, FoundAction, FoundCard, NetworkCard } from '../../engine/discoverFeed';
import {
  isColdRecommendation,
  outreachChannelFor,
  type RecommendationDismissReason,
} from '../../engine/recommend';
import { Avatar, Button, cx, Working } from '../../ui';
import { CompanyLogo } from '../CompanyLogo';
import { RoleLine } from '../SuggestionCard';
import { DegreeBadge, DismissMenu, ScoreBars, WhyThem } from './parts';

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

/** The words of a new person's main action. */
export function foundActionLabel(c: FoundCard, action: FoundAction = c.action): string {
  if (action === 'intro' && c.colleague) return `Ask ${c.colleague.firstName} for an intro`;
  if (action === 'save') return 'Save for later';
  if (action === 'write') return 'Write first message';
  return 'Start warm-up';
}

/** The key one card action runs under (`busy`), so the button clicked, and only it, shows the spinner. */
export const actionKey = (id: string, action: string) => `${id}:${action}`;

const cardShell =
  'group/card relative bg-canvas border rounded-[var(--radius-card)] p-4 fade-up flex flex-col gap-3 h-full transition-shadow hover:shadow-[var(--shadow-card)] min-w-0';

export interface FoundHandlers {
  onAct: (card: FoundCard, action: FoundAction) => void;
  onDismiss: (card: FoundCard, reason: RecommendationDismissReason, label: string) => void;
  /** the action being worked on (an actionKey); every card's actions wait for it, one at a time */
  busy?: string;
}

/** A new person from LinkedIn: not in Orbit until the student acts. */
export function FoundCardView({ card, h }: { card: FoundCard; h: FoundHandlers }) {
  const e = card.entry;
  const first = firstName(card.name);
  const busy = !!h.busy;
  const loading = (a: FoundAction) => h.busy === actionKey(card.id, a);
  const headId = `found-${e.memberId}`;
  const profile = e.profileUrl ? { href: e.profileUrl, target: '_blank', rel: 'noreferrer' } : undefined;
  return (
    <article className={cx(cardShell, 'border-line')} data-testid="found-card" aria-labelledby={headId}>
      <div className="flex items-start gap-3">
        <span className="shrink-0">
          <Avatar name={card.name} src={e.pictureUrl} id={e.memberId} size={44} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <a
              {...profile}
              id={headId}
              className="font-medium hover:underline truncate"
              title={e.profileUrl ? `Open ${first}'s LinkedIn profile` : undefined}
            >
              {card.name}
            </a>
            <DegreeBadge distance={e.distance} />
            {e.schoolEvidence && card.scored.parts.school > 0 && (
              <span className="sr-only">Went to your school</span>
            )}
          </div>
          <RoleLine title={card.role} company={e.company} />
          {e.location && <p className="text-[12px] text-ink-3 truncate">{e.location}</p>}
        </div>
        {card.action !== 'save' && (
          <button
            type="button"
            className="shrink-0 -mr-1 -mt-1 w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-canvas-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25"
            aria-label={`Save ${first}`}
            title="Save: add them to your people, to write to later"
            disabled={busy}
            aria-busy={loading('save') || undefined}
            onClick={() => h.onAct(card, 'save')}
            data-testid="found-save"
          >
            {loading('save') ? <Working /> : <Bookmark size={16} />}
          </button>
        )}
      </div>
      <WhyThem reasons={card.why} testId="found-reason" />
      <ScoreBars
        fit={card.metrics.match}
        reach={card.metrics.reach}
        odds={card.metrics.odds}
        testId="found-scores"
      />
      <div className="mt-auto pt-3 border-t border-line-2 flex items-center gap-1.5 min-w-0">
        <Button
          variant="primary"
          size="sm"
          className="min-w-0 max-w-full truncate"
          disabled={busy}
          loading={loading(card.action)}
          onClick={() => h.onAct(card, card.action)}
          data-testid="found-primary"
        >
          {foundActionLabel(card)}
        </Button>
        {card.action !== 'write' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            loading={loading('write')}
            onClick={() => h.onAct(card, 'write')}
            data-testid="found-write"
            title="Add them and write the first message now"
          >
            Write now
          </Button>
        )}
        <DismissMenu onPick={(r, l) => h.onDismiss(card, r, l)} testId="found-dismiss" />
      </div>
    </article>
  );
}

export interface NetworkHandlers {
  onStart: (personId: string, opts?: { skipWarmUp?: boolean }) => void;
  onToggleSave: (card: NetworkCard) => void;
  onDismiss: (card: NetworkCard, reason: RecommendationDismissReason, label: string) => void;
  /** the start being worked on: actionKey(personId, 'start' or 'write') */
  busy?: string;
}

/** Someone already in the student's network, worth reaching now. */
export function NetworkCardView({ card, h }: { card: NetworkCard; h: NetworkHandlers }) {
  const { rec: r, person: p, introducer } = card;
  // known from LinkedIn only: a warm-up or an intro first, and Write now for a student who knows them anyway
  const cold = isColdRecommendation(p, r);
  const busy = !!h.busy;
  return (
    <div
      // every card has the same skeleton, so a row of them lines up: who, why, how strong, how to reach them, and
      // one row of actions pinned to the bottom
      className={cx(cardShell, r.status === 'saved' ? 'border-accent/40' : 'border-line')}
      data-testid="rec-card"
    >
      <div className="flex items-start gap-3">
        <Link to={`/people/${p.id}`} className="shrink-0">
          <Avatar name={card.name} src={p.photoUrl} id={p.id} size={44} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link to={`/people/${p.id}`} className="font-medium hover:underline truncate">
              {card.name}
            </Link>
            {/* an alum: their school's logo, named on hover */}
            {p.isAlumni && p.school && <CompanyLogo name={p.school} label={`${p.school} alum`} size={16} />}
            <span className="shrink-0 px-1.5 h-[18px] inline-flex items-center rounded-full bg-canvas-2 text-[11px] text-ink-3">
              In your network
            </span>
          </div>
          <RoleLine title={p.currentTitle} company={p.currentOrganizationRaw} person={p} />
        </div>
        <button
          type="button"
          className={cx(
            'shrink-0 -mr-1 -mt-1 w-8 h-8 rounded-full inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25',
            r.status === 'saved' ? 'text-accent' : 'text-ink-3 hover:text-ink hover:bg-canvas-2',
          )}
          aria-label={r.status === 'saved' ? `Unsave ${p.firstName}` : 'Save'}
          aria-pressed={r.status === 'saved'}
          title={
            r.status === 'saved'
              ? 'Saved: stays at the top of Discover. Click to unsave.'
              : 'Save: keep them at the top of Discover'
          }
          onClick={() => h.onToggleSave(card)}
          data-testid="rec-save"
        >
          <Bookmark size={16} fill={r.status === 'saved' ? 'currentColor' : 'none'} />
        </button>
      </div>
      <WhyThem reasons={card.why} points={card.points} testId="rec-why" />
      <ScoreBars
        fit={card.metrics.match}
        reach={card.metrics.reach}
        odds={card.metrics.odds}
        testId="rec-scores"
      />
      {/* how to reach them, one quiet line in the same place on every card that needs one (an introducer is
          already among the reasons, and the button below) */}
      {card.action === 'warm_up' && (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-2 min-w-0" data-testid="rec-warmup-why">
          <span className="truncate">Known from LinkedIn only, so warm up first</span>
        </p>
      )}
      <div className="mt-auto pt-3 border-t border-line-2 flex items-center gap-1.5 min-w-0">
        {card.action === 'intro' && introducer ? (
          // someone the student knows can introduce them: that beats a warm-up with a stranger
          <Link to={`/map?reach=${p.id}`} data-testid="rec-intro" className="min-w-0">
            <Button variant="primary" size="sm" className="max-w-full truncate">
              Intro through {introducer.firstName}
            </Button>
          </Link>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            loading={h.busy === actionKey(p.id, 'start')}
            onClick={() => h.onStart(p.id)}
            data-testid="rec-start"
            data-channel={outreachChannelFor(p)}
          >
            {card.action === 'warm_up' ? 'Start warm-up' : 'Write first message'}
          </Button>
        )}
        {cold && (
          // the same choice Today and the person page give: a student who already knows them writes now
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            loading={h.busy === actionKey(p.id, 'write')}
            onClick={() => h.onStart(p.id, { skipWarmUp: true })}
            data-testid="rec-write-now"
            title="Skip the warm-up and write the first message now"
          >
            Write now
          </Button>
        )}
        <DismissMenu onPick={(reason, label) => h.onDismiss(card, reason, label)} />
      </div>
    </div>
  );
}

/** One proactive pick: who, the reason to write now, and one action. */
export function SuggestionCard({
  card,
  found,
  network,
}: {
  card: DiscoverCard;
  found: FoundHandlers;
  network: NetworkHandlers;
}) {
  // the pick's lines: its most specific reason, then the way in when it has one (who could introduce them, people
  // the student knows), so four picks at target companies do not read the same
  const line = card.why[0]?.text;
  const lead = card.why[0];
  const way = card.why.find((w, i) => i > 0 && w.anchor === 'tie' && w.kind !== lead?.kind)?.text;
  if (card.kind === 'found') {
    const e = card.entry;
    return (
      <li className="snap-start shrink-0 w-[min(280px,82vw)] @3xl:w-auto min-w-0" data-testid="suggest-card">
        <div className="relative h-full bg-canvas border border-line rounded-[var(--radius-card)] p-3.5 flex flex-col gap-2.5">
          <div className="flex items-start gap-2.5 pr-6">
            <Avatar name={card.name} src={e.pictureUrl} id={e.memberId} size={36} />
            <div className="min-w-0">
              <p className="font-medium text-[14px] truncate">{card.name}</p>
              <RoleLine title={card.role} company={e.company} />
            </div>
          </div>
          <PickLines line={line} way={way} />
          <div className="mt-auto">
            <Button
              size="sm"
              variant="primary"
              className="max-w-full truncate"
              disabled={!!found.busy}
              loading={found.busy === actionKey(card.id, card.action)}
              onClick={() => found.onAct(card, card.action)}
              data-testid="suggest-action"
            >
              {foundActionLabel(card)}
            </Button>
          </div>
          <button
            type="button"
            className="absolute top-2 right-2 w-7 h-7 rounded-full inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25"
            aria-label={`Not now: hide ${firstName(card.name)}`}
            title="Not now"
            onClick={() => found.onDismiss(card, 'not_now', 'Not now')}
            data-testid="suggest-dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </li>
    );
  }
  const { person: p, introducer } = card;
  return (
    <li className="snap-start shrink-0 w-[min(280px,82vw)] @3xl:w-auto min-w-0" data-testid="suggest-card">
      <div className="relative h-full bg-canvas border border-line rounded-[var(--radius-card)] p-3.5 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5 pr-6">
          <Avatar name={card.name} src={p.photoUrl} id={p.id} size={36} />
          <div className="min-w-0">
            <Link to={`/people/${p.id}`} className="font-medium text-[14px] truncate block hover:underline">
              {card.name}
            </Link>
            <RoleLine title={p.currentTitle} company={p.currentOrganizationRaw} person={p} />
          </div>
        </div>
        <PickLines line={line} way={way} />
        <div className="mt-auto">
          {card.action === 'intro' && introducer ? (
            <Link to={`/map?reach=${p.id}`} className="inline-block max-w-full">
              <Button
                size="sm"
                variant="primary"
                className="max-w-full truncate"
                data-testid="suggest-action"
              >
                Ask {introducer.firstName} for an intro
              </Button>
            </Link>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!!network.busy}
              loading={network.busy === actionKey(p.id, 'start')}
              onClick={() => network.onStart(p.id)}
              data-testid="suggest-action"
            >
              {card.action === 'warm_up' ? 'Start warm-up' : 'Write first message'}
            </Button>
          )}
        </div>
        <button
          type="button"
          className="absolute top-2 right-2 w-7 h-7 rounded-full inline-flex items-center justify-center text-ink-3 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/25"
          aria-label={`Not now: hide ${p.firstName}`}
          title="Not now"
          onClick={() => network.onDismiss(card, 'not_now', 'Not now')}
          data-testid="suggest-dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}

/** A pick's reason and, under it, the way in. */
function PickLines({ line, way }: { line?: string; way?: string }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <p className="text-[12.5px] text-ink-2 line-clamp-2" data-testid="suggest-reason">
        {line}
      </p>
      {way && (
        <p className="text-[12px] text-ink-3 truncate" data-testid="suggest-way">
          {way}
        </p>
      )}
    </div>
  );
}

/** The row of proactive picks at the top of Discover: a swipe on a phone, a grid on a wide screen. */
export function SuggestedRow({
  cards,
  found,
  network,
}: {
  cards: DiscoverCard[];
  found: FoundHandlers;
  network: NetworkHandlers;
}) {
  if (!cards.length) return null;
  return (
    <section className="mb-6" aria-labelledby="discover-suggested" data-testid="discover-suggestions">
      <h2 id="discover-suggested" className="text-[15px] font-medium tracking-[-0.01em] mb-2.5">
        Suggested for you
      </h2>
      <ul className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-4 px-4 scroll-thin @3xl:mx-0 @3xl:px-0 @3xl:grid @3xl:grid-cols-2 @6xl:grid-cols-4 @3xl:overflow-visible">
        {cards.map((c) => (
          <SuggestionCard key={c.id} card={c} found={found} network={network} />
        ))}
      </ul>
    </section>
  );
}
