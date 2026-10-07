import { describe, expect, it } from 'vitest';
import { TAU } from './motion';
import type { Pt } from './orbitGeometry';
import {
  curveControl,
  fanSlots,
  frameBox,
  labelSlots,
  nearestInDirection,
  openedAngle,
  orbitScale,
  type PathSink,
  quadPartial,
  quadPoint,
  routeControls,
  wedgeMid,
} from './orbitGeometry';

/** The closest a quadratic curve comes to a point, sampled. */
function closest(a: Pt, c: Pt, b: Pt, px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY;
  const q = { x: 0, y: 0 };
  for (let i = 0; i <= 200; i++) {
    quadPoint(q, a.x, a.y, c.x, c.y, b.x, b.y, i / 200);
    best = Math.min(best, Math.hypot(q.x - px, q.y - py));
  }
  return best;
}

describe('orbit geometry', () => {
  it('fits the orbit and its labels inside the canvas', () => {
    // the top label keeps at least 14 px from the canvas edge
    expect(orbitScale(1280, 720, 520)).toBeCloseTo((360 - 39) / 520);
    expect(orbitScale(390, 560, 520)).toBeCloseTo((195 - 10) / 520);
    expect(orbitScale(100, 100, 520)).toBe(0.2);
  });

  it('a wedge’s centre is halfway between its edges', () => {
    expect(wedgeMid({ startAngle: -Math.PI / 2, endAngle: 0 })).toBeCloseTo(-Math.PI / 4);
  });

  it('fans members out in rows centred on the wedge, inner row first', () => {
    const slots = fanSlots(5, 1, 500, 30);
    expect(slots).toHaveLength(5);
    expect(new Set(slots.map((s) => s.radius))).toEqual(new Set([500]));
    const mean = slots.reduce((s, x) => s + x.angle, 0) / slots.length;
    expect(mean).toBeCloseTo(1);
    // neighbours keep one pitch apart on the arc
    expect((slots[1]!.angle - slots[0]!.angle) * 500).toBeCloseTo(30);
    // too many for one row: later rows sit further out, and the total is capped
    const many = fanSlots(200, 0, 500, 30, 0.9, 3);
    const radii = [...new Set(many.map((s) => s.radius))];
    expect(radii).toEqual([500, 530, 560]);
    expect(many.length).toBeLessThan(200);
    for (const s of many) expect(Math.abs(s.angle)).toBeLessThanOrEqual(0.45 + 1e-9);
  });

  it('bends a curve to one side and finds points on it', () => {
    const c = curveControl({ x: 0, y: 0 }, 0, 0, 100, 0, 0.15);
    expect(c.x).toBeCloseTo(50);
    expect(c.y).toBeCloseTo(-15);
    const p = quadPoint({ x: 0, y: 0 }, 0, 0, c.x, c.y, 100, 0, 0.5);
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(-7.5);
  });

  it('draws the first part of a curve, ending on the curve itself', () => {
    const calls: [string, ...number[]][] = [];
    const sink: PathSink = {
      moveTo: (x, y) => calls.push(['M', x, y]),
      lineTo: (x, y) => calls.push(['L', x, y]),
      quadraticCurveTo: (cx, cy, x, y) => calls.push(['Q', cx, cy, x, y]),
    };
    quadPartial(sink, 0, 0, 50, -15, 100, 0, 0);
    expect(calls).toEqual([]);
    quadPartial(sink, 0, 0, 50, -15, 100, 0, 0.5);
    const end = quadPoint({ x: 0, y: 0 }, 0, 0, 50, -15, 100, 0, 0.5);
    expect(calls[0]).toEqual(['M', 0, 0]);
    expect(calls[1]![3]).toBeCloseTo(end.x);
    expect(calls[1]![4]).toBeCloseTo(end.y);
    calls.length = 0;
    quadPartial(sink, 0, 0, 50, -15, 100, 0, 1);
    expect(calls[1]).toEqual(['Q', 50, -15, 100, 0]);
  });

  it('frames a small box by zooming in, and leaves a big one alone', () => {
    const near = frameBox(-20, -150, 40, 0, 800, 600, 40, 1.35);
    expect(near.zoom).toBe(1.35);
    expect(near.panX).toBeCloseTo(-10 * 1.35);
    expect(near.panY).toBeCloseTo(75 * 1.35);
    expect(frameBox(-300, -280, 300, 280, 800, 600, 40, 1.35)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('keeps labels from overlapping, biggest companies first', () => {
    const groups = [
      { key: 'a', label: 'Alpha', startAngle: 0.1, endAngle: 0.12, count: 5 },
      { key: 'b', label: 'Beta', startAngle: 0.12, endAngle: 0.14, count: 9 },
      { key: 'c', label: 'Gamma', startAngle: 2, endAngle: 3, count: 3 },
    ];
    const slots = labelSlots({ groups, extent: 500 }, 1, false, (t) => t.length * 7);
    expect(slots.map((s) => s.key)).toEqual(['b', 'c']);
    expect(slots[0]!.mid).toBeCloseTo(0.13);
    // a label near the wrap-around point still clashes with one just past it
    const wrap = labelSlots(
      {
        groups: [
          { key: 'x', label: 'Xeno', startAngle: -0.05, endAngle: 0.05, count: 4 },
          { key: 'y', label: 'Yak', startAngle: TAU - 0.06, endAngle: TAU - 0.02, count: 3 },
        ],
        extent: 500,
      },
      1,
      false,
      () => 40,
    );
    expect(wrap.map((s) => s.key)).toEqual(['x']);
  });

  it('moves keyboard focus to the nearest dot in the arrow’s direction', () => {
    const xs = [0, 100, 0, -100, 30];
    const ys = [0, 0, 100, 0, -90];
    const none = () => false;
    expect(nearestInDirection(0, 0, 1, 0, xs, ys, none)).toBe(1);
    expect(nearestInDirection(0, 0, 0, 1, xs, ys, none)).toBe(2);
    expect(nearestInDirection(0, 0, -1, 0, xs, ys, none)).toBe(3);
    expect(nearestInDirection(0, 0, 0, -1, xs, ys, none)).toBe(4);
    expect(nearestInDirection(0, 0, 0, -1, xs, ys, (i) => i === 4)).toBe(-1);
  });

  it('swings a hop round You instead of drawing it through the centre', () => {
    // You at the centre, a connector below, the target straight above: the straight line would cross You
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 120 },
      { x: -5, y: 260 },
      { x: 0, y: -150 },
    ];
    const cs = routeControls(pts, 0, 0, 30, []);
    expect(cs).toHaveLength(3);
    expect(closest(pts[2]!, cs[2]!, pts[3]!, 0, 0)).toBeGreaterThan(50);
    // and it stays clear of the first hop out of You
    const q = { x: 0, y: 0 };
    quadPoint(q, pts[2]!.x, pts[2]!.y, cs[2]!.x, cs[2]!.y, pts[3]!.x, pts[3]!.y, 0.5);
    expect(Math.abs(q.x)).toBeGreaterThan(50);
    // a hop out of You keeps its gentle bow
    const plain = curveControl({ x: 0, y: 0 }, 0, 0, 10, 120, 0.15);
    expect(cs[0]!.x).toBeCloseTo(plain.x);
    expect(cs[0]!.y).toBeCloseTo(plain.y);
  });

  it('bows a hop that doubles back to the other side, wider', () => {
    // Rhea and Maya sit side by side on the inner ring; Kenji is out on the edge
    const pts = [
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { x: 400, y: 30 },
      { x: 152, y: 18 },
    ];
    const cs = routeControls(pts, 0, 0, 30, []);
    const mid = (k: number) =>
      quadPoint({ x: 0, y: 0 }, pts[k]!.x, pts[k]!.y, cs[k]!.x, cs[k]!.y, pts[k + 1]!.x, pts[k + 1]!.y, 0.5);
    const out = mid(1);
    const back = mid(2);
    // the two middles sit well apart, on opposite sides of the chord between Rhea and Kenji
    expect(Math.hypot(out.x - back.x, out.y - back.y)).toBeGreaterThan(60);
    const side = (p: Pt) => (p.x - 150) * (30 - 0) - (p.y - 0) * (400 - 150);
    expect(Math.sign(side(out))).not.toBe(Math.sign(side(back)));
    // and the way back bows toward where it ends (Maya's side), so the two lines never cross
    expect(Math.sign(side(back))).toBe(Math.sign(side(pts[3]!)));
    // the same with Maya on the other side of Rhea
    const flip = pts.map((p) => ({ x: p.x, y: -p.y }));
    const cf = routeControls(flip, 0, 0, 30, []);
    const backF = quadPoint(
      { x: 0, y: 0 },
      flip[2]!.x,
      flip[2]!.y,
      cf[2]!.x,
      cf[2]!.y,
      flip[3]!.x,
      flip[3]!.y,
      0.5,
    );
    const sideF = (p: Pt) => (p.x - 150) * (-30 - 0) - (p.y - 0) * (400 - 150);
    expect(Math.sign(sideF(backF))).toBe(Math.sign(sideF(flip[3]!)));
  });

  it('opens a wedge and closes the rest of the circle up to make room', () => {
    const mid = 1;
    const half = 0.2;
    // the wedge's own edge goes out by k
    expect(openedAngle(mid + half, mid, half, 1.3, true)).toBeCloseTo(mid + half * 1.3);
    // a neighbour just outside moves out with it, never landing inside the opened wedge
    const next = openedAngle(mid + half + 0.05, mid, half, 1.3, false);
    expect(next).toBeGreaterThan(mid + half * 1.3);
    expect(next - (mid + half * 1.3)).toBeGreaterThan(0.045);
    // the point opposite the wedge stays put, and order round the circle is kept
    expect(openedAngle(mid + Math.PI - 1e-6, mid, half, 1.3, false)).toBeCloseTo(mid + Math.PI, 4);
    const around = [0.3, 0.8, 1.5, 2.5, 3.5, 4.5, 5.5].map((d) =>
      openedAngle(mid + half + d * 0.5, mid, half, 1.3, false),
    );
    for (let i = 1; i < around.length; i++) expect(around[i]!).toBeGreaterThan(around[i - 1]!);
    expect(openedAngle(2, mid, half, 1, false)).toBe(2);
  });
});
