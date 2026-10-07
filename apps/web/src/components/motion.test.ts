import { describe, expect, it } from 'vitest';
import {
  easing,
  FrameRecorder,
  frameStats,
  fromTop,
  ManualClock,
  mixRgb,
  nearestAngle,
  outBack,
  parseHex,
  percentile,
  progress,
  rotationToTop,
  Spring,
  shortestTurn,
  TAU,
  Tween,
  wrapAngle,
} from './motion';

describe('easing', () => {
  it('every curve starts at 0 and ends at 1', () => {
    for (const [name, f] of Object.entries(easing)) {
      expect(f(0), name).toBeCloseTo(0, 9);
      expect(f(1), name).toBeCloseTo(1, 9);
    }
  });

  it('monotone curves stay inside 0..1; back overshoots past 1 and comes back', () => {
    for (const name of [
      'linear',
      'inQuad',
      'outQuad',
      'inOutQuad',
      'outCubic',
      'inOutCubic',
      'inOutSine',
    ] as const)
      for (let t = 0; t <= 1; t += 0.05) {
        expect(easing[name](t)).toBeGreaterThanOrEqual(-1e-12);
        expect(easing[name](t)).toBeLessThanOrEqual(1 + 1e-12);
      }
    const samples = Array.from({ length: 101 }, (_, i) => easing.outBack(i / 100));
    const peak = Math.max(...samples);
    // the classic constant overshoots by about ten percent
    expect(peak).toBeGreaterThan(1.09);
    expect(peak).toBeLessThan(1.11);
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => outBack(1.1)(i / 100)))).toBeLessThan(peak);
  });

  it('progress clamps and treats a zero duration as done', () => {
    expect(progress(50, 100, 200)).toBe(0);
    expect(progress(200, 100, 200)).toBe(0.5);
    expect(progress(400, 100, 200)).toBe(1);
    expect(progress(100, 100, 0)).toBe(1);
  });
});

describe('Tween', () => {
  it('runs from the start value to the target over its duration', () => {
    const t = new Tween(0).animate(100, 1000, 200, easing.linear);
    expect(t.value(900)).toBe(0);
    expect(t.value(1000)).toBe(0);
    expect(t.value(1100)).toBe(50);
    expect(t.value(1200)).toBe(100);
    expect(t.value(5000)).toBe(100);
    expect(t.done(1199)).toBe(false);
    expect(t.done(1200)).toBe(true);
  });

  it('an interruption starts from the current value: no jump', () => {
    const t = new Tween(0).animate(100, 0, 400, easing.outCubic);
    const before = t.value(150);
    t.animate(-50, 150, 300, easing.inOutCubic);
    expect(t.value(150)).toBeCloseTo(before, 9);
    // and it is continuous just after the switch too
    expect(Math.abs(t.value(151) - before)).toBeLessThan(1);
    expect(t.value(450)).toBe(-50);
  });

  it('asking for the target it is already heading to changes nothing', () => {
    const t = new Tween(0).animate(10, 0, 100, easing.linear);
    t.animate(10, 50, 1000, easing.linear);
    expect(t.end).toBe(100);
    expect(t.value(50)).toBe(5);
  });

  it('a delay holds the current value, then moves', () => {
    const t = new Tween(5).animate(15, 0, 100, easing.linear, 50);
    expect(t.value(25)).toBe(5);
    expect(t.value(100)).toBe(10);
    expect(t.end).toBe(150);
  });

  it('a zero duration is an instant set (reduced motion)', () => {
    const t = new Tween(1).animate(7, 0, 0);
    expect(t.value(0)).toBe(7);
    expect(t.done(0)).toBe(true);
  });

  it('play restarts from an explicit value', () => {
    const t = new Tween(3).play(0, 1, 100, 100, easing.linear);
    expect(t.value(150)).toBe(0.5);
  });
});

describe('Spring', () => {
  it('settles on its target and reports it', () => {
    const s = new Spring(0, { duration: 600 });
    s.target = 1;
    let t = 0;
    while (!s.settle(1e-4) && t < 5000) {
      s.step(16);
      t += 16;
    }
    expect(s.x).toBe(1);
    expect(s.v).toBe(0);
    // about the stated duration, not instant and not forever
    expect(t).toBeGreaterThan(300);
    expect(t).toBeLessThan(1600);
  });

  it('a critically damped spring never overshoots; a bouncy one does, a little', () => {
    const calm = new Spring(0, { duration: 500, bounce: 0 });
    const bouncy = new Spring(0, { duration: 500, bounce: 0.3 });
    calm.target = 1;
    bouncy.target = 1;
    let calmMax = 0;
    let bouncyMax = 0;
    for (let i = 0; i < 200; i++) {
      calm.step(10);
      bouncy.step(10);
      calmMax = Math.max(calmMax, calm.x);
      bouncyMax = Math.max(bouncyMax, bouncy.x);
    }
    expect(calmMax).toBeLessThanOrEqual(1 + 1e-9);
    expect(bouncyMax).toBeGreaterThan(1.01);
    expect(bouncyMax).toBeLessThan(1.4);
  });

  it('moving the target mid-flight keeps position and velocity continuous', () => {
    const s = new Spring(0, { duration: 600, bounce: 0.1 });
    s.target = 100;
    for (let i = 0; i < 10; i++) s.step(16);
    const x = s.x;
    const v = s.v;
    s.target = -100;
    expect(s.x).toBe(x);
    expect(s.v).toBe(v);
    s.step(1);
    // one millisecond later it has barely moved
    expect(Math.abs(s.x - x)).toBeLessThan(Math.abs(v) * 1 + 0.5);
  });

  it('is stable for long frames (closed form)', () => {
    const a = new Spring(0, { duration: 400, bounce: 0.2 });
    const b = new Spring(0, { duration: 400, bounce: 0.2 });
    a.target = 1;
    b.target = 1;
    a.step(500);
    for (let i = 0; i < 500; i++) b.step(1);
    expect(a.x).toBeCloseTo(b.x, 6);
    a.step(10_000);
    expect(a.x).toBeCloseTo(1, 6);
  });
});

describe('clock', () => {
  it('a manual clock only moves when told', () => {
    const c = new ManualClock(10);
    expect(c.now()).toBe(10);
    c.tick(16);
    expect(c.now()).toBe(26);
  });
});

describe('angles', () => {
  it('wraps into (-π, π]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(TAU + 0.5)).toBeCloseTo(0.5);
    expect(wrapAngle(-TAU - 0.5)).toBeCloseTo(-0.5);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
  });

  it('takes the shortest turn, either way round', () => {
    expect(shortestTurn(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(shortestTurn(3.0, -3.0)).toBeCloseTo(TAU - 6.0);
    expect(shortestTurn(-3.0, 3.0)).toBeCloseTo(6.0 - TAU);
    expect(nearestAngle(10 * TAU + 0.2, 0.1)).toBeCloseTo(10 * TAU + 0.1);
  });

  it('rotates a wedge to twelve o’clock the short way', () => {
    // a wedge at three o'clock (angle 0) needs a quarter turn back
    expect(rotationToTop(0, 0)).toBeCloseTo(-Math.PI / 2);
    // already at the top: no turn
    expect(rotationToTop(-Math.PI / 2, 0)).toBeCloseTo(0);
    // from a rotation many turns in, it stays near that rotation
    const r = rotationToTop(Math.PI / 2, 40);
    expect(Math.abs(r - 40)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(wrapAngle(Math.PI / 2 + r)).toBeCloseTo(-Math.PI / 2);
  });

  it('measures position from twelve o’clock clockwise', () => {
    expect(fromTop(-Math.PI / 2)).toBeCloseTo(0);
    expect(fromTop(0)).toBeCloseTo(0.25);
    expect(fromTop(Math.PI / 2)).toBeCloseTo(0.5);
    expect(fromTop(Math.PI)).toBeCloseTo(0.75);
    expect(fromTop(-Math.PI / 2 + TAU * 3)).toBeCloseTo(0);
  });
});

describe('colour', () => {
  it('mixes two hex colours', () => {
    expect(parseHex('#5B5BD6')).toEqual([91, 91, 214]);
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(mixRgb([0, 0, 0], [255, 255, 255], 0.5)).toBe('rgb(128,128,128)');
    expect(mixRgb([0, 0, 0], [255, 255, 255], 2)).toBe('rgb(255,255,255)');
  });
});

describe('frame timing', () => {
  it('percentiles interpolate', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([5, 1, 3], 100)).toBe(5);
  });

  it('counts dropped 60 Hz frames and ignores the idle gap', () => {
    const r = new FrameRecorder();
    r.frame(0, 2);
    r.frame(16.7, 2);
    r.frame(50, 3); // one frame missed
    r.gap();
    r.frame(5000, 2); // after a sleep: not a long frame
    r.frame(5016.7, 2);
    const s = r.stats();
    expect(s.frames).toBe(3);
    expect(s.max).toBeCloseTo(33.3);
    expect(s.dropped).toBeCloseTo(1 / 4);
    expect(s.workMax).toBe(3);
    expect(frameStats([]).frames).toBe(0);
  });

  it('counts the first frame after a wake from the moment of the change', () => {
    const r = new FrameRecorder();
    r.gap();
    r.resume(1000); // a click wakes the loop, then the page works for 60 ms before the frame
    r.frame(1060, 2);
    r.resume(1061); // already running: no effect
    r.frame(1076.7, 2);
    expect(r.deltas).toEqual([60, expect.closeTo(16.7, 5)]);
  });
});
