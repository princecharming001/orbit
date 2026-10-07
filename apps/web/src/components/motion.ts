/**
 * A tiny motion toolkit for the orbit map: easing curves, interruptible tweens, springs, a clock and a frame-time
 * recorder. Everything here is plain arithmetic on numbers, so the render loop can hold thousands of these
 * without allocating per frame.
 */

export type Easing = (t: number) => number;

export const TAU = Math.PI * 2;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Ease-out with a slight overshoot past the target before settling (1.70158 is the classic 10 percent). */
export function outBack(overshoot = 1.70158): Easing {
  const c3 = overshoot + 1;
  return (t) => {
    const u = t - 1;
    return 1 + c3 * u * u * u + overshoot * u * u;
  };
}

export const easing = {
  linear: ((t) => t) as Easing,
  inQuad: ((t) => t * t) as Easing,
  outQuad: ((t) => 1 - (1 - t) * (1 - t)) as Easing,
  inOutQuad: ((t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)) as Easing,
  inCubic: ((t) => t * t * t) as Easing,
  outCubic: ((t) => 1 - (1 - t) ** 3) as Easing,
  inOutCubic: ((t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)) as Easing,
  outQuint: ((t) => 1 - (1 - t) ** 5) as Easing,
  inOutSine: ((t) => -(Math.cos(Math.PI * t) - 1) / 2) as Easing,
  outBack: outBack(),
  /** a gentler overshoot, for things that should land rather than bounce */
  outBackSoft: outBack(1.1),
};

/** Fraction of `duration` elapsed at `now` since `start`, clamped to 0..1 (a zero duration is already done). */
export function progress(now: number, start: number, duration: number): number {
  if (duration <= 0) return now >= start ? 1 : 0;
  return clamp01((now - start) / duration);
}

/**
 * A value that moves from where it is to a target over a fixed time with an easing curve. Retargeting starts from
 * the value at that moment, so an interruption never jumps; asking for the target it is already heading to changes
 * nothing, so callers can set targets as often as they like.
 */
export class Tween {
  from: number;
  to: number;
  start = 0;
  duration = 0;
  ease: Easing = easing.outCubic;

  constructor(value = 0) {
    this.from = value;
    this.to = value;
  }

  value(now: number): number {
    if (this.duration <= 0 || now >= this.start + this.duration) return this.to;
    if (now <= this.start) return this.from;
    return this.from + (this.to - this.from) * this.ease((now - this.start) / this.duration);
  }

  /** Head for `target`, starting from the current value; `delay` holds the current value first (for staggers). */
  animate(target: number, now: number, duration: number, ease: Easing = easing.outCubic, delay = 0): this {
    if (target === this.to) return this;
    if (duration <= 0) return this.snap(target);
    this.from = this.value(now);
    this.to = target;
    this.start = now + Math.max(0, delay);
    this.duration = duration;
    this.ease = ease;
    return this;
  }

  /** Restart from an explicit value (for one-shot effects such as a pop or a draw-in). */
  play(
    from: number,
    target: number,
    now: number,
    duration: number,
    ease: Easing = easing.outCubic,
    delay = 0,
  ) {
    this.from = from;
    this.to = target;
    this.start = now + Math.max(0, delay);
    this.duration = Math.max(0, duration);
    this.ease = ease;
    return this;
  }

  /** Jump to a value with no motion (reduced motion, first paint). */
  snap(value: number): this {
    this.from = value;
    this.to = value;
    this.duration = 0;
    return this;
  }

  get end(): number {
    return this.start + this.duration;
  }

  done(now: number): boolean {
    return this.duration <= 0 || now >= this.start + this.duration;
  }
}

export interface SpringOptions {
  /** perceptual duration in ms: the period of the undamped spring */
  duration?: number;
  /** 0 = critically damped (no overshoot), up to 1 = undamped */
  bounce?: number;
}

/**
 * A damped spring solved in closed form, so a long frame (a busy main thread, a background tab) never makes it
 * unstable. Velocity carries over when the target moves mid-flight, which is what makes springs feel continuous.
 */
export class Spring {
  x: number;
  v = 0;
  target: number;
  omega: number;
  zeta: number;

  constructor(x = 0, opts: SpringOptions = {}) {
    this.x = x;
    this.target = x;
    this.omega = TAU / Math.max(1, opts.duration ?? 600);
    this.zeta = 1 - clamp(opts.bounce ?? 0, 0, 0.95);
  }

  configure(opts: SpringOptions): this {
    this.omega = TAU / Math.max(1, opts.duration ?? TAU / this.omega);
    if (opts.bounce !== undefined) this.zeta = 1 - clamp(opts.bounce, 0, 0.95);
    return this;
  }

  /** Advance by dt milliseconds. */
  step(dt: number): this {
    if (dt <= 0) return this;
    const w = this.omega;
    const z = this.zeta;
    const d0 = this.x - this.target;
    const v0 = this.v;
    if (z >= 1 - 1e-9) {
      const e = Math.exp(-w * dt);
      const b = v0 + w * d0;
      this.x = this.target + (d0 + b * dt) * e;
      this.v = (v0 - w * b * dt) * e;
    } else {
      const wd = w * Math.sqrt(1 - z * z);
      const e = Math.exp(-z * w * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      this.x = this.target + e * (d0 * c + ((v0 + z * w * d0) / wd) * s);
      this.v = e * (v0 * c - ((w * w * d0 + z * w * v0) / wd) * s);
    }
    return this;
  }

  /** True (and snapped onto the target) once both distance and speed are below the thresholds. */
  settle(eps: number, epsV = eps / 100): boolean {
    if (Math.abs(this.x - this.target) <= eps && Math.abs(this.v) <= epsV) {
      this.x = this.target;
      this.v = 0;
      return true;
    }
    return false;
  }

  isAt(target: number, eps: number): boolean {
    return Math.abs(this.x - target) <= eps && Math.abs(this.v) <= eps / 100 && this.target === target;
  }

  snap(x: number): this {
    this.x = x;
    this.target = x;
    this.v = 0;
    return this;
  }
}

/** Where time comes from: the browser's clock in the app, a hand-cranked one in tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => performance.now() };

export class ManualClock implements Clock {
  constructor(public t = 0) {}
  now(): number {
    return this.t;
  }
  tick(ms: number): number {
    this.t += ms;
    return this.t;
  }
}

// ---------- angles ----------

/** The same angle in (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x <= -Math.PI) x += TAU;
  else if (x > Math.PI) x -= TAU;
  return x;
}

/** The signed shortest turn from one angle to another, in (-π, π]. */
export function shortestTurn(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** The representation of `to` (plus a whole number of turns) closest to `from`, so a tween takes the short way. */
export function nearestAngle(from: number, to: number): number {
  return from + shortestTurn(from, to);
}

/** The rotation closest to `current` that puts an angle (before rotation) at twelve o'clock. */
export function rotationToTop(angle: number, current: number): number {
  return nearestAngle(current, -Math.PI / 2 - angle);
}

/** Position of an angle around the clock face, from twelve o'clock clockwise, as a fraction 0..1 (for staggers). */
export function fromTop(angle: number): number {
  const x = (angle + Math.PI / 2) % TAU;
  return (x < 0 ? x + TAU : x) / TAU;
}

// ---------- colour ----------

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): string {
  const k = clamp01(t);
  return `rgb(${Math.round(lerp(a[0], b[0], k))},${Math.round(lerp(a[1], b[1], k))},${Math.round(lerp(a[2], b[2], k))})`;
}

// ---------- frame timing ----------

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  /** share of 60 Hz frames that were missed, 0..1 */
  dropped: number;
  /** script time spent drawing, per frame */
  workP50: number;
  workP95: number;
  workMax: number;
}

/** Linear-interpolated percentile of a list of numbers (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = (clamp(p, 0, 100) / 100) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

const FRAME_MS = 1000 / 60;

/** Records requestAnimationFrame deltas while the map animates (enabled with ?perf=1). */
export class FrameRecorder {
  deltas: number[] = [];
  work: number[] = [];
  private last = -1;

  /** One drawn frame at rAF time `ts` that took `workMs` of script. */
  frame(ts: number, workMs: number): void {
    if (this.last >= 0) this.deltas.push(ts - this.last);
    this.work.push(workMs);
    this.last = ts;
  }

  /** The loop went to sleep: the next frame does not count the idle time as a long frame. */
  gap(): void {
    this.last = -1;
  }

  reset(): void {
    this.deltas = [];
    this.work = [];
    this.last = -1;
  }

  stats(): FrameStats {
    return frameStats(this.deltas, this.work);
  }
}

export function frameStats(deltas: readonly number[], work: readonly number[] = []): FrameStats {
  let missed = 0;
  for (const d of deltas) missed += Math.max(0, Math.round(d / FRAME_MS) - 1);
  const shown = deltas.length;
  return {
    frames: shown,
    p50: percentile(deltas, 50),
    p95: percentile(deltas, 95),
    max: deltas.length ? Math.max(...deltas) : 0,
    dropped: shown + missed ? missed / (shown + missed) : 0,
    workP50: percentile(work, 50),
    workP95: percentile(work, 95),
    workMax: work.length ? Math.max(...work) : 0,
  };
}
