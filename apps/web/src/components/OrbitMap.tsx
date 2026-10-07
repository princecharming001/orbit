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
  rotate?: boolean;
  /** what the map shows, for screen readers */
  label?: string;
}

export type CardPlace = 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right';

/** The person card's size and inset in CSS px (MapPage draws it: 260 px wide from 640 px up, full width below). */
const CARD_H = 92;
const CARD_INSET = 12;
/** Room the phone's tab bar takes at the bottom of the window. */
const TAB_BAR = 72;

/**
 * Where the person card goes: the corner that hides the fewest people, never over the person it is about (or the
 * name above their dot). On a touch screen the card prefers the top, and goes to the bottom only when the bottom of
 * the map is on screen, clear of the tab bar.
 */
function cardPlace(scene: OrbitScene, id: string, canvas: HTMLCanvasElement, touch: boolean): CardPlace {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const cw = w < 640 ? w - 2 * CARD_INSET : 260;
  const at = scene.positionOf(id);
  const bottomShown = !touch || canvas.getBoundingClientRect().bottom <= window.innerHeight - TAB_BAR;
  const order: CardPlace[] = touch
    ? ['top-left', 'bottom-left', 'top-right', 'bottom-right']
    : ['bottom-left', 'top-left', 'bottom-right', 'top-right'];
  let best: CardPlace = order[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const place of order) {
    const top = place.startsWith('top');
    if (!top && !bottomShown) continue;
    if (cw > w / 2 && place.endsWith('right')) continue;
    const x0 = place.endsWith('left') ? CARD_INSET : w - CARD_INSET - cw;
    const y0 = top ? CARD_INSET : h - CARD_INSET - CARD_H;
    const x1 = x0 + cw;
    const y1 = y0 + CARD_H;
    // the person themselves, and their name above the dot, stay in sight
    const covers =
      !!at && at.x + at.r + 8 > x0 && at.x - at.r - 8 < x1 && at.y + at.r + 8 > y0 && at.y - at.r - 34 < y1;
    const score = (covers ? 1000 : 0) + scene.dotsIn(x0, y0, x1, y1);
    if (score < bestScore) {
      best = place;
      bestScore = score;
    }
  }
  return best;
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
  useEffect(() => scene.setOptions({ spin: rotate && !coarse, reduced }), [scene, rotate, coarse, reduced]);
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
      onHover?.(
        id,
        id && canvasRef.current ? cardPlace(scene, id, canvasRef.current, how === 'touch') : undefined,
      );
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
