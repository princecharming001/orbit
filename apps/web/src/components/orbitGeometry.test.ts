import { describe, expect, it } from 'vitest';
import { TAU } from './motion';
import {
  curveControl,
  fanSlots,
  frameBox,
  labelSlots,
  nearestInDirection,
  orbitScale,
  type PathSink,
  quadPartial,
  quadPoint,
  wedgeMid,
} from './orbitGeometry';

describe('orbit geometry', () => {
  it('fits the orbit and its labels inside the canvas', () => {
    expect(orbitScale(1280, 720, 520)).toBeCloseTo((360 - 30) / 520);
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
});
