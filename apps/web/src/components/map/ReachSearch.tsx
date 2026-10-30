import type { Person, User } from '@orbit/core';
import { Building2, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReachCandidate } from '../../engine/graph';
import { type FoundView, linkedInSearchReady, searchLinkedInLive } from '../../engine/linkedinSearch';
import { Avatar, cx, Spinner, Working } from '../../ui';

/** LinkedIn is asked once typing pauses this long, and only from this many letters (LinkedIn limits searches a day). */
const LINKEDIN_PAUSE_MS = 650;
const LINKEDIN_MIN_CHARS = 3;

/**
 * LinkedIn people for what the student is typing, once they pause: their photos, names and headlines. Answers are
 * kept for the visit, so going back over a word asks LinkedIn nothing new.
 */
function useLinkedInResults(userId: string, q: string) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<{ q: string; people: FoundView[]; loading: boolean; error?: string }>({
    q: '',
    people: [],
    loading: false,
  });
  const cache = useRef(new Map<string, FoundView[]>());
  useEffect(() => {
    let live = true;
    void linkedInSearchReady({ id: userId }).then((r) => live && setReady(r));
    return () => {
      live = false;
    };
  }, [userId]);
  const query = q.trim();
  useEffect(() => {
    if (!ready || query.length < LINKEDIN_MIN_CHARS) {
      setState({ q: query, people: [], loading: false });
      return;
    }
    const hit = cache.current.get(query.toLowerCase());
    if (hit) {
      setState({ q: query, people: hit, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    let live = true;
    const t = setTimeout(async () => {
      const r = await searchLinkedInLive({ id: userId }, query);
      if (!live) return;
      if (r.ok) {
        const people = r.people.slice(0, 6);
        cache.current.set(query.toLowerCase(), people);
        setState({ q: query, people, loading: false });
      } else setState({ q: query, people: [], loading: false, error: r.message });
    }, LINKEDIN_PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ready, query, userId]);
  return { ready, ...state };
}

type Row = { kind: 'network'; c: ReachCandidate; person?: Person } | { kind: 'linkedin'; f: FoundView };

/**
 * The Reach search, at the top of the side panel: people and companies from the student's network as they type, then
 * people on LinkedIn with their photos once they pause. Picking one shows the routes to them.
 */
export function ReachSearch({
  user,
  query,
  onQuery,
  network,
  byId,
  onPick,
  onPickLinkedIn,
  onSubmit,
  compact,
  shake,
  placeholder = 'Search a person or company',
  hint,
  linkedIn: withLinkedIn = true,
  autoFocus = true,
  adding,
}: {
  user: Pick<User, 'id'>;
  query: string;
  onQuery: (q: string) => void;
  network: ReachCandidate[];
  byId: Map<string, Person>;
  onPick: (c: ReachCandidate) => void;
  onPickLinkedIn: (f: FoundView) => void;
  onSubmit: (q: string) => void;
  /** a route or a company is open below: the results only show while the student is typing */
  compact?: boolean;
  /** the last search found no one: the box shakes once, and again for each search after it that finds no one */
  shake?: number;
  placeholder?: string;
  /** the line under the empty box; null for none (the default names who the search reaches) */
  hint?: ReactNode | null;
  /** false: only the student's own network (the introductions view searches its people alone) */
  linkedIn?: boolean;
  /** someone picked from LinkedIn is being added: the list has closed, so the box itself shows the work */
  adding?: boolean;
  /** false: the box waits to be clicked (the map's own page should not open on a phone's keyboard) */
  autoFocus?: boolean;
}) {
  const li = useLinkedInResults(
    user.id,
    withLinkedIn && !/^\s*(https?:\/\/|www\.)/i.test(query) ? query : '',
  );
  const [open, setOpen] = useState(!compact);
  const [at, setAt] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // each miss replays the shake without remounting the box, so the caret stays in it
  useEffect(() => {
    const el = form.current;
    if (!el || !shake) return;
    el.classList.remove('shake-x');
    el.getBoundingClientRect();
    el.classList.add('shake-x');
  }, [shake]);
  useEffect(() => {
    const el = input.current;
    if (compact || !autoFocus || !el) return;
    // typing that began in the top bar goes on here: the caret lands after what was typed
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [compact, autoFocus]);
  // someone the student already has is shown once, from their network
  const linkedIn = li.people.filter((f) => !f.knownPersonId);
  const rows: Row[] = useMemo(
    () => [
      ...network.map(
        (c): Row => ({ kind: 'network', c, person: c.kind === 'person' ? byId.get(c.id) : undefined }),
      ),
      ...linkedIn.map((f): Row => ({ kind: 'linkedin', f })),
    ],
    [network, linkedIn, byId],
  );
  const pick = (r: Row) => {
    setOpen(false);
    setAt(-1);
    if (r.kind === 'network') onPick(r.c);
    else onPickLinkedIn(r.f);
  };
  const q = query.trim();
  // a pasted job link is read on Enter, not searched for as a name
  const isLink = /^(https?:\/\/|www\.)/i.test(q);
  const showList = open && q.length > 0 && !isLink;
  return (
    // pinned to the top of the panel, so it stays at hand while the routes below scroll
    <div
      className={cx(
        'sticky -top-4 z-10 -mx-4 -mt-4 space-y-3 bg-canvas px-4 pt-4 pb-2',
        // on a phone, with a route or a company open below, the routes come first: Exit reach brings the search back
        compact && '@max-4xl:hidden',
      )}
      data-testid="reach-search"
    >
      <form
        ref={form}
        className={cx('relative', !!shake && 'shake-x')}
        data-testid="reach-form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const r = at >= 0 ? rows[at] : undefined;
          if (r) pick(r);
          else if (q) {
            setOpen(false);
            onSubmit(q);
          }
        }}
      >
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
            setAt(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!rows.length) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((i) => (i + 1) % rows.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((i) => (i <= 0 ? rows.length - 1 : i - 1));
            }
          }}
          role="combobox"
          aria-expanded={showList}
          aria-controls="map-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? `map-suggestion-${at}` : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          className="h-11 w-full rounded-full border border-line bg-canvas pl-10 pr-4 text-[14.5px] placeholder:text-ink-3 focus:border-[#bdbab5] focus:outline-none focus:ring-4 focus:ring-ink/[0.06]"
          data-testid="reach-input"
        />
        {adding && <Working className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-3" />}
      </form>
      {!q && !compact && hint !== undefined && hint !== null && (
        <p className="px-1 text-[13px] text-ink-3">{hint}</p>
      )}
      {!q && !compact && hint === undefined && !li.ready && (
        <p className="px-1 text-[13px] text-ink-3">
          <Link to="/settings/integrations" className="underline underline-offset-2 hover:text-ink">
            Connect LinkedIn
          </Link>{' '}
          to search everyone.
        </p>
      )}
      {showList && (
        <div id="map-suggestions" role="listbox" aria-label="Results" data-testid="map-suggestions">
          {network.length > 0 && <p className="label-mono px-1 pb-1">In your network</p>}
          {rows.map((r, i) => {
            const head =
              r.kind === 'linkedin' && (i === 0 || rows[i - 1]!.kind === 'network') ? (
                <p key="li-head" className="label-mono flex items-center gap-2 px-1 pt-3 pb-1">
                  On LinkedIn
                </p>
              ) : null;
            const name = r.kind === 'network' ? r.c.label : r.f.name;
            const sub = r.kind === 'network' ? r.c.sub : r.f.headline;
            return (
              <div key={r.kind === 'network' ? `${r.c.kind}-${r.c.id}` : r.f.id}>
                {head}
                <div
                  role="option"
                  tabIndex={-1}
                  id={`map-suggestion-${i}`}
                  aria-selected={i === at}
                  // mousedown: the pick lands before the box loses focus
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                  onMouseEnter={() => setAt(i)}
                  className={cx(
                    'flex h-14 cursor-pointer items-center gap-3 rounded-[12px] px-2 transition-colors',
                    i === at ? 'bg-canvas-2' : 'hover:bg-canvas-2',
                  )}
                  data-testid={r.kind === 'network' ? 'map-suggestion' : 'map-linkedin-result'}
                >
                  {r.kind === 'network' && r.c.kind === 'company' ? (
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-canvas-2 text-ink-2">
                      <Building2 size={16} />
                    </span>
                  ) : (
                    <Avatar
                      name={name}
                      src={r.kind === 'network' ? r.person?.photoUrl : r.f.pictureUrl}
                      id={r.kind === 'network' ? r.c.id : r.f.id}
                      size={40}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{name}</span>
                    {sub && <span className="block truncate text-[12.5px] text-ink-3">{sub}</span>}
                  </span>
                  <span className="label-mono shrink-0 !text-[10px]">
                    {r.kind === 'linkedin'
                      ? r.f.distance === 2
                        ? '2nd'
                        : r.f.distance === 3
                          ? '3rd'
                          : 'LinkedIn'
                      : r.c.kind === 'person'
                        ? 'Person'
                        : 'Company'}
                  </span>
                </div>
              </div>
            );
          })}
          {li.loading && q.length >= LINKEDIN_MIN_CHARS && (
            <p
              className="flex items-center gap-2 px-1 pt-3 text-[12.5px] text-ink-3"
              data-testid="map-linkedin-loading"
            >
              <Spinner /> Searching LinkedIn…
            </p>
          )}
          {!rows.length && !li.loading && (
            <p className="px-1 text-[13px] text-ink-3">
              {li.ready && q.length < LINKEDIN_MIN_CHARS
                ? 'Keep typing to search LinkedIn.'
                : 'No one by that name yet.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
