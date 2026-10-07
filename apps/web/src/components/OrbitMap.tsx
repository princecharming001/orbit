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
  onHover?: (id: string | undefined) => void;
  rotate?: boolean;
  /** what the map shows, for screen readers */
  label?: string;
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
  const coarse = useCoarsePointer();
  const reduced = useReducedMotion();

  // Geometry is computed once per network at unit scale; the viewport only changes the draw scale.
  const layout: OrbitLayout = useMemo(() => orbitLayout(people, orgs), [people, orgs]);
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
    if (changed) onHover?.(id);
  };
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
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 block cursor-pointer touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-[2px]"
        data-testid="orbit-canvas"
        data-overlaps={overlaps}
        data-outside-wedges={outsideWedges}
        data-nodes={layout.nodes.length}
        data-aggregated={layout.aggregated}
        tabIndex={0}
        role="img"
        aria-label={
          label ??
          `Orbit map of ${people.length} people. Use the arrow keys to move between people and Enter to open one.`
        }
        onPointerDown={(e) => {
          scene.finishArrival();
          if (e.pointerType !== 'mouse' || e.button !== 0) return;
          const { x, y } = local(e.clientX, e.clientY);
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
          const id = scene.hitTest(x, y, true);
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
          const id = scene.hitTest(x, y);
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
