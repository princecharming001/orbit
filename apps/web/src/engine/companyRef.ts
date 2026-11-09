/**
 * Which company a name in the student's ask means (plan 37 §3.3). "Triumph" can be Triumph Law or Triumph Education
 * Group: the answer is then a question, never a guess. Model-free and structural: it only ever asks when two or more
 * distinct companies on file start with the name and the student knows someone at each (or has it as a target).
 *
 * Order (plan 37 R2): a pick the student already made in this conversation, the one company whose key is exactly the
 * name, a target company that starts with it, then the candidates. A known parent ("Amazon", "Google") never asks:
 * the search already covers its brands.
 */
import type { Affiliation, Organization, Person, TargetCompany } from '@orbit/core';
import { keysFor, orgKey } from '@orbit/core/search';
import type { ChatConversation, Resolution } from '../chat/types';
import { db } from '../db/schema';

export interface CompanyOption {
  /** the organization id when there is one, else the company's name as people list it */
  id: string;
  label: string;
  organizationId?: string;
  /** one line: what it is and who the student knows there */
  sub: string;
  people: number;
}

export type CompanyRef =
  | { kind: 'one'; label: string; id: string; organizationId?: string }
  | { kind: 'many'; term: string; options: CompanyOption[] }
  | { kind: 'none' };

interface Entry {
  key: string;
  label: string;
  organizationId?: string;
  industry?: string;
  now: number;
  former: number;
  target: boolean;
}

/** The most options a question offers. */
export const MAX_OPTIONS = 4;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function subOf(e: Entry): string {
  const who = e.now
    ? `${plural(e.now, 'person', 'people')} you know there`
    : e.former
      ? `${plural(e.former, 'person', 'people')} who used to work there`
      : 'On your targets';
  return e.industry ? `${e.industry}. ${who}` : who;
}

/** Every company the student's data names, keyed by orgKey, with how many people they know there now and before. */
export function companyEntries(input: {
  people: Pick<Person, 'id' | 'currentOrganizationId' | 'currentOrganizationRaw' | 'isHuman' | 'hiddenAt'>[];
  orgs: Pick<Organization, 'id' | 'name' | 'industry'>[];
  affiliations: Pick<Affiliation, 'personId' | 'organizationId' | 'nameRaw' | 'isCurrent' | 'kind'>[];
  targets: Pick<TargetCompany, 'organizationId' | 'nameRaw'>[];
}): Map<string, Entry> {
  const byKey = new Map<string, Entry>();
  const orgById = new Map(input.orgs.map((o) => [o.id, o]));
  const entry = (raw: string | undefined, organizationId?: string): Entry | undefined => {
    const org = organizationId ? orgById.get(organizationId) : undefined;
    const key = orgKey(org?.name ?? raw);
    if (!key) return undefined;
    let e = byKey.get(key);
    if (!e) {
      e = { key, label: org?.name ?? raw!.trim(), now: 0, former: 0, target: false };
      byKey.set(key, e);
    }
    if (org && !e.organizationId) {
      e.organizationId = org.id;
      e.label = org.name;
      e.industry = org.industry;
    }
    return e;
  };
  for (const o of input.orgs) entry(o.name, o.id);
  const live = new Set<string>();
  for (const p of input.people) {
    if (!p.isHuman || p.hiddenAt) continue;
    live.add(p.id);
    const e = entry(p.currentOrganizationRaw, p.currentOrganizationId);
    if (e) e.now++;
  }
  const formerSeen = new Set<string>();
  for (const a of input.affiliations) {
    if (a.kind !== 'employment' || a.isCurrent || !live.has(a.personId)) continue;
    const e = entry(a.nameRaw, a.organizationId);
    if (!e) continue;
    const k = `${e.key}|${a.personId}`;
    if (formerSeen.has(k)) continue;
    formerSeen.add(k);
    e.former++;
  }
  for (const t of input.targets) {
    const e = entry(t.nameRaw, t.organizationId);
    if (e) e.target = true;
  }
  return byKey;
}

/** The pure decision, over entries already gathered (tests call this directly). */
export function decideCompany(
  name: string,
  entries: Map<string, Entry>,
  resolved: Resolution[] = [],
): CompanyRef {
  const term = name.trim();
  const qk = orgKey(term);
  if (!qk || qk.length < 3) return { kind: 'none' };
  const picked = resolved.find((r) => r.about === 'company' && r.term === qk);
  if (picked)
    return { kind: 'one', label: picked.label, id: picked.id, organizationId: picked.organizationId };
  // a direct id
  for (const e of entries.values())
    if (e.organizationId === term)
      return { kind: 'one', label: e.label, id: e.organizationId, organizationId: e.organizationId };
  // a parent whose brands the search already covers: asking "which Amazon" would be a question for show
  if (keysFor(term).length > 1) return { kind: 'none' };
  const known = (e: Entry) => e.now + e.former > 0 || e.target;
  const exact = entries.get(qk);
  if (exact && known(exact)) return one(exact);
  // whole words from the start: "Triumph" covers "Triumph Law", never "Law" or "Triumphant"
  const starts = [...entries.values()].filter((e) => e.key.startsWith(`${qk} `) && known(e));
  if (!starts.length) return exact ? one(exact) : { kind: 'none' };
  const targets = starts.filter((e) => e.target);
  if (targets.length === 1) return one(targets[0]!);
  if (starts.length === 1) return one(starts[0]!);
  const options = starts
    .sort(
      (a, b) =>
        b.now - a.now ||
        b.former - a.former ||
        Number(b.target) - Number(a.target) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, MAX_OPTIONS)
    .map((e) => ({
      id: e.organizationId ?? e.label,
      label: e.label,
      organizationId: e.organizationId,
      sub: subOf(e),
      people: e.now + e.former,
    }));
  return { kind: 'many', term, options };
}

function one(e: Entry): CompanyRef {
  return { kind: 'one', label: e.label, id: e.organizationId ?? e.label, organizationId: e.organizationId };
}

/** Picks in conversations Dexie does not hold (a temporary chat), and a copy of the rest for this page load. */
const picks = new Map<string, Resolution[]>();

/** The student's picks in one conversation (plan 37 R5). */
export async function resolutionsFor(conversationId: string | undefined): Promise<Resolution[]> {
  if (!conversationId) return [];
  const c = (await db.chatConversations.get(conversationId)) as ChatConversation | undefined;
  return c?.resolved ?? picks.get(conversationId) ?? [];
}

/** Keep a pick for the rest of the conversation; a later pick for the same name replaces it. */
export async function rememberResolution(conversationId: string, r: Resolution): Promise<void> {
  const c = (await db.chatConversations.get(conversationId)) as ChatConversation | undefined;
  const before = c?.resolved ?? picks.get(conversationId) ?? [];
  const resolved = [...before.filter((x) => !(x.about === r.about && x.term === r.term)), r];
  picks.set(conversationId, resolved);
  if (c) await db.chatConversations.update(conversationId, { resolved });
}

/** Which company `name` means for this student, in this conversation. */
export async function resolveCompanyRef(
  userId: string,
  name: string,
  conversationId?: string,
): Promise<CompanyRef> {
  const [people, orgs, affiliations, targets, resolved] = await Promise.all([
    db.people.where('userId').equals(userId).toArray(),
    db.organizations.toArray(),
    db.affiliations.where('userId').equals(userId).toArray(),
    db.targetCompanies.where('userId').equals(userId).toArray(),
    resolutionsFor(conversationId),
  ]);
  return decideCompany(name, companyEntries({ people, orgs, affiliations, targets }), resolved);
}
