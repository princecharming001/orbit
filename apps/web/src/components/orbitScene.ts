import type { IntroWeb, OrbitCluster, OrbitGroup, OrbitLayout, OrbitNode, Person } from '@orbit/core';
import { ORBIT_PERIOD_MS } from '@orbit/core';
import { STAGE_COLOR } from '../pages/Pipeline';
import {
  type Clock,
  clamp01,
  easing,
  type FrameRecorder,
  fromTop,
  lerp,
  mixRgb,
  nearestAngle,
  outBack,
  parseHex,
  type Rgb,
  rotationToTop,
  Spring,
  systemClock,
  TAU,
  Tween,
} from './motion';
import {
  curveControl,
  fanSlots,
  frameBox,
  LABEL_FONT_PX,
  LABEL_GAP,
  type LabelSlot,
  labelSlots,
  nearestInDirection,
  orbitScale,
  type Pt,
  quadPartial,
  quadPoint,
  wedgeMid,
} from './orbitGeometry';

/*
 * The orbit map's scene. Every animated quantity on the canvas lives here as a tween or a spring, and one render
 * loop moves them toward their targets. React only sets targets (data, filters, focus, hover); the loop runs while
 * something moves and goes to sleep once everything has settled, so an idle map costs nothing.
 *
 * Geometry is kept in layout units (polar: angle before rotation, radius), so a dot that moves between two slots
 * travels around the orbit rather than cutting across it, and the whole orbit can turn as one.
 */

// ---------- look ----------
const ACCENT = '#5B5BD6';
const ACCENT_RGB = '91,91,214';
const RING = '#eceef2';
const LABEL = '#767d89';
const INK = '#0f1115';
/** One colour per introduction lineage, distinct from the accent and the stage colours. */
export const LINEAGE = ['#0e9384', '#d97706', '#db2777', '#2563eb', '#65a30d', '#9333ea'];
const STAGE_RGB: Record<string, Rgb> = Object.fromEntries(
  Object.entries(STAGE_COLOR).map(([k, v]) => [k, parseHex(v)]),
);
const STAGE_FALLBACK = parseHex('#9aa1ad');
const DIM = 0.16;
const OMEGA = TAU / ORBIT_PERIOD_MS;
/** extent of an orbit with no dots (the outer ring plus half a dot), for the empty and loading map */
const EMPTY_EXTENT = 456;
const FAN_PITCH = 30;

// ---------- timing (ms) ----------
export const TIMING = {
  arrive: 700,
  ringSweep: 520,
  ringStagger: 80,
  labelsIn: 300,
  fadeIn: 220,
  flip: 650,
  travel: 800,
  ripple: 900,
  introLinkHold: 3000,
  emphasis: 300,
  filter: 250,
  filterSweep: 180,
  popStagger: 38,
  hover: 120,
  hoverLines: 220,
  tip: 150,
  hop: 350,
  retract: 260,
  cometPeriod: 2500,
  cometTravel: 1100,
  radarTurn: 1400,
  shake: 520,
  webGen: 250,
  webLink: 450,
  webLight: 2200,
  stage: 450,
  burst: 900,
  pendingPeriod: 2400,
  pendingRipple: 1100,
  reduced: 140,
} as const;

export type ReachStatus = 'searching' | 'found' | 'none';

export type FocusSpec =
  | { kind: 'company'; groupKey: string }
  /** `ids`: the route from the student outwards, 'user' first */
  | { kind: 'reach'; targetId: string; status: ReachStatus; ids?: string[] };

export interface WebSpec {
  web: IntroWeb;
  /** a person whose chain is lit (hover, tap or a search match) */
  focusId?: string;
  /** a company searched within the web: its people are lit */
  focusGroup?: string;
  /** a search match the orbit turns to (a hover never moves the dot under the pointer) */
  turnTo?: { id?: string; group?: string };
}

export interface SceneData {
  layout: OrbitLayout;
  people: Map<string, Person>;
  loading: boolean;
  stages: Map<string, string>;
  pending: Set<string>;
  /** who introduced each person, when the records say so: a newcomer is born at their introducer's dot */
  introducerOf?: Map<string, string>;
}

export type HoverHow = 'pointer' | 'touch' | 'keyboard';

class NodeView {
  key: string;
  /** what a click reports: the person id, or the aggregate dot's id */
  pid: string;
  /** a temporary dot (an aggregate dot's member fanned out), not part of the layout */
  temp = false;
  fromKey = '';
  node?: OrbitNode;
  person?: Person;
  cluster?: OrbitCluster;
  groupKey = '';
  ring = 0;
  hue = 0;
  a = new Tween();
  r = new Tween();
  size = new Tween();
  appear = new Tween(0);
  alpha = new Tween(1);
  scale = new Tween(1);
  glow = new Tween(0);
  lift = new Tween(0);
  stage?: string;
  stageFrom: Rgb | null = null;
  stageTo: Rgb | null = null;
  stageCss = '';
  stageMix = new Tween(1);
  burstAt = -1e9;
  burstColor = ACCENT;
  rippleAt = -1e9;
  shakeAt = -1e9;
  popAt = -1e9;
  pending = false;
  removing = false;
  dead = false;
  removeAt = 0;
  label = '';
  layer = 1;
  mark = 0;
  // this frame, on screen (CSS px)
  x = 0;
  y = 0;
  pr = 0;
  pa = 0;
  visible = false;
  sprite: HTMLCanvasElement | null = null;
  spriteD = 0;
  spriteDpr = 0;
  spriteLabel = '';
  spriteImg = false;

  constructor(key: string, pid: string) {
    this.key = key;
    this.pid = pid;
  }
}

export interface SceneSnapshot {
  /** where "You" is, in CSS px inside the canvas */
  centre: [number, number];
  phase: string;
  /** the named animations started recently, oldest first */
  phaseLog: string[];
  animating: boolean;
  rotation: number;
  zoom: number;
  pan: [number, number];
  focus: string;
  chip: string;
  path: string[];
  pathDrawn: number;
  emphasized: string[];
  dimmed: number;
  nodes: number;
  fans: string[];
  webLinks: number;
  webDrawn: number;
  webLit: string[];
  hover?: string;
  spin: number;
  /** frames drawn since the map opened (the loop sleeps when nothing moves) */
  draws: number;
}

export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initialsOf(p: Pick<Person, 'firstName' | 'lastName'>): string {
  return `${p.firstName[0] ?? ''}${p.lastName[0] ?? ''}`.toUpperCase() || '?';
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

/** A pop: a quick bump in scale that rises and falls back (0 outside its window). */
function bump(since: number, duration: number, height: number): number {
  if (since < 0 || since > duration) return 0;
  return Math.sin((since / duration) * Math.PI) * height;
}

const clusterLabel = (c: OrbitCluster) => (c.count > 999 ? '999+' : `+${c.count}`);

export class OrbitScene {
  clock: Clock = systemClock;
  recorder?: FrameRecorder;
  /** the session has not seen the arrival yet; cleared once it plays */
  arrivalPending = false;
  onArrival?: () => void;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** draw scale this frame; it eases to fitTarget when the canvas or the network changes size */
  private fit = 1;
  private fitTarget = 1;
  private fitTween = new Tween(1);
  /** the canvas's top left corner on the page, to keep the orbit still on screen when the canvas moves */
  private at?: { left: number; top: number };
  /** rings that use several tracks (dense networks): their dots have less room to grow */
  private ringMulti = [false, false, false];
  private narrow = false;
  private reduced = false;
  private spinAllowed = true;

  private layout?: OrbitLayout;
  private people = new Map<string, Person>();
  private views: NodeView[] = [];
  private byKey = new Map<string, NodeView>();
  private clusterOf = new Map<string, NodeView>();
  private drawList: NodeView[] = [];
  private firstPerson?: NodeView;
  private initialized = false;
  private loading = true;
  private loadingSince = 0;
  private stagesReady = false;
  private introducerOf?: Map<string, string>;
  private connections?: Map<string, string[]>;
  private removals = 0;
  private frameNo = 0;

  private rot = 0;
  private spin = new Tween(0);
  private rotSpring = new Spring(0, { duration: 700, bounce: 0.12 });
  private rotSpringOn = false;
  private returnRot: number | null = null;
  private inertia = 0;
  private zoom = new Spring(1, { duration: 700 });
  private panX = new Spring(0, { duration: 700 });
  private panY = new Spring(0, { duration: 700 });
  private cameraMoving = false;
  /** the last frame ran at full rate (for the frame-time recorder) */
  private fullBefore = false;
  private draws = 0;
  private ringSweep = [new Tween(1), new Tween(1), new Tween(1)];
  private ghost = new Tween(1);
  private labelIn = new Tween(1);
  private labelDim = new Tween(1);
  private youPop = new Tween(1);

  private filterIds?: Set<string>;
  private groupsAlpha = new Tween(0);
  private shownGroups?: Set<string>;

  private companyKey?: string;
  /** how far the focused company's wedge has opened (1 = its own width) */
  private spreadK = 1;
  private wedge = { key: '', alpha: new Tween(0) };
  private wedgeOld = { key: '', alpha: new Tween(0) };
  private chip = { text: '', key: '', alpha: new Tween(0), radius: 0 };
  private chipOld = { text: '', key: '', alpha: new Tween(0), radius: 0 };

  private reach?: { targetId: string; status: ReachStatus; ids: string[] };
  private path = { ids: [] as string[], start: 0 };
  private pathOld = { ids: [] as string[], start: 0, from: 0 };
  private radar = new Tween(0);
  private radarStart = 0;

  private web?: WebSpec;
  private webStart = 0;
  private webOld?: { web: IntroWeb; start: number };
  private webAlpha = new Tween(0);
  private webChain = new Set<string>();
  private webPath: string[] = [];
  private webLightStart = 0;
  private lineageOf = new Map<string, string>();

  private hoverKey?: string;
  private hoverHow: HoverHow = 'pointer';
  private hoverLines = new Tween(0);
  private tipKey?: string;
  private tip = new Tween(0);

  private introLinks: { from: NodeView; to: NodeView; start: number; end: number }[] = [];

  private drag?: { last: number; t: number; v: number; moved: boolean; x0: number; y0: number };

  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastNow = -1;
  private lastDraw = -1e9;
  private busyUntil = 0;
  private dirty = true;
  private phase = 'loading';
  private phaseLog: string[] = ['loading'];
  private animating = true;
  private published: Record<string, string> = {};
  private labels: LabelSlot[] = [];
  private labelWidth = new Map<string, number>();
  private labelsClipped = 0;
  /** sprites are rebuilt within a few milliseconds per frame, so a zoom or a resize never stalls one frame */
  private spriteBuilds = 0;
  private spriteDeadline = 0;
  private images = new Map<string, HTMLImageElement>();
  private destroyed = false;
  private you: Pt = { x: 0, y: 0 };
  private scratchA: Pt = { x: 0, y: 0 };
  private scratchB: Pt = { x: 0, y: 0 };

  // ---------- lifecycle ----------

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') ?? undefined;
    this.destroyed = false;
    this.loadingSince = this.clock.now();
    this.dirty = true;
    this.wake();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    this.raf = 0;
    this.timer = undefined;
  }

  /**
   * The canvas changed size (a mode with a shorter header, a window resize). `at` is its top left corner on the
   * page: the orbit stays exactly where it was on screen, then glides to its new centre, so nothing jumps.
   */
  /**
   * The canvas's size in CSS px and, with `at`, where it sits on the page. When the page moves or resizes the canvas
   * (a panel above it grows), the orbit first stays where the eye has it, then glides to its new centre.
   */
  resize(w: number, h: number, at?: { left: number; top: number }): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const sized = w !== this.w || h !== this.h || dpr !== this.dpr;
    const moved = !!at && !!this.at && (at.left !== this.at.left || at.top !== this.at.top);
    if (!sized && !moved) return;
    if (at && this.at && this.initialized && this.w && this.h && !this.reduced) {
      const oldX = this.at.left + this.w / 2 + this.panX.x;
      const oldY = this.at.top + this.h / 2 + this.panY.x;
      this.panX.x = oldX - (at.left + w / 2);
      this.panY.x = oldY - (at.top + h / 2);
      this.cameraMoving = true;
    }
    if (at) this.at = at;
    if (!sized) {
      if (this.ctx && this.initialized) this.draw(this.clock.now());
      this.wake();
      return;
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.narrow = w < 600;
    if (this.canvas) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.refit();
    if (this.companyKey) this.frameCompany(this.clock.now());
    // resizing clears the canvas: draw now, in this frame, so it never flashes blank
    if (this.ctx && this.initialized) this.draw(this.clock.now());
    this.wake();
  }

  setOptions(o: { spin: boolean; reduced: boolean }): void {
    this.spinAllowed = o.spin;
    this.reduced = o.reduced;
    this.updateSpin(this.clock.now());
    this.wake();
  }

  /** Fonts arrived: initials and label widths are measured again. */
  invalidateText(): void {
    for (const v of this.views) v.spriteD = 0;
    this.labelWidth.clear();
    this.refit();
    this.wake();
  }

  // ---------- data ----------

  setData(d: SceneData): void {
    const now = this.clock.now();
    this.people = d.people;
    const prevIntroducers = this.introducerOf;
    this.introducerOf = d.introducerOf;
    if (d.loading) {
      if (!this.loading) this.loadingSince = now;
      this.loading = true;
      this.setPhase('loading');
      this.wake();
      return;
    }
    const wasLoading = this.loading;
    this.loading = false;
    const initial = !this.initialized;
    const relaid = d.layout !== this.layout;
    if (relaid) this.applyLayout(d.layout, now, initial);
    this.applyStages(d.stages, now, initial);
    for (const v of this.views) v.pending = !v.temp && !!v.person && d.pending.has(v.pid);
    if (initial) {
      this.initialized = true;
      this.enter(now, wasLoading);
    }
    if (relaid && !initial) this.reapplyModes(now);
    if (!initial && d.introducerOf && d.introducerOf !== prevIntroducers)
      this.lateIntroductions(prevIntroducers, now);
    this.wake();
  }

  /**
   * The record of who introduced someone can land a moment after the person (an intro email is read after its
   * people): if they only just arrived, their introducer's link still draws and stays lit for a few seconds.
   */
  private lateIntroductions(prev: Map<string, string> | undefined, now: number): void {
    if (this.reduced) return;
    for (const [id, by] of this.introducerOf ?? []) {
      if (prev?.get(id) === by) continue;
      const to = this.byKey.get(id);
      const from = this.viewFor(by);
      if (!to || !from || to.temp || to.appear.from !== 0 || now - to.appear.start > 2000) continue;
      if (this.introLinks.some((l) => l.to === to)) continue;
      const l = { from, to, start: now, end: now + TIMING.travel + TIMING.introLinkHold };
      this.introLinks.push(l);
      this.busyUntil = Math.max(this.busyUntil, l.end);
      this.setPhase('newcomer-intro');
    }
  }

  private applyLayout(layout: OrbitLayout, now: number, initial: boolean): void {
    const prevClusterOf = this.clusterOf;
    this.layout = layout;
    const seen = new Set<string>();
    const born: NodeView[] = [];
    const dur = this.reduced ? 0 : TIMING.flip;
    let moved = false;
    for (const n of layout.nodes) {
      let v = this.byKey.get(n.id);
      if (v?.temp) v = undefined;
      if (v) {
        if (v.removing) this.revive(v, now);
        this.bind(v, n);
        const ta = nearestAngle(v.a.value(now), n.angle);
        if (Math.abs(ta - v.a.to) > 1e-6 || Math.abs(n.radius - v.r.to) > 1e-6) {
          // FLIP: glide from where the dot is now to its new slot, round the orbit and along the radius
          this.anim(v.a, ta, now, dur, easing.inOutCubic);
          this.anim(v.r, n.radius, now, dur, easing.inOutCubic);
          moved = true;
        }
        this.anim(v.size, n.size, now, dur, easing.inOutCubic);
      } else {
        v = new NodeView(n.id, n.id);
        this.bind(v, n);
        v.a.snap(n.angle);
        v.r.snap(n.radius);
        v.size.snap(n.size);
        this.views.push(v);
        this.byKey.set(n.id, v);
        born.push(v);
      }
      seen.add(n.id);
    }
    if (moved && !initial && !this.reduced) this.setPhase('layout');
    for (let ring = 0; ring < 3; ring++) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const n of layout.nodes)
        if (n.ring === ring) {
          lo = Math.min(lo, n.radius);
          hi = Math.max(hi, n.radius);
        }
      this.ringMulti[ring] = hi - lo > 13;
    }
    // people and aggregate dots that left fade out, flying into the "+N" dot that now holds them
    const nextClusterOf = new Map<string, NodeView>();
    for (const n of layout.nodes) {
      if (!n.cluster) continue;
      const cv = this.byKey.get(n.id)!;
      for (const pid of n.cluster.personIds) nextClusterOf.set(pid, cv);
    }
    for (const v of this.views) {
      if (v.temp || v.removing || seen.has(v.key)) continue;
      const into = v.person ? nextClusterOf.get(v.pid) : undefined;
      if (into && !this.reduced) {
        this.anim(v.a, nearestAngle(v.a.value(now), into.a.to), now, TIMING.flip, easing.inOutCubic);
        this.anim(v.r, into.r.to, now, TIMING.flip, easing.inOutCubic);
      }
      this.retire(v, now, into ? TIMING.flip : 260);
    }
    this.clusterOf = nextClusterOf;
    const first = layout.nodes.find((n) => n.person);
    this.firstPerson = first ? this.byKey.get(first.id) : undefined;
    if (!initial && born.length) this.welcome(born, prevClusterOf, now);
    this.refit();
    this.sortDrawList();
  }

  private bind(v: NodeView, n: OrbitNode): void {
    v.node = n;
    v.person = n.person;
    v.cluster = n.cluster;
    v.groupKey = n.groupKey;
    v.ring = n.ring;
    v.hue = hueOf(n.id);
    v.label = n.cluster ? clusterLabel(n.cluster) : '';
  }

  private retire(v: NodeView, now: number, after: number): void {
    if (v.removing) return;
    v.removing = true;
    v.removeAt = now + (this.reduced ? TIMING.reduced : after);
    this.removals++;
    this.anim(v.appear, 0, now, this.reduced ? TIMING.reduced : after, easing.inQuad);
  }

  private revive(v: NodeView, now: number): void {
    v.removing = false;
    this.removals--;
    this.anim(v.appear, 1, now, TIMING.fadeIn, easing.outQuad);
  }

  /** New people while the map is open: born at their introducer (or at You), they travel to their slot and land. */
  private welcome(born: NodeView[], prevClusterOf: Map<string, NodeView>, now: number): void {
    const people = born.filter((v) => v.person);
    for (const v of born) if (v.cluster) this.play(v.appear, 0, 1, now, 300, easing.outQuad, 200);
    if (!people.length) return;
    const bulk = people.length > 24;
    const stagger = bulk ? Math.min(25, 700 / people.length) : Math.min(120, 900 / people.length);
    people.sort((a, b) => a.ring - b.ring || fromTop(a.a.to) - fromTop(b.a.to));
    let linked = false;
    people.forEach((v, i) => {
      if (this.reduced) {
        this.play(v.appear, 0, 1, now, TIMING.reduced, easing.linear);
        return;
      }
      const delay = i * stagger;
      const introducer = bulk ? undefined : this.introducerOf?.get(v.pid);
      const from = introducer ? this.viewFor(introducer) : undefined;
      const was = prevClusterOf.get(v.pid);
      const origin = from && !from.removing ? from : was && !was.removing ? was : undefined;
      const oa = origin ? origin.a.value(now) : v.a.to - 0.9;
      const or = origin ? origin.r.value(now) : 0;
      this.play(v.a, oa, nearestAngle(oa, v.a.to), now, TIMING.travel, easing.inOutCubic, delay);
      this.play(v.r, or, v.r.to, now, TIMING.travel, easing.inOutCubic, delay);
      this.play(v.appear, 0, 1, now, TIMING.fadeIn, easing.outQuad, delay);
      if (!bulk || i < 24) {
        v.rippleAt = now + delay + TIMING.travel - 40;
        this.busyUntil = Math.max(this.busyUntil, v.rippleAt + TIMING.ripple);
      }
      if (from && origin === from) {
        linked = true;
        const l = {
          from,
          to: v,
          start: now + delay,
          end: now + delay + TIMING.travel + TIMING.introLinkHold,
        };
        this.introLinks.push(l);
        this.busyUntil = Math.max(this.busyUntil, l.end);
      }
    });
    this.setPhase(linked ? 'newcomer-intro' : 'newcomer');
  }

  private applyStages(stages: Map<string, string>, now: number, initial: boolean): void {
    const animate = this.stagesReady && !initial && !this.reduced;
    for (const v of this.views) {
      if (v.temp || !v.person) continue;
      const s = stages.get(v.pid);
      if (s === v.stage) continue;
      const to = s ? (STAGE_RGB[s] ?? STAGE_FALLBACK) : null;
      const isNew = v.appear.from === 0 && !v.appear.done(now);
      if (!animate || isNew) {
        v.stageFrom = to;
        v.stageTo = to;
        v.stageMix.snap(1);
      } else {
        v.stageFrom = this.stageColorNow(v, now);
        v.stageTo = to;
        this.play(v.stageMix, 0, 1, now, TIMING.stage, easing.inOutQuad);
        if (s === 'scheduled' || s === 'completed') {
          v.burstAt = now;
          v.burstColor = STAGE_COLOR[s as keyof typeof STAGE_COLOR] ?? ACCENT;
          this.busyUntil = Math.max(this.busyUntil, now + TIMING.burst);
        }
        this.setPhase('stage');
      }
      v.stageCss = to ? mixRgb(to, to, 1) : '';
      v.stage = s;
    }
    this.stagesReady = true;
  }

  private stageColorNow(v: NodeView, now: number): Rgb | null {
    const t = v.stageMix.value(now);
    if (!v.stageFrom || !v.stageTo) return t >= 0.5 ? v.stageTo : v.stageFrom;
    return [
      lerp(v.stageFrom[0], v.stageTo[0], t),
      lerp(v.stageFrom[1], v.stageTo[1], t),
      lerp(v.stageFrom[2], v.stageTo[2], t),
    ];
  }

  /** First data: the arrival (once per session) or a short fade-in. */
  private enter(now: number, fromLoading: boolean): void {
    const all = this.views.filter((v) => !v.temp);
    if (this.arrivalPending && !this.reduced && all.length) {
      this.arrivalPending = false;
      this.onArrival?.();
      this.arrive(now);
      return;
    }
    this.anim(this.ghost, 0, now, 300, easing.outQuad);
    for (const v of all) {
      if (this.reduced || !fromLoading) v.appear.snap(1);
      else this.play(v.appear, 0, 1, now, TIMING.fadeIn, easing.outQuad, fromTop(v.a.to + this.rot) * 120);
    }
    this.setPhase(all.length ? 'enter' : 'idle');
  }

  /** Rings sweep in from the centre, then every dot spirals out of "You" to its slot; labels fade in last. */
  private arrive(now: number): void {
    this.setPhase('arrival');
    this.ringSweep.forEach((t, i) => {
      this.play(t, 0, 1, now, TIMING.ringSweep, easing.inOutCubic, i * TIMING.ringStagger);
    });
    this.anim(this.ghost, 0, now, 160, easing.outQuad);
    this.play(this.youPop, 0.6, 1, now, 420, easing.outBack);
    let last = 0;
    for (const v of this.views) {
      if (v.temp) continue;
      const delay = 120 + v.ring * 110 + fromTop(v.a.to + this.rot) * 260;
      last = Math.max(last, delay);
      this.play(v.a, v.a.to - 0.55, v.a.to, now, TIMING.arrive, easing.outCubic, delay);
      this.play(v.r, 0, v.r.to, now, TIMING.arrive, outBack(1.25), delay);
      this.play(v.appear, 0, 1, now, 260, easing.outQuad, delay);
    }
    this.play(this.labelIn, 0, 1, now, TIMING.labelsIn, easing.outQuad, last + TIMING.arrive - 250);
  }

  /** Any pointer interaction during the arrival finishes it at once. */
  finishArrival(): void {
    if (this.phase !== 'arrival') return;
    for (const t of this.ringSweep) t.snap(1);
    this.ghost.snap(0);
    this.labelIn.snap(1);
    this.youPop.snap(1);
    for (const v of this.views) {
      if (v.temp) continue;
      v.a.snap(v.a.to);
      v.r.snap(v.r.to);
      v.appear.snap(v.removing ? 0 : 1);
    }
    this.recomputeBusy();
    this.setPhase('idle');
    this.wake();
  }

  private recomputeBusy(): void {
    let end = 0;
    const tweens = (v: NodeView) => [
      v.a,
      v.r,
      v.size,
      v.appear,
      v.alpha,
      v.scale,
      v.glow,
      v.lift,
      v.stageMix,
    ];
    for (const v of this.views) for (const t of tweens(v)) if (t.duration > 0) end = Math.max(end, t.end);
    for (const t of [...this.ringSweep, this.ghost, this.labelIn, this.labelDim, this.youPop, this.radar])
      if (t.duration > 0) end = Math.max(end, t.end);
    this.busyUntil = end;
  }

  setPending(pending: Set<string>): void {
    for (const v of this.views) v.pending = !v.temp && !!v.person && pending.has(v.pid);
    this.wake();
  }

  setConnections(c: Map<string, string[]> | undefined): void {
    this.connections = c;
  }

  // ---------- modes ----------

  setFilter(ids: Set<string> | undefined, groups?: Set<string>): void {
    const now = this.clock.now();
    const changed = ids !== this.filterIds;
    this.filterIds = ids;
    if (groups?.size) {
      this.shownGroups = groups;
      this.anim(this.groupsAlpha, 1, now, 300, easing.outQuad);
    } else this.anim(this.groupsAlpha, 0, now, 250, easing.outQuad);
    if (changed && this.initialized) {
      this.refreshEmphasis(now, 'filter');
      this.setPhase('filter');
    }
    this.wake();
  }

  setFocus(f: FocusSpec | undefined): void {
    const now = this.clock.now();
    const company = f?.kind === 'company' ? f.groupKey : undefined;
    const reach = f?.kind === 'reach' ? f : undefined;
    if (company !== this.companyKey) this.applyCompany(company, now);
    this.applyReach(reach, now);
    this.releaseIfFree(now);
    this.updateSpin(now);
    this.wake();
  }

  setWeb(w: WebSpec | undefined): void {
    const now = this.clock.now();
    const prev = this.web;
    if (!w) {
      if (!prev) return;
      this.webOld = { web: prev.web, start: now };
      this.anim(this.webAlpha, 0, now, TIMING.retract, easing.inQuad);
      this.web = undefined;
      this.webChain = new Set();
      this.webPath = [];
      this.busyUntil = Math.max(this.busyUntil, now + TIMING.retract);
      // everyone goes back to their own slot
      this.retarget(now, 600);
      this.refreshEmphasis(now, 'web');
      this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
      this.setPhase('web-out');
    } else {
      const fresh = !prev || prev.web !== w.web;
      this.web = w;
      if (fresh) {
        this.lineageOf = new Map(
          [...w.web.root].map(([id, r]) => [id, LINEAGE[w.web.roots.indexOf(r) % LINEAGE.length]!]),
        );
        // the people in the web move out to their generation's ring, then the links grow
        this.retarget(now, 650);
        if (!prev) {
          this.webStart = now + (this.reduced ? 0 : 380);
          this.webOld = undefined;
          this.anim(this.webAlpha, 1, now, 300, easing.outQuad);
          this.busyUntil = Math.max(
            this.busyUntil,
            this.webStart + Math.max(0, w.web.depth - 1) * TIMING.webGen + TIMING.webLink,
          );
          this.setPhase('web');
        }
      }
      const key = `${w.focusId ?? ''}|${w.focusGroup ?? ''}`;
      const prevKey = `${prev?.focusId ?? ''}|${prev?.focusGroup ?? ''}`;
      if (fresh || key !== prevKey) {
        this.webChain = this.chainFor(w);
        this.webPath = w.focusId && w.web.members.has(w.focusId) ? this.ancestry(w.web, w.focusId) : [];
        this.webLightStart = now;
        if (key !== prevKey && (w.focusId || w.focusGroup)) this.setPhase('web-focus');
      }
      const turn = `${w.turnTo?.id ?? ''}|${w.turnTo?.group ?? ''}`;
      const prevTurn = `${prev?.turnTo?.id ?? ''}|${prev?.turnTo?.group ?? ''}`;
      if (turn !== prevTurn && w.turnTo) {
        // a search match: turn the orbit so it sits at the top, as for a company
        const target = w.turnTo.id ? this.viewFor(w.turnTo.id) : undefined;
        const g = w.turnTo.group ? this.layout?.groups.find((x) => x.key === w.turnTo!.group) : undefined;
        const angle = target ? target.a.to : g ? wedgeMid(g) : undefined;
        if (angle !== undefined) this.hold(rotationToTop(angle, this.rot), now);
      }
      this.refreshEmphasis(now, 'web');
      this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
    }
    this.releaseIfFree(now);
    this.updateSpin(now);
    this.wake();
  }

  private chainFor(w: WebSpec): Set<string> {
    const out = new Set<string>();
    if (w.focusId && w.web.members.has(w.focusId)) {
      for (const id of this.ancestry(w.web, w.focusId)) out.add(id);
      const queue = [w.focusId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const c of w.web.children.get(cur) ?? []) {
          if (out.has(c.toId)) continue;
          out.add(c.toId);
          queue.push(c.toId);
        }
      }
    }
    if (w.focusGroup)
      for (const id of w.web.members) if (this.viewFor(id)?.groupKey === w.focusGroup) out.add(id);
    return out;
  }

  private ancestry(web: IntroWeb, id: string): string[] {
    const out = [id];
    let cur = web.parent.get(id);
    while (cur && out.length < 1000) {
      out.unshift(cur.fromId);
      cur = web.parent.get(cur.fromId);
    }
    return out;
  }

  setHover(id: string | undefined, how: HoverHow = 'pointer'): void {
    const now = this.clock.now();
    const v = id ? this.viewFor(id) : undefined;
    const key = v?.key;
    if (key === this.hoverKey && how === this.hoverHow) return;
    const prev = this.hoverKey ? this.byKey.get(this.hoverKey) : undefined;
    if (prev && prev !== v) this.anim(prev.lift, 0, now, 150, easing.outCubic);
    this.hoverKey = key;
    this.hoverHow = how;
    if (v) {
      this.anim(v.lift, 1, now, TIMING.hover, easing.outCubic);
      this.play(this.hoverLines, 0, 1, now, TIMING.hoverLines, easing.outCubic, 40);
      this.tipKey = key;
      this.play(this.tip, prev ? 0.6 : 0, 1, now, TIMING.tip, easing.outCubic);
      this.setPhase('hover');
    } else {
      this.anim(this.tip, 0, now, 120, easing.inQuad);
      this.anim(this.hoverLines, 0, now, 140, easing.inQuad);
      if (prev) this.setPhase('hover-out');
    }
    this.sortDrawList();
    this.updateSpin(now);
    this.wake();
  }

  hovered(): string | undefined {
    return this.hoverKey ? this.byKey.get(this.hoverKey)?.pid : undefined;
  }

  // ---------- company focus ----------

  private applyCompany(groupKey: string | undefined, now: number): void {
    const prevKey = this.companyKey;
    this.companyKey = groupKey;
    if (prevKey) {
      this.collapseFans(now);
      if (this.wedge.key) this.fadeOutWedge(now);
      if (this.chip.text) this.fadeOutChip(now);
    }
    const g = groupKey ? this.layout?.groups.find((x) => x.key === groupKey) : undefined;
    this.retarget(now);
    if (!g) {
      if (prevKey) {
        this.frame0(now);
        this.refreshEmphasis(now, 'focus');
        this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
        this.setPhase('company-out');
      }
      return;
    }
    this.setPhase('company');
    this.hold(rotationToTop(wedgeMid(g), this.rot), now);
    this.wedge.key = g.key;
    this.play(this.wedge.alpha, 0, 1, now, 320, easing.outQuad, 120);
    this.chip.key = g.key;
    this.chip.text = this.chipText(g);
    const rows = this.burst(g, now);
    this.chip.radius = this.chipRadius(rows);
    this.play(this.chip.alpha, 0, 1, now, 260, easing.outCubic, 320);
    this.frameCompany(now);
    this.refreshEmphasis(now, 'focus');
    this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
  }

  /** The same company after the network changed: follow the wedge, keep the fan, no second burst. */
  private refreshCompany(now: number): void {
    const g = this.companyKey ? this.layout?.groups.find((x) => x.key === this.companyKey) : undefined;
    if (!g) {
      this.applyCompany(undefined, now);
      return;
    }
    if (this.returnRot !== null) this.hold(rotationToTop(wedgeMid(g), this.rotTarget()), now);
    this.chip.text = this.chipText(g);
    this.retarget(now);
    const want = this.clusterMembers(g).map((m) => m.pid);
    const have = this.views.filter((v) => v.temp && !v.removing).map((v) => v.pid);
    if (want.join('|') !== have.join('|') || want.length === 0) {
      this.collapseFans(now);
      this.chip.radius = this.chipRadius(this.burst(g, now));
    } else {
      const slots = fanSlots(have.length, wedgeMid(g), this.fanBase(), FAN_PITCH, 0.95, 3);
      let i = 0;
      for (const v of this.views) {
        if (!v.temp || v.removing) continue;
        const s = slots[i++];
        if (!s) break;
        this.anim(v.a, nearestAngle(v.a.value(now), s.angle), now, TIMING.flip, easing.inOutCubic);
        this.anim(v.r, s.radius, now, TIMING.flip, easing.inOutCubic);
      }
    }
    this.frameCompany(now);
  }

  private chipText(g: OrbitGroup): string {
    let warm = 0;
    for (const v of this.views)
      if (!v.temp && v.groupKey === g.key && (v.person?.strength ?? 0) >= 0.3) warm++;
    return `${g.count} at ${g.label}${warm ? ` · ${warm} warm` : ''}`;
  }

  private fanBase(): number {
    return (this.layout?.extent ?? EMPTY_EXTENT) + 8 + FAN_PITCH / 2;
  }

  private chipRadius(rows: number): number {
    const extent = this.layout?.extent ?? EMPTY_EXTENT;
    return rows ? this.fanBase() + (rows - 1) * FAN_PITCH + 14 : extent;
  }

  /** Room above the wedge for the fan and the count chip: the orbit slides down just enough. */
  private frameCompany(now: number): void {
    const top = this.chip.radius * this.fitTarget + LABEL_GAP + 24 + 8;
    this.anim(this.panY, Math.max(0, top - this.h / 2), now);
    this.anim(this.zoom, 1, now);
    this.anim(this.panX, 0, now);
  }

  /**
   * Where every dot should be for the current view. Normally its own slot. A focused company's wedge opens up (its
   * dots spread round the orbit from the wedge's centre) so its people have room to grow. In the introductions view
   * the people in the web leave their wedges for a radial tree: each generation one ring further out from You.
   */
  private retarget(now: number, dur = 560): void {
    const key = this.companyKey;
    const g = key ? this.layout?.groups.find((x) => x.key === key) : undefined;
    const mid = g ? wedgeMid(g) : 0;
    const k = g ? Math.min(1.35, Math.max(1, 3.4 / Math.max(1e-3, g.endAngle - g.startAngle))) : 1;
    this.spreadK = k;
    const tree = this.web ? this.webTree(this.web.web) : undefined;
    for (const v of this.views) {
      if (v.temp || !v.node || v.removing) continue;
      let a = v.node.angle;
      let r = v.node.radius;
      let delay = 0;
      const t = v.person ? tree?.get(v.pid) : undefined;
      if (t) {
        a = t.a;
        r = t.r;
        // the web grows outward: the first generation moves first
        delay = (t.gen - 1) * 110;
      } else if (g && v.groupKey === key) a = mid + (a - mid) * k;
      const ta = nearestAngle(v.a.value(now), a);
      if (Math.abs(ta - v.a.to) > 1e-6) this.anim(v.a, ta, now, dur, easing.inOutCubic, delay);
      if (Math.abs(r - v.r.to) > 1e-6) this.anim(v.r, r, now, dur, easing.inOutCubic, delay);
    }
  }

  /**
   * A radial tree of the referral web: each lineage gets a sector next to where its first person already sits,
   * children share their parent's sector by the number of people below them, and generation g sits on ring g.
   */
  private webTree(web: IntroWeb): Map<string, { a: number; r: number; gen: number }> {
    const out = new Map<string, { a: number; r: number; gen: number }>();
    const rings = this.layout?.ringRadii ?? [160, 300, 440];
    const radius = (gen: number) => (gen <= 3 ? rings[gen - 1]! : rings[2] + (gen - 3) * 70);
    const step = (gen: number) => 58 / radius(gen);
    const shown = (id: string) => {
      const v = this.byKey.get(id);
      return !!v && !v.temp && !!v.person;
    };
    const home = (id: string) => this.byKey.get(id)?.node?.angle ?? 0;
    const width = new Map<string, number>();
    const measure = (id: string, gen: number): number => {
      let kids = 0;
      for (const c of web.children.get(id) ?? []) kids += measure(c.toId, gen + 1);
      const w = Math.max(step(gen), kids);
      width.set(id, w);
      return w;
    };
    const roots = web.roots.filter(shown);
    for (const r of roots) measure(r, 1);
    // roots in their current order round the orbit, pushed apart where their sectors would overlap
    const order = [...roots].sort((x, y) => home(x) - home(y));
    const centre = order.map((id) => home(id));
    const span = order.map((id) => width.get(id)! + 0.12);
    const total = span.reduce((a, b) => a + b, 0);
    const squeeze = total > TAU ? TAU / total : 1;
    for (let iter = 0; iter < 40 && order.length > 1; iter++) {
      let moved = false;
      for (let i = 0; i < order.length; i++) {
        const j = (i + 1) % order.length;
        const gap = centre[j]! + (j === 0 ? TAU : 0) - centre[i]! - ((span[i]! + span[j]!) * squeeze) / 2;
        if (gap < -1e-6) {
          centre[i] = centre[i]! + gap / 2;
          centre[j] = centre[j]! - gap / 2;
          moved = true;
        }
      }
      if (!moved) break;
    }
    const place = (id: string, a: number, gen: number) => {
      out.set(id, { a, r: radius(gen), gen });
      const kids = [...(web.children.get(id) ?? [])].sort((x, y) => home(x.toId) - home(y.toId));
      const sum = kids.reduce((acc, c) => acc + width.get(c.toId)! * squeeze, 0);
      let at = a - sum / 2;
      for (const c of kids) {
        const w = width.get(c.toId)! * squeeze;
        place(c.toId, at + w / 2, gen + 1);
        at += w;
      }
    };
    order.forEach((id, i) => {
      place(id, centre[i]!, 1);
    });
    return out;
  }

  private clusterMembers(g: OrbitGroup): { pid: string; from: NodeView }[] {
    const out: { pid: string; from: NodeView }[] = [];
    for (const c of this.views) {
      if (c.temp || c.removing || !c.cluster || c.groupKey !== g.key) continue;
      for (const pid of c.cluster.personIds) if (this.people.has(pid)) out.push({ pid, from: c });
    }
    return out;
  }

  /** Bursts the company's "+N" dots: their members fan out along the outer edge of the wedge. Returns the rows. */
  private burst(g: OrbitGroup, now: number): number {
    const ids = this.clusterMembers(g);
    if (!ids.length) return 0;
    const slots = fanSlots(ids.length, wedgeMid(g), this.fanBase(), FAN_PITCH, 0.95, 3);
    const shown = ids.slice(0, slots.length);
    const fanned = new Set<string>();
    shown.forEach(({ pid, from }, i) => {
      const key = `fan:${pid}`;
      const old = this.byKey.get(key);
      if (old) this.dropView(old);
      const v = new NodeView(key, pid);
      v.temp = true;
      v.fromKey = from.key;
      v.person = this.people.get(pid);
      v.groupKey = from.groupKey;
      v.ring = 2;
      v.hue = hueOf(pid);
      v.layer = 3;
      const slot = slots[i]!;
      const delay = 180 + i * 22;
      const fa = from.a.value(now);
      v.size.snap(Math.min(26, from.size.to));
      v.a.snap(fa);
      v.r.snap(from.r.value(now));
      this.play(v.a, fa, nearestAngle(fa, slot.angle), now, 520, easing.outCubic, delay);
      this.play(v.r, from.r.value(now), slot.radius, now, 520, outBack(1.4), delay);
      this.play(v.appear, 0, 1, now, 200, easing.outQuad, delay);
      this.views.push(v);
      this.byKey.set(key, v);
      fanned.add(pid);
    });
    for (const c of new Set(ids.map((x) => x.from))) {
      const left = c.cluster!.personIds.filter((pid) => !fanned.has(pid)).length;
      c.popAt = now;
      if (left) c.label = `+${left}`;
      else this.anim(c.appear, 0, now, 360, easing.inQuad, 160);
    }
    this.sortDrawList();
    return new Set(slots.slice(0, shown.length).map((s) => s.radius)).size;
  }

  private collapseFans(now: number): void {
    const homes = new Set<NodeView>();
    for (const v of this.views) {
      if (!v.temp || v.removing) continue;
      const home = this.byKey.get(v.fromKey);
      if (home && !this.reduced) {
        this.anim(v.a, nearestAngle(v.a.value(now), home.a.to), now, 380, easing.inOutCubic);
        this.anim(v.r, home.r.to, now, 380, easing.inOutCubic);
      }
      this.retire(v, now, 380);
      if (home) homes.add(home);
    }
    for (const home of homes) {
      if (home.cluster) home.label = clusterLabel(home.cluster);
      this.anim(home.appear, 1, now, 300, easing.outQuad, 200);
    }
  }

  private fadeOutWedge(now: number): void {
    this.wedgeOld.key = this.wedge.key;
    this.wedgeOld.alpha.snap(this.wedge.alpha.value(now));
    this.anim(this.wedgeOld.alpha, 0, now, 240, easing.inQuad);
    this.wedge.key = '';
    this.wedge.alpha.snap(0);
  }

  private fadeOutChip(now: number): void {
    this.chipOld.text = this.chip.text;
    this.chipOld.key = this.chip.key;
    this.chipOld.radius = this.chip.radius;
    this.chipOld.alpha.snap(this.chip.alpha.value(now));
    this.anim(this.chipOld.alpha, 0, now, 200, easing.inQuad);
    this.chip.text = '';
    this.chip.key = '';
    this.chip.alpha.snap(0);
  }

  // ---------- reach ----------

  private applyReach(r: { targetId: string; status: ReachStatus; ids?: string[] } | undefined, now: number) {
    const prev = this.reach;
    if (!r) {
      if (!prev) return;
      this.reach = undefined;
      this.retractPath(now);
      this.anim(this.radar, 0, now, 200, easing.inQuad);
      this.frame0(now);
      this.refreshEmphasis(now, 'reach');
      this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
      this.setPhase('reach-out');
      return;
    }
    const ids = r.status === 'found' && r.ids && r.ids.length > 1 ? r.ids : [];
    const status: ReachStatus = r.status === 'found' && !ids.length ? 'none' : r.status;
    const newTarget = !prev || prev.targetId !== r.targetId;
    const changed = newTarget || prev.status !== status || prev.ids.join('>') !== ids.join('>');
    this.reach = { targetId: r.targetId, status, ids };
    if (!changed) return;
    const target = this.viewFor(r.targetId);
    if (newTarget && target) this.hold(rotationToTop(target.a.to, this.rotTarget()), now);
    if (status === 'searching') {
      this.radarStart = now;
      this.anim(this.radar, 1, now, 200, easing.outQuad);
      this.retractPath(now);
      this.setPhase('reach-search');
    } else {
      this.anim(this.radar, 0, now, 260, easing.inQuad);
      if (status === 'none') {
        this.retractPath(now);
        if (target && !this.reduced) {
          target.shakeAt = now + 120;
          this.busyUntil = Math.max(this.busyUntil, target.shakeAt + TIMING.shake);
        }
        this.setPhase('reach-none');
      } else if (ids.join('>') !== this.path.ids.join('>')) {
        // a new route: the old one retracts, then the new one draws hop by hop and each dot pops as it arrives
        const hadPath = this.path.ids.length > 0;
        this.retractPath(now);
        this.path = { ids, start: now + (this.reduced ? 0 : hadPath ? TIMING.retract : 160) };
        if (!this.reduced)
          for (let k = 1; k < ids.length; k++) {
            const v = this.viewFor(ids[k]!);
            if (v) v.popAt = this.path.start + k * TIMING.hop - 40;
          }
        this.busyUntil = Math.max(this.busyUntil, this.path.start + (ids.length - 1) * TIMING.hop + 340);
        this.setPhase('reach-path');
      }
    }
    if (status === 'found') this.framePath(now);
    else this.frame0(now);
    this.refreshEmphasis(now, 'reach');
    this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
  }

  private retractPath(now: number): void {
    if (!this.path.ids.length) return;
    const drawn = this.pathProgress(now);
    if (drawn > 0) {
      this.pathOld = { ids: this.path.ids, start: now, from: drawn };
      this.busyUntil = Math.max(this.busyUntil, now + TIMING.retract);
    }
    this.path = { ids: [], start: 0 };
  }

  /** Hops drawn so far (0..hops). */
  private pathProgress(now: number): number {
    const hops = this.path.ids.length - 1;
    if (hops <= 0) return 0;
    if (this.reduced) return now >= this.path.start ? hops : 0;
    return Math.max(0, Math.min(hops, (now - this.path.start) / TIMING.hop));
  }

  /** The camera that keeps the whole route in view (with the target turned to the top). */
  private framePath(now: number): void {
    const ids = this.reach?.ids ?? [];
    if (!ids.length) {
      this.frame0(now);
      return;
    }
    const rot = this.rotTarget();
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const id of ids) {
      if (id === 'user') continue;
      const v = this.viewFor(id);
      if (!v) continue;
      const a = v.a.to + rot;
      const r = (v.r.to + v.size.to) * this.fitTarget;
      minX = Math.min(minX, Math.cos(a) * r);
      maxX = Math.max(maxX, Math.cos(a) * r);
      minY = Math.min(minY, Math.sin(a) * r);
      maxY = Math.max(maxY, Math.sin(a) * r);
    }
    const cam = frameBox(minX, minY, maxX, maxY, this.w, this.h, 56, 1.3);
    this.anim(this.zoom, cam.zoom, now);
    this.anim(this.panX, cam.panX, now);
    this.anim(this.panY, cam.panY, now);
  }

  private frame0(now: number): void {
    if (this.companyKey) return;
    this.anim(this.zoom, 1, now);
    this.anim(this.panX, 0, now);
    this.anim(this.panY, 0, now);
  }

  // ---------- rotation ----------

  /** Turn to `target` and hold there; remembers where the orbit was so clearing can turn back. */
  private hold(target: number, now: number): void {
    if (this.returnRot === null) this.returnRot = this.rot;
    this.startSpring(target, now);
  }

  /** Nothing is focused any more: turn back to where the orbit was, and let it drift again. */
  private releaseIfFree(now: number): void {
    const webTurn = !!this.web?.turnTo;
    if (this.companyKey || this.reach || webTurn || this.returnRot === null) return;
    const back = this.returnRot;
    this.returnRot = null;
    this.startSpring(nearestAngle(this.rot, back), now);
  }

  private startSpring(target: number, now: number): void {
    if (this.reduced) {
      this.rot = target;
      this.rotSpring.snap(target);
      this.rotSpringOn = false;
      this.dirty = true;
      return;
    }
    if (!this.rotSpringOn) {
      this.rotSpring.x = this.rot;
      this.rotSpring.v = this.spin.value(now) + this.inertia;
    }
    this.inertia = 0;
    this.rotSpring.target = target;
    this.rotSpringOn = true;
    this.dirty = true;
  }

  private rotTarget(): number {
    return this.rotSpringOn ? this.rotSpring.target : this.rot;
  }

  private holdsStill(): boolean {
    return (
      !!this.companyKey ||
      !!this.reach ||
      !!this.web?.focusId ||
      !!this.web?.focusGroup ||
      !!this.hoverKey ||
      !!this.drag?.moved ||
      this.returnRot !== null
    );
  }

  private updateSpin(now: number): void {
    const want = this.spinAllowed && !this.reduced && !this.holdsStill() ? OMEGA : 0;
    if (this.reduced || !this.spinAllowed) this.spin.snap(want);
    // eases to a stop on hover and back again, never an abrupt pause
    else this.spin.animate(want, now, want ? 900 : 420, easing.inOutSine);
  }

  spinning(): boolean {
    return this.spin.to > 0;
  }

  // ---------- pointer ----------

  pointerDown(x: number, y: number): void {
    this.finishArrival();
    this.drag = { last: this.angleAt(x, y), t: this.clock.now(), v: 0, moved: false, x0: x, y0: y };
  }

  /** Mouse drag turns the orbit. Returns true while it is a drag rather than a click. */
  pointerMove(x: number, y: number): boolean {
    const d = this.drag;
    if (!d) return false;
    const now = this.clock.now();
    const angle = this.angleAt(x, y);
    if (!d.moved) {
      if (Math.hypot(x - d.x0, y - d.y0) < 6) return false;
      d.moved = true;
      d.last = angle;
      d.t = now;
      if (this.rotSpringOn) {
        this.rot = this.rotSpring.x;
        this.rotSpringOn = false;
      }
      this.inertia = 0;
      this.setHover(undefined);
      this.updateSpin(now);
      this.setPhase('drag');
      return true;
    }
    const delta = nearestAngle(d.last, angle) - d.last;
    this.rot += delta;
    const dt = Math.max(1, now - d.t);
    d.v = d.v * 0.5 + (delta / dt) * 0.5;
    d.last = angle;
    d.t = now;
    if (this.returnRot !== null) this.returnRot = null;
    this.dirty = true;
    this.wake();
    return true;
  }

  /** Returns true when the gesture was a drag (so the click that follows is not a selection). */
  pointerUp(): boolean {
    const d = this.drag;
    this.drag = undefined;
    if (!d?.moved) return false;
    const now = this.clock.now();
    // a flick keeps turning for a moment
    this.inertia = now - d.t < 80 && !this.reduced ? Math.max(-0.004, Math.min(0.004, d.v)) : 0;
    this.updateSpin(now);
    this.wake();
    return true;
  }

  private angleAt(x: number, y: number): number {
    return Math.atan2(y - (this.h / 2 + this.panY.x), x - (this.w / 2 + this.panX.x));
  }

  /** The dot under a point (CSS px in the canvas), nearest first; small dots get a finger-sized target on touch. */
  hitTest(x: number, y: number, touch = false): string | undefined {
    let best: NodeView | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = this.drawList.length - 1; i >= 0; i--) {
      const v = this.drawList[i]!;
      if (!v.visible || v.pa < 0.1 || v.removing) continue;
      const reach = Math.max(v.pr + 4, touch ? 16 : 8);
      const d = (x - v.x) ** 2 + (y - v.y) ** 2;
      if (d <= reach * reach && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best?.pid;
  }

  /** For keyboard focus: the next dot in an arrow's direction from the given one (or the first dot). */
  neighbour(fromId: string | undefined, dx: number, dy: number): string | undefined {
    const list = this.drawList.filter((v) => v.visible && v.pa >= 0.1 && !v.removing);
    const from = fromId ? list.find((v) => v.pid === fromId) : undefined;
    if (!from) return (this.firstPerson && list.includes(this.firstPerson) ? this.firstPerson : list[0])?.pid;
    const xs = list.map((v) => v.x);
    const ys = list.map((v) => v.y);
    const i = nearestInDirection(from.x, from.y, dx, dy, xs, ys, (k) => list[k] === from);
    return i >= 0 ? list[i]!.pid : from.pid;
  }

  isCluster(id: string): boolean {
    return !!this.byKey.get(id)?.cluster;
  }

  nodeOf(id: string): OrbitNode | undefined {
    return this.byKey.get(id)?.node;
  }

  /** Where a dot is now (CSS px), for tests and keyboard focus. */
  positionOf(id: string): { x: number; y: number; r: number; alpha: number } | undefined {
    const v = this.byKey.get(id) ?? this.byKey.get(`fan:${id}`);
    return v && !v.dead ? { x: v.x, y: v.y, r: v.pr, alpha: v.pa } : undefined;
  }

  // ---------- emphasis ----------

  private dimForMode(): number {
    if (this.companyKey || (this.reach && this.reach.status !== 'searching')) return 0.35;
    if (this.web) return 0.3;
    return 1;
  }

  private reapplyModes(now: number): void {
    if (this.companyKey) this.refreshCompany(now);
    else this.retarget(now);
    if (this.reach?.status === 'found') this.framePath(now);
    if (this.web) this.webChain = this.chainFor(this.web);
    this.refreshEmphasis(now, 'layout');
  }

  /** Recomputes every dot's alpha, scale and glow from the current filter, focus and view. */
  private refreshEmphasis(now: number, cause: 'filter' | 'focus' | 'reach' | 'web' | 'layout'): void {
    const dur = cause === 'filter' ? TIMING.filter : TIMING.emphasis;
    const company = this.companyKey;
    const reach = this.reach;
    const web = this.web;
    const popping: NodeView[] = [];
    for (const v of this.views) {
      if (v.temp) continue;
      let alpha = 1;
      let scale = 1;
      let glow = 0;
      let delay = 0;
      if (web) {
        const has = (s: Set<string>) =>
          v.person ? s.has(v.pid) : !!v.cluster?.personIds.some((id) => s.has(id));
        const member = has(web.web.members);
        if (this.webChain.size) {
          const lit = has(this.webChain);
          alpha = lit ? 1 : member ? 0.32 : 0.1;
          scale = lit ? 1.12 : member ? 1 : 0.85;
          glow = lit ? 1 : 0;
        } else {
          alpha = member ? 1 : 0.14;
          scale = member ? 1 : 0.85;
        }
      } else if (reach) {
        const isTarget = v.pid === reach.targetId;
        if (reach.status !== 'found') {
          alpha = isTarget ? 1 : reach.status === 'searching' ? 0.35 : 0.3;
          scale = isTarget ? 1.15 : 1;
        } else {
          const k = reach.ids.indexOf(v.pid);
          alpha = k >= 0 || isTarget ? 1 : DIM;
          scale = k >= 0 ? 1.12 : 0.95;
          glow = k >= 0 ? 0.55 : 0;
          // each dot on the route lights up as the line reaches it
          if (k > 0) delay = Math.max(0, this.path.start + k * TIMING.hop - 60 - now);
        }
      } else if (company) {
        if (v.groupKey === company) {
          // the wedge opens up so its people can grow without touching (less where rings are packed in tracks)
          scale = v.person ? (this.ringMulti[v.ring] ? 1.12 : 1.35) : 1;
          glow = v.person ? 1 : 0;
          if (v.person && v.scale.to !== scale) popping.push(v);
        } else {
          alpha = 0.15;
          scale = 0.92;
        }
      } else if (this.filterIds) {
        const ids = this.filterIds;
        const inside = v.person ? ids.has(v.pid) : !!v.cluster?.personIds.some((id) => ids.has(id));
        alpha = inside ? 1 : 0.18;
        scale = inside ? 1 : 0.88;
      }
      // a filter sweeps round the orbit, clockwise from the top
      if (cause === 'filter') delay = fromTop(v.a.to + this.rot) * TIMING.filterSweep;
      v.layer = alpha < 0.5 ? 0 : glow > 0 || scale > 1.05 ? 2 : 1;
      this.anim(v.alpha, alpha, now, dur, easing.outCubic, delay);
      if (!popping.includes(v)) this.anim(v.scale, scale, now, dur, easing.outCubic, delay);
      this.anim(v.glow, glow, now, dur, easing.outCubic, delay);
    }
    // the company's people pop one after another, clockwise from the top of the wedge
    const rot = this.rotTarget();
    popping.sort((a, b) => fromTop(a.a.to + rot) - fromTop(b.a.to + rot));
    popping.forEach((v, i) => {
      const to = this.ringMulti[v.ring] ? 1.12 : 1.35;
      this.play(v.scale, v.scale.value(now), to, now, 380, easing.outBack, 220 + i * TIMING.popStagger);
    });
    this.sortDrawList();
  }

  private sortDrawList(): void {
    const hover = this.hoverKey;
    const rank = (v: NodeView) => (v.key === hover ? 4 : v.temp ? 3 : v.layer);
    this.drawList = this.views.filter((v) => !v.dead).sort((a, b) => rank(a) - rank(b));
    this.dirty = true;
  }

  // ---------- helpers ----------

  /** The view that stands for a person: their own dot, their fanned-out dot, or the "+N" dot holding them. */
  private viewFor(id: string): NodeView | undefined {
    const own = this.byKey.get(id);
    if (own && !own.removing) return own;
    const fan = this.byKey.get(`fan:${id}`);
    if (fan && !fan.removing) return fan;
    return this.clusterOf.get(id) ?? own;
  }

  private dropView(v: NodeView): void {
    const i = this.views.indexOf(v);
    if (i >= 0) this.views.splice(i, 1);
    if (this.byKey.get(v.key) === v) this.byKey.delete(v.key);
    if (v.removing) this.removals--;
    v.dead = true;
  }

  private anim(
    t: Tween | Spring,
    target: number,
    now: number,
    dur = 0,
    ease = easing.outCubic,
    delay = 0,
  ): void {
    if (t instanceof Spring) {
      if (this.reduced) t.snap(target);
      else {
        t.target = target;
        if (t.x !== target || t.v !== 0) this.cameraMoving = true;
      }
      this.dirty = true;
      return;
    }
    t.animate(
      target,
      now,
      this.reduced ? Math.min(dur, TIMING.reduced) : dur,
      ease,
      this.reduced ? 0 : delay,
    );
    this.track(t);
  }

  private play(
    t: Tween,
    from: number,
    to: number,
    now: number,
    dur: number,
    ease = easing.outCubic,
    delay = 0,
  ) {
    if (this.reduced) t.snap(to);
    else t.play(from, to, now, dur, ease, delay);
    this.track(t);
  }

  private track(t: Tween): void {
    if (t.end > this.busyUntil) this.busyUntil = t.end;
    this.dirty = true;
  }

  private setPhase(p: string): void {
    this.phase = p;
    this.logPhase(p);
    this.dirty = true;
  }

  /** The recent phases, for tests: some last less than a frame (a route found at once). */
  private logPhase(p: string): void {
    if (this.phaseLog[this.phaseLog.length - 1] === p) return;
    this.phaseLog.push(p);
    if (this.phaseLog.length > 40) this.phaseLog.shift();
  }

  private refit(): void {
    if (!this.w || !this.h) return;
    const target = orbitScale(this.w, this.h, this.layout?.extent ?? EMPTY_EXTENT);
    if (target !== this.fitTarget || this.fitTween.to !== target) {
      this.fitTarget = target;
      // a new canvas size (a mode with a shorter header) or a bigger network: the orbit eases to its new size
      if (this.initialized && this.lastDraw > -1e9)
        this.anim(this.fitTween, target, this.clock.now(), 380, easing.inOutCubic);
      else {
        this.fitTween.snap(target);
        this.fit = target;
      }
    }
    const ctx = this.ctx;
    if (!ctx || !this.layout) return;
    const fontPx = this.labelFont();
    ctx.font = `500 ${fontPx}px Inter, sans-serif`;
    this.labels = labelSlots(this.layout, this.fitTarget, this.narrow, (t) => this.measure(t, fontPx, false));
    this.dirty = true;
  }

  private labelFont(): number {
    return Math.max(10, LABEL_FONT_PX * Math.max(0.85, this.fitTarget));
  }

  /** Text width with the current font, cached (labels and chips are measured once, not every frame). */
  private measure(text: string, fontPx: number, bold: boolean): number {
    const key = `${bold ? 'b' : 'r'}${fontPx}|${text}`;
    let w = this.labelWidth.get(key);
    if (w === undefined && this.ctx) {
      w = this.ctx.measureText(text).width;
      this.labelWidth.set(key, w);
    }
    return w ?? text.length * fontPx * 0.55;
  }

  // ---------- loop ----------

  wake = (): void => {
    if (this.destroyed || !this.canvas) return;
    // a transition shows on the canvas's data-animating at once, not a frame later, so waiting for it is race-free
    if (!this.animating && this.inTransition(this.clock.now())) {
      this.animating = true;
      this.publish();
    }
    if (this.raf) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private frame = (ts: number): void => {
    this.raf = 0;
    if (this.destroyed || !this.ctx || !this.w || !this.h) return;
    const now = this.clock.now();
    const dt = this.lastNow < 0 ? 16 : Math.min(100, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    this.advance(now, dt);
    const transition = this.inTransition(now);
    const full = transition || this.fullRate(now);
    const half = this.spin.value(now) > 0 || !this.spin.done(now) || this.rippling(now);
    if (this.dirty || full || (half && now - this.lastDraw >= 33)) {
      const t0 = performance.now();
      this.draw(now);
      // only frames of an animation count: the slow drift is drawn at half rate on purpose, not as dropped frames
      if (full || this.fullBefore) this.recorder?.frame(ts, performance.now() - t0);
      else this.recorder?.gap();
      this.lastDraw = now;
      this.dirty = false;
    }
    this.fullBefore = full;
    if (!transition && this.phase !== 'idle') {
      this.phase = 'idle';
      this.logPhase('idle');
    }
    this.animating = transition;
    this.publish();
    if (full || half || this.dirty) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.recorder?.gap();
    this.lastNow = -1;
    const next = this.nextWake(now);
    if (next < Number.POSITIVE_INFINITY) this.timer = setTimeout(this.wake, Math.max(16, next - now));
  };

  private inTransition(now: number): boolean {
    return (
      now < this.busyUntil ||
      this.rotSpringOn ||
      this.cameraMoving ||
      !!this.drag?.moved ||
      this.inertia !== 0 ||
      this.loading ||
      this.removals > 0 ||
      this.reach?.status === 'searching'
    );
  }

  /** Effects that loop while shown: the route's comet and the lit chain's travelling light. */
  private fullRate(now: number): boolean {
    if (this.path.ids.length > 1 && this.cometT(now) >= 0) return true;
    return !!this.web && this.webPath.length > 0 && !this.reduced;
  }

  private rippling(now: number): boolean {
    return this.ripplePhase(now) >= 0 && this.pendingVisible();
  }

  private nextWake(now: number): number {
    let next = Number.POSITIVE_INFINITY;
    if (this.pendingVisible()) {
      const p = TIMING.pendingPeriod;
      next = Math.min(next, Math.floor(now / p) * p + p);
    }
    if (this.path.ids.length > 1 && !this.reduced) {
      const begin = this.cometBegin();
      const k = Math.max(0, Math.ceil((now - begin) / TIMING.cometPeriod));
      next = Math.min(next, begin + k * TIMING.cometPeriod);
    }
    return next;
  }

  private pendingVisible(): boolean {
    if (this.reduced) return false;
    for (const v of this.views) if (v.pending && v.visible && v.pa > 0.5) return true;
    return false;
  }

  /** 0..1 inside the shared ripple window, -1 outside it: every pending dot ripples together. */
  private ripplePhase(now: number): number {
    const t = now % TIMING.pendingPeriod;
    return t < TIMING.pendingRipple ? t / TIMING.pendingRipple : -1;
  }

  private cometBegin(): number {
    return this.path.start + (this.path.ids.length - 1) * TIMING.hop + 300;
  }

  /** The comet's trip along the route, 0..1, or -1 while it rests between trips. */
  private cometT(now: number): number {
    if (this.reduced) return -1;
    const begin = this.cometBegin();
    if (now < begin) return -1;
    const t = (now - begin) % TIMING.cometPeriod;
    return t < TIMING.cometTravel ? t / TIMING.cometTravel : -1;
  }

  private advance(now: number, dt: number): void {
    const spin = this.spin.value(now);
    if (this.drag?.moved) {
      // the pointer sets the rotation
    } else if (this.rotSpringOn) {
      this.rotSpring.target += spin * dt;
      this.rotSpring.step(dt);
      this.rot = this.rotSpring.x;
      const off = Math.abs(this.rotSpring.x - this.rotSpring.target);
      if (spin === 0 && this.spin.done(now) && off < 1e-4 && Math.abs(this.rotSpring.v) < 1e-6) {
        // holding still on a focus: land exactly on it
        this.rot = this.rotSpring.target;
        this.rotSpringOn = false;
      } else if (spin > 0 && off < 2e-3 && Math.abs(this.rotSpring.v - spin) < 1e-5) {
        // turning back into the slow drift: hand over at the same angle and speed, no snap
        this.rotSpringOn = false;
      }
    } else {
      this.rot += (spin + this.inertia) * dt;
      if (this.inertia) {
        this.inertia *= Math.exp(-dt / 320);
        if (Math.abs(this.inertia) < 3e-6) this.inertia = 0;
      }
    }
    this.zoom.step(dt);
    this.panX.step(dt);
    this.panY.step(dt);
    const z = this.zoom.settle(0.0005, 0.000005);
    const px = this.panX.settle(0.25, 0.0025);
    const py = this.panY.settle(0.25, 0.0025);
    this.cameraMoving = !(z && px && py);
    if (this.removals > 0) {
      let gone = false;
      for (let i = this.views.length - 1; i >= 0; i--) {
        const v = this.views[i]!;
        if (v.removing && now >= v.removeAt) {
          this.views.splice(i, 1);
          if (this.byKey.get(v.key) === v) this.byKey.delete(v.key);
          v.dead = true;
          this.removals--;
          gone = true;
        }
      }
      if (gone) this.sortDrawList();
      if (this.removals < 0) this.removals = 0;
    }
    if (this.introLinks.length && this.introLinks.some((l) => now > l.end))
      this.introLinks = this.introLinks.filter((l) => now <= l.end);
    if (this.webOld && now - this.webOld.start > TIMING.retract) this.webOld = undefined;
    if (this.pathOld.ids.length && now - this.pathOld.start >= TIMING.retract)
      this.pathOld = { ids: [], start: 0, from: 0 };
  }

  // ---------- drawing ----------

  private draw(now: number): void {
    this.draws++;
    const ctx = this.ctx!;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.fit = this.fitTween.value(now);
    const S = this.fit * this.zoom.x;
    const ox = w / 2 + this.panX.x;
    const oy = h / 2 + this.panY.x;
    const rot = this.rot;
    this.you.x = ox;
    this.you.y = oy;
    this.spriteBuilds = 0;
    this.spriteDeadline = performance.now() + 4;
    this.frameNo++;
    for (const v of this.views) this.place(v, now, ox, oy, S, rot);
    this.drawRings(ctx, now, ox, oy, S);
    if (!this.loading) {
      this.drawWedges(ctx, now, ox, oy, S, rot);
      this.drawRadar(ctx, now, ox, oy, S);
      this.drawHoverLines(ctx, now);
      this.drawIntroLinks(ctx, now);
      this.drawWeb(ctx, now);
      this.drawPath(ctx, now);
      this.drawDots(ctx, now);
      this.drawComet(ctx, now);
    }
    this.drawYou(ctx, now, ox, oy);
    if (!this.loading) {
      this.drawLabels(ctx, now, ox, oy, S, rot);
      this.drawChips(ctx, now, ox, oy, S, rot);
      this.drawTip(ctx, now);
    }
    ctx.globalAlpha = 1;
  }

  private place(v: NodeView, now: number, ox: number, oy: number, S: number, rot: number): void {
    const ap = v.appear.value(now);
    if (ap <= 0.001) {
      v.visible = false;
      v.pa = 0;
      return;
    }
    const a = v.a.value(now) + rot;
    const r = v.r.value(now) * S;
    let x = ox + Math.cos(a) * r;
    const y = oy + Math.sin(a) * r;
    const shake = now - v.shakeAt;
    if (shake >= 0 && shake < TIMING.shake) {
      const k = shake / TIMING.shake;
      x += Math.sin(k * Math.PI * 6) * 5 * (1 - k);
    }
    const sc =
      v.scale.value(now) *
      (1 + 0.25 * v.lift.value(now)) *
      (1 + bump(now - v.popAt, 340, 0.22)) *
      (0.55 + 0.45 * ap);
    const pr = (v.size.value(now) / 2) * S * sc;
    v.x = x;
    v.y = y;
    v.pr = pr;
    v.pa = v.alpha.value(now) * ap;
    v.visible = v.pa > 0.004 && x + pr > -24 && x - pr < this.w + 24 && y + pr > -24 && y - pr < this.h + 24;
  }

  private drawRings(ctx: CanvasRenderingContext2D, now: number, ox: number, oy: number, S: number): void {
    const radii = this.layout?.ringRadii ?? [160, 300, 440];
    const ghost = this.ghost.value(now);
    const breathing = this.loading && !this.reduced;
    const phase = ((now - this.loadingSince) / 2400) * TAU;
    ctx.lineWidth = 1;
    ctx.strokeStyle = RING;
    if (ghost > 0.01) {
      // while the network loads, the empty rings breathe
      for (let i = 0; i < 3; i++) {
        const wave = breathing ? Math.sin(phase - i * 0.9) : 0;
        ctx.globalAlpha = ghost * (0.6 + 0.3 * wave);
        ctx.beginPath();
        ctx.arc(ox, oy, Math.max(1, radii[i]! * S + wave * 2.5), 0, TAU);
        ctx.stroke();
      }
    }
    if (this.loading) {
      ctx.globalAlpha = 1;
      return;
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < 3; i++) {
      const sweep = this.ringSweep[i]!.value(now);
      if (sweep <= 0) continue;
      const R = radii[i]! * S;
      const end = -Math.PI / 2 + TAU * Math.min(1, sweep);
      ctx.strokeStyle = RING;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ox, oy, R, -Math.PI / 2, end);
      ctx.stroke();
      if (sweep < 1) {
        // the pen drawing the ring: a short accent stroke at the leading edge
        const tail = Math.min(0.5, TAU * sweep);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        for (let k = 0; k < 4; k++) {
          ctx.globalAlpha = 0.5 * (1 - k / 4) * Math.min(1, (1 - sweep) * 6);
          ctx.beginPath();
          ctx.arc(ox, oy, R, end - (tail * (k + 1)) / 4, end - (tail * k) / 4);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawWedges(
    ctx: CanvasRenderingContext2D,
    now: number,
    ox: number,
    oy: number,
    S: number,
    rot: number,
  ) {
    if (!this.layout) return;
    const inner = 60 * S;
    const outer = (this.layout.extent + 6) * S;
    const groups = this.layout.groups;
    const ga = this.groupsAlpha.value(now);
    if (ga > 0.005 && this.shownGroups)
      for (const g of groups)
        if (this.shownGroups.has(g.key)) this.sector(ctx, g, ga, 0.045, ox, oy, inner, outer, rot);
    for (const wd of [this.wedgeOld, this.wedge]) {
      if (!wd.key) continue;
      const alpha = wd.alpha.value(now);
      if (alpha <= 0.005) continue;
      const g = groups.find((x) => x.key === wd.key);
      if (g)
        this.sector(ctx, g, alpha, 0.075, ox, oy, inner, outer, rot, wd === this.wedge ? this.spreadK : 1);
    }
    ctx.globalAlpha = 1;
  }

  /** A soft translucent wedge from the inner to the outer ring, behind a company's dots. */
  private sector(
    ctx: CanvasRenderingContext2D,
    g: OrbitGroup,
    alpha: number,
    fill: number,
    ox: number,
    oy: number,
    inner: number,
    outer: number,
    rot: number,
    k = 1,
  ): void {
    // opened by the same factor as the focused company's dots, plus half a dot either side
    const mid = wedgeMid(g);
    const half = ((g.endAngle - g.startAngle) / 2) * k + (k > 1 ? 0.035 : 0);
    const a0 = mid - half + rot;
    const a1 = mid + half + rot;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(ox, oy, outer, a0, a1);
    ctx.arc(ox, oy, inner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = `rgba(${ACCENT_RGB},${fill})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${ACCENT_RGB},${fill * 2.4})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawRadar(ctx: CanvasRenderingContext2D, now: number, ox: number, oy: number, S: number) {
    const alpha = this.radar.value(now);
    if (alpha <= 0.005 || !this.layout) return;
    const R = this.layout.extent * S;
    // a thin line sweeping round from the centre, with a fading trail
    const a = ((now - this.radarStart) / TIMING.radarTurn) * TAU - Math.PI / 2;
    const slices = 12;
    const span = 0.85;
    ctx.fillStyle = ACCENT;
    for (let i = 0; i < slices; i++) {
      ctx.globalAlpha = alpha * 0.11 * (1 - i / slices);
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.arc(ox, oy, R, a - ((i + 1) * span) / slices, a - (i * span) / slices);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + Math.cos(a) * R, oy + Math.sin(a) * R);
    ctx.stroke();
    // and the target pulses while Orbit looks for a way to it
    const t = this.reach ? this.viewFor(this.reach.targetId) : undefined;
    if (t?.visible) {
      const p = ((now - this.radarStart) % 900) / 900;
      ctx.globalAlpha = alpha * 0.6 * (1 - p);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.pr + 4 + p * 14, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawHoverLines(ctx: CanvasRenderingContext2D, now: number): void {
    const p = this.hoverLines.value(now);
    if (p <= 0.01 || !this.hoverKey || this.web || (this.reach && this.reach.status !== 'searching')) return;
    const v = this.byKey.get(this.hoverKey);
    const near = v?.person ? this.connections?.get(v.pid) : undefined;
    if (!v?.visible || !near?.length) return;
    const mark = this.frameNo;
    v.mark = mark;
    const grow = easing.outCubic(p);
    const A = this.scratchA;
    ctx.globalAlpha = 0.45 * Math.min(1, p * 1.5);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const id of near) {
      const t = this.viewFor(id);
      if (!t?.visible || t.mark === mark) continue;
      t.mark = mark;
      curveControl(A, v.x, v.y, t.x, t.y, 0.12);
      quadPartial(ctx, v.x, v.y, A.x, A.y, t.x, t.y, grow);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawIntroLinks(ctx: CanvasRenderingContext2D, now: number): void {
    const A = this.scratchA;
    for (const l of this.introLinks) {
      if (now < l.start || !l.from.visible || !l.to.visible) continue;
      const grow = clamp01((now - l.start) / TIMING.travel);
      const fade = clamp01((l.end - now) / 600);
      ctx.globalAlpha = 0.8 * fade;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      curveControl(A, l.from.x, l.from.y, l.to.x, l.to.y, 0.18);
      quadPartial(ctx, l.from.x, l.from.y, A.x, A.y, l.to.x, l.to.y, easing.outCubic(grow));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawWeb(ctx: CanvasRenderingContext2D, now: number): void {
    const web = this.web?.web ?? this.webOld?.web;
    if (!web) return;
    const retract = this.web ? 1 : 1 - clamp01((now - this.webOld!.start) / TIMING.retract);
    const lit = this.webChain.size > 0;
    const t = now - this.webStart;
    // the student's own tie to the first person of each lineage, then every introduction, generation by generation
    for (const r of web.roots) {
      const v = this.viewFor(r);
      if (!v) continue;
      this.webLink(
        ctx,
        this.you,
        v,
        1,
        this.lineageOf.get(r) ?? ACCENT,
        true,
        this.webChain.has(r),
        lit,
        t,
        retract,
      );
    }
    for (const l of web.links) {
      const from = this.viewFor(l.fromId);
      const to = this.viewFor(l.toId);
      if (!from?.visible || !to || from === to) continue;
      const onChain = this.webChain.has(l.fromId) && this.webChain.has(l.toId);
      const gen = web.generation.get(l.toId) ?? 2;
      this.webLink(ctx, from, to, gen, this.lineageOf.get(l.toId) ?? ACCENT, false, onChain, lit, t, retract);
    }
    if (this.web && this.webPath.length && !this.reduced) this.drawChainLight(ctx, now);
    ctx.globalAlpha = 1;
  }

  private webLink(
    ctx: CanvasRenderingContext2D,
    from: Pt,
    to: NodeView,
    gen: number,
    color: string,
    own: boolean,
    onChain: boolean,
    lit: boolean,
    t: number,
    retract: number,
  ): void {
    const grow = this.reduced
      ? 1
      : easing.outCubic(clamp01((t - (gen - 1) * TIMING.webGen) / TIMING.webLink));
    const p = Math.min(grow, retract);
    if (p <= 0.005 || !to.visible) return;
    const A = this.scratchA;
    const B = this.scratchB;
    curveControl(A, from.x, from.y, to.x, to.y, own ? 0.08 : 0.2);
    ctx.globalAlpha = (lit ? (onChain ? 1 : 0.16) : 0.85) * (own ? 0.6 : 1);
    ctx.lineWidth = own ? 1.2 : onChain && lit ? 2.6 : 2;
    if (own) {
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 4]);
    } else {
      // fades in from the introducer to the person introduced, so the direction reads at a glance
      const g = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      g.addColorStop(0, `${color}26`);
      g.addColorStop(1, color);
      ctx.strokeStyle = g;
    }
    ctx.beginPath();
    quadPartial(ctx, from.x, from.y, A.x, A.y, to.x, to.y, p);
    ctx.stroke();
    if (own) ctx.setLineDash([]);
    else if (p > 0.92) {
      quadPoint(B, from.x, from.y, A.x, A.y, to.x, to.y, 0.94);
      const ang = Math.atan2(to.y - B.y, to.x - B.x);
      const tipX = to.x - Math.cos(ang) * (to.pr + 4.5);
      const tipY = to.y - Math.sin(ang) * (to.pr + 4.5);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(ang - 0.45) * 7, tipY - Math.sin(ang - 0.45) * 7);
      ctx.lineTo(tipX - Math.cos(ang + 0.45) * 7, tipY - Math.sin(ang + 0.45) * 7);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** A light that travels down the lit chain: from You, through each introducer, to the person. */
  private drawChainLight(ctx: CanvasRenderingContext2D, now: number): void {
    const k = ((now - this.webLightStart) % TIMING.webLight) / TIMING.webLight;
    const hops = this.webPath.length;
    const u = easing.inOutSine(Math.min(1, k * 1.25)) * hops;
    const i = Math.min(hops - 1, Math.floor(u));
    const f = u - i;
    const a = i === 0 ? this.you : this.viewFor(this.webPath[i - 1]!);
    const b = this.viewFor(this.webPath[i]!);
    if (!a || !b?.visible) return;
    const A = this.scratchA;
    const B = this.scratchB;
    curveControl(A, a.x, a.y, b.x, b.y, i === 0 ? 0.08 : 0.2);
    quadPoint(B, a.x, a.y, A.x, A.y, b.x, b.y, f);
    const fade = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
    ctx.globalAlpha = 0.3 * fade;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(B.x, B.y, 9, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.95 * fade;
    ctx.fillStyle = this.lineageOf.get(this.webPath[0]!) ?? ACCENT;
    ctx.beginPath();
    ctx.arc(B.x, B.y, 3.6, 0, TAU);
    ctx.fill();
  }

  private pathPoint(id: string): NodeView | Pt | undefined {
    if (id === 'user') return this.you;
    const v = this.viewFor(id);
    return v?.visible ? v : undefined;
  }

  private drawHops(ctx: CanvasRenderingContext2D, ids: string[], upto: number, alpha: number): void {
    if (upto <= 0 || alpha <= 0) return;
    const A = this.scratchA;
    ctx.lineCap = 'round';
    ctx.strokeStyle = ACCENT;
    for (let k = 0; k < ids.length - 1; k++) {
      const p = clamp01(upto - k);
      if (p <= 0) break;
      const a = this.pathPoint(ids[k]!);
      const b = this.pathPoint(ids[k + 1]!);
      if (!a || !b) continue;
      curveControl(A, a.x, a.y, b.x, b.y, 0.15);
      const e = this.reduced ? 1 : easing.inOutSine(p);
      ctx.globalAlpha = 0.16 * alpha;
      ctx.lineWidth = 7;
      ctx.beginPath();
      quadPartial(ctx, a.x, a.y, A.x, A.y, b.x, b.y, e);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      quadPartial(ctx, a.x, a.y, A.x, A.y, b.x, b.y, e);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  private drawPath(ctx: CanvasRenderingContext2D, now: number): void {
    // a route being replaced retracts toward You while the new one draws out
    if (this.pathOld.ids.length) {
      const k = clamp01((now - this.pathOld.start) / TIMING.retract);
      this.drawHops(ctx, this.pathOld.ids, this.pathOld.from * (1 - easing.inCubic(k)), 1 - k * 0.3);
    }
    if (this.path.ids.length > 1) this.drawHops(ctx, this.path.ids, this.pathProgress(now), 1);
    ctx.globalAlpha = 1;
  }

  /** A small comet travels the route (You, then each connector, then the target) to show its direction. */
  private drawComet(ctx: CanvasRenderingContext2D, now: number): void {
    const k = this.cometT(now);
    const ids = this.path.ids;
    if (k < 0 || ids.length < 2) return;
    const hops = ids.length - 1;
    const head = easing.inOutSine(k) * hops;
    const A = this.scratchA;
    const B = this.scratchB;
    const out = k > 0.85 ? (1 - k) / 0.15 : 1;
    for (let j = 9; j >= 0; j--) {
      const u = head - j * 0.035 * hops;
      if (u < 0) continue;
      const i = Math.min(hops - 1, Math.floor(u));
      const a = this.pathPoint(ids[i]!);
      const b = this.pathPoint(ids[i + 1]!);
      if (!a || !b) continue;
      curveControl(A, a.x, a.y, b.x, b.y, 0.15);
      quadPoint(B, a.x, a.y, A.x, A.y, b.x, b.y, u - i);
      const fade = (1 - j / 10) * out;
      if (j === 0) {
        ctx.globalAlpha = 0.28 * fade;
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.arc(B.x, B.y, 8, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = (j === 0 ? 1 : 0.5) * fade;
      ctx.fillStyle = j === 0 ? '#ffffff' : ACCENT;
      ctx.beginPath();
      ctx.arc(B.x, B.y, j === 0 ? 3.2 : Math.max(0.6, 3 - j * 0.22), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawDots(ctx: CanvasRenderingContext2D, now: number): void {
    const ripple = this.reduced ? -1 : this.ripplePhase(now);
    const webOn = this.webAlpha.value(now);
    const route = this.reach?.status === 'found' ? this.path.ids : undefined;
    const drawn = this.pathProgress(now);
    const target = this.reach?.targetId;
    const kb = this.hoverHow === 'keyboard' ? this.hoverKey : undefined;
    // ambient ripples wait until the map has arrived
    const quiet = this.phase !== 'arrival';
    for (const v of this.drawList) {
      if (!v.visible) continue;
      const { x, y, pr, pa } = v;
      const glow = v.glow.value(now);
      if (glow > 0.01) {
        ctx.fillStyle = ACCENT;
        ctx.globalAlpha = pa * glow * 0.14;
        ctx.beginPath();
        ctx.arc(x, y, pr + 4, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = pa * glow * 0.07;
        ctx.beginPath();
        ctx.arc(x, y, pr + 8, 0, TAU);
        ctx.fill();
      }
      // in the introductions view each lineage tints its people, so a chain reads as one branch
      if (webOn > 0.01 && v.person) {
        const color = this.lineageOf.get(v.pid);
        if (color) {
          ctx.globalAlpha = pa * webOn * 0.22;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, pr + 5, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = pa * webOn;
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, pr + 3.5, 0, TAU);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = pa;
      this.drawSprite(ctx, v);
      // pipeline stage ring, crossfading between colours when the stage changes
      if (v.stageFrom || v.stageTo) {
        const t = v.stageMix.value(now);
        ctx.lineWidth = 2.5;
        if (t >= 1 && v.stageTo) {
          ctx.strokeStyle = v.stageCss;
          ctx.globalAlpha = pa;
        } else if (v.stageFrom && v.stageTo) {
          ctx.strokeStyle = mixRgb(v.stageFrom, v.stageTo, t);
          ctx.globalAlpha = pa;
        } else {
          const c = (v.stageTo ?? v.stageFrom)!;
          ctx.strokeStyle = mixRgb(c, c, 1);
          ctx.globalAlpha = pa * (v.stageTo ? t : 1 - t);
        }
        if (ctx.globalAlpha > 0.005) {
          ctx.beginPath();
          ctx.arc(x, y, pr + 1.5, 0, TAU);
          ctx.stroke();
        }
      }
      // one soft ring burst when a chat is booked or has happened
      const b = now - v.burstAt;
      if (b >= 0 && b < TIMING.burst) {
        const k = b / TIMING.burst;
        ctx.globalAlpha = pa * 0.55 * (1 - k);
        ctx.strokeStyle = v.burstColor;
        ctx.lineWidth = 2.5 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(x, y, pr + 3 + easing.outCubic(k) * 20, 0, TAU);
        ctx.stroke();
      }
      // a newcomer lands with a ripple
      const rp = now - v.rippleAt;
      if (rp >= 0 && rp < TIMING.ripple) {
        const k = rp / TIMING.ripple;
        ctx.globalAlpha = pa * 0.6 * (1 - k);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(x, y, pr + 2 + easing.outCubic(k) * 18, 0, TAU);
        ctx.stroke();
      }
      // a pending suggestion: one soft ripple every few seconds, in step across all dots
      if (v.pending && ripple >= 0 && pa > 0.5 && quiet) {
        ctx.globalAlpha = pa * 0.3 * (1 - ripple);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, pr + 3 + easing.outCubic(ripple) * 8, 0, TAU);
        ctx.stroke();
      }
      // reach: the target carries an accent ring, and each person on the route gets one as the line arrives
      const hop = route ? route.indexOf(v.pid) : -1;
      if (!v.temp && (v.pid === target || (hop > 0 && hop <= drawn + 0.02))) {
        ctx.globalAlpha = pa;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, pr + 5, 0, TAU);
        ctx.stroke();
      }
      if (v.key === kb) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, pr + 6.5, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawSprite(ctx: CanvasRenderingContext2D, v: NodeView): void {
    const d = v.pr * 2;
    if (d < 0.5) return;
    // built at the size the dot is heading for, so a pop or a lift does not rebuild it every frame
    const target = v.size.to * this.fitTarget * this.zoom.target * v.scale.to * (1 + 0.25 * v.lift.to);
    const want = Math.max(d, target);
    const label = v.cluster ? v.label : '';
    const photo = v.person?.photoUrl ? this.imageFor(v.person) : undefined;
    const fresh =
      !!v.sprite &&
      v.spriteDpr === this.dpr &&
      v.spriteLabel === label &&
      want <= v.spriteD * 1.04 &&
      want >= v.spriteD * 0.55 &&
      v.spriteImg === !!(photo?.complete && photo.naturalWidth);
    if (!fresh) {
      if (this.spriteBuilds < 4 || performance.now() < this.spriteDeadline) {
        this.spriteBuilds++;
        this.buildSprite(v, Math.ceil(want), label, photo);
      } else if (!v.sprite) {
        // over this frame's budget: a plain disc stands in until the next frame
        ctx.fillStyle = v.cluster ? '#eef0f5' : `hsl(${v.hue} 45% 55%)`;
        ctx.beginPath();
        ctx.arc(v.x, v.y, v.pr, 0, TAU);
        ctx.fill();
        this.dirty = true;
        return;
      } else this.dirty = true;
    }
    const size = d + 6 * (d / v.spriteD);
    ctx.drawImage(v.sprite!, v.x - size / 2, v.y - size / 2, size, size);
  }

  private imageFor(p: Person): HTMLImageElement | undefined {
    if (!p.photoUrl) return undefined;
    let img = this.images.get(p.id);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.dirty = true;
        this.wake();
      };
      img.src = p.photoUrl;
      this.images.set(p.id, img);
    }
    return img;
  }

  private buildSprite(v: NodeView, d: number, label: string, photo?: HTMLImageElement): void {
    const pad = 3;
    const css = d + pad * 2;
    const px = Math.max(2, Math.ceil(css * this.dpr));
    const c = v.sprite ?? document.createElement('canvas');
    c.width = px;
    c.height = px;
    const g = c.getContext('2d')!;
    g.setTransform(px / css, 0, 0, px / css, 0, 0);
    g.clearRect(0, 0, css, css);
    const cx = css / 2;
    const r = d / 2;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let img = false;
    if (v.cluster) {
      g.beginPath();
      g.arc(cx, cx, r - 0.5, 0, TAU);
      g.fillStyle = '#eef0f5';
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = '#c9cdd6';
      g.stroke();
      if (r >= 5) {
        g.fillStyle = '#4a505c';
        g.font = `600 ${Math.max(7, Math.min(r * 0.8, (r * 2.8) / Math.max(1, label.length)))}px Inter, sans-serif`;
        g.fillText(label, cx, cx + 0.5);
      }
    } else if (v.person) {
      g.save();
      g.beginPath();
      g.arc(cx, cx, r, 0, TAU);
      g.closePath();
      g.clip();
      if (photo?.complete && photo.naturalWidth) {
        g.drawImage(photo, cx - r, cx - r, r * 2, r * 2);
        img = true;
      } else {
        g.fillStyle = `hsl(${v.hue} 45% 55%)`;
        g.fillRect(cx - r, cx - r, r * 2, r * 2);
        if (r >= 7) {
          g.fillStyle = '#fff';
          g.font = `600 ${Math.max(7, r * 0.8)}px Inter, sans-serif`;
          g.fillText(initialsOf(v.person), cx, cx + 0.5);
        }
      }
      g.restore();
      g.beginPath();
      g.arc(cx, cx, r + 1.5, 0, TAU);
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(15,17,21,0.08)';
      g.stroke();
    }
    v.sprite = c;
    v.spriteD = d;
    v.spriteDpr = this.dpr;
    v.spriteLabel = label;
    v.spriteImg = img;
  }

  private drawYou(ctx: CanvasRenderingContext2D, now: number, ox: number, oy: number): void {
    let k = this.youPop.value(now);
    const pulsing = this.loading && !this.reduced;
    if (pulsing) k *= 1 + 0.06 * Math.sin(((now - this.loadingSince) / 1200) * TAU);
    const R = 26 * Math.max(0.6, this.fit) * this.zoom.x * k;
    if (pulsing) {
      const p = ((now - this.loadingSince) % 1800) / 1800;
      ctx.globalAlpha = 0.35 * (1 - p);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox, oy, R + 4 + p * 22, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(ox, oy, R, 0, TAU);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${12 * Math.max(0.8, this.fit) * k}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('You', ox, oy + 1);
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    now: number,
    ox: number,
    oy: number,
    S: number,
    rot: number,
  ) {
    if (!this.layout) return;
    const labelR = this.layout.extent * S + LABEL_GAP;
    const fontPx = this.labelFont();
    ctx.font = `500 ${fontPx}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = LABEL;
    const shown = this.labelIn.value(now);
    const base = shown * this.labelDim.value(now);
    const chipA = this.chip.alpha.value(now);
    const chipOldA = this.chipOld.alpha.value(now);
    let clipped = 0;
    for (const l of this.labels) {
      const a = l.mid + rot;
      const half = this.measure(l.text, fontPx, false) / 2;
      // anchor the label's near edge on the label ring, so side labels grow outwards, not into the dots
      const r = labelR + Math.abs(Math.cos(a)) * half + Math.abs(Math.sin(a)) * (fontPx / 2);
      const want = ox + Math.cos(a) * r;
      const x = Math.min(Math.max(want, half + 4), this.w - half - 4);
      const y = oy + Math.sin(a) * r;
      // a label that would have to slide over the dots to stay on screen fades out instead (narrow screens)
      const fit = Math.max(0, Math.min(1, 1 - (Math.abs(want - x) - 4) / 16));
      if (fit <= 0) continue;
      if (y - fontPx / 2 < 0 || y + fontPx / 2 > this.h || x - half < 0 || x + half > this.w) clipped++;
      // the focused company's label hands over to its count chip
      let alpha = l.key === this.companyKey ? fit * shown : fit * base;
      if (l.key === this.chip.key) alpha *= 1 - chipA;
      if (l.key === this.chipOld.key) alpha *= 1 - chipOldA;
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.fillText(l.text, x, y);
    }
    ctx.globalAlpha = 1;
    this.labelsClipped = clipped;
  }

  /** The floating count chip ("7 at Stripe · 2 warm") that fades and slides in where the company's label was. */
  private drawChips(
    ctx: CanvasRenderingContext2D,
    now: number,
    ox: number,
    oy: number,
    S: number,
    rot: number,
  ) {
    if (!this.layout) return;
    for (const chip of [this.chipOld, this.chip]) {
      const alpha = chip.alpha.value(now);
      if (alpha <= 0.01 || !chip.text) continue;
      const g = this.layout.groups.find((x) => x.key === chip.key);
      if (!g) continue;
      const a = wedgeMid(g) + rot;
      ctx.font = '500 12px Inter, sans-serif';
      const bw = this.measure(chip.text, 12, false) + 22;
      const bh = 24;
      const r = chip.radius * S + LABEL_GAP + bh / 2 + (1 - alpha) * 10;
      let x = ox + Math.cos(a) * (r + Math.abs(Math.cos(a)) * (bw / 2 - bh / 2));
      let y = oy + Math.sin(a) * r;
      x = Math.min(Math.max(x, bw / 2 + 4), this.w - bw / 2 - 4);
      y = Math.min(Math.max(y, bh / 2 + 4), this.h - bh / 2 - 4);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = `rgba(${ACCENT_RGB},0.35)`;
      ctx.lineWidth = 1;
      roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(chip.text, x, y + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  /** The name label above the hovered (or keyboard-focused) dot, which fades and slides in. */
  private drawTip(ctx: CanvasRenderingContext2D, now: number): void {
    const alpha = this.tip.value(now);
    if (alpha <= 0.01 || !this.tipKey) return;
    const v = this.byKey.get(this.tipKey);
    if (!v?.visible) return;
    const label = v.cluster
      ? v.cluster.label === 'Other companies'
        ? `${v.cluster.count} people at other companies`
        : `${v.cluster.count} more at ${v.cluster.label}`
      : (v.person?.displayName ?? '');
    if (!label) return;
    ctx.font = '500 12px Inter, sans-serif';
    const tw = this.measure(label, 12, false) + 16;
    const x = Math.min(Math.max(v.x, tw / 2 + 4), this.w - tw / 2 - 4);
    const y = Math.max(v.y - v.pr - 18 + (1 - alpha) * 6, 14);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#e6e8ec';
    ctx.lineWidth = 1;
    roundRect(ctx, x - tw / 2, y - 11, tw, 22, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
    ctx.globalAlpha = 1;
  }

  // ---------- test hooks ----------

  private publish(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const attrs = this.published;
    const set = (k: string, v: string) => {
      if (attrs[k] === v) return;
      attrs[k] = v;
      canvas.dataset[k] = v;
    };
    set('animating', String(this.animating));
    set('phase', this.phase);
    set('moving', String(this.spinning()));
    set('labels', String(this.labels.length));
    set('labelsClipped', String(this.labelsClipped));
    set('scale', this.fitTarget.toFixed(3));
    set('focus', this.focusName());
    set('chip', this.chip.alpha.to > 0 ? this.chip.text : '');
    set('path', this.path.ids.join('>'));
    const fp = this.firstPerson;
    if (fp?.visible) set('firstDot', `${Math.round(fp.x)},${Math.round(fp.y)}`);
  }

  private focusName(): string {
    if (this.companyKey) return `company:${this.companyKey}`;
    if (this.reach) return `reach:${this.reach.targetId}:${this.reach.status}`;
    if (this.web) return `web${this.web.focusId ? `:${this.web.focusId}` : ''}`;
    return '';
  }

  snapshot(): SceneSnapshot {
    const now = this.clock.now();
    const web = this.web;
    return {
      centre: [this.w / 2 + this.panX.x, this.h / 2 + this.panY.x],
      phase: this.phase,
      phaseLog: [...this.phaseLog],
      animating: this.animating,
      rotation: this.rot,
      zoom: this.zoom.x,
      pan: [this.panX.x, this.panY.x],
      focus: this.focusName(),
      chip: this.chip.text,
      path: this.path.ids,
      pathDrawn: this.pathProgress(now),
      emphasized: this.views
        .filter((v) => !v.temp && v.alpha.to >= 0.9 && (v.glow.to > 0 || v.scale.to > 1.05))
        .map((v) => v.pid),
      dimmed: this.views.filter((v) => !v.temp && v.alpha.to < 0.5).length,
      nodes: this.views.filter((v) => !v.temp).length,
      fans: this.views.filter((v) => v.temp && !v.removing).map((v) => v.pid),
      webLinks: web ? web.web.links.length : 0,
      webDrawn: web
        ? web.web.links.filter(
            (l) =>
              now - this.webStart >=
              ((web.web.generation.get(l.toId) ?? 2) - 1) * TIMING.webGen + TIMING.webLink,
          ).length
        : 0,
      webLit: [...this.webChain],
      hover: this.hovered(),
      spin: this.spin.value(now),
      draws: this.draws,
    };
  }

  /** Current dot positions in CSS px, by person or aggregate-dot id. */
  positions(ids?: string[]): Record<string, { x: number; y: number; r: number; alpha: number }> {
    const out: Record<string, { x: number; y: number; r: number; alpha: number }> = {};
    const list = ids ?? this.views.filter((v) => !v.temp && !v.dead).map((v) => v.pid);
    for (const id of list) {
      const p = this.positionOf(id);
      if (p) out[id] = p;
    }
    return out;
  }
}
