import type { OrbitGroup, OrbitLayout } from '@orbit/core';
import { clamp, TAU, wrapAngle } from './motion';

/** Gap between the outermost dots and the company labels, in CSS px. */
export const LABEL_GAP = 14;
export const LABEL_FONT_PX = 11;

/** Fit the orbit (dots plus labels) inside the canvas: labels above and below need room, sides are clamped. */
export function orbitScale(w: number, h: number, extent: number): number {
  const side = w < 600 ? 10 : 60;
  // the top and bottom labels keep a clear margin from the canvas edge
  const s = Math.min(1, (h / 2 - LABEL_GAP - LABEL_FONT_PX - 14) / extent, (w / 2 - side) / extent);
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

/**
 * Control points for the hops of a route that starts at the centre (You) and runs through `pts`. Each hop bows
 * gently to the left of travel, like `curveControl`. Two cases get more room:
 * - a hop whose straight line would pass close to the centre swings round it, on the far side from the centre, so
 *   it never reads as a line from You;
 * - a hop that heads back the way the previous one came, and that previous one, bow apart like a lens, wider, so
 *   the two read as two lines that never cross rather than one thick one.
 * `minClear` is the least distance from the centre a hop between two dots keeps (the You dot plus some air).
 */
export function routeControls(pts: readonly Pt[], cx: number, cy: number, minClear: number, out: Pt[]): Pt[] {
  const hops = Math.max(0, pts.length - 1);
  out.length = hops;
  // a hop followed by one that heads back the way it came (within about 40 degrees): the pair bows apart like a
  // lens, the way out away from where the way back ends and the way back toward it, so the two never cross
  const want = new Array<number>(hops).fill(0);
  for (let k = 0; k + 1 < hops; k++) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    const c = pts[k + 2]!;
    const ox = b.x - a.x;
    const oy = b.y - a.y;
    const rx = c.x - b.x;
    const ry = c.y - b.y;
    const lo = Math.hypot(ox, oy);
    const lr = Math.hypot(rx, ry);
    if (lo < 1 || lr < 1 || (-ox * rx - oy * ry) / (lo * lr) <= 0.76) continue;
    // which side of the way out the way back ends on (left of travel is +1)
    const sigma = (c.x - a.x) * (oy / lo) - (c.y - a.y) * (ox / lo) >= 0 ? 1 : -1;
    want[k] = -sigma;
    want[k + 1] = -sigma;
  }
  for (let k = 0; k < hops; k++) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const c = out[k] ?? { x: 0, y: 0 };
    out[k] = c;
    if (len < 1) {
      c.x = mx;
      c.y = my;
      continue;
    }
    // unit normal to the left of travel (the side curveControl bows to)
    const nx = dy / len;
    const ny = -dx / len;
    let side = want[k] || 1;
    let offset = (want[k] ? 0.32 : 0.15) * len;
    const ra = Math.hypot(a.x - cx, a.y - cy);
    const rb = Math.hypot(b.x - cx, b.y - cy);
    if (ra > 1 && rb > 1) {
      const t = ((cx - a.x) * dx + (cy - a.y) * dy) / (len * len);
      const across = (cx - mx) * nx + (cy - my) * ny;
      const clear = Math.max(minClear, 0.45 * Math.min(ra, rb));
      if (t > 0.05 && t < 0.95 && Math.abs(across) < clear) {
        // bow away from the centre, far enough that the curve's middle clears it
        side = across > 0 ? -1 : 1;
        offset = Math.min(1.2 * len, Math.max(offset, 2 * (clear - Math.abs(across))));
      }
    }
    c.x = mx + nx * side * offset;
    c.y = my + ny * side * offset;
  }
  return out;
}

/**
 * Where a dot at angle `a` sits while the wedge centred on `mid` (half-width `half`) opens up by `k`: the wedge's
 * own dots spread out from its centre, and everyone else closes up a little round the rest of the circle to make
 * the room, so the opened wedge never pushes its dots onto a neighbour's.
 */
export function openedAngle(a: number, mid: number, half: number, k: number, inside: boolean): number {
  if (k === 1) return a;
  if (inside) return mid + (a - mid) * k;
  let d = (a - mid) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  const m = Math.abs(d);
  const open = Math.min(Math.PI * 0.9, half * k);
  if (m <= half || half >= Math.PI) return a + d * (k - 1);
  const squeezed = open + ((m - half) * (Math.PI - open)) / (Math.PI - half);
  return a + Math.sign(d) * (squeezed - m);
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

/**
 * Angle nudges (radians, one per dot) that move dots sitting side by side apart until every pair is at least the sum
 * of their sizes plus `gap` apart, centre to centre. Dots keep their radius; each push is shared by the two dots, and
 * no dot moves more than `cap`. Polar input in layout units (angle before rotation, radius, drawn radius).
 */
export function spreadApart(
  angles: readonly number[],
  radii: readonly number[],
  sizes: readonly number[],
  gap: number,
  cap = 0.5,
): number[] {
  const n = angles.length;
  const off = new Array<number>(n).fill(0);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const ri = radii[i]!;
        const rj = radii[j]!;
        const need = sizes[i]! + sizes[j]! + gap;
        const diff = wrapAngle(angles[i]! + off[i]! - (angles[j]! + off[j]!));
        // the angle between them that puts them `need` apart at these radii (none when the radii alone do it)
        const c = (ri * ri + rj * rj - need * need) / (2 * ri * rj);
        const want = c >= 1 ? 0 : c <= -1 ? Math.PI : Math.acos(c);
        const push = (want - Math.abs(diff)) / 2;
        if (push <= 1e-6) continue;
        const dir = diff >= 0 ? 1 : -1;
        const oi = clamp(off[i]! + dir * push, -cap, cap);
        const oj = clamp(off[j]! - dir * push, -cap, cap);
        if (Math.abs(oi - off[i]!) + Math.abs(oj - off[j]!) < 1e-6) continue;
        off[i] = oi;
        off[j] = oj;
        moved = true;
      }
    if (!moved) break;
  }
  return off;
}
