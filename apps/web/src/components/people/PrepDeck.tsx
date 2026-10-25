/**
 * The Prep deck (docs/plan/22-prep-deck.md): everything for a call, one card at a time, opened from About's Prep
 * button (or the header just before a chat) as `?prep=1` on the person's page. The cards come from buildPrepDeck; this
 * gathers what it needs from rows Orbit already has (it never reads LinkedIn, starts research or spends anything),
 * draws each card, keeps the questions the student picks on the chat, and holds the After the call card: who they
 * suggested, and Log this chat. The card the student was on is kept for this tab's session.
 */
import type { ActionItem, CalendarEvent, CoffeeChat, FactType, Person, ResumeFacet } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { readRecord } from '../../engine/enrichment/store';
import { togglePrepQuestion } from '../../engine/facts';
import { buildReachGraph, mutualStandings } from '../../engine/graph';
import {
  knownOrganisations,
  readSuggestedNames,
  type SuggestedName,
  saveSuggestedContacts,
} from '../../engine/introductions';
import { moveChatGuarded } from '../../engine/pipeline';
import { buildPrep } from '../../engine/prep';
import { buildPrepDeck, type PrepCard, type PrepCardKind, type PrepLine } from '../../engine/prepDeck';
import { dossierView } from '../../engine/research';
import { useSession } from '../../state/session';
import { Avatar, Button, cx, useToast } from '../../ui';
import { DeckLayer, DeckProgress, useDeckFocus, useDeckKeys, useDeckSwipe } from '../../ui/Deck';
import { CompanyLogo } from '../CompanyLogo';

// the card the student is on, by its kind: cards that arrive later (the mutuals) never move them to another card
const POSITION_KEY = (personId: string) => `orbit.prep.${personId}`;
const readPosition = (personId: string): PrepCardKind | undefined => {
  try {
    return (sessionStorage.getItem(POSITION_KEY(personId)) as PrepCardKind | null) ?? undefined;
  } catch {
    return undefined;
  }
};
const writePosition = (personId: string, kind: PrepCardKind) => {
  try {
    sessionStorage.setItem(POSITION_KEY(personId), kind);
  } catch {}
};

/** "Oct 12", or "Oct 12, 2024" from another year. */
const shortDate = (iso: string, tz?: string) => {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: tz,
  });
};

export function PrepDeck({
  person,
  chat,
  chats,
  event,
  facts,
  timeline,
  items,
  resumeFacets,
  onClose,
}: {
  person: Person;
  chat?: CoffeeChat;
  chats: CoffeeChat[];
  /** the next chat on the calendar, or the one that just ended */
  event?: CalendarEvent;
  facts: { type: string; text: string }[];
  timeline: { at: string; text: string }[];
  items: Pick<ActionItem, 'text' | 'status'>[];
  resumeFacets: ResumeFacet[];
  onClose: () => void;
}) {
  const { user, goals } = useSession();
  const userId = user?.id ?? '';
  const affs = useLiveQuery(() => db.affiliations.where('personId').equals(person.id).toArray(), [person.id]);
  const dossier = useLiveQuery(
    async () =>
      (await db.dossiers.where('personId').equals(person.id).toArray())
        .filter((x) => x.status === 'ready' || x.status === 'partial')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
    [person.id],
  );
  const rec = useLiveQuery(() => readRecord(person.id), [person.id]);
  // their posts as the map's route check already read them: the deck reads nothing new
  const engagement = useLiveQuery(
    async () =>
      userId && person.linkedinMemberId
        ? ((await db.engagement.get(`${userId}:${person.linkedinMemberId}`)) ?? null)
        : null,
    [userId, person.linkedinMemberId],
  );
  // the mutuals who know them best, weighed the way the map weighs a route's hops
  const [mutuals, setMutuals] = useState<{ personId: string; name: string; phrase: string }[]>();
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void (async () => {
      const edges = await db.edges
        .where('userId')
        .equals(userId)
        .filter((e) => e.personAId === person.id || e.personBId === person.id)
        .toArray();
      const ids = [...new Set(edges.map((e) => (e.personAId === person.id ? e.personBId : e.personAId)))];
      if (!ids.length) return live && setMutuals([]);
      const { g, people } = await buildReachGraph(userId);
      const standing = mutualStandings(g, person.id, ids);
      const best = [...standing.entries()]
        .filter(([, s]) => !s.blocked && s.band !== 'unclear')
        .sort(([, a], [, b]) => b.know * b.ask - a.know * a.ask)
        .slice(0, 3)
        .map(([id, s]) => ({
          personId: id,
          name: people.get(id)?.displayName ?? 'Someone',
          phrase: s.phrase,
        }));
      if (live) setMutuals(best);
    })().catch(() => live && setMutuals([]));
    return () => {
      live = false;
    };
  }, [userId, person.id]);

  const deck = useMemo(() => {
    if (!user || affs === undefined || dossier === undefined) return undefined;
    const plan = buildPrep({
      user,
      goals,
      person,
      facts: facts as { type: FactType; text: string }[],
      chats,
      event,
      resumeFacets,
      now: new Date(),
    });
    const linkedin = affs.filter((a) => a.source === 'linkedin_profile');
    return buildPrepDeck({
      person,
      user: { school: user.school },
      plan,
      now: new Date(),
      event,
      chat,
      affiliations: linkedin.length ? linkedin : affs,
      brief: dossier ? dossierView(dossier) : undefined,
      posts: engagement?.posts,
      jobChange: rec?.jobChange,
      mutuals,
      mine: {
        orgs: resumeFacets
          .filter((f) => f.kind === 'experience' && f.organizationName)
          .map((f) => f.organizationName!),
      },
      timeline,
      openItems: items.filter((i) => i.status === 'open'),
      facts,
      when: (iso) => shortDate(iso, user.timezone || undefined),
    });
  }, [
    user,
    goals,
    person,
    facts,
    chats,
    event,
    resumeFacets,
    affs,
    dossier,
    engagement,
    rec,
    mutuals,
    chat,
    timeline,
    items,
  ]);

  const count = deck?.cards.length ?? 0;
  const [kind, setKind] = useState<PrepCardKind>();
  // where the deck opens: the card the student left it on this session, else the deck's own start
  useEffect(() => {
    if (!deck || kind !== undefined) return;
    const saved = readPosition(person.id);
    setKind(saved && deck.cards.some((c) => c.kind === saved) ? saved : deck.cards[deck.start]?.kind);
  }, [deck, kind, person.id]);
  const found = deck && kind ? deck.cards.findIndex((c) => c.kind === kind) : -1;
  const at = found >= 0 ? found : (deck?.start ?? 0);
  const go = useCallback(
    (to: number) => {
      const next = deck?.cards[Math.max(0, Math.min(count - 1, to))];
      if (!next) return;
      setKind(next.kind);
      writePosition(person.id, next.kind);
    },
    [deck, count, person.id],
  );
  const ref = useRef<HTMLElement>(null);
  useDeckKeys(ref, { open: true, i: at, go, onEscape: onClose });
  useDeckFocus(ref, true, at);
  const swipe = useDeckSwipe(at, go);

  const card = deck?.cards[at];
  const isLast = at === count - 1;
  return (
    <DeckLayer
      deckRef={ref}
      label={`Prep for your chat with ${person.firstName || person.displayName}`}
      testId="prep-deck"
      step={card?.kind}
      onBackdrop={onClose}
      swipe={swipe}
    >
      <header className="px-4 md:px-5 pt-2.5 md:pt-4 pb-2 flex items-center gap-2">
        <DeckProgress count={Math.max(count, 1)} i={at} label="Prep progress" testId="prep-progress" />
        <span className="text-[12px] text-ink-3 tabular shrink-0" data-testid="prep-counter">
          {count ? `${at + 1} of ${count}` : ''}
        </span>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center text-ink-3 hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Close prep"
          title="Close (Esc)"
          data-testid="prep-close"
        >
          <X size={16} />
        </button>
      </header>
      <div className="px-5 md:px-6 pb-4 flex-1 min-h-0 overflow-y-auto scroll-thin" key={card?.kind}>
        {!deck || !card ? (
          <p className="text-[13px] text-ink-3 pt-6">Getting your prep ready…</p>
        ) : (
          <div className="fade-up">
            <div className="flex items-center gap-2 text-[12px] text-ink-3 mb-2">
              <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={20} />
              <span className="truncate">{person.displayName}</span>
            </div>
            <h2
              className="text-[22px] leading-tight font-medium tracking-[-0.01em]"
              data-testid="prep-card-title"
            >
              {card.title}
            </h2>
            {card.lead && <p className="mt-1.5 text-[14px] text-ink-2">{card.lead}</p>}
            {card.kind === 'questions' ? (
              <Questions card={card} chat={chat} personFirst={person.firstName} />
            ) : (
              <Lines lines={card.lines} sources={deck.sources} big={card.kind === 'intro'} />
            )}
            {card.more && (
              <div className="mt-4">
                <div className="text-[11.5px] uppercase tracking-wide text-ink-3 mb-1.5">
                  {card.more.heading}
                </div>
                <Lines lines={card.more.lines} sources={deck.sources} />
              </div>
            )}
            {card.kind === 'lately' && !dossier && (
              <Link
                to={`/people/${person.id}?tab=facts`}
                onClick={onClose}
                className="mt-3 inline-block text-[13px] underline underline-offset-4 text-ink-2 hover:text-ink"
                data-testid="prep-research-link"
              >
                Go to Deep research
              </Link>
            )}
            {(card.kind === 'lately' || card.kind === 'openers') && dossier && (
              <p className="mt-4 text-[11.5px] text-ink-3">
                Public professional sources only, every line cited, kept 90 days.
              </p>
            )}
            {card.kind === 'after' && <After person={person} chat={chat} userId={userId} />}
          </div>
        )}
      </div>
      <footer className="px-3 md:px-4 py-3 border-t border-line-2 flex items-center gap-2 min-h-[60px]">
        <button
          onClick={() => go(at - 1)}
          disabled={at === 0}
          className="w-9 h-9 shrink-0 rounded-full inline-flex items-center justify-center text-ink-2 hover:bg-canvas-2 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Back"
          title="Back (←)"
          data-testid="prep-back"
        >
          <ChevronLeft size={17} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3 hidden md:block" aria-hidden>
          ← → to move · Esc to close
        </span>
        <span className="flex-1 md:hidden" />
        <Button
          size="sm"
          variant="primary"
          className="shrink-0"
          onClick={() => (isLast ? onClose() : go(at + 1))}
          data-primary="true"
          data-testid="prep-next"
          title={isLast ? 'Done' : 'Next (→)'}
        >
          {isLast ? 'Done' : 'Next'}
          {!isLast && <ChevronRight size={14} />}
        </Button>
      </footer>
    </DeckLayer>
  );
}

/** A card's lines: a small label, the text, a logo, a link, and the research brief's [n] marks. */
function Lines({
  lines,
  sources,
  big,
}: {
  lines: PrepLine[];
  sources: { n: number; url?: string; demo?: boolean }[];
  big?: boolean;
}) {
  if (!lines.length) return null;
  return (
    <ul className={cx('mt-4 space-y-3', big && 'space-y-2')} data-testid="prep-lines">
      {lines.map((l, k) => (
        <li key={k} className="flex items-start gap-2.5">
          {l.org && (
            <span className="mt-0.5 shrink-0">
              <CompanyLogo name={l.org.name} orgId={l.org.id} size={22} decorative />
            </span>
          )}
          <div className="min-w-0">
            {l.label && <div className="text-[11.5px] uppercase tracking-wide text-ink-3">{l.label}</div>}
            <div
              className={cx(
                l.muted
                  ? 'text-[12.5px] text-ink-3'
                  : big
                    ? 'text-[17px] leading-relaxed text-ink'
                    : 'text-[14px] text-ink',
              )}
            >
              {l.href ? (
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4"
                >
                  {l.text}
                </a>
              ) : l.personId ? (
                <Link to={`/people/${l.personId}`} className="hover:underline underline-offset-4">
                  {l.text}
                </Link>
              ) : (
                l.text
              )}
              {l.sources?.map((n) => {
                const s = sources.find((x) => x.n === n);
                return s?.url && !s.demo ? (
                  <a
                    key={n}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ml-0.5 align-super text-[10px] text-ink-3 hover:text-ink"
                  >
                    [{n}]
                  </a>
                ) : (
                  <span key={n} className="ml-0.5 align-super text-[10px] text-ink-3">
                    [{n}]
                  </span>
                );
              })}
            </div>
            {l.detail && <div className="text-[12.5px] text-ink-3">{l.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Questions: tick up to three, kept on the chat; the closing question always last. */
function Questions({ card, chat, personFirst }: { card: PrepCard; chat?: CoffeeChat; personFirst: string }) {
  const picked = chat?.prepQuestions ?? [];
  return (
    <>
      <p className="mt-1.5 text-[13px] text-ink-3">
        {chat
          ? 'Tick up to three you most want answered. Orbit keeps them with this chat.'
          : 'Pick three to lead with.'}
      </p>
      <ol className="mt-3 space-y-2.5" data-testid="prep-questions">
        {card.lines.map((l, k) => (
          <li key={l.text} className="flex items-start gap-2.5 text-[14px]">
            {chat ? (
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={picked.includes(l.text)}
                // three is the point: more than that and nothing gets asked properly
                disabled={!picked.includes(l.text) && picked.length >= 3}
                onChange={() => void togglePrepQuestion(chat.id, l.text)}
                aria-label={`Pick question ${k + 1}`}
              />
            ) : (
              <span className="text-ink-3 tabular w-4 shrink-0">{k + 1}.</span>
            )}
            <span>{l.text}</span>
          </li>
        ))}
        <li className="flex items-start gap-2.5 text-[14px] pt-1 border-t border-line-2">
          <span className="text-ink-3 w-4 shrink-0" aria-hidden>
            ↳
          </span>
          <span>
            <span className="font-medium">Always close with:</span> Is there anyone else you'd suggest I talk
            to?
          </span>
        </li>
      </ol>
      {picked.length > 0 && (
        <p className="text-[12px] text-ink-3 mt-2" data-testid="prep-picked">
          {picked.length} picked for this chat with {personFirst}.
        </p>
      )}
    </>
  );
}

/**
 * After the call: Log this chat (it moves to Completed and Orbit drafts the thank-you), and who they suggested you talk
 * to. Clear names are saved; names Orbit is not sure are people wait for a yes; what is not a name stays in the field.
 */
function After({ person, chat, userId }: { person: Person; chat?: CoffeeChat; userId: string }) {
  const { user } = useSession();
  const toast = useToast();
  const [suggested, setSuggested] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const [notSaved, setNotSaved] = useState<string[]>([]);
  const [unsure, setUnsure] = useState<SuggestedName[]>([]);
  const keep = async (list: SuggestedName[]) => {
    const people = await saveSuggestedContacts(userId, person.id, list);
    if (people.length) setAdded((a) => [...a, ...people.map((p) => p.displayName)]);
  };
  const label = (s: SuggestedName) => (s.org ? `${s.name} at ${s.org}` : s.name);
  const done = !!chat?.completedAt || ['completed', 'followed_up', 'nurturing'].includes(chat?.stage ?? '');
  return (
    <div className="mt-5 space-y-4 text-[13.5px]">
      {chat && !done && (
        <div className="rounded-[14px] border border-line p-3">
          <p className="text-ink-2">
            Had the chat? Log it, and Orbit moves it to Completed and drafts your thank-you.
          </p>
          <Button
            size="sm"
            className="mt-2"
            data-testid="prep-log-chat"
            onClick={async () => {
              if (!user) return;
              const r = await moveChatGuarded(user, chat, 'completed', 'user:prep');
              if (r.outcome === 'meeting_ahead')
                toast.push({
                  text: 'Your chat is still ahead on your calendar. Log it once it has happened.',
                });
              else toast.push({ text: 'Logged. Your thank-you is waiting in Drafts.', tone: 'good' });
            }}
          >
            Log this chat
          </Button>
        </div>
      )}
      <div>
        <label className="block text-ink-2" htmlFor="prep-suggested">
          Who did {person.firstName} suggest you talk to?
        </label>
        <input
          id="prep-suggested"
          data-testid="prep-suggested"
          value={suggested}
          onChange={(e) => setSuggested(e.target.value)}
          placeholder="Priya Shah at Stripe, Tom Lee"
          className="mt-1 w-full h-9 rounded-lg border border-line px-2.5 text-[13.5px] bg-canvas"
          onKeyDown={async (e) => {
            if (e.key !== 'Enter' || !suggested.trim()) return;
            e.preventDefault();
            // an organisation the student already has ("Wilson Sonsini") is a company, never a person
            const knownOrgs = await knownOrganisations(userId);
            const { names, confirm, skipped } = readSuggestedNames(suggested, { knownOrgs });
            await keep(names);
            setUnsure((u) => [
              ...u,
              ...confirm.filter((c) => !u.some((x) => x.name.toLowerCase() === c.name.toLowerCase())),
            ]);
            setNotSaved(skipped);
            setSuggested(skipped.join(', '));
          }}
        />
        <p className="mt-1 text-[12px] text-ink-3">Press Enter to save them to Discover.</p>
      </div>
      {unsure.length > 0 && (
        <div className="rounded-lg border border-line p-2.5" data-testid="prep-suggested-confirm">
          <p className="text-ink-2">
            Are these people {person.firstName} suggested? Nothing is saved until you say yes.
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {unsure.map((s) => (
              <li key={label(s)} className="flex flex-wrap items-center gap-2" data-testid="prep-confirm-row">
                <span className="flex-1 min-w-0 font-medium">{label(s)}</span>
                <Button
                  size="sm"
                  data-testid="prep-confirm-save"
                  onClick={async () => {
                    setUnsure((u) => u.filter((x) => x !== s));
                    await keep([s]);
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="prep-confirm-skip"
                  onClick={() => setUnsure((u) => u.filter((x) => x !== s))}
                >
                  Not a person
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notSaved.length > 0 && (
        <p className="text-ink-2" data-testid="prep-suggested-skipped">
          Not saved: {notSaved.join(', ')}. Write each as a full name, like Priya Shah at Stripe or Tom Lee.
        </p>
      )}
      {added.length > 0 && (
        <p className="text-ink-3">
          Saved to Discover as suggested by {person.firstName}: {added.join(', ')}
        </p>
      )}
    </div>
  );
}
