import type { OrbitNode, Organization, Person } from '@orbit/core';
import { countOutsideWedges, countOverlaps, type OrbitLayout, orbitLayout } from '@orbit/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FrameRecorder } from './motion';
import { type FocusSpec, type HoverHow, OrbitScene, type WebSpec } from './orbitScene';

export { orbitScale } from './orbitGeometry';

export interface MapProps {
  people: Person[];
  orgs: Map<string, Organization>;
  stages: Map<string, string>;
  pending: Set<string>;
  /** the network is still loading: the empty orbit breathes until the people arrive */
  loading?: boolean;
  /** a filter: everyone else fades back */
  highlightIds?: Set<string>;
  /** companies whose wedges are tinted (Target companies) */
  highlightGroups?: Set<string>;
  /** a company or a reach target the map turns to and frames */
  focus?: FocusSpec;
  /** the introductions view */
  web?: WebSpec;
  /** each person's strongest direct connections inside the network, strongest first */
  connections?: Map<string, string[]>;
  /** who introduced each person, so someone new is born at their introducer's dot */
  introducerOf?: Map<string, string>;
  onSelect: (id: string) => void;
  /** an aggregate dot ("+14 at Google") was clicked */
  onSelectCluster?: (node: OrbitNode) => void;
  /** `place`: the corner of the map where a card about the person covers the fewest people */
  onHover?: (id: string | undefined, place?: CardPlace) => void;
  /** the page shows a card next to the hovered person, so the map does not write their name above the dot too */
  personCard?: boolean;
  rotate?: boolean;
  /** what the map shows, for screen readers */
  label?: string;
}

/**
 * Where the person card goes. From 640 px up it is a 260 px card next to the dot (`x`, `y`: its top-left corner in
 * the map), so the eye does not have to cross the map; below that it spans the map's width at the top or bottom.
 */
export type CardPlace = { at: 'top' | 'bottom' } | { x: number; y: number };

/** The person card's size and inset in CSS px (MapPage draws it: 260 px wide from 640 px up, full width below). */
export const CARD_W = 260;
const CARD_H = 92;
const CARD_INSET = 12;
/** Room the phone's tab bar takes at the bottom of the window. */
const TAB_BAR = 72;

/**
 * Where the person card goes: never over the person it is about, and over as few other people as it can. Next to
 * the dot on a wide map (the side away from the centre first, where the orbit is thinner), at the top or bottom of
 * a narrow one. On a touch screen a narrow map's card prefers the top, and goes to the bottom only when the bottom of
 * the map is on screen, clear of the tab bar.
 *
 * On a wide map the card weighs what it would hide: every dot under it (with a little room round the card, so a dot
 * peeping out from under its edge counts too), the person's ties and the lines to them, and, for keyboard focus, the
 * dots the arrow keys go to next, which must stay in sight. It may move a little further from the dot to clear them,
 * out to a corner of the map when the orbit round the dot is crowded.
 */
function cardPlace(scene: OrbitScene, id: string, canvas: HTMLCanvasElement, how: HoverHow): CardPlace {
  const touch = how === 'touch';
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const at = scene.positionOf(id);
  const covers = (x0: number, y0: number, x1: number, y1: number) =>
    !!at && at.x + at.r + 8 > x0 && at.x - at.r - 8 < x1 && at.y + at.r + 8 > y0 && at.y - at.r - 8 < y1;
  if (w >= 640 && at) {
    const gap = 14;
    const you = scene.youAt();
    // the dots the arrow keys go to from here: a keyboard user's next stop is never under the card
    const next = new Set<string>();
    if (how === 'keyboard')
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const n = scene.neighbour(id, dx, dy);
        if (n && n !== id) next.add(n);
      }
    const nextAt = [...next].map((n) => scene.positionOf(n)).filter((p) => !!p);
    // beside the dot (level with it, or with the dot at the card's top or bottom), or above or below it, and the
    // same a step further out; then the corners of the map
    const cands: { x: number; y: number }[] = [];
    for (const far of [0, 40, 90, 140]) {
      const xs = { right: at.x + at.r + gap + far, left: at.x - at.r - gap - far - CARD_W };
      const ys = [at.y - CARD_H / 2, at.y - 18, at.y + 18 - CARD_H];
      const sides = at.x >= w / 2 ? [xs.right, xs.left] : [xs.left, xs.right];
      for (const x of sides) for (const y of ys) cands.push({ x, y });
      for (const y of [at.y + at.r + gap + far, at.y - at.r - gap - far - CARD_H])
        for (const x of [at.x - CARD_W / 2, at.x - 24, at.x + 24 - CARD_W]) cands.push({ x, y });
    }
    for (const x of [0, w])
      for (const y of [0, h]) cands.push({ x: x - (x ? CARD_W : 0), y: y - (y ? CARD_H : 0) });
    let best = cands[0]!;
    let bestScore = Number.POSITIVE_INFINITY;
    const m = 6;
    const far = (d: number) => d / 30 + Math.max(0, d - 60) / 8;
    cands.forEach((c, i) => {
      const x = Math.round(Math.min(Math.max(c.x, CARD_INSET), w - CARD_INSET - CARD_W));
      const y = Math.round(Math.min(Math.max(c.y, CARD_INSET), h - CARD_INSET - CARD_H));
      const x1 = x + CARD_W;
      const y1 = y + CARD_H;
      // how far the card ended up from the dot once kept inside the map
      const dx = Math.max(x - at.x, 0, at.x - x1);
      const dy = Math.max(y - at.y, 0, at.y - y1);
      const hidesYou = you.x + you.r > x && you.x - you.r < x1 && you.y + you.r > y && you.y - you.r < y1;
      const hidesNext = nextAt.filter(
        (p) => p.x + p.r + m > x && p.x - p.r - m < x1 && p.y + p.r + m > y && p.y - p.r - m < y1,
      ).length;
      const score =
        (covers(x, y, x1, y1) ? 1000 : 0) +
        (hidesYou ? 12 : 0) +
        hidesNext * 40 +
        2 * scene.dotsIn(x - m, y - m, x1 + m, y1 + m, at) +
        // the people the lines run to, and the lines, stay in sight
        3 * scene.tiesIn(id, x, y, x1, y1) +
        // close to the dot, and only a little further when that clears the people round it
        far(Math.hypot(dx, dy)) +
        i * 0.05;
      if (score < bestScore) {
        best = { x, y };
        bestScore = score;
      }
    });
    return best;
  }
  const cw = w - 2 * CARD_INSET;
  const bottomShown = !touch || canvas.getBoundingClientRect().bottom <= window.innerHeight - TAB_BAR;
  const order: ('top' | 'bottom')[] = touch ? ['top', 'bottom'] : ['bottom', 'top'];
  let best: 'top' | 'bottom' = order[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const side of order) {
    if (side === 'bottom' && !bottomShown) continue;
    const y0 = side === 'top' ? CARD_INSET : h - CARD_INSET - CARD_H;
    // the person themselves, and the name above their dot, stay in sight
    const hidden =
      !!at && covers(CARD_INSET, y0, CARD_INSET + cw, y0 + CARD_H + (side === 'bottom' ? 26 : 0));
    const score = (hidden ? 1000 : 0) + scene.dotsIn(CARD_INSET, y0, CARD_INSET + cw, y0 + CARD_H);
    if (score < bestScore) {
      best = side;
      bestScore = score;
    }
  }
  return { at: best };
}

const COARSE_QUERY = '(hover: none) and (pointer: coarse)';
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const ARRIVED = 'orbit.map.arrived';

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, [query]);
  return on;
}

/** True on phones and tablets: no hover, a finger instead of a mouse. Follows changes (a tablet with a mouse). */
export function useCoarsePointer(): boolean {
  return useMedia(COARSE_QUERY);
}

export function useReducedMotion(): boolean {
  return useMedia(REDUCED_QUERY);
}

function sessionFlag(): boolean {
  try {
    return sessionStorage.getItem(ARRIVED) === '1';
  } catch {
    return true;
  }
}

function setSessionFlag(): void {
  try {
    sessionStorage.setItem(ARRIVED, '1');
  } catch {
    // private mode: the arrival may play again, which is harmless
  }
}

/** Tells the scene the canvas's size and where it sits on the page. */
function place(scene: OrbitScene, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  scene.resize(el.clientWidth, el.clientHeight, {
    left: r.left + window.scrollX,
    top: r.top + window.scrollY,
  });
}

/**
 * The wedges the student last saw, for the whole visit: a company keeps its place round the orbit when ties change
 * strength or people arrive, and when the student comes back to the map from another page.
 */
let lastWedges: OrbitLayout['groups'] | undefined;

let recorder: FrameRecorder | undefined;
/** `?perf=1` records every animated frame's rAF delta and script time on window.__orbitPerf. */
function perfRecorder(): FrameRecorder | undefined {
  if (recorder) return recorder;
  try {
    if (new URLSearchParams(window.location.search).get('perf') !== '1') return undefined;
  } catch {
    return undefined;
  }
  const r = new FrameRecorder();
  recorder = r;
  (window as unknown as { __orbitPerf: unknown }).__orbitPerf = {
    stats: () => r.stats(),
    reset: () => r.reset(),
    deltas: () => [...r.deltas],
  };
  return r;
}

export function OrbitMap({
  people,
  orgs,
  stages,
  pending,
  loading = false,
  highlightIds,
  highlightGroups,
  focus,
  web,
  connections,
  introducerOf,
  onSelect,
  onSelectCluster,
  onHover,
  personCard = false,
  rotate = true,
  label,
}: MapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OrbitScene | null>(null);
  if (!sceneRef.current) sceneRef.current = new OrbitScene();
  const scene = sceneRef.current;
  const hoverRef = useRef<{ id?: string; how: HoverHow }>({ how: 'pointer' });
  const [said, setSaid] = useState('');
  const lastTouch = useRef(0);
  const dragged = useRef(false);
  /** a dot pressed while the arrival was still flying in: the click opens that dot, wherever it lands */
  const pressedInFlight = useRef<string | undefined>(undefined);
  const coarse = useCoarsePointer();
  const reduced = useReducedMotion();

  // Geometry is computed once per network at unit scale; the viewport only changes the draw scale. Not while the
  // network is still loading: people can arrive before their companies, and a big network's layout is costly, so
  // it is worked out once, when everything it needs is there.
  const layout: OrbitLayout = useMemo(() => {
    const l = orbitLayout(loading ? [] : people, orgs, { previous: lastWedges });
    if (l.groups.length) lastWedges = l.groups;
    return l;
  }, [people, orgs, loading]);
  const overlaps = useMemo(() => countOverlaps(layout.nodes), [layout]);
  const outsideWedges = useMemo(() => countOutsideWedges(layout), [layout]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    scene.recorder = perfRecorder();
    scene.arrivalPending = !sessionFlag();
    scene.onArrival = setSessionFlag;
    scene.attach(canvas);
    if (navigator.webdriver || scene.recorder)
      (window as unknown as { __orbitMap: unknown }).__orbitMap = {
        snapshot: () => scene.snapshot(),
        positions: (ids?: string[]) => scene.positions(ids),
        hitTest: (x: number, y: number) => scene.hitTest(x, y),
        slot: (id: string) => scene.slotOf(id),
        stageColor: (id: string) => scene.stageColorOf(id),
        neighbour: (id: string, dx: number, dy: number) => scene.neighbour(id, dx, dy),
      };
    let live = true;
    document.fonts?.ready.then(() => {
      if (live) scene.invalidateText();
    });
    return () => {
      live = false;
      scene.destroy();
    };
  }, [scene]);

  // The canvas is absolutely positioned, so the wrapper's size comes from the page layout, never from the canvas.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => place(scene, el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scene]);
  // After every render as well, before the paint: a panel above can move the map without resizing it.
  useLayoutEffect(() => {
    if (wrapRef.current) place(scene, wrapRef.current);
  });

  // On touch screens the orbit holds still: a moving dot is hard to tap and its name card would drift away.
  useEffect(
    () => scene.setOptions({ spin: rotate && !coarse, reduced, personCard }),
    [scene, rotate, coarse, reduced, personCard],
  );
  useEffect(
    () => scene.setData({ layout, people: byId, loading, stages, pending, introducerOf }),
    [scene, layout, byId, loading, stages, pending, introducerOf],
  );
  useEffect(() => scene.setFilter(highlightIds, highlightGroups), [scene, highlightIds, highlightGroups]);
  useEffect(() => scene.setFocus(focus), [scene, focus]);
  useEffect(() => scene.setWeb(web), [scene, web]);
  useEffect(() => scene.setConnections(connections), [scene, connections]);

  const setHover = (id: string | undefined, how: HoverHow) => {
    const cur = hoverRef.current;
    if (id === cur.id && how === cur.how) return;
    const changed = id !== cur.id;
    hoverRef.current = { id, how };
    scene.setHover(id, how);
    if (changed)
      onHover?.(id, id && canvasRef.current ? cardPlace(scene, id, canvasRef.current, how) : undefined);
  };
  // a tapped dot belongs to the view it was tapped in: a search, a route, a filter or the introductions view lets
  // go of it (a mouse hover follows the pointer anyway)
  const webOn = !!web;
  useEffect(() => {
    const cur = hoverRef.current;
    if (cur.id && cur.how === 'touch') setHover(undefined, 'touch');
  }, [focus, webOn, highlightIds]);
  // a dot that left the map (a new layout) cannot stay hovered
  useEffect(() => {
    const cur = hoverRef.current;
    if (cur.id && !scene.positionOf(cur.id)) {
      hoverRef.current = { how: cur.how };
      scene.setHover(undefined);
      onHover?.(undefined);
    }
  }, [layout]);

  const local = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const activate = (id: string) => {
    const node = scene.nodeOf(id);
    if (node?.cluster) onSelectCluster?.(node);
    else onSelect(id);
  };
  const describe = (id: string): string => {
    const node = scene.nodeOf(id);
    if (node?.cluster)
      return node.cluster.label === 'Other companies'
        ? `${node.cluster.count} people at other companies. Press Enter to see them.`
        : `${node.cluster.count} more people at ${node.cluster.label}. Press Enter to see them.`;
    const p = byId.get(id);
    if (!p) return '';
    const role = [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ');
    return `${p.displayName}${role ? `, ${role}` : ''}. Press Enter to open.`;
  };
  const focusDot = (id: string | undefined) => {
    setHover(id, 'keyboard');
    setSaid(id ? describe(id) : '');
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: the canvas is a keyboard-driven widget (arrow keys, Enter, Escape), so screen readers must pass keys through to it */}
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 block cursor-pointer touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-[2px]"
        data-testid="orbit-canvas"
        data-overlaps={overlaps}
        data-outside-wedges={outsideWedges}
        data-nodes={layout.nodes.length}
        data-aggregated={layout.aggregated}
        tabIndex={0}
        role="application"
        aria-roledescription="orbit map"
        aria-label={
          label ??
          `Orbit map of ${people.length} people. Use the arrow keys to move between people and Enter to open one.`
        }
        onPointerDown={(e) => {
          const { x, y } = local(e.clientX, e.clientY);
          pressedInFlight.current = scene.arriving()
            ? scene.hitTest(x, y, e.pointerType !== 'mouse')
            : undefined;
          scene.finishArrival();
          if (e.pointerType !== 'mouse' || e.button !== 0) return;
          dragged.current = false;
          scene.pointerDown(x, y);
        }}
        onPointerMove={(e) => {
          if (e.pointerType !== 'mouse') return;
          const { x, y } = local(e.clientX, e.clientY);
          const canvas = canvasRef.current!;
          if (e.buttons & 1 && scene.pointerMove(x, y)) {
            if (!dragged.current) {
              dragged.current = true;
              canvas.setPointerCapture?.(e.pointerId);
              if (hoverRef.current.id) setHover(undefined, 'pointer');
            }
            canvas.style.cursor = 'grabbing';
            return;
          }
          const id = scene.hitTest(x, y);
          canvas.style.cursor = id ? 'pointer' : 'grab';
          setHover(id, 'pointer');
        }}
        onPointerLeave={(e) => {
          // moving onto the person's card (its Open link) keeps them hovered
          const to = e.relatedTarget;
          if (to instanceof Element && to.closest('[data-testid="map-tooltip"]')) return;
          if (e.pointerType === 'mouse' && !dragged.current && hoverRef.current.how === 'pointer')
            setHover(undefined, 'pointer');
        }}
        onPointerCancel={() => {
          scene.pointerUp();
          dragged.current = false;
        }}
        onPointerUp={(e) => {
          if (e.pointerType === 'mouse') {
            if (scene.pointerUp()) {
              canvasRef.current!.style.cursor = 'grab';
              canvasRef.current!.releasePointerCapture?.(e.pointerId);
            }
            return;
          }
          // touch: the first tap shows who it is, a second tap on the same dot opens it
          lastTouch.current = Date.now();
          const { x, y } = local(e.clientX, e.clientY);
          const id = pressedInFlight.current ?? scene.hitTest(x, y, true);
          pressedInFlight.current = undefined;
          if (!id) return setHover(undefined, 'touch');
          if (id === hoverRef.current.id) return activate(id);
          setHover(id, 'touch');
        }}
        onClick={(e) => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (Date.now() - lastTouch.current < 600) return; // already handled as a tap
          const { x, y } = local(e.clientX, e.clientY);
          const id = pressedInFlight.current ?? scene.hitTest(x, y);
          pressedInFlight.current = undefined;
          if (id) activate(id);
        }}
        onWheel={() => scene.finishArrival()}
        onKeyDown={(e) => {
          const dirs: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          };
          const dir = dirs[e.key];
          const current = hoverRef.current.how === 'keyboard' ? hoverRef.current.id : undefined;
          if (dir) {
            e.preventDefault();
            scene.finishArrival();
            focusDot(scene.neighbour(current, dir[0], dir[1]));
          } else if (e.key === 'Home') {
            e.preventDefault();
            focusDot(scene.neighbour(undefined, 0, 0));
          } else if ((e.key === 'Enter' || e.key === ' ') && current) {
            e.preventDefault();
            activate(current);
          } else if (e.key === 'Escape' && current) {
            // the first Escape lets go of the dot; the next one clears the view (handled by the page)
            e.preventDefault();
            e.stopPropagation();
            focusDot(undefined);
          }
        }}
        onBlur={() => {
          if (hoverRef.current.how === 'keyboard' && hoverRef.current.id) focusDot(undefined);
        }}
      />
      <div className="sr-only" aria-live="polite" data-testid="map-announce">
        {said}
      </div>
    </div>
  );
}
