import { ArrowRight, ChevronRight, Search, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, cx } from '../../ui';
import { CompanyLogo } from '../CompanyLogo';
import { type CardPlace, OrbitMap } from '../OrbitMap';
import type { FocusSpec } from '../orbitScene';
import {
  type CompanyResult,
  companyResult,
  type Route,
  routesTo,
  SAMPLE_BY_ID,
  SAMPLE_CONNECTIONS,
  SAMPLE_ORGS,
  SAMPLE_PEOPLE,
  type Suggestion,
  suggest,
} from './sampleNetwork';

type Shown =
  | { kind: 'company'; result: CompanyResult }
  | { kind: 'person'; id: string; routes: Route[]; pick: number };

/** What the map plays on its own until the visitor takes over: two companies and two people, one after another. */
const SCRIPT: { type: string; pick: Suggestion['kind']; route?: number }[] = [
  { type: 'Stripe', pick: 'company' },
  { type: 'Priya Ahmed', pick: 'person', route: 1 },
  { type: 'Anthropic', pick: 'company' },
  { type: 'Arjun Cohen', pick: 'person' },
  { type: 'Goldman Sachs', pick: 'company' },
  { type: 'Elena Garcia', pick: 'person' },
];
const TRY = ['Stripe', 'Priya Ahmed', 'Anthropic', 'Arjun Cohen'];

const EMPTY_STAGES = new Map<string, string>();
const NO_PENDING = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const first = (name: string) => name.split(' ')[0];
const nameOf = (id: string) => SAMPLE_BY_ID.get(id)?.displayName ?? '';

/**
 * The landing page's map: the same orbit the app draws, on a made-up student's network. The visitor searches a
 * company or a person and watches the map turn to the company's wedge, or draw the warmest route through people
 * the student already knows; the panel names each hop and why it holds, and drafts the ask. Until the visitor
 * touches it, it plays a few searches on its own, typed into the box as a person would.
 */
export default function NetworkDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(-1);
  const [shown, setShown] = useState<Shown>();
  const [auto, setAuto] = useState(true);
  const [inView, setInView] = useState(false);
  const [draftFor, setDraftFor] = useState<string>();
  const [hover, setHover] = useState<{ id: string; place: CardPlace }>();
  const reduce = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const suggestions = useMemo(() => suggest(query), [query]);

  const show = (s: Suggestion, route = 0) => {
    setOpen(false);
    setAt(-1);
    setDraftFor(undefined);
    if (s.kind === 'company') {
      setQuery(s.name);
      const result = companyResult(s.name);
      if (result) setShown({ kind: 'company', result });
    } else {
      setQuery(s.person.displayName);
      setShown({ kind: 'person', id: s.person.id, routes: routesTo(s.person.id), pick: route });
    }
  };
  const showPerson = (id: string) => {
    const person = SAMPLE_BY_ID.get(id);
    if (person) show({ kind: 'person', person });
  };
  const clear = () => {
    setQuery('');
    setShown(undefined);
    setOpen(false);
    setDraftFor(undefined);
  };
  const takeOver = () => {
    if (auto) setAuto(false);
  };

  // plays only while the section is on screen
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // with reduced motion there is no typing: the first search is simply shown
  useEffect(() => {
    if (!reduce) return;
    setAuto(false);
    show({ kind: 'company', name: 'Stripe', count: 0 });
  }, [reduce]);

  useEffect(() => {
    if (!auto || !inView || reduce) return;
    let cancelled = false;
    const run = async () => {
      await sleep(900);
      for (let i = 0; !cancelled; i = (i + 1) % SCRIPT.length) {
        const step = SCRIPT[i]!;
        setShown(undefined);
        setDraftFor(undefined);
        setQuery('');
        await sleep(350);
        for (let k = 1; k <= step.type.length && !cancelled; k++) {
          setQuery(step.type.slice(0, k));
          setOpen(true);
          await sleep(55 + (k % 3) * 25);
        }
        if (cancelled) return;
        const hit = suggest(step.type).find((s) => s.kind === step.pick);
        if (!hit) continue;
        setAt(suggest(step.type).indexOf(hit));
        await sleep(450);
        if (cancelled) return;
        show(hit);
        await sleep(3600);
        if (cancelled) return;
        if (step.route !== undefined) {
          setShown((s) => (s?.kind === 'person' ? { ...s, pick: step.route! } : s));
          await sleep(2600);
          if (cancelled) return;
        }
        if (hit.kind === 'person') {
          setDraftFor(hit.person.id);
          await sleep(3800);
        } else await sleep(1200);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [auto, inView, reduce]);

  const route = shown?.kind === 'person' ? shown.routes[shown.pick] : undefined;
  const focus: FocusSpec | undefined = useMemo(() => {
    if (shown?.kind === 'company')
      return {
        kind: 'company',
        groupKey: shown.result.groupKey,
        count: shown.result.people.length,
        warm: shown.result.warm,
      };
    if (shown?.kind === 'person')
      return {
        kind: 'reach',
        targetId: shown.id,
        status: 'found',
        ids: route ? ['user', ...route.hops.map((h) => h.id)] : [],
      };
    return undefined;
  }, [shown, route]);

  const legend = (() => {
    if (shown?.kind === 'company') {
      const r = shown.result;
      return `${r.people.length} people at ${r.name}${r.warm ? `, ${r.warm} you know well` : ''}. The warmest way in is through ${first(nameOf(r.intros[0]!.route.hops[0]!.id))}.`;
    }
    if (shown?.kind === 'person' && route) {
      const target = nameOf(shown.id);
      if (route.hops.length === 1) return `You know ${first(target)} directly, but only a little.`;
      return `${route.hops.length - 1 === 1 ? 'One person' : 'Two people'} between you and ${target}, through ${route.hops
        .slice(0, -1)
        .map((h) => first(nameOf(h.id)))
        .join(' and ')}.`;
    }
    return `A sample student’s network: ${SAMPLE_PEOPLE.length} people across ${SAMPLE_ORGS.size} companies. Closest in the middle, each company a wedge.`;
  })();

  const hovered = hover ? SAMPLE_BY_ID.get(hover.id) : undefined;

  return (
    <div
      ref={rootRef}
      className="relative overflow-hidden rounded-[20px] border border-line bg-canvas shadow-[0_30px_80px_-40px_rgba(15,61,46,0.35),var(--shadow-card)]"
      onPointerDownCapture={takeOver}
      onKeyDownCapture={takeOver}
      data-testid="landing-map"
    >
      <div className="grid md:grid-cols-[380px_minmax(0,1fr)] md:h-[660px]">
        {/* the panel: search, things to try, and the answer */}
        <div className="relative z-10 flex flex-col min-h-0 md:border-r border-line bg-canvas">
          <div className="p-4 sm:p-5 border-b border-line">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="label-mono">Search your network</span>
              <AutoPill auto={auto && !reduce} onStop={() => setAuto(false)} />
            </div>
            <form
              className="relative"
              onSubmit={(e) => {
                e.preventDefault();
                const s = suggestions[at >= 0 ? at : 0];
                if (s) show(s);
              }}
            >
              <Search
                size={16}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
                aria-hidden
              />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(true);
                  setAt(-1);
                }}
                onFocus={() => {
                  takeOver();
                  setOpen(true);
                }}
                onBlur={() => setTimeout(() => setOpen(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setOpen(true);
                    setAt((i) => Math.min(i + 1, suggestions.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setAt((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Escape') clear();
                }}
                placeholder="A company or a person…"
                className="h-11 w-full rounded-full border border-line bg-white pl-10 pr-4 text-[15px] text-ink placeholder:text-[#a59f97] shadow-[var(--shadow-pill)] transition-[border-color,box-shadow] focus:outline-none focus:border-[#a8a5a0] focus:ring-4 focus:ring-ink/[0.05]"
                role="combobox"
                aria-expanded={open && suggestions.length > 0}
                aria-controls="landing-map-suggestions"
                aria-autocomplete="list"
                aria-label="Search the sample network"
                data-testid="landing-map-search"
              />
              {open && suggestions.length > 0 && (
                <div
                  id="landing-map-suggestions"
                  role="listbox"
                  className="pop-in absolute left-0 right-0 top-[calc(100%+6px)] z-20 rounded-[14px] border border-line bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.18)]"
                >
                  {suggestions.map((s, i) => (
                    <div
                      key={s.kind === 'company' ? s.name : s.person.id}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === at}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        show(s);
                      }}
                      onMouseEnter={() => setAt(i)}
                      className={cx(
                        'flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 cursor-pointer transition-colors',
                        i === at ? 'bg-canvas-2' : '',
                      )}
                      data-testid="landing-map-suggestion"
                    >
                      {s.kind === 'company' ? (
                        <CompanyLogo name={s.name} size={28} decorative className="rounded-[8px]" />
                      ) : (
                        <Avatar
                          name={s.person.displayName}
                          src={s.person.photoUrl}
                          id={s.person.id}
                          size={28}
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] text-ink truncate">
                          {s.kind === 'company' ? s.name : s.person.displayName}
                        </span>
                        <span className="block text-[12px] text-ink-3 truncate">
                          {s.kind === 'company'
                            ? `${s.count} people in your network`
                            : `${s.person.currentTitle} at ${s.person.currentOrganizationRaw}`}
                        </span>
                      </span>
                      <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-ink-3">
                        {s.kind}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-ink-3 mr-0.5">Try</span>
              {TRY.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    const s = suggest(t)[0];
                    if (s) show(s);
                  }}
                  className={cx(
                    'h-7 px-2.5 rounded-full border text-[12.5px] transition-colors',
                    query === t && shown
                      ? 'bg-ink border-ink text-white'
                      : 'bg-white border-line text-ink-2 hover:text-ink hover:bg-canvas-2',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div
            className="flex-1 min-h-[260px] md:min-h-0 max-h-[520px] md:max-h-none overflow-y-auto scroll-thin p-4 sm:p-5"
            aria-live="polite"
          >
            {!shown ? (
              <Idle />
            ) : shown.kind === 'company' ? (
              <CompanyPanel key={shown.result.name} r={shown.result} onPick={showPerson} />
            ) : (
              <PersonPanel
                key={shown.id}
                id={shown.id}
                routes={shown.routes}
                pick={shown.pick}
                onPick={(i) => {
                  setDraftFor(undefined);
                  setShown({ ...shown, pick: i });
                }}
                draft={draftFor === shown.id}
                onDraft={() => setDraftFor(shown.id)}
              />
            )}
          </div>
        </div>

        {/* the map */}
        {/* on a phone the map comes first, so the answer is seen being drawn; the panel follows */}
        <div className="relative order-first md:order-none min-h-[380px] md:min-h-0 border-b md:border-b-0 border-line bg-[radial-gradient(circle_at_center,_#fff_0%,_#fbfaf9_60%,_#f6f5f3_100%)]">
          <div className="absolute inset-0">
            <OrbitMap
              people={SAMPLE_PEOPLE}
              orgs={SAMPLE_ORGS}
              stages={EMPTY_STAGES}
              pending={NO_PENDING}
              focus={focus}
              connections={SAMPLE_CONNECTIONS}
              personCard
              arrival="always"
              onSelect={(id) => {
                takeOver();
                showPerson(id);
              }}
              onHover={(id, place) => setHover(id && place ? { id, place } : undefined)}
              label="A sample student's network. Search a company or a person to see the warmest way in."
            />
          </div>
          <div className="pointer-events-none absolute left-4 right-4 bottom-4 flex justify-start">
            <p
              key={legend}
              className="fade-up max-w-[520px] rounded-full border border-line bg-white/85 backdrop-blur px-3.5 py-1.5 text-[12.5px] text-ink-2 shadow-[var(--shadow-pill)]"
              data-testid="landing-map-legend"
            >
              {legend}
            </p>
          </div>
          {hovered && hover && (
            <div
              className={cx(
                'pointer-events-none absolute fade-up rounded-[12px] border border-line bg-white p-3 shadow-[var(--shadow-card)]',
                'at' in hover.place ? 'left-3 right-3' : 'w-[260px]',
              )}
              style={
                'at' in hover.place ? { top: hover.place.y } : { left: hover.place.x, top: hover.place.y }
              }
            >
              <div className="flex items-center gap-2">
                <Avatar name={hovered.displayName} src={hovered.photoUrl} id={hovered.id} size={30} />
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-ink truncate">{hovered.displayName}</div>
                  <div className="text-[12px] text-ink-3 truncate">
                    {hovered.currentTitle} · {hovered.currentOrganizationRaw}
                  </div>
                </div>
              </div>
              <div className="mt-2 text-[12px] text-ink-2">
                Knows {SAMPLE_CONNECTIONS.get(hovered.id)?.length ?? 0} people here · click for the way in
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AutoPill({ auto, onStop }: { auto: boolean; onStop: () => void }) {
  return auto ? (
    <button
      type="button"
      onClick={onStop}
      className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-accent-soft text-accent text-[11.5px] font-medium"
      title="The map is playing sample searches. Click to take over."
    >
      <span className="relative flex w-1.5 h-1.5">
        <span className="absolute inset-0 rounded-full bg-accent animate-ping opacity-60" />
        <span className="relative w-1.5 h-1.5 rounded-full bg-accent" />
      </span>
      Playing a demo
    </button>
  ) : (
    <span className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full border border-line text-ink-3 text-[11.5px]">
      Your turn
    </span>
  );
}

function Idle() {
  return (
    <div className="h-full flex flex-col justify-center text-center px-4 py-8 fade-up">
      <span className="mx-auto mb-3 w-10 h-10 rounded-full border border-line bg-canvas-2 inline-flex items-center justify-center">
        <Sparkles size={16} className="text-ink-2" />
      </span>
      <p className="text-[15px] text-ink">Who do you want to meet?</p>
      <p className="mt-1 text-[13px] text-ink-3 leading-[1.5]">
        Type a company to see who you know there, or a person to see who can introduce you.
      </p>
    </div>
  );
}

function Chain({ hops, size = 22 }: { hops: Route['hops']; size?: number }) {
  return (
    <div className="flex items-center flex-wrap gap-1 text-[12.5px]">
      <span className="inline-flex items-center h-6 px-2 rounded-full bg-ink text-white text-[11.5px] font-medium">
        You
      </span>
      {hops.map((h) => (
        <span key={h.id} className="inline-flex items-center gap-1">
          <ChevronRight size={13} className="text-ink-3" />
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={nameOf(h.id)} src={SAMPLE_BY_ID.get(h.id)?.photoUrl} id={h.id} size={size} />
            <span className="text-ink">{first(nameOf(h.id))}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

function BandChip({ band }: { band: Route['band'] }) {
  return (
    <span
      className={cx(
        'shrink-0 inline-flex items-center h-[22px] px-2 rounded-full border text-[11.5px]',
        band === 'Strong route'
          ? 'bg-good-soft border-good/20 text-good'
          : band === 'Good route'
            ? 'bg-accent-soft border-accent/15 text-accent'
            : 'bg-warn-soft border-warn/20 text-warn',
      )}
    >
      {band}
    </span>
  );
}

function CompanyPanel({ r, onPick }: { r: CompanyResult; onPick: (id: string) => void }) {
  return (
    <div>
      <div className="flex items-center gap-2.5 fade-up">
        <CompanyLogo name={r.name} size={36} decorative className="rounded-[10px]" />
        <div>
          <div className="text-[16px] text-ink">{r.name}</div>
          <div className="text-[12.5px] text-ink-3">
            {r.people.length} people in your network · {r.warm} you know well
          </div>
        </div>
      </div>
      <p className="label-mono mt-5 mb-2">Warmest ways in</p>
      <div className="stagger space-y-2" data-testid="landing-map-result">
        {r.intros.slice(0, 4).map(({ person, route }) => (
          <button
            key={person.id}
            type="button"
            onClick={() => onPick(person.id)}
            className="group w-full text-left rounded-[12px] border border-line bg-white p-3 transition-[border-color,box-shadow,transform] hover:border-[#d4d2ce] hover:shadow-[var(--shadow-card)] active:scale-[0.99]"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13.5px] text-ink truncate">{person.displayName}</div>
                <div className="text-[12px] text-ink-3 truncate">{person.currentTitle}</div>
              </div>
              <BandChip band={route.band} />
            </div>
            <div className="mt-2.5">
              <Chain hops={route.hops} size={20} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function PersonPanel({
  id,
  routes,
  pick,
  onPick,
  draft,
  onDraft,
}: {
  id: string;
  routes: Route[];
  pick: number;
  onPick: (i: number) => void;
  draft: boolean;
  onDraft: () => void;
}) {
  const p = SAMPLE_BY_ID.get(id)!;
  const route = routes[pick];
  return (
    <div>
      <div className="flex items-center gap-2.5 fade-up">
        <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={36} />
        <div className="min-w-0">
          <div className="text-[16px] text-ink truncate">{p.displayName}</div>
          <div className="text-[12.5px] text-ink-3 truncate">
            {p.currentTitle} · {p.currentOrganizationRaw}
          </div>
        </div>
      </div>
      <p className="label-mono mt-5 mb-2">
        {routes.length} {routes.length === 1 ? 'route' : 'routes'}, warmest first
      </p>
      <div className="stagger space-y-2" data-testid="landing-map-result">
        {routes.map((r, i) => (
          <button
            key={r.hops.map((h) => h.id).join('>')}
            type="button"
            onClick={() => onPick(i)}
            aria-pressed={i === pick}
            className={cx(
              'w-full text-left rounded-[12px] border bg-white p-3 transition-[border-color,box-shadow,transform] active:scale-[0.99]',
              i === pick
                ? 'border-accent/50 shadow-[0_0_0_3px_rgba(15,61,46,0.08)]'
                : 'border-line hover:border-[#d4d2ce]',
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[12px] text-ink-3">
                Route {i + 1} · {r.hops.length} {r.hops.length === 1 ? 'hop' : 'hops'}
              </span>
              <BandChip band={r.band} />
            </div>
            <Chain hops={r.hops} />
            {i === pick && (
              <ol className="mt-2.5 space-y-1 text-[12px] text-ink-2 fade-up">
                {r.hops.map((h, k) => (
                  <li key={h.id} className="flex gap-1.5">
                    <span className="text-ink-3 tabular-nums">{k + 1}.</span>
                    <span>
                      <span className="text-ink">{k === 0 ? 'You' : first(nameOf(r.hops[k - 1]!.id))}</span>{' '}
                      and <span className="text-ink">{first(nameOf(h.id))}</span>: {h.why}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </button>
        ))}
      </div>
      {route &&
        (draft ? (
          <Draft key={route.hops[0]!.id} route={route} target={id} />
        ) : (
          <button
            type="button"
            onClick={onDraft}
            className="mt-3 w-full h-10 inline-flex items-center justify-center gap-1.5 rounded-full bg-accent text-white text-[13.5px] font-medium transition-[background-color,transform] hover:bg-accent-2 active:scale-[0.98]"
            data-testid="landing-map-draft"
          >
            {route.hops.length > 1
              ? `Ask ${first(nameOf(route.hops[0]!.id))} for an intro`
              : `Write to ${first(p.displayName)}`}
            <ArrowRight size={15} />
          </button>
        ))}
    </div>
  );
}

/** The ask, written out the way Orbit would draft it, typed in so it reads as being written. */
function Draft({ route, target }: { route: Route; target: string }) {
  const via = route.hops.length > 1 ? SAMPLE_BY_ID.get(route.hops[0]!.id) : undefined;
  const t = SAMPLE_BY_ID.get(target)!;
  const text = via
    ? `Hi ${via.firstName}, hope things at ${via.currentOrganizationRaw} are going well! I’m recruiting for ${
        t.currentTitle?.toLowerCase().includes('design') ? 'product design' : 'product'
      } roles and would love to learn how ${t.firstName} got to ${t.currentOrganizationRaw}. Would you be open to a quick intro? I can send a two-line blurb you can forward. Thanks, Alex`
    : `Hi ${t.firstName}, we’re connected on LinkedIn but have never properly met. I’m a Cornell junior recruiting for roles like yours at ${t.currentOrganizationRaw}. Would you have 15 minutes for a call in the next couple of weeks? Thanks, Alex`;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setN(text.length);
      return;
    }
    let i = 0;
    const iv = setInterval(() => {
      i += 3;
      setN(Math.min(i, text.length));
      if (i >= text.length) clearInterval(iv);
    }, 16);
    return () => clearInterval(iv);
  }, [text]);
  return (
    <div
      className="mt-3 rounded-[12px] border border-line bg-canvas-2/60 p-3 fade-up"
      data-testid="landing-map-draft-text"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="label-mono">Draft to {via ? via.firstName : t.firstName}</span>
        <span className="text-[11.5px] text-ink-3">in your voice</span>
      </div>
      <p className="text-[13px] leading-[1.55] text-ink whitespace-pre-wrap">
        {text.slice(0, n)}
        {n < text.length && <Caret />}
      </p>
      <p className="mt-2 text-[11.5px] text-ink-3">Nothing is sent until you send it yourself.</p>
    </div>
  );
}

function Caret(): ReactNode {
  return <span className="inline-block w-[2px] h-[14px] -mb-[2px] ml-[1px] bg-ink animate-pulse" />;
}
