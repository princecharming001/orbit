import { strengthTier } from '../scoring/strength';
import { hueFromId, normalizeCompany } from '../text/normalize';
import type { Organization, Person } from '../types';

export interface OrbitCluster {
  /** how many people the dot stands for */
  count: number;
  personIds: string[];
  /** company name, or "Other companies" for the merged long tail */
  label: string;
}

export interface OrbitNode {
  id: string;
  /** set for a person dot */
  person?: Person;
  /** set for an aggregate dot ("+14 at Google") */
  cluster?: OrbitCluster;
  ring: 0 | 1 | 2;
  angle: number; // radians, before rotation
  radius: number;
  size: number; // diameter
  groupKey: string;
}

export interface OrbitGroup {
  key: string;
  label: string;
  orgId?: string;
  startAngle: number;
  endAngle: number;
  /** people in this company across all rings */
  count: number;
  logoUrl?: string;
}

export interface OrbitLayout {
  nodes: OrbitNode[];
  groups: OrbitGroup[];
  ringRadii: [number, number, number];
  /** distance from the centre to the outer edge of the farthest dot */
  extent: number;
  /** people shown inside aggregate dots rather than individually */
  aggregated: number;
}

const RING_RADII: [number, number, number] = [160, 300, 440];
/** radial band each ring may use for extra tracks; bands never overlap, so rings never collide */
const BANDS: [number, number][] = [
  [60, 232],
  [232, 372],
  [372, 520],
];
const NODE_SIZE: [number, number, number] = [48, 40, 32];
const GAP = 4;
/** node size factors tried before aggregating, largest first; strong ties may shrink further than the rest */
const SIZE_STEPS: number[][] = [
  [1, 0.85, 0.75, 0.65, 0.55],
  [1, 0.85, 0.75],
  [1, 0.85, 0.75],
];
/** steps of SIZE_STEPS the inner ring takes before it opens a second track */
const INNER_SHRINK_FIRST = 2;
/** leave slack so wedge rounding never forces overlaps */
const FILL = 0.85;
export const OTHER_GROUP_KEY = 'other';
/** smallest aggregate dot worth drawing; smaller leftovers go to "Other companies" */
const MIN_CLUSTER = 3;

function hashJitter(id: string, salt: string): number {
  let h = 0;
  const s = id + salt;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 - 0.5; // -0.5..0.5
}

interface RingGeometry {
  size: number;
  pitch: number;
  tracks: number[]; // radii, main track first
  capacity: number;
}

function ringGeometry(ring: 0 | 1 | 2, factor: number): RingGeometry {
  const size = NODE_SIZE[ring] * factor;
  const pitch = size + GAP;
  const [lo, hi] = BANDS[ring]!;
  const r0 = RING_RADII[ring];
  const tracks = [r0];
  for (let k = 1; k < 6; k++) {
    for (const r of [r0 - k * pitch, r0 + k * pitch])
      if (r - size / 2 >= lo && r + size / 2 <= hi) tracks.push(r);
  }
  const capacity = tracks.reduce((s, r) => s + Math.floor((2 * Math.PI * r) / pitch), 0);
  return { size, pitch, tracks, capacity };
}

interface Group {
  key: string;
  label: string;
  orgId?: string;
  logoUrl?: string;
  members: Person[];
  strength: number;
}

/** Group key: the organization's normalized name, else the normalized raw name, so spellings share a wedge. */
export function orbitGroupKey(p: Person, orgs: Map<string, Organization>): string {
  const org = p.currentOrganizationId ? orgs.get(p.currentOrganizationId) : undefined;
  const norm = org?.nameNormalized || normalizeCompany(p.currentOrganizationRaw);
  return norm ? `n:${norm}` : 'independent';
}

type Slot = { person?: Person; cluster?: OrbitCluster };

interface RingPack {
  /** what each company shows on this ring, strongest first, its "+N" dot last */
  slots: Map<string, Slot[]>;
  /** the merged long tail ("Other companies"), empty or one dot */
  other: Slot[];
  aggregated: number;
}

/**
 * One ring's dots: each company shows its members, or, when capped at q dots, its q - 1 strongest and one
 * "+N" dot for the rest; merged companies go into a single "Other companies" dot.
 */
function packRing(
  present: Group[],
  members: (g: Group) => Person[],
  caps: Map<string, number>,
  merged: Set<string>,
): RingPack {
  const slots = new Map<string, Slot[]>();
  let aggregated = 0;
  const tail: Person[] = [];
  for (const g of present) {
    const m = members(g);
    if (merged.has(g.key)) {
      tail.push(...m);
      continue;
    }
    const q = caps.get(g.key) ?? m.length;
    if (m.length <= q) {
      slots.set(
        g.key,
        m.map((person) => ({ person })),
      );
      continue;
    }
    const rest = m.slice(q - 1);
    aggregated += rest.length;
    slots.set(g.key, [
      ...m.slice(0, q - 1).map((person) => ({ person })),
      { cluster: { count: rest.length, personIds: rest.map((p) => p.id), label: g.label } },
    ]);
  }
  const other: Slot[] = [];
  if (tail.length) {
    aggregated += tail.length;
    other.push({
      cluster: { count: tail.length, personIds: tail.map((p) => p.id), label: 'Other companies' },
    });
  }
  return { slots, other, aggregated };
}

/** Angle two neighbouring dots on a track of radius r need so they never touch (chord >= pitch). */
function trackStep(r: number, pitch: number): number {
  return 2 * Math.asin(Math.min(1, (pitch + 0.5) / (2 * r)));
}

/** An empty stretch of a ring wider than this (and than three dots' even share) is lopsided. */
const LOPSIDED = (30 * Math.PI) / 180;
/** A layout that had to take dots away but fills less of the circle than this is worked out once more. */
const REFIT_BELOW = 0.9;

/** Radial jitter (px either way) on a ring that uses a single track; multi-track rings sit exactly on their tracks. */
const RADIAL_JITTER = 6;
/** Share of a dot's step that must lie inside its company's wedge (its centre always does). */
const INSIDE = 0.25;
/** Angular jitter limit, either way. */
const MAX_JITTER = (6 * Math.PI) / 180;

interface RingState {
  step: number;
  geo: RingGeometry;
  /** how many of geo.tracks are in use, main track first */
  tracks: number;
  /** per company, the most dots it may show on this ring */
  caps: Map<string, number>;
  /** companies whose people on this ring are in "Other companies" */
  merged: Set<string>;
  pack: RingPack;
}

type Entry = { key: string; label: string; orgId?: string; logoUrl?: string; count: number; slots: Slot[][] };

interface Sweep {
  /** angle needed for everything, measured from the first wedge's start */
  total: number;
  bounds: [number, number][];
  /** per entry, per ring, per dot: track index and left-most feasible angle */
  track: number[][][];
  pos: number[][][];
  /** per entry, the ring that sets its width */
  binding: number[];
}

/**
 * Walk the companies in order and pack every dot as early as it can go: on each track a dot keeps one step from
 * the previous dot there (whatever its company), and keeps INSIDE of its step within its own wedge. Dots go on
 * the track where they fit earliest, so neighbouring small companies stagger across tracks. A wedge ends where
 * its last dot's share ends.
 */
function sweep(entries: Entry[], steps: number[][]): Sweep {
  const last = steps.map((ts) => ts.map(() => Number.NEGATIVE_INFINITY));
  const first = steps.map((ts) => ts.map(() => Number.NaN));
  const out: Sweep = { total: 0, bounds: [], track: [], pos: [], binding: [] };
  let start = 0;
  for (const e of entries) {
    let end = start + 1e-3;
    let bind = 0;
    const tr: number[][] = [[], [], []];
    const ps: number[][] = [[], [], []];
    e.slots.forEach((items, r) => {
      const ds = steps[r]!;
      for (let i = 0; i < items.length; i++) {
        let best = 0;
        let at = Number.POSITIVE_INFINITY;
        ds.forEach((d, t) => {
          const c = Math.max(start + (INSIDE * d) / 2, last[r]![t]! + d);
          if (c < at - 1e-12) {
            at = c;
            best = t;
          }
        });
        last[r]![best] = at;
        if (Number.isNaN(first[r]![best]!)) first[r]![best] = at;
        tr[r]!.push(best);
        ps[r]!.push(at);
        const right = at + (INSIDE * ds[best]!) / 2;
        if (right > end) {
          end = right;
          bind = r;
        }
      }
    });
    out.bounds.push([start, end]);
    out.track.push(tr);
    out.pos.push(ps);
    out.binding.push(bind);
    start = end;
  }
  out.total = start;
  // around the circle, the last dot on a track must also keep one step from the first
  for (let r = 0; r < steps.length; r++)
    for (let t = 0; t < steps[r]!.length; t++)
      if (!Number.isNaN(first[r]![t]!))
        out.total = Math.max(out.total, last[r]![t]! - first[r]![t]! + steps[r]![t]!);
  return out;
}

/**
 * Deterministic orbit layout. Rings by strength tier; one contiguous wedge per company, shared by all rings,
 * and every dot's centre sits inside its company's wedge. Companies go round the orbit strongest first, unless
 * that leaves a ring empty along a wide stretch of the circle: then they are woven so that every ring's dots reach
 * all the way round it (see spreadRings).
 *
 * Each ring packs dots on concentric tracks within its own radial band, keeping one step between neighbours on
 * a track. When the wedges do not fit around the circle, the ring that costs the most angle gets room in this
 * order: another track, then slightly smaller dots, then fewer dots in the wedges that ring makes widest (such
 * a company's weakest overflow collapses into one "+N" dot, and a company already down to one dot there merges
 * into an "Other companies" dot), weak and medium rings before strong ties. Spare angle
 * is shared out in proportion, and dots are spread evenly inside their wedge as far as spacing allows, so no
 * two dots overlap whatever the network size.
 */
export function orbitLayout(
  people: Person[],
  orgs: Map<string, Organization>,
  opts: {
    scale?: number;
    /**
     * The wedges the student already sees (the previous layout's groups). Companies keep that order, new ones slot
     * in after the company they would follow, and every wedge stays as close as it can to where it was, so one tie
     * growing stronger moves that one person rather than swapping and sliding whole companies round the orbit. When
     * the network has changed so much that this would leave a ring empty along a wide stretch, it is laid out
     * afresh instead.
     */
    previous?: readonly Pick<OrbitGroup, 'key' | 'startAngle' | 'endAngle'>[];
  } = {},
): OrbitLayout {
  const plain = layOut(people, orgs, opts, false);
  if (lopsided(plain) <= 1) return plain;
  // Strength order, and companies kept where the student saw them, are worth a little, never a lopsided map. Woven,
  // companies the student has seen still keep their order. After the network has changed a lot (a LinkedIn sync
  // writing thousands of people in batches, each laid out where the last one was), the order and wedges kept from a
  // much smaller network can still leave a ring badly empty: then it is laid out afresh, and the next change keeps
  // that layout. The one that reads markedly best wins, else the one closer to what the student saw.
  const options = [plain, layOut(people, orgs, opts, true)];
  if (opts.previous?.length && Math.min(...options.map(lopsided)) > 1.5)
    options.push(layOut(people, orgs, { scale: opts.scale }, true));
  let best = options[0]!;
  for (const l of options.slice(1)) if (lopsided(l) < lopsided(best) * 0.9) best = l;
  return best;
}

/**
 * How lopsided a layout looks: its widest empty stretch on any ring, against what that ring may leave empty (30
 * degrees, or three dots' even share on a sparse ring). Above 1 is lopsided.
 */
function lopsided(l: Pick<OrbitLayout, 'nodes'>): number {
  let worst = 0;
  for (let ring = 0; ring < 3; ring++) {
    const n = l.nodes.filter((x) => x.ring === ring).length;
    if (!n) continue;
    worst = Math.max(worst, largestGap(l.nodes, ring) / Math.max(LOPSIDED, (3 * Math.PI * 2) / n));
  }
  return worst;
}

/** One layout; `woven`: companies in the order the rings they show dots on call for, rather than by strength. */
function layOut(
  people: Person[],
  orgs: Map<string, Organization>,
  opts: { scale?: number; previous?: readonly Pick<OrbitGroup, 'key' | 'startAngle' | 'endAngle'>[] },
  woven: boolean,
): OrbitLayout {
  const scale = opts.scale ?? 1;
  const visible = people.filter((p) => p.isHuman && !p.hiddenAt);
  const groupsMap = new Map<string, Group>();
  for (const p of visible) {
    const key = orbitGroupKey(p, orgs);
    const org = p.currentOrganizationId ? orgs.get(p.currentOrganizationId) : undefined;
    let g = groupsMap.get(key);
    if (!g) {
      g = {
        key,
        label: key === 'independent' ? 'Independent' : (org?.name ?? p.currentOrganizationRaw ?? 'Other'),
        orgId: org?.id,
        logoUrl: org?.logoUrl,
        members: [],
        strength: 0,
      };
      groupsMap.set(key, g);
    } else if (!g.orgId && org) {
      g.orgId = org.id;
      g.label = org.name;
      g.logoUrl = org.logoUrl;
    }
    g.members.push(p);
    g.strength += p.strength;
  }
  const byStrength = (a: Person, b: Person) => b.strength - a.strength || (a.id < b.id ? -1 : 1);
  const ringMembers = new Map<string, Person[][]>();
  for (const g of groupsMap.values()) {
    const rings: Person[][] = [[], [], []];
    for (const p of g.members) {
      const tier = strengthTier(p.strength);
      rings[tier === 'strong' ? 0 : tier === 'medium' ? 1 : 2]!.push(p);
    }
    for (const r of rings) r.sort(byStrength);
    ringMembers.set(g.key, rings);
  }
  const strongestFirst = [...groupsMap.values()].sort(
    (a, b) =>
      b.strength - a.strength ||
      b.members.length - a.members.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const previousOrder = opts.previous?.map((g) => g.key);
  let ordered = keepOrder(strongestFirst, previousOrder);
  const RINGS = [0, 1, 2] as const;
  const presentOf = () =>
    RINGS.map((ring) => ordered.filter((g) => ringMembers.get(g.key)![ring]!.length > 0));
  let present = presentOf();
  const members = (ring: number) => (g: Group) => ringMembers.get(g.key)![ring]!;
  const repack = (ring: 0 | 1 | 2) => {
    const st = state[ring]!;
    st.pack = packRing(present[ring]!, members(ring), st.caps, st.merged);
  };

  // start from the dot size each ring's head count calls for, on its main track, with everyone shown (but the
  // companies already folded into "Other companies", when laying out again)
  const initial = (ring: 0 | 1 | 2, merged = new Set<string>()): RingState => {
    const demand = present[ring]!.reduce((s, g) => s + members(ring)(g).length, 0);
    const sizes = SIZE_STEPS[ring]!;
    let step = 0;
    while (step < sizes.length - 1 && demand > ringGeometry(ring, sizes[step]!).capacity * FILL) step++;
    const geo = ringGeometry(ring, sizes[step]!);
    const caps = new Map<string, number>();
    return {
      step,
      geo,
      tracks: 1,
      caps,
      merged,
      pack: packRing(present[ring]!, members(ring), caps, merged),
    };
  };
  let state: RingState[] = RINGS.map((ring) => initial(ring));

  const entriesOf = (): Entry[] => {
    const list: Entry[] = ordered
      .map((g) => ({
        key: g.key,
        label: g.label,
        orgId: g.orgId,
        logoUrl: g.logoUrl,
        count: g.members.length,
        slots: RINGS.map((r) => state[r]!.pack.slots.get(g.key) ?? []),
      }))
      .filter((e) => e.slots.some((x) => x.length > 0)); // a company merged away on every ring has no wedge
    if (state.some((s) => s.pack.other.length)) {
      const other = RINGS.map((r) => state[r]!.pack.other);
      list.push({
        key: OTHER_GROUP_KEY,
        label: 'Other companies',
        count: other.reduce((s, o) => s + (o[0]?.cluster?.count ?? 0), 0),
        slots: other,
      });
    }
    return list;
  };
  const stepsOf = (ring: 0 | 1 | 2) => {
    const st = state[ring]!;
    const jitter = st.tracks === 1 ? RADIAL_JITTER : 0;
    return st.geo.tracks.slice(0, st.tracks).map((r) => trackStep(r - jitter, st.geo.pitch));
  };

  /**
   * The companies in the order the rings they show dots on call for (see spreadRings); companies the student has
   * seen keep their order. Only folding a company away on a ring changes that (a "+N" dot never empties a ring), so
   * it is worked out again only then. True when the order changed.
   */
  let folded = woven;
  const weave = (): boolean => {
    if (!folded) return false;
    folded = false;
    const next = keepOrder(
      spreadRings(strongestFirst, (g) => RINGS.map((r) => !!state[r]!.pack.slots.get(g.key)?.length)),
      previousOrder,
    );
    if (next.every((g, i) => g === ordered[i])) return false;
    ordered = next;
    // what each company shows does not depend on the order: the rings are packed in the new order from now on
    present = presentOf();
    entries = entriesOf();
    return true;
  };

  let entries = entriesOf();
  weave();
  let steps = RINGS.map(stepsOf);
  let sw = sweep(entries, steps);
  /** Makes room until everything fits round the circle; true when it took dots away to get there. */
  const makeRoom = (): boolean => {
    let lossy = false;
    for (let iter = 0; iter < 500; iter++) {
      if (sw.total <= Math.PI * 2) {
        // it fits: once more in the order the dots it now shows call for (folding changes it), or done
        if (!weave()) break;
        sw = sweep(entries, steps);
        continue;
      }
      // the angle each ring is responsible for: the wedges it makes widest
      const cost = [0, 0, 0];
      sw.binding.forEach((r, i) => {
        cost[r]! += sw.bounds[i]![1] - sw.bounds[i]![0];
      });
      const byCost = [...RINGS].sort((a, b) => cost[b]! - cost[a]! || b - a);
      // lossless room first (another track, then smaller dots), on the ring that costs most
      const roomy = byCost.find(
        (r) =>
          cost[r]! > 0 &&
          (state[r]!.tracks < state[r]!.geo.tracks.length || state[r]!.step < SIZE_STEPS[r]!.length - 1),
      );
      if (roomy !== undefined) {
        const st = state[roomy]!;
        // close ties stay one clean ring for as long as slightly smaller dots allow: a second inner track would
        // crowd You, and a tie growing closer would send half the ring to it
        const shrinkFirst = roomy === 0 && st.step < INNER_SHRINK_FIRST;
        if (st.tracks < st.geo.tracks.length && !shrinkFirst) st.tracks++;
        else {
          st.step++;
          st.geo = ringGeometry(roomy, SIZE_STEPS[roomy]![st.step]!);
          st.tracks = Math.min(st.tracks, st.geo.tracks.length);
        }
      } else if (weave()) {
        // before anyone is folded away: the companies in the order the dots they now show call for, which may be
        // room enough already
      } else {
        // then fewer dots, weak and medium rings before strong ties, and only in the wedges that ring makes widest
        const binding = (r: number) =>
          entries.filter(
            (e, i) => sw.binding[i] === r && e.key !== OTHER_GROUP_KEY && e.slots[r]!.length > 0,
          );
        const ring = byCost.find((r) => r > 0 && binding(r).length) ?? byCost.find((r) => binding(r).length);
        if (ring === undefined) break;
        const st = state[ring]!;
        const wide = binding(ring);
        const groupOf = new Map(present[ring]!.map((g) => [g.key, g]));
        let capped = 0;
        const single: Group[] = [];
        for (const e of wide) {
          const g = groupOf.get(e.key)!;
          const m = members(ring)(g).length;
          const shown = e.slots[ring]!.length;
          // keep every "+N" dot a real group: never fewer than MIN_CLUSTER people behind it
          const q = Math.min(Math.floor(shown * 0.75), m - MIN_CLUSTER + 1);
          if (shown > 1 && q >= 1) {
            st.caps.set(e.key, q);
            capped++;
          } else single.push(g);
        }
        if (!capped) {
          // every wide wedge already shows one dot here: fold the smaller half of them into "Other companies"
          single.sort((a, b) => members(ring)(a).length - members(ring)(b).length || a.strength - b.strength);
          for (const g of single.slice(0, Math.max(1, Math.ceil(single.length / 2)))) st.merged.add(g.key);
          folded = true;
        }
        lossy = true;
        repack(ring);
        entries = entriesOf();
      }
      steps = RINGS.map(stepsOf);
      sw = sweep(entries, steps);
    }
    return lossy;
  };
  if (makeRoom() && woven && sw.total < Math.PI * 2 * REFIT_BELOW) {
    // Dots were taken away while the companies were still in an order that wasted room (the order only settles as
    // companies fold away), and a lot of the circle is left over: lay out again from full size in the settled order,
    // keeping only what folded away, so no more people hide in "+N" dots than the circle needs.
    state = RINGS.map((ring) => initial(ring, state[ring]!.merged));
    entries = entriesOf();
    steps = RINGS.map(stepsOf);
    sw = sweep(entries, steps);
    makeRoom();
  }

  // spread spare angle in proportion; if nothing fits (cannot happen with at least a few degrees per dot),
  // squeeze and let the spacing pass below win over wedge membership
  const f = (Math.PI * 2) / Math.max(sw.total, 1e-9);
  const fits = f >= 1 - 1e-9;
  const base = -Math.PI / 2;
  // each wedge's start (from base) and width; its dots keep their packed offsets from the wedge's start
  let wStart = sw.bounds.map((b) => b[0] * f);
  let wSpan = sw.bounds.map((b, i) =>
    i === entries.length - 1 ? Math.PI * 2 - b[0] * f : (b[1] - b[0]) * f,
  );
  let leftMost = (_ei: number, pos: number) => pos * f;
  const anchored = fits && opts.previous?.length ? anchorWedges(entries, sw, opts.previous) : undefined;
  if (anchored) {
    wStart = anchored.map((b) => b - base);
    wSpan = anchored.map(
      (b, i) => (i + 1 < anchored.length ? anchored[i + 1]! : anchored[0]! + Math.PI * 2) - b,
    );
    leftMost = (ei, pos) => wStart[ei]! + pos - sw.bounds[ei]![0];
  }
  const groups: OrbitGroup[] = entries.map((e, i) => ({
    key: e.key,
    label: e.label,
    orgId: e.orgId,
    startAngle: base + wStart[i]!,
    endAngle: base + wStart[i]! + wSpan[i]!,
    count: e.count,
    logoUrl: e.logoUrl,
  }));

  // place each track's dots in circular order
  const nodes: OrbitNode[] = [];
  RINGS.forEach((ring) => {
    const st = state[ring]!;
    const tracks = st.geo.tracks.slice(0, st.tracks);
    tracks.forEach((radius, t) => {
      const d = steps[ring]![t]!;
      const list: { e: number; i: number; L: number; lo: number; hi: number; E: number }[] = [];
      for (let ei = 0; ei < entries.length; ei++) {
        const tr = sw.track[ei]![ring]!;
        const mine = tr.map((x, i) => (x === t ? i : -1)).filter((i) => i >= 0);
        const s = wStart[ei]!;
        const span = anchored ? wSpan[ei]! : (sw.bounds[ei]![1] - sw.bounds[ei]![0]) * f;
        mine.forEach((i, j) => {
          list.push({
            e: ei,
            i,
            L: leftMost(ei, sw.pos[ei]![ring]![i]!),
            lo: s + (INSIDE * d) / 2,
            hi: s + span - (INSIDE * d) / 2,
            E: s + (span * (j + 0.5)) / mine.length,
          });
        });
      }
      const n = list.length;
      if (!n) return;
      let p: number[];
      if (fits) {
        // right-most feasible placement, then pull each dot toward its even spot without breaking spacing:
        // the average of a forward and a backward repair of the clamped targets stays feasible
        const R = new Array<number>(n);
        let next = list[0]!.L + Math.PI * 2;
        for (let k = n - 1; k >= 0; k--) {
          R[k] = Math.min(list[k]!.hi, next - d);
          next = R[k]!;
        }
        const c = list.map((x, k) => Math.min(Math.max(x.E, x.L), R[k]!));
        const F = [...c];
        for (let k = 1; k < n; k++) F[k] = Math.max(c[k]!, F[k - 1]! + d);
        const B = [...c];
        for (let k = n - 2; k >= 0; k--) B[k] = Math.min(c[k]!, B[k + 1]! - d);
        p = F.map((x, k) => (x + B[k]!) / 2);
      } else p = list.map((x) => x.L);
      p.forEach((a, k) => {
        const x = list[k]!;
        const e = entries[x.e]!;
        const item = e.slots[ring]![x.i]!;
        const id = item.person?.id ?? `cluster:${e.key}:${ring}`;
        let angle = a;
        if (fits) {
          // jitter within half the slack to each neighbour and inside the wedge
          const prev = n === 1 ? a - Math.PI * 2 : k ? p[k - 1]! : p[n - 1]! - Math.PI * 2;
          const next = n === 1 ? a + Math.PI * 2 : k < n - 1 ? p[k + 1]! : p[0]! + Math.PI * 2;
          const left = Math.max(0, Math.min((a - prev - d) / 2, a - x.lo, MAX_JITTER));
          const right = Math.max(0, Math.min((next - a - d) / 2, x.hi - a, MAX_JITTER));
          const j = hashJitter(id, 'a') * 2;
          angle += j < 0 ? j * left : j * right;
        }
        nodes.push({
          id,
          person: item.person,
          cluster: item.cluster,
          ring,
          angle: base + angle,
          radius: radius + (tracks.length === 1 ? hashJitter(id, 'r') * 2 * RADIAL_JITTER : 0),
          size: st.geo.size,
          groupKey: e.key,
        });
      });
    });
  });
  if (!fits)
    separateOnTracks(
      nodes,
      state.map((s) => ({ ...s.geo, tracks: s.geo.tracks.slice(0, s.tracks) })),
    );
  const aggregated = state.reduce((s, st) => s + st.pack.aggregated, 0);
  let extent = 0;
  for (const n of nodes) extent = Math.max(extent, n.radius + n.size / 2);
  if (scale !== 1) {
    for (const n of nodes) {
      n.radius *= scale;
      n.size *= scale;
    }
  }
  return {
    nodes,
    groups,
    ringRadii: [RING_RADII[0] * scale, RING_RADII[1] * scale, RING_RADII[2] * scale],
    extent: (nodes.length ? extent : RING_RADII[2] + NODE_SIZE[2] / 2) * scale,
    aggregated,
  };
}

/**
 * Wedge boundaries (absolute angles, one per entry: where its wedge starts) as close as possible, in least squares,
 * to where the previous layout had them, while every wedge keeps at least the width its dots need. With the
 * minimum widths taken out this is isotonic regression (pool adjacent violators); the circle's wrap is then met by
 * narrowing the spread. Undefined when no wedge was there before.
 */
function anchorWedges(
  entries: { key: string }[],
  sw: Sweep,
  previous: readonly Pick<OrbitGroup, 'key' | 'startAngle' | 'endAngle'>[],
): number[] | undefined {
  const TAU = Math.PI * 2;
  const n = entries.length;
  const prevStart = new Map(previous.map((g) => [g.key, g.startAngle]));
  // where each known wedge started, unwrapped so the targets increase round the circle
  const target: (number | undefined)[] = [];
  let last: number | undefined;
  for (const e of entries) {
    let b = prevStart.get(e.key);
    if (b !== undefined && last !== undefined) while (b < last - 1e-9) b += TAU;
    if (b !== undefined) last = b;
    target.push(b);
  }
  const known = target.filter((b): b is number => b !== undefined);
  if (!known.length) return undefined;
  // a new company starts where the next known one did, so it opens up between its neighbours
  for (let i = n - 1, next = known[0]! + TAU; i >= 0; i--) {
    if (target[i] === undefined) target[i] = next;
    else next = target[i]!;
  }
  const minW = sw.bounds.map((b) => b[1] - b[0]);
  // the wrap: the last wedge also leaves the room the first dots on each track need
  minW[n - 1] = minW[n - 1]! + sw.total - sw.bounds[n - 1]![1];
  const cum: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    cum.push(acc);
    acc += minW[i]!;
  }
  const slack = TAU - acc;
  if (slack < -1e-9) return undefined;
  const y = target.map((b, i) => b! - cum[i]!);
  // pool adjacent violators: the closest non-decreasing sequence
  const blocks: { sum: number; n: number }[] = [];
  for (const v of y) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      a.sum += b.sum;
      a.n += b.n;
      blocks.pop();
    }
  }
  const c: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) c.push(b.sum / b.n);
  const spread = c[n - 1]! - c[0]!;
  if (spread > slack) for (let i = 0; i < n; i++) c[i] = c[0]! + ((c[i]! - c[0]!) * slack) / spread;
  // any common turn keeps every constraint: take the one closest to the targets
  let shift = 0;
  for (let i = 0; i < n; i++) shift += y[i]! - c[i]!;
  shift /= n;
  return c.map((v, i) => v + shift + cum[i]!);
}

/**
 * Companies round the orbit so that every ring's dots go all the way round it.
 *
 * Rings share each wedge's angle: a wedge is as wide as the ring that needs the most angle in it, and only its own
 * company's dots sit in it. In plain strength order the big companies (and "Independent"), whose people are mostly
 * weak ties on the outer ring, come first, and the many small companies that show only a close tie (their weak ties
 * fold into "Other companies") all come last: the outer ring is crammed many tracks deep into one side of the circle
 * and the other side has no outer dots at all, a lopsided map. So, ring by ring from the one the fewest companies
 * show dots on, the companies that show dots there are spread evenly between those that do not, the way Bresenham
 * spreads steps along a line (each side ordered the same way for the other rings, strongest first otherwise). A run
 * of wedges with nothing on a ring is then a few dots at most, and the first close tie in a run takes no angle of its
 * own (it sits in the inner ring's room beside the wedge before), so the orbit also packs tighter.
 * `rings`: which rings a company shows dots on; one that shows none has no wedge and goes last.
 */
function spreadRings<T>(byStrength: T[], rings: (g: T) => boolean[]): T[] {
  const on = new Map(byStrength.map((g) => [g, rings(g)]));
  const order = (list: T[], left: number[]): T[] => {
    if (list.length < 2 || !left.length) return list;
    // the ring the fewest of these show dots on, whose dots would bunch the most
    let ring = -1;
    let fewest = Number.POSITIVE_INFINITY;
    for (const r of left) {
      const n = list.filter((g) => on.get(g)![r]).length;
      if (n > 0 && n < list.length && n < fewest) {
        fewest = n;
        ring = r;
      }
    }
    if (ring < 0) return list;
    const rest = left.filter((r) => r !== ring);
    const some = order(
      list.filter((g) => on.get(g)![ring]),
      rest,
    );
    const others = order(
      list.filter((g) => !on.get(g)![ring]),
      rest,
    );
    // each of `some` in the middle of its even share of the line
    const out: T[] = [];
    let k = 0;
    some.forEach((g, j) => {
      const before = Math.floor(((j + 0.5) * others.length) / some.length);
      while (k < before) out.push(others[k++]!);
      out.push(g);
    });
    while (k < others.length) out.push(others[k++]!);
    return out;
  };
  const shown = byStrength.filter((g) => on.get(g)!.some(Boolean));
  const hidden = byStrength.filter((g) => !on.get(g)!.some(Boolean));
  return [...order(shown, [0, 1, 2]), ...hidden];
}

/**
 * Companies the student has already seen keep their order round the orbit; a new company goes right after the
 * known company it follows in `byStrength` (or first, when it comes before them all).
 */
function keepOrder<T extends { key: string }>(byStrength: T[], order?: readonly string[]): T[] {
  if (!order?.length) return byStrength;
  const rank = new Map(order.map((k, i) => [k, i]));
  const known = byStrength.filter((g) => rank.has(g.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  if (!known.length) return byStrength;
  const out = [...known];
  let after: T | undefined;
  for (const g of byStrength) {
    if (rank.has(g.key)) {
      after = g;
      continue;
    }
    out.splice(after ? out.indexOf(after) + 1 : 0, 0, g);
    after = g;
  }
  return out;
}

/** Push apart dots closer than one pitch on the same track; falls back to even spacing on a dense track. */
function separateOnTracks(nodes: OrbitNode[], geometry: RingGeometry[]): void {
  const tracks = new Map<string, OrbitNode[]>();
  for (const n of nodes) {
    const geo = geometry[n.ring]!;
    const ti = geo.tracks.length === 1 ? 0 : geo.tracks.findIndex((r) => Math.abs(r - n.radius) < 0.5);
    const key = `${n.ring}:${ti}`;
    const arr = tracks.get(key) ?? [];
    arr.push(n);
    tracks.set(key, arr);
  }
  const TAU = Math.PI * 2;
  for (const [key, list] of tracks) {
    if (list.length < 2) continue;
    const geo = geometry[Number(key.split(':')[0])]!;
    const r = Math.min(...list.map((n) => n.radius));
    // chord >= pitch  <=>  angle >= 2 asin(pitch / 2r)
    let delta = 2 * Math.asin(Math.min(1, (geo.pitch + 1) / (2 * r)));
    if (delta * list.length > TAU) delta = TAU / list.length;
    list.sort((a, b) => a.angle - b.angle);
    const ok = () => {
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!.angle;
        const b = i + 1 < list.length ? list[i + 1]!.angle : list[0]!.angle + TAU;
        if (b - a < delta - 1e-9) return false;
      }
      return true;
    };
    for (let iter = 0; iter < 60 && !ok(); iter++) {
      for (let i = 0; i < list.length; i++) {
        const A = list[i]!;
        const B = list[(i + 1) % list.length]!;
        const b = i + 1 < list.length ? B.angle : B.angle + TAU;
        const gap = b - A.angle;
        if (gap < delta) {
          const push = (delta - gap) / 2 + 1e-9;
          A.angle -= push;
          B.angle += push;
        }
      }
      list.sort((a, b) => a.angle - b.angle);
    }
    if (!ok()) {
      // keep the order, space evenly from the first dot
      const step = TAU / list.length;
      const a0 = list[0]!.angle;
      list.forEach((n, i) => {
        n.angle = a0 + i * step;
      });
    }
  }
}

/**
 * The widest stretch of a ring's circle with no dot on it (radians): what makes a map look lopsided. 2π for a ring
 * with no dots.
 */
export function largestGap(nodes: readonly Pick<OrbitNode, 'angle' | 'ring'>[], ring: number): number {
  const TAU = Math.PI * 2;
  const a = nodes
    .filter((n) => n.ring === ring)
    .map((n) => ((n.angle % TAU) + TAU) % TAU)
    .sort((x, y) => x - y);
  if (!a.length) return TAU;
  let gap = a[0]! + TAU - a[a.length - 1]!;
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i]! - a[i - 1]!);
  return gap;
}

/** Number of dots whose centre lies outside their company's wedge (used by tests and the map's readability check). */
export function countOutsideWedges(layout: Pick<OrbitLayout, 'nodes' | 'groups'>): number {
  const TAU = Math.PI * 2;
  const wedges = new Map(layout.groups.map((g) => [g.key, g]));
  let n = 0;
  for (const x of layout.nodes) {
    const w = wedges.get(x.groupKey);
    if (!w) {
      n++;
      continue;
    }
    let a = x.angle;
    while (a < w.startAngle - 1e-6) a += TAU;
    while (a >= w.startAngle + TAU - 1e-6) a -= TAU;
    if (a > w.endAngle + 1e-6) n++;
  }
  return n;
}

/** Number of pairs of dots that overlap (used by tests and the map's readability check). */
export function countOverlaps(nodes: Pick<OrbitNode, 'angle' | 'radius' | 'size'>[]): number {
  const pts = nodes.map((n) => ({
    x: Math.cos(n.angle) * n.radius,
    y: Math.sin(n.angle) * n.radius,
    r: n.size / 2,
  }));
  const cell = Math.max(1, ...pts.map((p) => p.r * 2));
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
    const arr = grid.get(k) ?? [];
    arr.push(i);
    grid.set(k, arr);
  });
  let n = 0;
  pts.forEach((p, i) => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (j <= i) continue;
          const q = pts[j]!;
          if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 < (p.r + q.r - 0.5) ** 2) n++;
        }
  });
  return n;
}

/** One revolution of the orbit's slow turn. */
export const ORBIT_PERIOD_MS = 12 * 60_000;

/** One slow rotation shared by every ring (one revolution in 12 minutes), so company wedges stay aligned. */
export function orbitRotation(elapsedMs: number): number {
  return ((elapsedMs % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS) * Math.PI * 2;
}

/** Rings no longer turn at different speeds (that broke the wedges); every ring uses orbitRotation. */
export function ringRotation(_ring: 0 | 1 | 2, elapsedMs: number): number {
  return orbitRotation(elapsedMs);
}

export function avatarHue(id: string): number {
  return hueFromId(id);
}
