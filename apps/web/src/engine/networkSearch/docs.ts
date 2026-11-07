/**
 * The student's people as search documents (plan 32 §5, §18.7): one lean PersonDoc per person, built from the person,
 * their affiliations and what LinkedIn listed about them, and kept in this tab until any of those change. What Orbit
 * knows about the tie (closeness, last talk, channels, a chat) is not in the doc: it is joined at query time, so a new
 * email never rebuilds a doc.
 */
import type { Affiliation, CoffeeChat, FacetScanWire, Person, Touchpoint, User } from '@orbit/core';
import {
  buildPersonDoc,
  type Channel,
  type FacetAssertion,
  hashString,
  type PersonDoc,
  type RelInfo,
  type SearchContext,
} from '@orbit/core/search';
import { db, type FacetRow } from '../../db/schema';
import { companyFacts, facetsByPerson, placeIndex, schoolIndex } from './data';
import { loadScans } from './lookup';

interface Kept {
  sig: string;
  doc: PersonDoc;
}

const cache = new Map<string, Map<string, Kept>>();

const BAND_OF = (p: Person): RelInfo['band'] => {
  if (p.tieBand) return p.tieBand;
  const s = p.strength ?? 0;
  return s >= 0.8 ? 'close' : s >= 0.6 ? 'strong' : s >= 0.4 ? 'warm' : s >= 0.2 ? 'light' : 'faint';
};

const TOUCH_CHANNEL: Partial<Record<Touchpoint['kind'], [Channel, 'in' | 'out']>> = {
  email_in: ['email', 'in'],
  email_out: ['email', 'out'],
  meeting: ['meeting', 'in'],
  linkedin_in: ['linkedin', 'in'],
  linkedin_out: ['linkedin', 'out'],
  text_in: ['text', 'in'],
  text_out: ['text', 'out'],
};

export interface SearchWorld {
  docs: PersonDoc[];
  ctx: SearchContext;
  people: Map<string, Person>;
}

/** The people a search runs over: human, not hidden, not the student. */
function searchable(p: Person): boolean {
  return p.isHuman && !p.hiddenAt;
}

/**
 * Docs and the context for one search. `touches` loads every touchpoint (only when the ask filters by a channel or a
 * time); otherwise the channel answers come from what each person already carries.
 */
/** A person's facets, plus a no for each complete scan that did not list them (connections known by LinkedIn id). */
function withScans(p: Person, fs: FacetRow[], scans: FacetScanWire[]): FacetAssertion[] {
  const out = fs.map(
    (f): FacetAssertion => ({ kind: f.kind, value: f.value, positive: f.positive, at: f.at }),
  );
  if (!p.linkedinMemberId || !scans.length) return out;
  for (const s of scans) {
    const v = s.value.toLowerCase();
    const listed = fs.some((f) => f.positive && f.kind === s.kind && f.value.toLowerCase() === v);
    if (!listed) out.push({ kind: s.kind, value: s.value, positive: false, at: s.at });
  }
  return out;
}

export async function loadWorld(
  user: Pick<User, 'id' | 'school'>,
  opts: { touches?: boolean } = {},
): Promise<SearchWorld> {
  const userId = user.id;
  const [people, affiliations, orgs, chats, facts, schools, places, facets, touches, scans] =
    await Promise.all([
      db.people.where('userId').equals(userId).toArray(),
      db.affiliations.where('userId').equals(userId).toArray(),
      db.organizations.toArray(),
      db.chats.where('userId').equals(userId).toArray(),
      companyFacts(userId),
      schoolIndex(),
      placeIndex(),
      facetsByPerson(userId),
      opts.touches
        ? db.touchpoints.where('userId').equals(userId).toArray()
        : Promise.resolve([] as Touchpoint[]),
      loadScans(userId),
    ]);
  // a complete LinkedIn lookup: a connection it did not list lacks the facet (for people Orbit knows by LinkedIn id)
  const scanSig = scans.map((x) => `${x.kind}:${x.value}:${x.at}`).join('|');
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const byPersonAff = new Map<string, Affiliation[]>();
  for (const a of affiliations) {
    const list = byPersonAff.get(a.personId);
    if (list) list.push(a);
    else byPersonAff.set(a.personId, [a]);
  }
  let kept = cache.get(userId);
  if (!kept) {
    kept = new Map();
    cache.set(userId, kept);
  }
  const deps = {
    isSchool: (t: string) => schools.lookup(t),
    places,
    orgName: (id: string) => orgName.get(id),
  };
  const docs: PersonDoc[] = [];
  const live = new Set<string>();
  const map = new Map<string, Person>();
  for (const p of people) {
    if (!searchable(p)) continue;
    map.set(p.id, p);
    live.add(p.id);
    const aff = byPersonAff.get(p.id) ?? [];
    const fs: FacetRow[] = facets.get(p.id) ?? [];
    const sig = `${scanSig.length}:${hashString(scanSig)}|${p.updatedAt}|${aff.length}|${aff.map((a) => a.id).join(',').length}|${fs.length}|${
      fs
        .map((f) => f.at)
        .sort()
        .at(-1) ?? ''
    }`;
    const prev = kept.get(p.id);
    if (prev && prev.sig === sig) {
      docs.push(prev.doc);
      continue;
    }
    const doc = buildPersonDoc(p, aff, deps, withScans(p, fs, scans));
    kept.set(p.id, { sig, doc });
    docs.push(doc);
  }
  for (const id of kept.keys()) if (!live.has(id)) kept.delete(id);

  // the tie, joined at query time
  const chatOf = new Set(chats.filter((c: CoffeeChat) => c.stage !== 'archived').map((c) => c.personId));
  const touchBy = new Map<string, RelInfo['touches']>();
  const channelSince: Partial<Record<Channel, string>> = {};
  for (const t of touches) {
    const ch = TOUCH_CHANNEL[t.kind];
    if (!ch) continue;
    const [channel, dir] = ch;
    if (!channelSince[channel] || t.occurredAt < channelSince[channel]!) channelSince[channel] = t.occurredAt;
    let m = touchBy.get(t.personId);
    if (!m) {
      m = {};
      touchBy.set(t.personId, m);
    }
    const c = (m[channel] ??= { inCount: 0, outCount: 0 });
    if (dir === 'in') {
      c.inCount++;
      if (!c.lastIn || t.occurredAt > c.lastIn) c.lastIn = t.occurredAt;
    } else {
      c.outCount++;
      if (!c.lastOut || t.occurredAt > c.lastOut) c.lastOut = t.occurredAt;
    }
  }
  // without the touchpoints, a channel counts as seen when anyone carries a count for it
  if (!opts.touches)
    for (const p of map.values()) {
      const counts = p.strengthBreakdown?.counts ?? {};
      for (const [kind, n] of Object.entries(counts)) {
        const ch = TOUCH_CHANNEL[kind as Touchpoint['kind']];
        if (ch && n && !channelSince[ch[0]]) channelSince[ch[0]] = '';
      }
      if (p.linkedinConnectedOn && channelSince.linkedin === undefined) channelSince.linkedin = '';
    }
  const relCache = new Map<string, RelInfo>();
  const rel = (id: string): RelInfo | undefined => {
    const hit = relCache.get(id);
    if (hit) return hit;
    const p = map.get(id);
    if (!p) return undefined;
    const info: RelInfo = {
      band: BAND_OF(p),
      type: p.relationshipType === 'unknown' ? undefined : p.relationshipType,
      lastConversationAt: p.strengthBreakdown?.lastConversationAt,
      touches: touchBy.get(id) ?? {},
      connectedOn: p.linkedinConnectedOn,
      hasChat: chatOf.has(id),
      tags: p.tags ?? [],
    };
    relCache.set(id, info);
    return info;
  };
  const channel = (c: Channel) => ({
    connected: channelSince[c] !== undefined,
    since: channelSince[c] || undefined,
  });
  const mine = user.school ? schools.lookup(user.school) : undefined;
  const ctx: SearchContext = {
    facts,
    places,
    schools,
    rel,
    channels: {
      email: channel('email'),
      meeting: channel('meeting'),
      text: channel('text'),
      linkedin: channel('linkedin'),
    },
    mySchools: mine ? [mine] : user.school ? [user.school] : [],
    now: Date.now(),
  };
  return { docs, ctx, people: map };
}

/** Test hook. */
export function resetDocsForTests(): void {
  cache.clear();
}
