import type { Organization, Person, ReachPath } from '@orbit/core';
import { type OrbitLayout, orbitLayout, ringRotation } from '@orbit/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { STAGE_COLOR } from '../pages/Pipeline';

export interface MapProps {
  people: Person[];
  orgs: Map<string, Organization>;
  stages: Map<string, string>;
  pending: Set<string>;
  highlightPath?: ReachPath; // reach mode
  highlightIds?: Set<string>;
  onSelect: (id: string) => void;
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

export function OrbitMap({
  people,
  orgs,
  stages,
  pending,
  highlightPath,
  highlightIds,
  onSelect,
  onHover,
  rotate = true,
  focusId,
}: MapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 640 });
  const [hover, setHover] = useState<string | undefined>();
  const [paused, setPaused] = useState(false);
  const images = useRef(new Map<string, HTMLImageElement>());
  const startRef = useRef(performance.now());
  const posRef = useRef<Pos[]>([]);
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: Math.max(420, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: Math.max(420, el.clientHeight) });
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, Math.min(size.w, size.h) / 960) * (size.w < 480 ? 0.9 : 1);
  const layout: OrbitLayout = useMemo(
    () => orbitLayout(people, orgs, { scale: Math.max(0.42, scale) }),
    [people, orgs, scale],
  );
  const pathIds = useMemo(
    () => new Set(highlightPath ? highlightPath.hops.flatMap((h) => [h.fromId, h.toId]) : []),
    [highlightPath],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
        canvas.width = size.w * dpr;
        canvas.height = size.h * dpr;
        canvas.style.width = `${size.w}px`;
        canvas.style.height = `${size.h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);
      const cx = size.w / 2;
      const cy = size.h / 2;
      const elapsed =
        rotate && !paused && !reduced && !highlightPath ? performance.now() - startRef.current : 0;
      // rings
      ctx.strokeStyle = '#eceef2';
      ctx.lineWidth = 1;
      for (const r of layout.ringRadii) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      // company arcs/labels on outer ring
      const outer = layout.ringRadii[2] + 44 * Math.max(0.42, scale);
      ctx.font = `500 ${Math.max(10, 11 * Math.max(0.8, scale))}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const g of layout.groups) {
        if (g.count < 2 && layout.groups.length > 12) continue;
        const a = (g.startAngle + g.endAngle) / 2 + ringRotation(2, elapsed);
        const x = cx + Math.cos(a) * outer;
        const y = cy + Math.sin(a) * outer;
        const dim = (highlightPath || highlightIds) && true;
        ctx.fillStyle = dim ? 'rgba(118,125,137,0.45)' : '#767d89';
        ctx.fillText(g.label.length > 18 ? `${g.label.slice(0, 17)}…` : g.label, x, y);
      }
      // positions
      const pos: Pos[] = [];
      for (const n of layout.nodes) {
        const a = n.angle + ringRotation(n.ring, elapsed);
        pos.push({ id: n.id, x: cx + Math.cos(a) * n.radius, y: cy + Math.sin(a) * n.radius, r: n.size / 2 });
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
        const dim = (highlightPath && !pathIds.has(n.id)) || (highlightIds && !highlightIds.has(n.id));
        ctx.globalAlpha = dim ? 0.18 : 1;
        const person = n.person;
        const img = person.photoUrl ? images.current.get(person.id) : undefined;
        if (person.photoUrl && !img) {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.src = person.photoUrl;
          images.current.set(person.id, im);
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
          ctx.fillStyle = '#fff';
          ctx.font = `600 ${Math.max(9, p.r * 0.8)}px Inter, sans-serif`;
          ctx.fillText(initialsOf(person), p.x, p.y + 0.5);
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
        const person = layout.nodes.find((n) => n.id === hover)?.person;
        if (p && person) {
          const label = person.displayName;
          ctx.font = '500 12px Inter, sans-serif';
          const w = ctx.measureText(label).width + 16;
          const x = p.x;
          const y = p.y - p.r - 18;
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#e6e8ec';
          roundRect(ctx, x - w / 2, y - 11, w, 22, 6);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#0f1115';
          ctx.fillText(label, x, y);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [
    layout,
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
  const hit = (e: React.MouseEvent<HTMLCanvasElement>): string | undefined => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: Pos | undefined;
    for (const p of posRef.current) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= (p.r + 4) ** 2) best = p;
    return best?.id;
  };
  return (
    <div ref={wrapRef} className="relative w-full h-full min-h-[420px]">
      <canvas
        ref={canvasRef}
        className="block cursor-pointer"
        data-testid="orbit-canvas"
        onMouseMove={(e) => {
          const id = hit(e);
          if (id !== hover) {
            setHover(id);
            onHover?.(id);
          }
          setPaused(!!id);
        }}
        onMouseLeave={() => {
          setHover(undefined);
          setPaused(false);
          onHover?.(undefined);
        }}
        onClick={(e) => {
          const id = hit(e);
          if (id) onSelect(id);
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
