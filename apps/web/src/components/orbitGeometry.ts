import type { OrbitGroup, OrbitLayout } from '@orbit/core';
import { clamp, TAU } from './motion';

/** Gap between the outermost dots and the company labels, in CSS px. */
export const LABEL_GAP = 14;
export const LABEL_FONT_PX = 11;

/** Fit the orbit (dots plus labels) inside the canvas: labels above and below need room, sides are clamped. */
export function orbitScale(w: number, h: number, extent: number): number {
  const side = w < 600 ? 10 : 60;
  const s = Math.min(1, (h / 2 - LABEL_GAP - 16) / extent, (w / 2 - side) / extent);
  return Math.max(0.2, s);
}

/** The centre angle of a company's wedge (before rotation). */
export function wedgeMid(g: Pick<OrbitGroup, 'startAngle' | 'endAngle'>): number {
  return (g.startAngle + g.endAngle) / 2;
}

export interface Slot {
  angle: number;
  radius: number;
}

/**
 * Where an aggregate dot's members go when it bursts open: rows of dots just outside the orbit, centred on the
 * wedge, inner row first, at most `maxSpan` radians wide. Returns as many slots as fit (up to `count`).
 */
export function fanSlots(
  count: number,
  mid: number,
  baseRadius: number,
  pitch: number,
  maxSpan = 0.9,
  maxRows = 3,
): Slot[] {
  const out: Slot[] = [];
  let left = count;
  for (let row = 0; row < maxRows && left > 0; row++) {
    const radius = baseRadius + row * pitch;
    const step = pitch / radius;
    const cap = Math.max(1, Math.floor(maxSpan / step) + 1);
    const n = Math.min(left, cap);
    for (let i = 0; i < n; i++) out.push({ angle: mid + (i - (n - 1) / 2) * step, radius });
    left -= n;
  }
  return out;
}

export interface Pt {
  x: number;
  y: number;
}

/** Control point of a gentle curve from (x0, y0) to (x1, y1), bowed to the left of the direction of travel. */
export function curveControl(out: Pt, x0: number, y0: number, x1: number, y1: number, bend = 0.15): Pt {
  out.x = (x0 + x1) / 2 + (y1 - y0) * bend;
  out.y = (y0 + y1) / 2 - (x1 - x0) * bend;
  return out;
}

/** Point at parameter t on a quadratic curve. */
export function quadPoint(
  out: Pt,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number,
): Pt {
  const u = 1 - t;
  out.x = u * u * x0 + 2 * u * t * cx + t * t * x1;
  out.y = u * u * y0 + 2 * u * t * cy + t * t * y1;
  return out;
}

/** The subset of the canvas path API the helpers draw with (so tests can record calls). */
export interface PathSink {
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

/** Adds the first `p` (0..1) of a quadratic curve to the current path: a line that grows from its start. */
export function quadPartial(
  ctx: PathSink,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  p: number,
): void {
  if (p <= 0) return;
  ctx.moveTo(x0, y0);
  if (p >= 1) {
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    return;
  }
  // de Casteljau split at p: the first half is itself a quadratic curve
  const qx = x0 + (cx - x0) * p;
  const qy = y0 + (cy - y0) * p;
  const rx = cx + (x1 - cx) * p;
  const ry = cy + (y1 - cy) * p;
  ctx.quadraticCurveTo(qx, qy, qx + (rx - qx) * p, qy + (ry - qy) * p);
}

export interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * The camera that frames a box (screen px relative to the orbit centre at zoom 1) inside a view, zooming in no
 * further than `maxZoom`. At zoom 1 the whole orbit already fits, so a box that cannot be enlarged stays put.
 */
export function frameBox(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  viewW: number,
  viewH: number,
  margin: number,
  maxZoom: number,
): Camera {
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const zoom = clamp(Math.min((viewW - 2 * margin) / bw, (viewH - 2 * margin) / bh), 1, maxZoom);
  if (zoom < 1.05) return { zoom: 1, panX: 0, panY: 0 };
  return { zoom, panX: (-(minX + maxX) / 2) * zoom, panY: (-(minY + maxY) / 2) * zoom };
}

export interface LabelSlot {
  key: string;
  text: string;
  /** wedge centre angle before rotation */
  mid: number;
}

/**
 * Company labels, biggest companies first. A label is shown only when its arc is free; the test uses angles, so
 * the set of labels does not change while the orbit turns.
 */
export function labelSlots(
  layout: Pick<OrbitLayout, 'groups' | 'extent'>,
  scale: number,
  narrow: boolean,
  measure: (text: string) => number,
): LabelSlot[] {
  const radius = layout.extent * scale + LABEL_GAP;
  const max = narrow ? 12 : 18;
  const taken: [number, number][] = [];
  const out: LabelSlot[] = [];
  const ordered = [...layout.groups].sort((a, b) => b.count - a.count);
  for (const g of ordered) {
    if (g.count < 2 && layout.groups.length > 8) continue;
    const text = g.label.length > max ? `${g.label.slice(0, max - 1)}…` : g.label;
    const half = (measure(text) + 12) / 2 / radius;
    const mid = wedgeMid(g);
    const lo = mid - half;
    const hi = mid + half;
    const clash = taken.some(([a, b]) => [-TAU, 0, TAU].some((s) => lo < b + s && hi > a + s));
    if (clash) continue;
    taken.push([lo, hi]);
    out.push({ key: g.key, text, mid });
  }
  return out;
}

/** Index of the point nearest in the direction (dx, dy) from (x0, y0), favouring points straight ahead. */
export function nearestInDirection(
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  skip: (i: number) => boolean,
): number {
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < xs.length; i++) {
    if (skip(i)) continue;
    const ox = xs[i]! - x0;
    const oy = ys[i]! - y0;
    const ahead = ox * dx + oy * dy;
    if (ahead <= 2) continue;
    const side = Math.abs(ox * dy - oy * dx);
    const score = ahead + side * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
