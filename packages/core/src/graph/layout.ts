import { strengthTier } from '../scoring/strength';
import { hueFromId } from '../text/normalize';
import type { Organization, Person } from '../types';

export interface OrbitNode {
  id: string;
  person: Person;
  ring: 0 | 1 | 2;
  angle: number; // radians, before rotation
  radius: number;
  size: number;
  groupKey: string;
}

export interface OrbitGroup {
  key: string;
  label: string;
  orgId?: string;
  startAngle: number;
  endAngle: number;
  count: number;
  logoUrl?: string;
}

export interface OrbitLayout {
  nodes: OrbitNode[];
  groups: OrbitGroup[];
  ringRadii: [number, number, number];
}

function hashJitter(id: string, salt: string): number {
  let h = 0;
  const s = id + salt;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 - 0.5; // -0.5..0.5
}

export function orbitLayout(
  people: Person[],
  orgs: Map<string, Organization>,
  opts: { scale?: number } = {},
): OrbitLayout {
  const scale = opts.scale ?? 1;
  const ringRadii: [number, number, number] = [160 * scale, 300 * scale, 440 * scale];
  const visible = people.filter((p) => p.isHuman && !p.hiddenAt);
  const groupsMap = new Map<
    string,
    { label: string; orgId?: string; members: Person[]; strength: number; logoUrl?: string }
  >();
  for (const p of visible) {
    const key =
      p.currentOrganizationId ??
      (p.currentOrganizationRaw ? `raw:${p.currentOrganizationRaw.toLowerCase()}` : 'independent');
    const label = p.currentOrganizationId
      ? (orgs.get(p.currentOrganizationId)?.name ?? p.currentOrganizationRaw ?? 'Other')
      : (p.currentOrganizationRaw ?? 'Independent');
    const g = groupsMap.get(key) ?? {
      label,
      orgId: p.currentOrganizationId,
      members: [],
      strength: 0,
      logoUrl: p.currentOrganizationId ? orgs.get(p.currentOrganizationId)?.logoUrl : undefined,
    };
    g.members.push(p);
    g.strength += p.strength;
    groupsMap.set(key, g);
  }
  const ordered = [...groupsMap.entries()].sort(
    (a, b) => b[1].strength - a[1].strength || b[1].members.length - a[1].members.length,
  );
  const totalWeight = ordered.reduce((s, [, g]) => s + g.members.length + 1, 0);
  const groups: OrbitGroup[] = [];
  const nodes: OrbitNode[] = [];
  let angle = -Math.PI / 2;
  for (const [key, g] of ordered) {
    const span = ((g.members.length + 1) / totalWeight) * Math.PI * 2;
    const start = angle;
    const end = angle + span;
    groups.push({
      key,
      label: g.label,
      orgId: g.orgId,
      startAngle: start,
      endAngle: end,
      count: g.members.length,
      logoUrl: g.logoUrl,
    });
    const byRing: Person[][] = [[], [], []];
    for (const p of g.members) {
      const tier = strengthTier(p.strength);
      byRing[tier === 'strong' ? 0 : tier === 'medium' ? 1 : 2]!.push(p);
    }
    byRing.forEach((members, ring) => {
      members.sort((a, b) => b.strength - a.strength);
      members.forEach((p, idx) => {
        const t = (idx + 1) / (members.length + 1);
        const a = start + span * t + hashJitter(p.id, 'a') * (span / Math.max(2, members.length)) * 0.6;
        const r = ringRadii[ring as 0 | 1 | 2] + hashJitter(p.id, 'r') * 24 * scale;
        nodes.push({
          id: p.id,
          person: p,
          ring: ring as 0 | 1 | 2,
          angle: a,
          radius: r,
          size: (ring === 0 ? 48 : ring === 1 ? 40 : 32) * scale,
          groupKey: key,
        });
      });
    });
    angle = end;
  }
  return { nodes, groups, ringRadii };
}

export function ringRotation(ring: 0 | 1 | 2, elapsedMs: number): number {
  const periodsMin = [6, -8, 10];
  const p = periodsMin[ring]! * 60_000;
  return ((elapsedMs % Math.abs(p)) / Math.abs(p)) * Math.PI * 2 * Math.sign(p);
}

export function avatarHue(id: string): number {
  return hueFromId(id);
}
