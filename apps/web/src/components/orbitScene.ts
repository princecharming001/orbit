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
  openedAngle,
  orbitScale,
  type Pt,
  quadPartial,
  quadPoint,
  routeControls,
  spreadApart,
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
const DASH: number[] = [3, 4];
const SOLID: number[] = [];
/** fill and edge colours for the company wedges, built once rather than every frame */
const WEDGE_STYLE = new Map<number, [string, string]>(
  [0.045, 0.075].map((f) => [f, [`rgba(${ACCENT_RGB},${f})`, `rgba(${ACCENT_RGB},${f * 2.4})`]]),
);
const CHIP_EDGE = `rgba(${ACCENT_RGB},0.35)`;
const OMEGA = TAU / ORBIT_PERIOD_MS;
/** extent of an orbit with no dots (the outer ring plus half a dot), for the empty and loading map */
const EMPTY_EXTENT = 456;
const FAN_PITCH = 30;
const NO_VIEWS = new Set<never>();
/** A drag released slower than this (radians a millisecond, about 70 degrees a second) does not coast. */
const FLICK_MIN = 0.0012;
/** How far from a person the dots round them count extra when the person card is placed (CSS px). */
const NEAR_CARD = 140;

/** How much a dot on a reach route grows (no more than its neighbours leave room for). */
const ROUTE_SCALE = 1.12;
/** CSS px kept clear between two people on a route who sit side by side: room for the hop, its arrow and names */
const ROUTE_GAP = 26;
/** an introductions web this small names everyone in it; a bigger one names only the lit chain */
const TAG_WEB_ALL = 16;

// ---------- timing (ms) ----------
export const TIMING = {
  arrive: 700,
  skip: 140,
  ringSweep: 520,
  ringStagger: 80,
  labelsIn: 300,
  fadeIn: 220,
  flip: 650,
  makeRoom: 160,
  spotHold: 1400,
  travel: 800,
  ripple: 900,
  introLinkHold: 3000,
  introWait: 180,
  emphasis: 300,
  filter: 250,
  filterSweep: 180,
  popStagger: 38,
  /** the whole stagger of a company's pops, at most */
  popSpread: 350,
  hover: 120,
  hoverLines: 220,
  tip: 150,
  hop: 350,
  /** a hop's draw when the student picks another route: the new one draws while the old one pulls back */
  hopSwitch: 220,
  turn: 700,
  turnMax: 950,
  turnBackMax: 1150,
  retract: 260,
  cometPeriod: 2500,
  cometTravel: 1100,
  radarTurn: 1200,
  /** the radar shows for at least this long, so a route found at once still reads as "searching" first */
  radarMin: 480,
  shake: 520,
  webGen: 250,
  webLink: 450,
  webLight: 1700,
  webLightRest: 900,
  stage: 450,
  burst: 900,
  pendingPeriod: 2400,
  pendingRipple: 1100,
  reduced: 140,
} as const;

export type ReachStatus = 'searching' | 'found' | 'none';

export type FocusSpec =
  /** `count` and `warm`: what the page's legend line says, so the chip on the map agrees with it */
  | { kind: 'company'; groupKey: string; count?: number; warm?: number }
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
  /** how far the pop swells the dot: less when its neighbours leave no room */
  popH = 0.22;
  /** a moment in the spotlight (a newcomer, a tie that moved rings, a chat just booked): larger, with a halo */
  spotStart = -1e9;
  spotEnd = -1e9;
  spotScale = 0.35;
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
  /** hops of a route being replaced that are still drawn as it pulls back */
  pathOldDrawn: number;
  emphasized: string[];
  dimmed: number;
  nodes: number;
  fans: string[];
  webLinks: number;
  webDrawn: number;
  webLit: string[];
  hover?: string;
  spin: number;
  /** the first names written under dots in the last frame drawn (a route, the introductions web, a spotlight) */
  tags: string[];
  /** people the pending-suggestion ripple marks */
  pending: string[];
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

/** 0..1: how far into its spotlight a dot is (eases in, holds, eases out before the end). */
function spotOf(v: NodeView, now: number): number {
  if (now < v.spotStart || now > v.spotEnd) return 0;
  const k = Math.min(clamp01((now - v.spotStart) / 220), clamp01((v.spotEnd - now) / 500));
  return easing.outCubic(k);
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
  /** the page shows a card next to the hovered person, so the canvas does not write their name a second time */
  private personCard = false;
  private reduced = false;
  private spinAllowed = true;

  private layout?: OrbitLayout;
  private groupByKey = new Map<string, OrbitGroup>();
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
  /** the loading halo and breathing round "You": fades out when the people arrive, never cut */
  private youHalo = new Tween(1);
  private youBumpAt = -1e9;

  private filterIds?: Set<string>;
  private groupsAlpha = new Tween(0);
  private shownGroups?: Set<string>;

  private companyKey?: string;
  private companyCounts?: { count: number; warm: number };
  /** how far the focused company's wedge has opened (1 = its own width) */
  private spreadK = 1;
  /** `k`: how far the wedge is drawn open, tweened with its dots so the tint never runs ahead of them */
  private wedge = { key: '', alpha: new Tween(0), k: new Tween(1) };
  private wedgeOld = { key: '', alpha: new Tween(0), k: new Tween(1) };
  /** the arc an open fan covers (before rotation), whose neighbouring labels fade out while it is open */
  private fanArc = { mid: 0, half: 0 };
  private fanVeil = new Tween(0);
  private chip = { text: '', key: '', alpha: new Tween(0), radius: 0 };
  private chipOld = { text: '', key: '', alpha: new Tween(0), radius: 0 };

  private reach?: { targetId: string; status: ReachStatus; ids: string[] };
  /** the route on the map: `start` is when its first hop began drawing, `hop` how long each hop takes */
  private path = { ids: [] as string[], start: 0, hop: TIMING.hop as number };
  /** a route being replaced: it pulls back from `from` hops drawn to `to` (the hops it shares with the new one) */
  private pathOld = { ids: [] as string[], start: 0, from: 0, to: 0 };
  /** the reach target the orbit has turned to the top */
  private reachTurned?: string;
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
  private gradients = new WeakMap<
    object,
    { x0: number; y0: number; x1: number; y1: number; color: string; g: CanvasGradient }
  >();

  private hoverKey?: string;
  private hoverHow: HoverHow = 'pointer';
  private hoverLines = new Tween(0);
  private tipKey?: string;
  private tip = new Tween(0);

  private introLinks: { from: NodeView; to: NodeView; start: number; end: number }[] = [];

  /** name tags this frame (for tests), the dots they belong to with their alpha, and the boxes already taken */
  private tags: string[] = [];
  private tagList: (NodeView | number)[] = [];
  private tagBoxes: number[] = [];
  private tagNames = new Map<string, string>();
  /** people in the spotlight (a newcomer, a tie that moved rings, a chat just booked), named while it lasts */
  private named: NodeView[] = [];

  private drag?: { last: number; t: number; v: number; moved: boolean; x0: number; y0: number };

  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** the loop is waiting on a timer between two slow drift draws (rather than asleep, or drawing every frame) */
  private napping = false;
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
  /** where the sprite pre-build has got to in `views` (-1: nothing waiting) */
  private prebuildAt = -1;
  private images = new Map<string, HTMLImageElement>();
  private destroyed = false;
  private you: Pt = { x: 0, y: 0 };
  private scratchA: Pt = { x: 0, y: 0 };
  private scratchB: Pt = { x: 0, y: 0 };
  private routePts: Pt[] = [];
  private chipXY: [number, number, number, number] = [0, 0, 0, 0];
  private routeCs: Pt[] = [];

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

  setOptions(o: { spin: boolean; reduced: boolean; personCard?: boolean }): void {
    this.spinAllowed = o.spin;
    this.reduced = o.reduced;
    this.personCard = !!o.personCard;
    this.dirty = true;
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
    if (d.people !== this.people) this.tagNames.clear();
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
    if (wasLoading) this.anim(this.youHalo, 0, now, 360, easing.outQuad);
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
      let start = now;
      if (now < to.a.start && !from.removing) {
        // still waiting at You: set out from the introducer instead, at the same moment
        start = to.a.start;
        const oa = from.a.value(now);
        this.play(to.a, oa, nearestAngle(oa, to.a.to), now, TIMING.travel, easing.inOutCubic, start - now);
        this.play(to.r, from.r.value(now), to.r.to, now, TIMING.travel, easing.inOutCubic, start - now);
      }
      const l = { from, to, start, end: start + TIMING.travel + TIMING.introLinkHold };
      if (to.spotEnd > now) this.spotlight(to, to.spotStart, l.end, to.spotScale);
      this.introLinks.push(l);
      this.busyUntil = Math.max(this.busyUntil, l.end);
      this.setPhase('newcomer-intro');
    }
  }

  private applyLayout(layout: OrbitLayout, now: number, initial: boolean): void {
    const prevClusterOf = this.clusterOf;
    this.layout = layout;
    this.groupByKey = new Map(layout.groups.map((g) => [g.key, g]));
    const seen = new Set<string>();
    const born: NodeView[] = [];
    const dur = this.reduced ? 0 : TIMING.flip;
    let moved = false;
    // a few people changing rings (a tie grew closer) lead: they move first and land in the spotlight, and
    // everyone else makes room a beat later, so the eye follows the change rather than the reshuffle
    let changers = 0;
    for (const n of layout.nodes) {
      const v = this.byKey.get(n.id);
      if (v && !v.temp && !v.removing && v.person && v.ring !== n.ring) changers++;
    }
    const lead = !initial && !this.reduced && changers > 0 && changers <= 6;
    for (const n of layout.nodes) {
      let v = this.byKey.get(n.id);
      if (v?.temp) v = undefined;
      if (v) {
        if (v.removing) this.revive(v, now);
        const changer = lead && !!v.person && v.ring !== n.ring;
        this.bind(v, n);
        const ta = nearestAngle(v.a.value(now), n.angle);
        if (Math.abs(ta - v.a.to) > 1e-6 || Math.abs(n.radius - v.r.to) > 1e-6) {
          // FLIP: glide from where the dot is now to its new slot, round the orbit and along the radius
          const delay = lead && !changer ? TIMING.makeRoom : 0;
          const d = lead && !changer ? TIMING.flip + 100 : dur;
          this.anim(v.a, ta, now, d, easing.inOutCubic, delay);
          this.anim(v.r, n.radius, now, d, easing.inOutCubic, delay);
          moved = true;
        }
        if (changer) {
          this.spotlight(v, now, now + TIMING.flip + TIMING.spotHold, n.ring === 0 ? 0.15 : 0.3);
          v.rippleAt = now + TIMING.flip - 60;
          this.busyUntil = Math.max(this.busyUntil, v.rippleAt + TIMING.ripple);
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
    if (born.length) this.prebuildAt = 0;
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

  /** A dot steps into the spotlight for a moment, so the eye finds what changed. */
  private spotlight(v: NodeView, start: number, end: number, scale: number): void {
    if (this.reduced) return;
    v.spotStart = start;
    v.spotEnd = end;
    v.spotScale = scale;
    if (!this.named.includes(v)) this.named.push(v);
    this.busyUntil = Math.max(this.busyUntil, end);
  }

  private groupOf(key: string | undefined): OrbitGroup | undefined {
    return key ? this.groupByKey.get(key) : undefined;
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
      const introducer = bulk ? undefined : this.introducerOf?.get(v.pid);
      const from = introducer ? this.viewFor(introducer) : undefined;
      const was = prevClusterOf.get(v.pid);
      const origin = from && !from.removing ? from : was && !was.removing ? was : undefined;
      // with no introducer on record yet, wait a moment: the record of who introduced them is often saved just
      // after the person, and then they still set out from their introducer's dot (see lateIntroductions)
      const delay = i * stagger + (bulk || origin ? 0 : TIMING.introWait);
      const oa = origin ? origin.a.value(now) : v.a.to - 0.9;
      const or = origin ? origin.r.value(now) : 0;
      this.play(v.a, oa, nearestAngle(oa, v.a.to), now, TIMING.travel, easing.inOutCubic, delay);
      this.play(v.r, or, v.r.to, now, TIMING.travel, easing.inOutCubic, delay);
      this.play(v.appear, 0, 1, now, TIMING.fadeIn, easing.outQuad, delay);
      if (!bulk || i < 24) {
        v.rippleAt = now + delay + TIMING.travel - 40;
        this.busyUntil = Math.max(this.busyUntil, v.rippleAt + TIMING.ripple);
        // someone new is the news: larger, with a halo, until their introduction link fades
        const landed = now + delay + TIMING.travel - 160;
        const end =
          from && origin === from ? now + delay + TIMING.travel + TIMING.introLinkHold : landed + 2400;
        // larger, but never over a neighbour's initials once landed: the halo and the ripple say the rest
        const want = v.ring === 2 ? 0.7 : 0.4;
        this.spotlight(v, landed, end, Math.min(want, this.roomFor(v, 1 + want, NO_VIEWS, 1) - 1));
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
          // the booked chat lifts above its neighbours while the burst plays
          this.spotlight(v, now, now + TIMING.burst + 700, 0.35);
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
    // the rings the loading orbit already shows stay while the pen goes round them, and step back once all three
    // are drawn: the arrival carries on from the loading orbit instead of clearing it first
    this.anim(this.ghost, 0, now, 260, easing.outQuad, TIMING.ringSweep + 2 * TIMING.ringStagger);
    // "You" swells once as the people leave it, from the size it already has (no shrink, no cut)
    this.youBumpAt = now;
    let last = 0;
    for (const v of this.views) {
      if (v.temp) continue;
      // a wave down both sides from twelve o'clock, meeting at six: smooth all round, with no seam where it began
      const wave = (1 - Math.cos(fromTop(v.a.to + this.rot) * TAU)) / 2;
      const delay = 100 + v.ring * 90 + wave * 240;
      last = Math.max(last, delay);
      this.play(v.a, v.a.to - 0.55, v.a.to, now, TIMING.arrive, easing.outCubic, delay);
      this.play(v.r, 0, v.r.to, now, TIMING.arrive, outBack(1.25), delay);
      this.play(v.appear, 0, 1, now, 260, easing.outQuad, delay);
    }
    this.play(this.labelIn, 0, 1, now, TIMING.labelsIn, easing.outQuad, last + TIMING.arrive - 250);
  }

  /** The first-visit arrival is still flying in. */
  arriving(): boolean {
    return this.phase === 'arrival';
  }

  /**
   * Any pointer interaction during the arrival finishes it: everything still on its way fast-forwards to its place
   * in a blink (TIMING.skip), from wherever it is, so the click is honoured without a hard cut.
   */
  finishArrival(): void {
    if (this.phase !== 'arrival') return;
    const now = this.clock.now();
    const ff = (t: Tween, to: number) => {
      if (t.done(now) && t.to === to) return;
      t.play(t.value(now), to, now, TIMING.skip, easing.outCubic);
    };
    for (const t of this.ringSweep) ff(t, 1);
    ff(this.ghost, 0);
    ff(this.labelIn, 1);
    ff(this.youHalo, 0);
    if (now - this.youBumpAt < 420) this.youBumpAt = -1e9;
    for (const v of this.views) {
      if (v.temp) continue;
      ff(v.a, v.a.to);
      ff(v.r, v.r.to);
      ff(v.appear, v.removing ? 0 : 1);
    }
    this.recomputeBusy();
    this.setPhase('arrival-skip');
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
    for (const t of [...this.ringSweep, this.ghost, this.labelIn, this.labelDim, this.youHalo, this.radar])
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
    this.companyCounts =
      f?.kind === 'company' && f.count !== undefined ? { count: f.count, warm: f.warm ?? 0 } : undefined;
    if (company !== this.companyKey) this.applyCompany(company, now);
    else if (company && this.chip.key === company) {
      const g = this.groupOf(company);
      if (g) this.chip.text = this.chipText(g);
    }
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
      this.webOld = this.reduced ? undefined : { web: prev.web, start: now };
      this.anim(this.webAlpha, 0, now, TIMING.retract, easing.inQuad);
      this.web = undefined;
      this.webChain = new Set();
      this.webPath = [];
      if (!this.reduced) this.busyUntil = Math.max(this.busyUntil, now + TIMING.retract);
      // everyone goes back to their own slot, and the camera with them
      this.retarget(now, 600);
      if (this.reach?.status === 'found') this.framePath(now);
      else this.frame0(now);
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
        // the people in the web move out to their generation's ring, then the links grow, and the camera moves in
        // on the tree
        this.retarget(now, 650);
        this.frameWeb(now);
        if (!prev) {
          this.webStart = now + (this.reduced ? 0 : 380);
          this.webOld = undefined;
          this.anim(this.webAlpha, 1, now, 300, easing.outQuad);
          // reduced motion draws every link at once, so there is nothing to wait for
          if (!this.reduced)
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
        const g = w.turnTo.group ? this.groupOf(w.turnTo!.group) : undefined;
        const angle = target ? target.a.to : g ? wedgeMid(g) : undefined;
        if (angle !== undefined) {
          this.hold(rotationToTop(angle, this.rot), now);
          this.frameWeb(now);
        }
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
    const g = groupKey ? this.groupOf(groupKey) : undefined;
    if (g) {
      this.wedge.key = g.key;
      this.wedge.k.snap(1);
    }
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
    const g = this.companyKey ? this.groupOf(this.companyKey) : undefined;
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
      const slots = fanSlots(have.length, wedgeMid(g), this.fanBase(), FAN_PITCH, this.fanSpan(g), 3);
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
    const said = this.companyCounts;
    if (said) return `${said.count} at ${g.label}${said.warm ? ` · ${said.warm} warm` : ''}`;
    let warm = 0;
    for (const v of this.views)
      if (!v.temp && v.groupKey === g.key && (v.person?.strength ?? 0) >= 0.3) warm++;
    return `${g.count} at ${g.label}${warm ? ` · ${warm} warm` : ''}`;
  }

  /**
   * How wide the fan may open: a little wider than the opened wedge, so a big company's fan stays above its own
   * wedge instead of spilling over its neighbours' labels (whoever does not fit stays in the "+N" dot).
   */
  private fanSpan(g: OrbitGroup): number {
    const wedge = (g.endAngle - g.startAngle) * this.spreadK;
    return Math.min(0.95, Math.max(0.4, wedge + 0.12));
  }

  private fanBase(): number {
    return (this.layout?.extent ?? EMPTY_EXTENT) + 8 + FAN_PITCH / 2;
  }

  private chipRadius(rows: number): number {
    const extent = this.layout?.extent ?? EMPTY_EXTENT;
    // clear of the top row of the fan, with a little air under the chip
    return rows ? this.fanBase() + (rows - 1) * FAN_PITCH + 30 : extent;
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
    const g = key ? this.groupOf(key) : undefined;
    const mid = g ? wedgeMid(g) : 0;
    const k = g ? Math.min(1.35, Math.max(1, 3.4 / Math.max(1e-3, g.endAngle - g.startAngle))) : 1;
    this.spreadK = k;
    const travel = this.reduced ? 0 : dur;
    if (g && this.wedge.key === key) this.anim(this.wedge.k, k, now, travel, easing.inOutCubic);
    const tree = this.web ? this.webTree(this.web.web) : undefined;
    const nudge = this.routeNudges();
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
      } else if (g) a = openedAngle(a, mid, (g.endAngle - g.startAngle) / 2, k, v.groupKey === key);
      if (nudge) a += nudge.get(v) ?? 0;
      const ta = nearestAngle(v.a.value(now), a);
      // reduced motion: dots are set in place, never travel
      if (Math.abs(ta - v.a.to) > 1e-6) this.anim(v.a, ta, now, travel, easing.inOutCubic, delay);
      if (Math.abs(r - v.r.to) > 1e-6) this.anim(v.r, r, now, travel, easing.inOutCubic, delay);
    }
  }

  /**
   * People on a route who sit side by side on the orbit step apart while the route shows, so the hop between them,
   * its arrow and both names can be seen. Angle nudges in layout units; none without a route.
   */
  private routeNudges(): Map<NodeView, number> | undefined {
    const r = this.reach;
    if (r?.status !== 'found' || r.ids.length < 3) return undefined;
    const vs: NodeView[] = [];
    for (let k = 1; k < r.ids.length; k++) {
      const v = this.byKey.get(r.ids[k]!);
      if (v && !v.temp && !v.removing && v.node && v.person && !vs.includes(v)) vs.push(v);
    }
    if (vs.length < 2) return undefined;
    const off = spreadApart(
      vs.map((v) => v.node!.angle),
      vs.map((v) => v.node!.radius),
      // a dot's size is its diameter
      vs.map((v) => (v.size.to / 2) * (ROUTE_SCALE + 0.08)),
      ROUTE_GAP / Math.max(0.3, this.fitTarget),
    );
    const out = new Map<NodeView, number>();
    vs.forEach((v, i) => {
      if (off[i]) out.set(v, off[i]!);
    });
    return out.size ? out : undefined;
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
    // each lineage sits round the middle of where its people already are, so nobody crosses the orbit to reach it
    const seat = new Map<string, number>();
    for (const r of roots) {
      const h = home(r);
      let sum = 0;
      let n = 0;
      for (const [id, root] of web.root)
        if (root === r && shown(id)) {
          sum += nearestAngle(h, home(id)) - h;
          n++;
        }
      const a = h + (n ? sum / n : 0);
      seat.set(r, ((a % TAU) + TAU) % TAU);
    }
    // lineages in their order round the orbit, pushed apart where their sectors would overlap
    const order = [...roots].sort((x, y) => seat.get(x)! - seat.get(y)!);
    const centre = order.map((id) => seat.get(id)!);
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
    const slots = fanSlots(ids.length, wedgeMid(g), this.fanBase(), FAN_PITCH, this.fanSpan(g), 3);
    const shown = ids.slice(0, slots.length);
    const fanned = new Set<string>();
    // the labels of the neighbouring wedges under the fan step aside while it is open
    if (shown.length) {
      const half = Math.max(...slots.slice(0, shown.length).map((x) => Math.abs(x.angle - wedgeMid(g))));
      this.fanArc = { mid: wedgeMid(g), half: half + 0.06 };
      this.anim(this.fanVeil, 1, now, 260, easing.outQuad, 120);
    }
    // a big fan opens a little faster per dot, so the whole burst lands with the turn
    const stagger = Math.min(22, 300 / Math.max(1, shown.length));
    shown.forEach(({ pid, from }, i) => {
      const key = `fan:${pid}`;
      const slot = slots[i]!;
      const old = this.byKey.get(key);
      if (old?.removing && !old.dead) {
        // the same company again while its fan was folding back: the dot turns round where it is, no restart
        this.revive(old, now);
        old.fromKey = from.key;
        this.anim(old.a, nearestAngle(old.a.value(now), slot.angle), now, 420, easing.outCubic);
        this.anim(old.r, slot.radius, now, 420, easing.outCubic);
        fanned.add(pid);
        return;
      }
      if (old) this.dropView(old);
      const v = new NodeView(key, pid);
      v.temp = true;
      v.fromKey = from.key;
      v.person = this.people.get(pid);
      v.groupKey = from.groupKey;
      v.ring = 2;
      v.hue = hueOf(pid);
      v.layer = 3;
      const delay = 180 + i * stagger;
      const fa = from.a.value(now);
      v.size.snap(Math.min(26, from.size.to));
      v.a.snap(fa);
      v.r.snap(from.r.value(now));
      this.play(v.a, fa, nearestAngle(fa, slot.angle), now, 520, easing.outCubic, delay);
      // a gentle overshoot: the rows land side by side without bumping into each other
      this.play(v.r, from.r.value(now), slot.radius, now, 520, outBack(0.7), delay);
      this.play(v.appear, 0, 1, now, 200, easing.outQuad, delay);
      this.views.push(v);
      this.byKey.set(key, v);
      fanned.add(pid);
    });
    for (const c of new Set(ids.map((x) => x.from))) {
      const left = c.cluster!.personIds.filter((pid) => !fanned.has(pid)).length;
      if (!this.reduced) c.popAt = now;
      if (left) c.label = `+${left}`;
      else this.anim(c.appear, 0, now, 360, easing.inQuad, 160);
    }
    this.sortDrawList();
    return new Set(slots.slice(0, shown.length).map((s) => s.radius)).size;
  }

  private collapseFans(now: number): void {
    this.anim(this.fanVeil, 0, now, 300, easing.inOutQuad, 120);
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
    // it closes with its dots as it fades
    this.wedgeOld.k.snap(this.wedge.k.value(now));
    this.anim(this.wedgeOld.k, 1, now, this.reduced ? 0 : 560, easing.inOutCubic);
    this.wedge.k.snap(1);
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
      this.reachTurned = undefined;
      this.retractPath(now);
      // people a route pulled apart go back to their places
      this.retarget(now, 450);
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
    // people on the route who sit side by side step apart (and step back when the route goes)
    this.retarget(now, 450);
    const target = this.viewFor(r.targetId);
    // the target turns to the top as the search starts; with reduced motion it waits for the answer, so the turn
    // and the camera framing the route are one set instead of two snaps a moment apart
    if (target && this.reachTurned !== r.targetId && (!this.reduced || status !== 'searching')) {
      this.reachTurned = r.targetId;
      this.hold(rotationToTop(target.a.to, this.rotTarget()), now);
    }
    // a radar that only just started keeps sweeping a moment longer, then hands over to the answer
    const wait =
      !this.reduced && prev?.status === 'searching' && !newTarget
        ? Math.max(0, this.radarStart + TIMING.radarMin - now)
        : 0;
    if (status === 'searching') {
      if (newTarget || prev?.status !== 'searching') this.radarStart = now;
      this.anim(this.radar, 1, now, 160, easing.outQuad);
      this.retractPath(now);
      this.setPhase('reach-search');
    } else {
      this.anim(this.radar, 0, now, 260, easing.inQuad, wait);
      if (status === 'none') {
        this.retractPath(now);
        if (target && !this.reduced) {
          target.shakeAt = now + wait + 120;
          this.busyUntil = Math.max(this.busyUntil, target.shakeAt + TIMING.shake);
        }
        this.setPhase('reach-none');
      } else if (ids.join('>') !== this.path.ids.join('>')) {
        // Another route to the same person morphs: the hops both routes share stay drawn, the rest of the old one
        // pulls back while the new one draws out at once, a little faster, so the map is never without a route.
        // A first route waits for the radar, then draws hop by hop; each dot pops as the line reaches it.
        const morph = !newTarget && this.path.ids.length > 1;
        let shared = 0;
        if (morph) while (shared < ids.length - 1 && this.path.ids[shared + 1] === ids[shared + 1]) shared++;
        const drawn = this.pathProgress(now);
        this.retractPath(now, Math.min(shared, drawn));
        const hop = morph ? TIMING.hopSwitch : TIMING.hop;
        const from = morph ? Math.min(shared, drawn) : 0;
        this.path = {
          ids,
          hop,
          start: this.reduced ? now : (morph ? now : now + Math.max(wait, 160)) - from * hop,
        };
        if (!this.reduced) {
          const route = new Set(ids.map((id) => this.viewFor(id)).filter((v): v is NodeView => !!v));
          for (let k = Math.ceil(from) + 1; k < ids.length; k++) {
            const v = this.viewFor(ids[k]!);
            if (!v) continue;
            v.popAt = this.hopAt(k) - 40;
            // the pop swells only as far as the neighbours leave room (two people on a route can sit side by side)
            const rest = this.roomFor(v, ROUTE_SCALE, route, 0.95);
            v.popH = Math.min(0.22, this.roomFor(v, ROUTE_SCALE * 1.22, route, 0.95) / rest - 1);
          }
        }
        if (!this.reduced) this.busyUntil = Math.max(this.busyUntil, this.hopAt(ids.length - 1) + 340);
        this.setPhase('reach-path');
      }
    }
    if (status === 'found') this.framePath(now);
    else this.frame0(now);
    this.refreshEmphasis(now, 'reach');
    this.anim(this.labelDim, this.dimForMode(), now, TIMING.emphasis, easing.outQuad);
  }

  /** Pulls the route on the map back to its first `keep` hops (the ones the next route shares), then lets it go. */
  private retractPath(now: number, keep = 0): void {
    if (!this.path.ids.length) return;
    const drawn = this.pathProgress(now);
    // a route picked a moment ago has barely started: the one still pulling back is the line the student sees
    const old = this.oldPathDrawn(now);
    if (drawn > keep && !this.reduced && drawn >= old) {
      this.pathOld = { ids: this.path.ids, start: now, from: drawn, to: keep };
      this.busyUntil = Math.max(this.busyUntil, now + TIMING.retract);
    }
    this.path = { ids: [], start: 0, hop: TIMING.hop };
  }

  /** Hops of the route being replaced still drawn, as it pulls back. */
  private oldPathDrawn(now: number): number {
    const o = this.pathOld;
    if (!o.ids.length) return 0;
    const k = clamp01((now - o.start) / TIMING.retract);
    return o.from - (o.from - o.to) * easing.inCubic(k);
  }

  /** When the line reaches the route's `k`th stop. */
  private hopAt(k: number): number {
    return this.path.start + k * this.path.hop;
  }

  /** Hops drawn so far (0..hops). */
  private pathProgress(now: number): number {
    const hops = this.path.ids.length - 1;
    if (hops <= 0) return 0;
    if (this.reduced) return now >= this.path.start ? hops : 0;
    return Math.max(0, Math.min(hops, (now - this.path.start) / this.path.hop));
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

  /** The camera that keeps the whole introductions tree in view, as large as it comfortably goes. */
  private frameWeb(now: number): void {
    const web = this.web?.web;
    const tree = web ? this.webTree(web) : undefined;
    if (!tree?.size) {
      this.anim(this.zoom, 1, now);
      this.anim(this.panX, 0, now);
      this.anim(this.panY, 0, now);
      return;
    }
    const rot = this.rotTarget();
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const [id, t] of tree) {
      const v = this.byKey.get(id);
      const a = t.a + rot;
      const r = (t.r + (v?.size.to ?? 20)) * this.fitTarget;
      minX = Math.min(minX, Math.cos(a) * r);
      maxX = Math.max(maxX, Math.cos(a) * r);
      minY = Math.min(minY, Math.sin(a) * r);
      maxY = Math.max(maxY, Math.sin(a) * r);
    }
    // room below each dot for its name
    const cam = frameBox(minX, minY - 6, maxX, maxY + 22, this.w, this.h, 48, 1.35);
    this.anim(this.zoom, cam.zoom, now);
    this.anim(this.panX, cam.panX, now);
    this.anim(this.panY, cam.panY, now);
  }

  private frame0(now: number): void {
    if (this.companyKey) return;
    if (this.web) {
      this.frameWeb(now);
      return;
    }
    this.anim(this.zoom, 1, now);
    this.anim(this.panX, 0, now);
    this.anim(this.panY, 0, now);
  }

  // ---------- rotation ----------

  /** Turn to `target` and hold there; remembers where the orbit was so clearing can turn back. */
  private hold(target: number, now: number): void {
    if (this.returnRot === null) this.returnRot = this.rot;
    // a long turn takes a little longer, so the outer ring stays easy to follow instead of smearing
    const deg = (Math.abs(target - this.rot) * 180) / Math.PI;
    this.rotSpring.configure({
      duration: Math.min(TIMING.turnMax, TIMING.turn + 2.2 * Math.max(0, deg - 60)),
    });
    this.startSpring(target, now);
  }

  /** Nothing is focused any more: turn back to where the orbit was, and let it drift again. */
  private releaseIfFree(now: number): void {
    const webTurn = !!this.web?.turnTo;
    if (this.companyKey || this.reach || webTurn || this.returnRot === null) return;
    const back = nearestAngle(this.rot, this.returnRot);
    this.returnRot = null;
    // the way back runs while the camera zooms out too: a long turn takes a little longer, so the outer ring
    // glides rather than strobes
    const deg = (Math.abs(back - this.rot) * 180) / Math.PI;
    this.rotSpring.configure({ duration: Math.min(TIMING.turnBackMax, TIMING.turn + 3 * deg) });
    this.startSpring(back, now);
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
      // the introductions tree holds still, so its people are easy to point at and their names easy to read
      !!this.web ||
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
    // a flick keeps turning for a moment; a slow, steady drag stops where the hand let go (only the speed past
    // FLICK_MIN carries on, so a drag that only just counts as a flick coasts only a little)
    const fast = Math.max(0, Math.abs(d.v) - FLICK_MIN);
    this.inertia = now - d.t < 80 && !this.reduced ? Math.sign(d.v) * Math.min(0.004, fast) : 0;
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
      // a finger gets a 44 px target; the nearest dot still wins where targets overlap
      const reach = Math.max(v.pr + 4, touch ? 22 : 8);
      const d = (x - v.x) ** 2 + (y - v.y) ** 2;
      if (d <= reach * reach && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best?.pid;
  }

  /**
   * How many dots a box (CSS px in the canvas) would hide: where the person card covers least. Given a point (the
   * person the card is about), a dot near it weighs up to three times as much as one across the map: the people
   * round someone are the ones the eye looks at next.
   */
  dotsIn(x0: number, y0: number, x1: number, y1: number, near?: { x: number; y: number }): number {
    let n = 0;
    for (const v of this.drawList) {
      if (!v.visible || v.pa < 0.3 || v.removing) continue;
      if (v.x + v.pr > x0 && v.x - v.pr < x1 && v.y + v.pr > y0 && v.y - v.pr < y1)
        n += near ? 1 + 5 * Math.max(0, 1 - Math.hypot(v.x - near.x, v.y - near.y) / NEAR_CARD) : 1;
    }
    return n;
  }

  /**
   * How much of a person's ties a box would hide: the dots their hover lines run to (on top of `dotsIn`, so they
   * weigh three times as much as anyone else) and the lines themselves, sampled. For placing the person card.
   */
  tiesIn(id: string, x0: number, y0: number, x1: number, y1: number): number {
    const v = this.byKey.get(id);
    const near = v?.person ? this.connections?.get(v.pid) : undefined;
    if (!v || !near?.length) return 0;
    let n = 0;
    for (const tid of near) {
      const t = this.viewFor(tid);
      if (!t?.visible || t === v) continue;
      if (t.x + t.pr > x0 && t.x - t.pr < x1 && t.y + t.pr > y0 && t.y - t.pr < y1) n += 2;
      for (let k = 1; k < 4; k++) {
        const px = v.x + ((t.x - v.x) * k) / 4;
        const py = v.y + ((t.y - v.y) * k) / 4;
        if (px > x0 && px < x1 && py > y0 && py < y1) n += 0.5;
      }
    }
    return n;
  }

  /** For keyboard focus: the next dot in an arrow's direction from the given one (or the first dot). */
  neighbour(fromId: string | undefined, dx: number, dy: number): string | undefined {
    // the arrows walk the people the view is about: a dot the view has faded back is skipped
    const shown = this.drawList.filter((v) => v.visible && v.pa >= 0.1 && !v.removing);
    const lit = shown.filter((v) => v.alpha.to >= 0.3 || v.pid === fromId);
    const list = lit.some((v) => v.pid !== fromId) ? lit : shown;
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

  /** Where "You" is now (CSS px): the centre of the orbit and its radius. */
  youAt(): { x: number; y: number; r: number } {
    return { x: this.you.x, y: this.you.y, r: 26 * Math.max(0.6, this.fit) * this.zoom.x };
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
    if (this.web) {
      this.webChain = this.chainFor(this.web);
      this.frameWeb(now);
    }
    this.refreshEmphasis(now, 'layout');
  }

  /** Recomputes every dot's alpha, scale and glow from the current filter, focus and view. */
  private refreshEmphasis(now: number, cause: 'filter' | 'focus' | 'reach' | 'web' | 'layout'): void {
    const dur = cause === 'filter' ? TIMING.filter : TIMING.emphasis;
    const company = this.companyKey;
    const reach = this.reach;
    const web = this.web;
    const popping: NodeView[] = [];
    const popTo = new Map<NodeView, number>();
    let members: Set<NodeView> | undefined;
    const route =
      reach?.status === 'found' && !web
        ? new Set(reach.ids.map((id) => this.viewFor(id)).filter((v): v is NodeView => !!v))
        : undefined;
    // in the introductions view the web's people sit on their generation's ring, where someone faded back may be
    // under them: that faded dot steps out of sight instead of peeping out from behind as a double dot
    const inWeb = web
      ? this.views.filter(
          (v) =>
            !v.temp &&
            !v.removing &&
            (v.person
              ? web.web.members.has(v.pid)
              : !!v.cluster?.personIds.some((id) => web.web.members.has(id))),
        )
      : [];
    const underWeb = (v: NodeView) =>
      inWeb.some((m) => {
        const d = Math.sqrt(v.r.to ** 2 + m.r.to ** 2 - 2 * v.r.to * m.r.to * Math.cos(v.a.to - m.a.to));
        return d < (v.size.to * 0.85 + m.size.to * 1.12) / 2 + 4;
      });
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
        if (!member && underWeb(v)) {
          alpha = 0;
          scale = 0.85;
        } else if (this.webChain.size) {
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
          // the route grows, but never into a neighbour (two people on it can sit side by side in a ring)
          scale = k >= 0 && route ? this.roomFor(v, ROUTE_SCALE, route, 0.95) : 0.95;
          glow = k >= 0 ? 0.55 : 0;
          // each dot on the route lights up as the line reaches it
          if (k > 0) delay = Math.max(0, this.hopAt(k) - 60 - now);
        }
      } else if (company) {
        if (v.groupKey === company) {
          // the wedge opens up so its people can grow without touching (less where rings are packed in tracks),
          // and each grows only as far as its neighbours, in the wedge or beside it, leave room
          members ??= new Set(this.views.filter((u) => !u.temp && u.person && u.groupKey === company));
          scale = v.person ? this.roomFor(v, this.ringMulti[v.ring] ? 1.12 : 1.35, members, 0.92) : 1;
          glow = v.person ? 1 : 0;
          if (v.person && v.scale.to !== scale) popping.push(v);
          if (v.person) popTo.set(v, scale);
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
    // the company's people pop one after another, clockwise from the top of the wedge; a big company's pops are
    // packed closer together, so the last one lands with the turn rather than trickling in seconds later
    const rot = this.rotTarget();
    popping.sort((a, b) => fromTop(a.a.to + rot) - fromTop(b.a.to + rot));
    const stagger = Math.min(TIMING.popStagger, TIMING.popSpread / Math.max(1, popping.length));
    popping.forEach((v, i) => {
      const to = popTo.get(v) ?? 1;
      const want = this.ringMulti[v.ring] ? 1.12 : 1.35;
      // the overshoot only where there is room for it
      const ease = to >= want - 1e-3 ? easing.outBack : easing.outCubic;
      this.play(v.scale, v.scale.value(now), to, now, 380, ease, 220 + i * stagger);
    });
    this.sortDrawList();
  }

  /**
   * The largest scale up to `want` at which a dot still clears its neighbours (at their own emphasis: `want` for
   * the others in `group`, `rest` for everyone else), never below 1.
   */
  private roomFor(v: NodeView, want: number, group: Set<NodeView>, rest: number): number {
    let s = want;
    const a = v.a.to;
    const r = v.r.to;
    for (const u of this.views) {
      if (u === v || u.temp || u.removing || !u.node) continue;
      const d = Math.sqrt(r * r + u.r.to * u.r.to - 2 * r * u.r.to * Math.cos(a - u.a.to));
      if (d > (v.size.to + u.size.to) * want) continue;
      const room = d - 2;
      s = Math.min(
        s,
        group.has(u) ? (2 * room) / (v.size.to + u.size.to) : (2 * room - u.size.to * rest) / v.size.to,
      );
    }
    return Math.max(1, s);
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
    if (this.animating) this.recorder?.resume(performance.now());
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
    let dt = this.lastNow < 0 ? 16 : Math.min(100, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    if (this.napping && dt > 17) {
      // woken from a nap between two slow drift draws: only the drift went on meanwhile, so it alone catches up,
      // and anything that started since (a turn, a camera move) takes one ordinary frame's step, never a leap
      const drift = this.spin.value(now) * (dt - 17);
      if (this.rotSpringOn) {
        this.rotSpring.x += drift;
        this.rotSpring.target += drift;
      } else if (!this.drag?.moved) this.rot += drift;
      dt = 17;
    }
    this.napping = false;
    this.advance(now, dt);
    const transition = this.inTransition(now);
    const full = transition || this.fullRate(now);
    // the slow drift moves a few pixels a second, so 15 frames a second show it smoothly; a ripple needs 30
    const rippling = this.rippling(now);
    const half = this.spin.value(now) > 0 || !this.spin.done(now) || rippling;
    const every = rippling || !this.spin.done(now) ? 33 : 66;
    if (this.dirty || full || (half && now - this.lastDraw >= every)) {
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
    if (full || this.dirty) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    if (half) {
      // the drift and the ripples draw at a lower rate: wait for the next draw on a timer rather than waking on
      // every display frame, then ask for the frame just before it is due
      const wait = every - (now - this.lastDraw);
      if (wait > 20) {
        this.napping = true;
        this.timer = setTimeout(this.wake, wait - 12);
      } else this.raf = requestAnimationFrame(this.frame);
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
      // the radar sweeps while routes are found (reduced motion shows a still ring instead)
      (this.reach?.status === 'searching' && !this.reduced)
    );
  }

  /** Effects that loop while shown: the route's comet and the lit chain's travelling light. */
  private fullRate(now: number): boolean {
    if (this.path.ids.length > 1 && this.cometT(now) >= 0) return true;
    return this.chainLightT(now) >= 0;
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
    if (this.web && this.webPath.length && !this.reduced) {
      const period = TIMING.webLight + TIMING.webLightRest;
      const k = Math.max(0, Math.ceil((now - this.webLightStart) / period));
      next = Math.min(next, this.webLightStart + k * period);
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

  /** The lit chain's travelling light, 0..1 along its trip, or -1 while it rests between trips. */
  private chainLightT(now: number): number {
    if (this.reduced || !this.web || !this.webPath.length) return -1;
    const t = (now - this.webLightStart) % (TIMING.webLight + TIMING.webLightRest);
    return t < TIMING.webLight ? t / TIMING.webLight : -1;
  }

  private cometBegin(): number {
    return this.hopAt(this.path.ids.length - 1) + 300;
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
      // how far the outer ring moves for one radian, in CSS px: the turn is over once nothing moves a visible amount
      const R = Math.max(1, (this.layout?.ringRadii[2] ?? 440) * this.fit * this.zoom.x);
      if (spin === 0 && this.spin.done(now) && off * R < 0.5 && Math.abs(this.rotSpring.v) * R < 0.008) {
        // holding still on a focus: land exactly on it (less than half a pixel away, and all but still)
        this.rot = this.rotSpring.target;
        this.rotSpringOn = false;
      } else if (spin > 0 && off < 1e-2 && Math.abs(this.rotSpring.v - spin) < 1e-5) {
        // turning back into the slow drift: hand over at the same angle and speed, no snap (a slower spring trails
        // its drifting target by a little more, which is why the distance allowed is not tiny)
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
      this.pathOld = { ids: [], start: 0, from: 0, to: 0 };
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
      this.drawHoverEnds(ctx, now);
      if (this.prebuildAt >= 0) this.prebuild(now);
      this.drawComet(ctx, now);
    }
    this.drawYou(ctx, now, ox, oy);
    if (!this.loading) {
      this.drawNameTags(ctx, now);
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
      (1 + bump(now - v.popAt, 340, this.reduced ? 0 : v.popH)) *
      (1 + v.spotScale * spotOf(v, now)) *
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
    const breathing = this.reduced ? 0 : this.loading ? 1 : this.youHalo.value(now);
    const phase = ((now - this.loadingSince) / 2400) * TAU;
    ctx.lineWidth = 1;
    ctx.strokeStyle = RING;
    if (ghost > 0.01) {
      // while the network loads, the empty rings breathe
      for (let i = 0; i < 3; i++) {
        const wave = breathing * Math.sin(phase - i * 0.9);
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
    // the Target companies tint steps back while one company is focused, so its wedge stands alone
    const ga = this.groupsAlpha.value(now) * (1 - this.wedge.alpha.value(now));
    if (ga > 0.005 && this.shownGroups)
      for (const g of groups)
        if (this.shownGroups.has(g.key)) this.sector(ctx, g, ga, 0.045, ox, oy, inner, outer, rot);
    for (let i = 0; i < 2; i++) {
      const wd = i ? this.wedge : this.wedgeOld;
      if (!wd.key) continue;
      const alpha = wd.alpha.value(now);
      if (alpha <= 0.005) continue;
      const g = this.groupOf(wd.key);
      if (g) this.sector(ctx, g, alpha, 0.075, ox, oy, inner, outer, rot, wd.k.value(now));
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
    const half = ((g.endAngle - g.startAngle) / 2) * k + 0.035 * clamp01((k - 1) / 0.08);
    const a0 = mid - half + rot;
    const a1 = mid + half + rot;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(ox, oy, outer, a0, a1);
    ctx.arc(ox, oy, inner, a1, a0, true);
    ctx.closePath();
    const style = WEDGE_STYLE.get(fill) ?? [
      `rgba(${ACCENT_RGB},${fill})`,
      `rgba(${ACCENT_RGB},${fill * 2.4})`,
    ];
    ctx.fillStyle = style[0];
    ctx.fill();
    ctx.strokeStyle = style[1];
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawRadar(ctx: CanvasRenderingContext2D, now: number, ox: number, oy: number, S: number) {
    const alpha = this.radar.value(now);
    if (alpha <= 0.005 || !this.layout) return;
    if (this.reduced) {
      // reduced motion: no sweep, no pulse, just a still ring round the person Orbit is looking for
      const t = this.reach ? this.viewFor(this.reach.targetId) : undefined;
      if (t?.visible) {
        ctx.globalAlpha = alpha * 0.6;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(t.x, t.y, t.pr + 9, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      return;
    }
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

  /** A thin accent ring round each person the hover lines reach, so it reads who they run to, not just where. */
  private drawHoverEnds(ctx: CanvasRenderingContext2D, now: number): void {
    const p = this.hoverLines.value(now);
    if (p <= 0.01 || !this.hoverKey || this.web || (this.reach && this.reach.status !== 'searching')) return;
    const v = this.byKey.get(this.hoverKey);
    const near = v?.person ? this.connections?.get(v.pid) : undefined;
    if (!v?.visible || !near?.length) return;
    // each ring shows as its line arrives
    const shown = clamp01((easing.outCubic(p) - 0.7) / 0.3);
    if (shown <= 0) return;
    ctx.globalAlpha = 0.85 * shown;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const id of near) {
      const t = this.viewFor(id);
      if (!t?.visible || t === v || t.pa < 0.1) continue;
      const r = t.pr + 2.5;
      ctx.moveTo(t.x + r, t.y);
      ctx.arc(t.x, t.y, r, 0, TAU);
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
        undefined,
      );
    }
    for (const l of web.links) {
      const from = this.viewFor(l.fromId);
      const to = this.viewFor(l.toId);
      if (!from?.visible || !to || from === to) continue;
      const onChain = this.webChain.has(l.fromId) && this.webChain.has(l.toId);
      const gen = web.generation.get(l.toId) ?? 2;
      this.webLink(
        ctx,
        from,
        to,
        gen,
        this.lineageOf.get(l.toId) ?? ACCENT,
        false,
        onChain,
        lit,
        t,
        retract,
        l,
      );
    }
    if (this.web && this.webPath.length) this.drawChainLight(ctx, now);
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
    link: object | undefined,
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
      ctx.setLineDash(DASH);
    } else {
      // fades in from the introducer to the person introduced, so the direction reads at a glance; the gradient
      // is kept while the two dots hold still (a lit chain holds the orbit still), not rebuilt every frame
      const cached = link ? this.gradients.get(link) : undefined;
      if (
        cached &&
        cached.color === color &&
        Math.abs(cached.x0 - from.x) +
          Math.abs(cached.y0 - from.y) +
          Math.abs(cached.x1 - to.x) +
          Math.abs(cached.y1 - to.y) <
          0.5
      )
        ctx.strokeStyle = cached.g;
      else {
        const g = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
        g.addColorStop(0, `${color}26`);
        g.addColorStop(1, color);
        ctx.strokeStyle = g;
        if (link) this.gradients.set(link, { x0: from.x, y0: from.y, x1: to.x, y1: to.y, color, g });
      }
    }
    ctx.beginPath();
    quadPartial(ctx, from.x, from.y, A.x, A.y, to.x, to.y, p);
    ctx.stroke();
    if (own) ctx.setLineDash(SOLID);
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
    const k = this.chainLightT(now);
    if (k < 0) return;
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

  /**
   * The route's points and the control point of each hop's curve this frame: hops bow round You rather than through
   * it, and a hop that doubles back bows to the other side (see routeControls). False when a point is off the map.
   */
  private routeCurve(ids: string[]): boolean {
    const pts = this.routePts;
    pts.length = 0;
    for (const id of ids) {
      const p = this.pathPoint(id);
      if (!p) return false;
      pts.push(p);
    }
    const youR = 26 * Math.max(0.6, this.fit) * this.zoom.x;
    routeControls(pts, this.you.x, this.you.y, youR + 22, this.routeCs);
    return true;
  }

  private drawHops(ctx: CanvasRenderingContext2D, ids: string[], upto: number, alpha: number): void {
    if (upto <= 0 || alpha <= 0 || !this.routeCurve(ids)) return;
    const pts = this.routePts;
    const cs = this.routeCs;
    const B = this.scratchB;
    ctx.lineCap = 'round';
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = ACCENT;
    for (let k = 0; k < pts.length - 1; k++) {
      const p = clamp01(upto - k);
      if (p <= 0) break;
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const A = cs[k]!;
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
      // a small arrowhead halfway along says which way the hop goes, once the line has passed it
      if (e < 0.62) continue;
      quadPoint(B, a.x, a.y, A.x, A.y, b.x, b.y, 0.55);
      // the curve's direction at that point
      const tx = 0.9 * (A.x - a.x) + 1.1 * (b.x - A.x);
      const ty = 0.9 * (A.y - a.y) + 1.1 * (b.y - A.y);
      const tl = Math.hypot(tx, ty);
      if (tl < 1) continue;
      const ux = tx / tl;
      const uy = ty / tl;
      ctx.globalAlpha = alpha * clamp01((e - 0.62) / 0.2);
      ctx.beginPath();
      ctx.moveTo(B.x + ux * 5, B.y + uy * 5);
      ctx.lineTo(B.x - ux * 4 - uy * 4.5, B.y - uy * 4 + ux * 4.5);
      ctx.lineTo(B.x - ux * 4 + uy * 4.5, B.y - uy * 4 - ux * 4.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  private drawPath(ctx: CanvasRenderingContext2D, now: number): void {
    // a route being replaced retracts toward You while the new one draws out
    if (this.pathOld.ids.length) {
      const k = clamp01((now - this.pathOld.start) / TIMING.retract);
      this.drawHops(ctx, this.pathOld.ids, this.oldPathDrawn(now), 1 - k * 0.3);
    }
    if (this.path.ids.length > 1) this.drawHops(ctx, this.path.ids, this.pathProgress(now), 1);
    ctx.globalAlpha = 1;
  }

  /** A small comet travels the route (You, then each connector, then the target) to show its direction. */
  private drawComet(ctx: CanvasRenderingContext2D, now: number): void {
    const k = this.cometT(now);
    const ids = this.path.ids;
    if (k < 0 || ids.length < 2) return;
    if (!this.routeCurve(ids)) return;
    const pts = this.routePts;
    const cs = this.routeCs;
    const hops = ids.length - 1;
    const head = easing.inOutSine(k) * hops;
    const B = this.scratchB;
    const out = k > 0.85 ? (1 - k) / 0.15 : 1;
    for (let j = 9; j >= 0; j--) {
      const u = head - j * 0.035 * hops;
      if (u < 0) continue;
      const i = Math.min(hops - 1, Math.floor(u));
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const A = cs[i]!;
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
      const spot = spotOf(v, now);
      if (spot > 0.01) {
        ctx.fillStyle = ACCENT;
        ctx.globalAlpha = pa * spot * 0.16;
        ctx.beginPath();
        ctx.arc(x, y, pr + 7, 0, TAU);
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
      this.drawSprite(ctx, v, now);
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
      // one ring burst when a chat is booked or has happened: a bold ring in the stage colour, and a second,
      // thinner one just behind it, so it reads even in a crowded inner ring
      const b = now - v.burstAt;
      if (b >= 0 && b < TIMING.burst) {
        ctx.strokeStyle = v.burstColor;
        for (let w = 0; w < 2; w++) {
          const k = clamp01((b - w * 160) / (TIMING.burst - 160));
          if (k <= 0 || k >= 1) continue;
          ctx.globalAlpha = pa * (w ? 0.45 : 0.8) * (1 - k);
          ctx.lineWidth = (w ? 2 : 5) * (1 - k) + 0.5;
          ctx.beginPath();
          ctx.arc(x, y, pr + 3 + easing.outCubic(k) * (w ? 34 : 26), 0, TAU);
          ctx.stroke();
        }
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

  private drawSprite(ctx: CanvasRenderingContext2D, v: NodeView, now: number): void {
    const d = v.pr * 2;
    if (d < 0.5) return;
    const want = Math.max(d, this.spriteSize(v, now));
    const label = v.cluster ? v.label : '';
    const photo = v.person?.photoUrl ? this.imageFor(v.person) : undefined;
    if (!this.spriteFresh(v, want, label, photo)) {
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

  /** The size a dot's sprite is built at: the size it is heading for, so a pop or a lift does not rebuild it. */
  private spriteSize(v: NodeView, now: number): number {
    return (
      v.size.to *
      this.fitTarget *
      this.zoom.target *
      v.scale.to *
      (1 + 0.25 * v.lift.to) *
      (now < v.spotEnd ? 1 + v.spotScale : 1)
    );
  }

  private spriteFresh(
    v: NodeView,
    want: number,
    label: string,
    photo: HTMLImageElement | undefined,
  ): boolean {
    return (
      !!v.sprite &&
      v.spriteDpr === this.dpr &&
      v.spriteLabel === label &&
      want <= v.spriteD * 1.04 &&
      want >= v.spriteD * 0.55 &&
      v.spriteImg === !!(photo?.complete && photo.naturalWidth)
    );
  }

  /**
   * Builds the sprites of dots that are not on screen yet (people about to arrive) with whatever is left of this
   * frame's sprite budget, so the frames where they fly in only draw them.
   */
  private prebuild(now: number): void {
    const views = this.views;
    while (this.prebuildAt < views.length) {
      if (performance.now() >= this.spriteDeadline) return;
      const v = views[this.prebuildAt++]!;
      if (v.dead || v.visible || v.sprite || v.temp) continue;
      const want = Math.ceil(this.spriteSize(v, now));
      if (want < 1) continue;
      const photo = v.person?.photoUrl ? this.imageFor(v.person) : undefined;
      this.buildSprite(v, want, v.cluster ? v.label : '', photo);
    }
    this.prebuildAt = -1;
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
    let k = 1 + bump(now - this.youBumpAt, 420, this.reduced ? 0 : 0.1);
    // while loading "You" pulses with a halo; both fade out when the people arrive rather than stopping dead
    const halo = this.reduced ? 0 : this.loading ? 1 : this.youHalo.value(now);
    if (halo > 0.001) k *= 1 + 0.06 * halo * Math.sin(((now - this.loadingSince) / 1200) * TAU);
    const R = 26 * Math.max(0.6, this.fit) * this.zoom.x * k;
    if (halo > 0.001) {
      const p = ((now - this.loadingSince) % 1800) / 1800;
      ctx.globalAlpha = 0.35 * (1 - p) * halo;
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
    const veil = this.fanVeil.value(now);
    let clipped = 0;
    // where the count chips are (alpha, x, y, width, height), measured in the chip's own font
    const chips: number[] = [];
    if (chipA > 0.01 || chipOldA > 0.01) {
      ctx.font = '500 12px Inter, sans-serif';
      for (const [chip, ca] of [
        [this.chip, chipA],
        [this.chipOld, chipOldA],
      ] as const)
        if (ca > 0.01 && this.chipBox(chip, ca, ox, oy, S, rot)) chips.push(ca, ...this.chipXY);
      ctx.font = `500 ${fontPx}px Inter, sans-serif`;
    }
    // while a company's wedge is open, the other labels close up with their dots
    const wd = this.wedge.key ? this.wedge : this.wedgeOld.key ? this.wedgeOld : undefined;
    const open = wd ? this.groupOf(wd.key) : undefined;
    const openK = wd ? wd.k.value(now) : 1;
    for (const l of this.labels) {
      const mid =
        open && openK !== 1 && l.key !== open.key
          ? openedAngle(l.mid, wedgeMid(open), (open.endAngle - open.startAngle) / 2, openK, false)
          : l.mid;
      const a = mid + rot;
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
      // a neighbour's label under an open fan steps aside, so the fan reads cleanly
      if (veil > 0.001 && l.key !== this.companyKey) {
        const off = Math.abs(nearestAngle(this.fanArc.mid, mid) - this.fanArc.mid);
        if (off < this.fanArc.half + half / labelR) alpha *= 1 - veil;
      }
      // any label under the count chip steps aside for it
      for (let i = 0; i < chips.length; i += 5) {
        const [ca, cx, cy, cw, ch] = [chips[i]!, chips[i + 1]!, chips[i + 2]!, chips[i + 3]!, chips[i + 4]!];
        if (
          x - half < cx + cw / 2 + 6 &&
          x + half > cx - cw / 2 - 6 &&
          Math.abs(y - cy) < ch / 2 + fontPx / 2 + 4
        )
          alpha *= 1 - ca;
      }
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.fillText(l.text, x, y);
    }
    ctx.globalAlpha = 1;
    this.labelsClipped = clipped;
  }

  /**
   * First names under the dots a story is about: the people on a route, and the people in the introductions web
   * (all of them in a small web, the lit chain in a big one), so the words in the panel can be matched to dots
   * without hovering each one. A name that would cover another is tried above its dot, else left out.
   */
  private drawNameTags(ctx: CanvasRenderingContext2D, now: number): void {
    const tags = this.tags;
    tags.length = 0;
    const list = this.tagList;
    list.length = 0;
    const reach = this.reach;
    if (reach) {
      const t = this.viewFor(reach.targetId);
      if (t && !t.cluster) list.push(t, 1);
      if (reach.status === 'found')
        for (let k = 1; k < this.path.ids.length - 1; k++) {
          const v = this.viewFor(this.path.ids[k]!);
          const shown = this.reduced ? 1 : clamp01((now - (this.hopAt(k) - 60)) / 200);
          if (v && !v.cluster && shown > 0) list.push(v, shown);
        }
    }
    const web = this.web;
    const webOn = this.webAlpha.value(now);
    if (web && webOn > 0.01) {
      const lit = this.webChain.size > 0;
      const all = web.web.members.size <= TAG_WEB_ALL;
      for (const id of web.web.members) {
        const onChain = this.webChain.has(id);
        if (!onChain && !all) continue;
        const v = this.viewFor(id);
        if (!v || v.cluster) continue;
        const gen = web.web.generation.get(id) ?? 1;
        const grow = this.reduced
          ? 1
          : clamp01((now - this.webStart - (gen - 1) * TIMING.webGen - TIMING.webLink * 0.5) / 250);
        const k = webOn * grow * (lit && !onChain ? 0.3 : 1);
        if (k > 0.01) list.push(v, k);
      }
    }
    // whoever is in the spotlight is named under their dot while it lasts, so the change reads in words where it
    // happens (a few at a time: a big import is said in the line under the filters instead)
    const named = this.named;
    for (let i = named.length - 1; i >= 0; i--)
      if (named[i]!.spotEnd <= now || named[i]!.dead) named.splice(i, 1);
    if (named.length && named.length <= 4)
      for (const v of named) {
        if (v.cluster || now < v.spotStart || list.includes(v)) continue;
        // gone a beat before the spotlight ends, so the last frame the loop draws never leaves it behind
        const k = clamp01((now - v.spotStart) / 200) * clamp01((v.spotEnd - 120 - now) / 300);
        if (k > 0.01) list.push(v, k);
      }
    if (!list.length) return;
    const fontPx = 11;
    ctx.font = `500 ${fontPx}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const boxes = this.tagBoxes;
    boxes.length = 0;
    const hh = 8;
    const free = (x: number, y: number, hw: number) => {
      if (y - hh < 0 || y + hh > this.h || x - hw < 0 || x + hw > this.w) return false;
      for (let i = 0; i < boxes.length; i += 4)
        if (x - hw < boxes[i + 2]! && x + hw > boxes[i]! && y - hh < boxes[i + 3]! && y + hh > boxes[i + 1]!)
          return false;
      return true;
    };
    for (let i = 0; i < list.length; i += 2) {
      const v = list[i] as NodeView;
      const k = (list[i + 1] as number) * v.pa;
      if (!v.visible || k <= 0.01 || !v.person) continue;
      // the hovered dot already shows its full name above it
      if (v.key === this.tipKey && this.tip.value(now) > 0.5 && !this.cardShown()) continue;
      const text = this.tagText(v.person);
      const hw = this.measure(text, fontPx, false) / 2 + 5;
      let y = v.y + v.pr + 5 + hh;
      if (!free(v.x, y, hw)) {
        y = v.y - v.pr - 5 - hh;
        if (!free(v.x, y, hw)) continue;
      }
      boxes.push(v.x - hw, y - hh, v.x + hw, y + hh);
      ctx.globalAlpha = 0.92 * k;
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, v.x - hw, y - hh, hw * 2, hh * 2, hh);
      ctx.fill();
      ctx.globalAlpha = k;
      ctx.fillStyle = INK;
      ctx.fillText(text, v.x, y + 0.5);
      tags.push(text);
    }
    ctx.globalAlpha = 1;
  }

  /** A first name, with the last initial when someone else on the map shares it. */
  private tagText(p: Person): string {
    let text = this.tagNames.get(p.id);
    if (text === undefined) {
      let twins = 0;
      for (const q of this.people.values()) if (q.firstName === p.firstName) twins++;
      const first = p.firstName || p.displayName;
      text = twins > 1 && p.lastName ? `${first} ${p.lastName[0]}.` : first;
      this.tagNames.set(p.id, text);
    }
    return text;
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
    for (let i = 0; i < 2; i++) {
      const chip = i ? this.chip : this.chipOld;
      const alpha = chip.alpha.value(now);
      if (alpha <= 0.01 || !chip.text) continue;
      ctx.font = '500 12px Inter, sans-serif';
      if (!this.chipBox(chip, alpha, ox, oy, S, rot)) continue;
      const [x, y, bw, bh] = this.chipXY;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = CHIP_EDGE;
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

  /** Where a count chip sits (centre x, y, width, height in chipXY); false when its company is gone. */
  private chipBox(
    chip: { text: string; key: string; radius: number },
    alpha: number,
    ox: number,
    oy: number,
    S: number,
    rot: number,
  ): boolean {
    const g = this.groupOf(chip.key);
    if (!g || !chip.text) return false;
    const a = wedgeMid(g) + rot;
    const bw = this.measure(chip.text, 12, false) + 22;
    const bh = 24;
    const r = chip.radius * S + LABEL_GAP + bh / 2 + (1 - alpha) * 10;
    const x = ox + Math.cos(a) * (r + Math.abs(Math.cos(a)) * (bw / 2 - bh / 2));
    const y = oy + Math.sin(a) * r;
    const out = this.chipXY;
    out[0] = Math.min(Math.max(x, bw / 2 + 4), this.w - bw / 2 - 4);
    out[1] = Math.min(Math.max(y, bh / 2 + 4), this.h - bh / 2 - 4);
    out[2] = bw;
    out[3] = bh;
    return true;
  }

  /** The page's person card sits next to the dot (wide maps); on a narrow map it sits at the edge, so the name stays. */
  private cardShown(): boolean {
    return this.personCard && this.w >= 640;
  }

  /** The name label above the hovered (or keyboard-focused) dot, which fades and slides in. */
  private drawTip(ctx: CanvasRenderingContext2D, now: number): void {
    const alpha = this.tip.value(now);
    if (alpha <= 0.01 || !this.tipKey) return;
    const v = this.byKey.get(this.tipKey);
    if (!v?.visible || (v.person && this.cardShown())) return;
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
      pathOldDrawn:
        this.pathOld.ids.length && now - this.pathOld.start < TIMING.retract ? this.oldPathDrawn(now) : 0,
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
      tags: [...this.tags],
      pending: this.views.filter((v) => v.pending).map((v) => v.pid),
      draws: this.draws,
    };
  }

  /** A dot's own slot in the layout (angle before rotation, radius), for tests. */
  slotOf(id: string): { angle: number; radius: number } | undefined {
    const n = this.byKey.get(id)?.node;
    return n ? { angle: n.angle, radius: n.radius } : undefined;
  }

  /** The colour a dot's stage ring shows now ('rgb(r,g,b)'), mid crossfade included; undefined with no stage. */
  stageColorOf(id: string): string | undefined {
    const v = this.byKey.get(id);
    const c = v ? this.stageColorNow(v, this.clock.now()) : null;
    return c ? mixRgb(c, c, 1) : undefined;
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
