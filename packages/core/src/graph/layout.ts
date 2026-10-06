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

/**
 * Deterministic orbit layout. Rings by strength tier; one contiguous wedge per company, shared by all rings.
 * Each ring packs dots on concentric tracks within its band. When a ring is still too full the dots shrink a
 * little, then each company's weakest overflow collapses into one "+N" dot, and finally the long tail of small
 * companies merges into an "Other companies" dot. A last pass on every track enforces a minimum spacing, so no
 * two dots overlap whatever the network size.
 */
export function orbitLayout(
  people: Person[],
  orgs: Map<string, Organization>,
  opts: { scale?: number } = {},
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
  const ordered = [...groupsMap.values()].sort(
    (a, b) =>
      b.strength - a.strength ||
      b.members.length - a.members.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const byStrength = (a: Person, b: Person) => b.strength - a.strength || (a.id < b.id ? -1 : 1);
  const ringMembers = new Map<string, Person[][]>();
  for (const g of ordered) {
    const rings: Person[][] = [[], [], []];
    for (const p of g.members) {
      const tier = strengthTier(p.strength);
      rings[tier === 'strong' ? 0 : tier === 'medium' ? 1 : 2]!.push(p);
    }
    for (const r of rings) r.sort(byStrength);
    ringMembers.set(g.key, rings);
  }
  const membersOn = (g: Group, ring: number) => ringMembers.get(g.key)![ring]!;
  const slots = new Map<string, Slot[][]>(ordered.map((g) => [g.key, [[], [], []]]));
  const otherSlots: Slot[][] = [[], [], []];
  const geometry: RingGeometry[] = [];
  let aggregated = 0;
  for (const ring of [0, 1, 2] as const) {
    const demand = ordered.reduce((s, g) => s + membersOn(g, ring).length, 0);
    let geo = ringGeometry(ring, 1);
    for (const f of SIZE_STEPS[ring]!) {
      geo = ringGeometry(ring, f);
      if (demand <= geo.capacity * FILL) break;
    }
    geometry.push(geo);
    const budget = Math.max(2, Math.floor(geo.capacity * FILL));
    const present = ordered.filter((g) => membersOn(g, ring).length > 0);
    if (demand <= budget) {
      for (const g of present) slots.get(g.key)![ring] = membersOn(g, ring).map((person) => ({ person }));
      continue;
    }
    // Keep the bigger companies on this ring as wedges and merge the long tail into "Other companies".
    // Start by merging nothing; merge companies with up to S people here while that still leaves many
    // pointless "+1"/"+2" dots, so every aggregate dot that remains stands for a real group.
    const plan = (S: number) => {
      const bySize = present
        .filter((g) => membersOn(g, ring).length > S)
        .sort((a, b) => membersOn(b, ring).length - membersOn(a, ring).length || b.strength - a.strength);
      const keep = new Set(bySize.slice(0, budget - 1).map((g) => g.key));
      const kept = present.filter((g) => keep.has(g.key));
      const merged = present.filter((g) => !keep.has(g.key));
      const room = budget - (merged.length ? 1 : 0);
      // largest per-company cap q such that sum(min(members, q)) fits the room
      const used = (q: number) => kept.reduce((s, g) => s + Math.min(membersOn(g, ring).length, q), 0);
      let lo = 1;
      let hi = Math.max(1, ...kept.map((g) => membersOn(g, ring).length));
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (used(mid) <= room) lo = mid;
        else hi = mid - 1;
      }
      const tiny = kept.filter((g) => {
        const m = membersOn(g, ring).length;
        return m > lo && m - lo + 1 < MIN_CLUSTER;
      }).length;
      return { kept, merged, q: lo, tiny };
    };
    let best = plan(0);
    // strong ties are never merged away for tidiness, only when the inner ring is truly full
    for (let S = 1; ring > 0 && S <= 12 && best.tiny > 2; S++) best = plan(S);
    const { kept, merged, q } = best;
    for (const g of kept) {
      const m = membersOn(g, ring);
      if (m.length <= q) {
        slots.get(g.key)![ring] = m.map((person) => ({ person }));
        continue;
      }
      const shown = m.slice(0, q - 1);
      const rest = m.slice(q - 1);
      aggregated += rest.length;
      slots.get(g.key)![ring] = [
        ...shown.map((person) => ({ person })),
        { cluster: { count: rest.length, personIds: rest.map((p) => p.id), label: g.label } },
      ];
    }
    if (merged.length) {
      const rest = merged.flatMap((g) => membersOn(g, ring));
      aggregated += rest.length;
      otherSlots[ring] = [
        { cluster: { count: rest.length, personIds: rest.map((p) => p.id), label: 'Other companies' } },
      ];
    }
  }
  // wedges: each company gets the share it needs on its most crowded ring, plus a little padding
  const entries = ordered.map((g) => ({
    key: g.key,
    label: g.label,
    orgId: g.orgId,
    logoUrl: g.logoUrl,
    slots: slots.get(g.key)!,
    count: g.members.length,
  }));
  if (otherSlots.some((s) => s.length))
    entries.push({
      key: OTHER_GROUP_KEY,
      label: 'Other companies',
      orgId: undefined,
      logoUrl: undefined,
      slots: otherSlots,
      count: otherSlots.reduce((s, r) => s + (r[0]?.cluster?.count ?? 0), 0),
    });
  const totalCap = geometry.reduce((s, geo) => s + geo.capacity, 0);
  const weights = entries.map(
    (e) => Math.max(...e.slots.map((s, r) => s.length / geometry[r]!.capacity)) + 1 / Math.max(totalCap, 1),
  );
  const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;
  const groups: OrbitGroup[] = [];
  const perRing: { id: string; item: Slot; angle: number; key: string }[][] = [[], [], []];
  let angle = -Math.PI / 2;
  entries.forEach((e, gi) => {
    const span = (weights[gi]! / totalWeight) * Math.PI * 2;
    const start = angle;
    groups.push({
      key: e.key,
      label: e.label,
      orgId: e.orgId,
      startAngle: start,
      endAngle: start + span,
      count: e.count,
      logoUrl: e.logoUrl,
    });
    e.slots.forEach((items, ring) => {
      const k = items.length;
      const free = span / Math.max(k, 1) - geometry[ring]!.pitch / RING_RADII[ring as 0 | 1 | 2];
      items.forEach((item, idx) => {
        const id = item.person?.id ?? `cluster:${e.key}:${ring}`;
        const jitter = free > 0 ? hashJitter(id, 'a') * Math.min(free, (12 * Math.PI) / 180) : 0;
        perRing[ring]!.push({ id, item, angle: start + (span * (idx + 0.5)) / k + jitter, key: e.key });
      });
    });
    angle = start + span;
  });
  const nodes: OrbitNode[] = [];
  perRing.forEach((list, ringIdx) => {
    if (!list.length) return;
    const ring = ringIdx as 0 | 1 | 2;
    const geo = geometry[ring]!;
    // use as few tracks as the ring needs: main track first, then one inside, one outside, ...
    const caps = geo.tracks.map((r) => Math.floor((2 * Math.PI * r) / geo.pitch));
    let used = 1;
    let cap = caps[0]!;
    while (used < caps.length && list.length > cap * FILL) cap += caps[used++]!;
    const tracks = geo.tracks.slice(0, used);
    geo.tracks = tracks; // the separation pass works on the tracks actually used
    // in angular order, put each dot on the track that is least full relative to its capacity,
    // so neighbours alternate between tracks instead of piling up on one
    const count = tracks.map(() => 0);
    list.sort((a, b) => a.angle - b.angle);
    for (const it of list) {
      let best = 0;
      for (let t = 1; t < tracks.length; t++)
        if (count[t]! / caps[t]! < count[best]! / caps[best]! - 1e-12) best = t;
      count[best]!++;
      const jitterR = tracks.length === 1 ? hashJitter(it.id, 'r') * 12 : 0;
      nodes.push({
        id: it.id,
        person: it.item.person,
        cluster: it.item.cluster,
        ring,
        angle: it.angle,
        radius: tracks[best]! + jitterR,
        size: geo.size,
        groupKey: it.key,
      });
    }
  });
  separateOnTracks(nodes, geometry);
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

/** One slow rotation shared by every ring (one revolution in 12 minutes), so company wedges stay aligned. */
export function orbitRotation(elapsedMs: number): number {
  const period = 12 * 60_000;
  return ((elapsedMs % period) / period) * Math.PI * 2;
}

/** Rings no longer turn at different speeds (that broke the wedges); every ring uses orbitRotation. */
export function ringRotation(_ring: 0 | 1 | 2, elapsedMs: number): number {
  return orbitRotation(elapsedMs);
}

export function avatarHue(id: string): number {
  return hueFromId(id);
}
