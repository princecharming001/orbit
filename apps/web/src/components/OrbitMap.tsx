import type { Organization, Person, ReachPath } from '@orbit/core';
import { countOverlaps, type OrbitLayout, type OrbitNode, orbitLayout, orbitRotation } from '@orbit/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { STAGE_COLOR } from '../pages/Pipeline';

export interface MapProps {
  people: Person[];
  orgs: Map<string, Organization>;
  stages: Map<string, string>;
  pending: Set<string>;
  highlightPath?: ReachPath; // reach mode
  highlightIds?: Set<string>;
  onSelect: (id: string) => void;
  /** an aggregate dot ("+14 at Google") was clicked */
  onSelectCluster?: (node: OrbitNode) => void;
  onHover?: (id: string | undefined) => void;
  rotate?: boolean;
  focusId?: string;
}

interface Pos {
  x: number;
  y: number;
  r: number;
  id: string;
}

interface LabelSlot {
  key: string;
  text: string;
  mid: number; // wedge centre angle before rotation
}

/** gap between the outermost dots and the company labels, in CSS px */
const LABEL_GAP = 14;
const LABEL_FONT_PX = 11;

/** Fit the orbit (dots plus labels) inside the canvas: labels above and below need room, sides are clamped. */
export function orbitScale(w: number, h: number, extent: number): number {
  const side = w < 600 ? 10 : 60;
  const s = Math.min(1, (h / 2 - LABEL_GAP - 16) / extent, (w / 2 - side) / extent);
  return Math.max(0.2, s);
}

export function OrbitMap({
  people,
  orgs,
  stages,
  pending,
  highlightPath,
  highlightIds,
  onSelect,
  onSelectCluster,
  onHover,
  rotate = true,
  focusId,
}: MapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | undefined>();
  const [paused, setPaused] = useState(false);
  const images = useRef(new Map<string, HTMLImageElement>());
  const startRef = useRef(performance.now());
  const posRef = useRef<Pos[]>([]);
  const dirtyRef = useRef(true);
  const lastTouch = useRef(0);
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // The canvas is absolutely positioned, so the wrapper's size comes from the page layout, never from the canvas.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Geometry is computed once per network at unit scale; the viewport only changes the draw scale.
  const layout: OrbitLayout = useMemo(() => orbitLayout(people, orgs), [people, orgs]);
  const overlaps = useMemo(() => countOverlaps(layout.nodes), [layout]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const scale = size.w && size.h ? orbitScale(size.w, size.h, layout.extent) : 1;
  const narrow = size.w < 600;
  const pathIds = useMemo(
    () => new Set(highlightPath ? highlightPath.hops.flatMap((h) => [h.fromId, h.toId]) : []),
    [highlightPath],
  );
  // Company labels, biggest companies first. A label is shown only when its arc is free; the test uses angles,
  // so the set of labels does not change while the orbit turns.
  const labels: LabelSlot[] = useMemo(() => {
    if (!size.w) return [];
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return [];
    ctx.font = `500 ${Math.max(10, LABEL_FONT_PX * Math.max(0.85, scale))}px Inter, sans-serif`;
    const radius = layout.extent * scale + LABEL_GAP;
    const max = narrow ? 12 : 18;
    const taken: [number, number][] = [];
    const out: LabelSlot[] = [];
    const ordered = [...layout.groups].sort((a, b) => b.count - a.count);
    for (const g of ordered) {
      if (g.count < 2 && layout.groups.length > 8) continue;
      const text = g.label.length > max ? `${g.label.slice(0, max - 1)}…` : g.label;
      const half = (ctx.measureText(text).width + 12) / 2 / radius;
      const mid = (g.startAngle + g.endAngle) / 2;
      const lo = mid - half;
      const hi = mid + half;
      const TAU = Math.PI * 2;
      const clash = taken.some(([a, b]) => [-TAU, 0, TAU].some((s) => lo < b + s && hi > a + s));
      if (clash) continue;
      taken.push([lo, hi]);
      out.push({ key: g.key, text, mid });
    }
    return out;
  }, [layout, scale, size.w, narrow]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let lastDraw = 0;
    dirtyRef.current = true;
    const moving = rotate && !paused && !reduced && !highlightPath;
    const animating = moving || pending.size > 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // redraw on change, otherwise at ~30 fps while something moves; an idle map costs nothing
      if (!dirtyRef.current && (!animating || now - lastDraw < 33)) return;
      dirtyRef.current = false;
      lastDraw = now;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(size.w * dpr);
      const H = Math.round(size.h * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        canvas.style.width = `${size.w}px`;
        canvas.style.height = `${size.h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      const cx = size.w / 2;
      const cy = size.h / 2;
      const rot = orbitRotation(moving ? performance.now() - startRef.current : 0);
      // rings
      ctx.strokeStyle = '#eceef2';
      ctx.lineWidth = 1;
      for (const r of layout.ringRadii) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      // company labels just outside the outermost dots, kept inside the canvas
      const labelR = layout.extent * scale + LABEL_GAP;
      const fontPx = Math.max(10, LABEL_FONT_PX * Math.max(0.85, scale));
      ctx.font = `500 ${fontPx}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let clipped = 0;
      const labelAlpha = highlightPath || highlightIds ? 0.45 : 1;
      ctx.fillStyle = '#767d89';
      for (const l of labels) {
        const a = l.mid + rot;
        const half = ctx.measureText(l.text).width / 2;
        // anchor the label's near edge on the label ring, so side labels grow outwards, not into the dots
        const r = labelR + Math.abs(Math.cos(a)) * half + Math.abs(Math.sin(a)) * (fontPx / 2);
        const want = cx + Math.cos(a) * r;
        const x = Math.min(Math.max(want, half + 4), size.w - half - 4);
        const y = cy + Math.sin(a) * r;
        // a label that would have to slide over the dots to stay on screen fades out instead (narrow screens)
        const alpha = Math.max(0, Math.min(1, 1 - (Math.abs(want - x) - 4) / 16));
        if (alpha <= 0) continue;
        if (y - fontPx / 2 < 0 || y + fontPx / 2 > size.h || x - half < 0 || x + half > size.w) clipped++;
        ctx.globalAlpha = alpha * labelAlpha;
        ctx.fillText(l.text, x, y);
      }
      ctx.globalAlpha = 1;
      canvas.dataset.labels = String(labels.length);
      canvas.dataset.labelsClipped = String(clipped);
      // positions
      const pos: Pos[] = [];
      for (const n of layout.nodes) {
        const a = n.angle + rot;
        const r = n.radius * scale;
        pos.push({ id: n.id, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, r: (n.size * scale) / 2 });
      }
      posRef.current = pos;
      const byId = new Map(pos.map((p) => [p.id, p]));
      // path lines
      if (highlightPath) {
        ctx.strokeStyle = '#5B5BD6';
        ctx.lineWidth = 2;
        for (const h of highlightPath.hops) {
          const from = h.fromId === 'user' ? { x: cx, y: cy } : byId.get(h.fromId);
          const to = byId.get(h.toId);
          if (!from || !to) continue;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          const mx = (from.x + to.x) / 2 + (to.y - from.y) * 0.15;
          const my = (from.y + to.y) / 2 - (to.x - from.x) * 0.15;
          ctx.quadraticCurveTo(mx, my, to.x, to.y);
          ctx.stroke();
        }
      }
      // nodes
      for (const n of layout.nodes) {
        const p = byId.get(n.id)!;
        if (n.cluster) {
          const dim =
            !!highlightPath || (highlightIds && !n.cluster.personIds.some((id) => highlightIds.has(id)));
          ctx.globalAlpha = dim ? 0.18 : 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fillStyle = '#eef0f5';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#c9cdd6';
          ctx.stroke();
          const label = n.cluster.count > 999 ? '999+' : `+${n.cluster.count}`;
          if (p.r >= 5) {
            ctx.fillStyle = '#4a505c';
            ctx.font = `600 ${Math.max(7, Math.min(p.r * 0.8, (p.r * 2.8) / label.length))}px Inter, sans-serif`;
            ctx.fillText(label, p.x, p.y + 0.5);
          }
          ctx.globalAlpha = 1;
          continue;
        }
        const person = n.person!;
        const dim = (highlightPath && !pathIds.has(n.id)) || (highlightIds && !highlightIds.has(n.id));
        ctx.globalAlpha = dim ? 0.18 : 1;
        let img = person.photoUrl ? images.current.get(person.id) : undefined;
        if (person.photoUrl && !img) {
          img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            dirtyRef.current = true;
          };
          img.src = person.photoUrl;
          images.current.set(person.id, img);
        }
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        if (img?.complete && img.naturalWidth) ctx.drawImage(img, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        else {
          ctx.fillStyle = `hsl(${hue(person.id)} 45% 55%)`;
          ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
          if (p.r >= 7) {
            ctx.fillStyle = '#fff';
            ctx.font = `600 ${Math.max(7, p.r * 0.8)}px Inter, sans-serif`;
            ctx.fillText(initialsOf(person), p.x, p.y + 0.5);
          }
        }
        ctx.restore();
        // ring: stage colour or hairline
        const st = stages.get(n.id);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 1.5, 0, Math.PI * 2);
        ctx.lineWidth = st ? 2.5 : 1;
        ctx.strokeStyle = st
          ? (STAGE_COLOR[st as keyof typeof STAGE_COLOR] ?? '#9aa1ad')
          : 'rgba(15,17,21,0.08)';
        ctx.stroke();
        if (pathIds.has(n.id) || focusId === n.id) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#5B5BD6';
          ctx.stroke();
        }
        if (pending.has(n.id) && !dim) {
          const t = (performance.now() / 1200) % 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 3 + t * 10, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(91,91,214,${0.5 * (1 - t)})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // centre
      ctx.beginPath();
      ctx.arc(cx, cy, 26 * Math.max(0.6, scale), 0, Math.PI * 2);
      ctx.fillStyle = '#5B5BD6';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${12 * Math.max(0.8, scale)}px Inter, sans-serif`;
      ctx.fillText('You', cx, cy + 1);
      // tooltip
      if (hover) {
        const p = byId.get(hover);
        const node = nodeById.get(hover);
        if (p && node) {
          const label = node.cluster
            ? node.cluster.label === 'Other companies'
              ? `${node.cluster.count} people at other companies`
              : `${node.cluster.count} more at ${node.cluster.label}`
            : node.person!.displayName;
          ctx.font = '500 12px Inter, sans-serif';
          const w = ctx.measureText(label).width + 16;
          const x = Math.min(Math.max(p.x, w / 2 + 4), size.w - w / 2 - 4);
          const y = Math.max(p.y - p.r - 18, 14);
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#e6e8ec';
          ctx.lineWidth = 1;
          roundRect(ctx, x - w / 2, y - 11, w, 22, 6);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#0f1115';
          ctx.fillText(label, x, y);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [
    layout,
    labels,
    nodeById,
    size,
    hover,
    paused,
    rotate,
    reduced,
    highlightPath,
    highlightIds,
    pathIds,
    stages,
    pending,
    scale,
    focusId,
  ]);
  const hit = (clientX: number, clientY: number, touch = false): string | undefined => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Pos | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of posRef.current) {
      // small dots get a finger-sized target on touch screens
      const reach = Math.max(p.r + 4, touch ? 16 : 8);
      const d = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (d <= reach ** 2 && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best?.id;
  };
  const activate = (id: string) => {
    const node = nodeById.get(id);
    if (node?.cluster) onSelectCluster?.(node);
    else onSelect(id);
  };
  const clearHover = () => {
    setHover(undefined);
    setPaused(false);
    onHover?.(undefined);
  };
  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 block cursor-pointer touch-manipulation"
        data-testid="orbit-canvas"
        data-overlaps={overlaps}
        data-nodes={layout.nodes.length}
        data-aggregated={layout.aggregated}
        data-scale={scale.toFixed(3)}
        aria-label={`Orbit map of ${people.length} people`}
        role="img"
        onPointerMove={(e) => {
          if (e.pointerType !== 'mouse') return;
          const id = hit(e.clientX, e.clientY);
          if (id !== hover) {
            setHover(id);
            onHover?.(id);
          }
          setPaused(!!id);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') clearHover();
        }}
        onPointerUp={(e) => {
          if (e.pointerType === 'mouse') return;
          // touch: the first tap shows who it is, a second tap on the same dot opens it
          lastTouch.current = Date.now();
          const id = hit(e.clientX, e.clientY, true);
          if (!id) return clearHover();
          if (id === hover) return activate(id);
          setHover(id);
          setPaused(true);
          onHover?.(id);
        }}
        onClick={(e) => {
          if (Date.now() - lastTouch.current < 600) return; // already handled as a tap
          const id = hit(e.clientX, e.clientY);
          if (id) activate(id);
        }}
      />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
function initialsOf(p: Person): string {
  return `${p.firstName[0] ?? ''}${p.lastName[0] ?? ''}`.toUpperCase() || '?';
}
