/**
 * What the chat learns about the student after a turn, in this browser (plan 17 §G). Claude reads the last turns when
 * it is reachable (the student's own key, or Orbit's shared access with its `memory` call); otherwise, or when that
 * fails, Orbit's own rules read clear statements (core/memory/extract.ts). Either way:
 *
 * - every memory's quote must be the student's own words, and nothing touching a sensitive topic is kept;
 * - when Claude says a new memory replaces one it was shown ("Prefers evening calls" after "Prefers morning calls"),
 *   the old one is forgotten, but only a memory of the same kind, about the same person, named by its exact text;
 * - recruiting targets they stated ("I'm targeting PM internships at fintech startups in New York") go to the goals
 *   that drafts and recommendations read and to the recruiting goal record (engine/goals.ts), and only targets that
 *   are in their words;
 * - school, majors, graduation year and city fill profile fields that are empty, never ones the student set.
 */
import type { ChatTurn, Goal, MemoryKind, RecruitingHints, StatedMemory, User } from '@orbit/core';
import {
  extractStatements,
  groundHints,
  looksLikeCompany,
  looksLikeSchool,
  mayHoldFacts,
  memoryKey,
  mergeHints,
  quoteIsFrom,
  sensitiveTopic,
} from '@orbit/core';
import { db, type LocalMemory } from '../db/schema';
import { claudeReachable, llmExtractMemories, overDailyCap } from '../integrations/anthropic';
import { DEFAULT_DAILY_REQUEST_CAP, readPrefs, todaysLlmUsage } from '../integrations/prefs';
import { applyRecruitingTargets, type RecruitingChange } from './goals';
import { MEMORY_KINDS } from './memory';
import { localForget, localMemories, localRemember } from './memoryLocal';
import { updateProfile } from './settings';

export interface Learned {
  /** memories added this turn (not ones that were only refreshed) */
  memories: LocalMemory[];
  refreshed: number;
  /** the texts of memories forgotten because a new one replaced them */
  replaced: string[];
  goals?: RecruitingChange & { goal?: Goal };
  /** profile fields filled because they were empty */
  profile: string[];
  via: 'claude' | 'rules';
}

/** Requests left today below which the chat keeps them for itself rather than spend one on reading a turn. */
const KEEP_FOR_CHAT = 5;

function budgetLeft(): boolean {
  if (overDailyCap()) return false;
  const p = readPrefs();
  const cap = p.llmDailyRequestCap ?? DEFAULT_DAILY_REQUEST_CAP;
  return cap - todaysLlmUsage(p).requests > KEEP_FOR_CHAT;
}

/** The one person whose name the student used ("Maya Chen", or a first name only one person has). */
async function personNamed(userId: string, name: string | null | undefined): Promise<string | undefined> {
  const n = name?.trim().toLowerCase();
  if (!n) return undefined;
  const people = await db.people.where('userId').equals(userId).toArray();
  const full = people.filter((p) => !p.hiddenAt && p.displayName.trim().toLowerCase() === n);
  if (full.length === 1) return full[0]!.id;
  if (n.includes(' ')) return undefined;
  const first = people.filter((p) => !p.hiddenAt && (p.firstName ?? '').trim().toLowerCase() === n);
  return first.length === 1 ? first[0]!.id : undefined;
}

/** A memory read from the turn, with the known memories (by text) it makes outdated. */
type ReadMemory = StatedMemory & { replaces?: string[] };

interface Found {
  memories: ReadMemory[];
  recruiting?: RecruitingHints;
  profile?: ReturnType<typeof extractStatements>['profile'];
  via: 'claude' | 'rules';
}

/** Claude's read of the turns, checked: quotes from the student, no sensitive topics, targets they said. */
async function claudeRead(turns: ChatTurn[], said: string, known: string[]): Promise<Found | undefined> {
  const r = await llmExtractMemories(turns, known);
  if (!r) return undefined;
  const memories: ReadMemory[] = [];
  for (const m of r.memories) {
    const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text || !m.quote?.trim() || !quoteIsFrom(m.quote, said)) continue;
    if (sensitiveTopic(`${text} ${m.quote}`)) continue;
    if (!(MEMORY_KINDS as readonly string[]).includes(m.kind)) continue;
    memories.push({
      kind: m.kind as MemoryKind,
      text,
      quote: m.quote.trim(),
      importance: Number.isFinite(m.importance) ? Math.max(0, Math.min(1, m.importance)) : 0.5,
      personName: m.person_name ?? undefined,
      replaces: (m.replaces ?? []).filter((s) => typeof s === 'string' && s.trim()),
    });
  }
  const rec =
    r.recruiting && quoteIsFrom(r.recruiting.quote, said)
      ? groundHints(
          {
            functions: r.recruiting.functions,
            industries: r.recruiting.industries,
            locations: r.recruiting.locations,
            organizations: r.recruiting.organizations,
            phrase: r.recruiting.phrase ?? undefined,
          },
          said,
          r.recruiting.quote,
        )
      : undefined;
  return { memories, recruiting: rec, via: 'claude' };
}

/**
 * Learn from the turn that just ended: `turns` are the last turns (oldest first), the last student turn among them is
 * the one just answered. Resolves to what was kept; never throws for a model failure (the rules take over).
 */
export async function learnFromTurn(
  user: Pick<User, 'id'>,
  turns: ChatTurn[],
  opts: { sourceTurn?: LocalMemory['sourceTurn']; now?: Date; claude?: boolean } = {},
): Promise<Learned> {
  const now = opts.now ?? new Date();
  const userTurns = turns.filter((t) => t.role === 'user');
  const last = userTurns[userTurns.length - 1]?.text ?? '';
  const out: Learned = { memories: [], refreshed: 0, replaced: [], profile: [], via: 'rules' };
  if (!last.trim()) return out;
  const rules = extractStatements(last);
  let found: Found = { ...rules, via: 'rules' };
  const tryClaude =
    (opts.claude ?? true) && mayHoldFacts(last) && claudeReachable('chat', 'memory') && budgetLeft();
  // the memories Claude is shown, so it does not find them again and can say which one a new one replaces
  const shown: LocalMemory[] = tryClaude ? (await localMemories(user.id)).slice(0, 20) : [];
  if (tryClaude) {
    const said = userTurns
      .slice(-2)
      .map((t) => t.text)
      .join('\n');
    const known = shown.map((m) => m.text);
    const read = await claudeRead(turns, said, known).catch(() => undefined);
    if (read)
      found = {
        memories: read.memories,
        // Orbit's own reading of the targets is exact; Claude's adds what the rules missed
        recruiting: rules.recruiting
          ? read.recruiting
            ? mergeHints(rules.recruiting, read.recruiting)
            : rules.recruiting
          : read.recruiting,
        profile: rules.profile,
        via: 'claude',
      };
  }
  out.via = found.via;

  for (const m of found.memories) {
    const personId = m.personName ? await personNamed(user.id, m.personName) : undefined;
    const r = await localRemember(
      user.id,
      {
        text: m.text,
        kind: m.kind,
        quote: m.quote,
        importance: m.importance,
        personId,
        source: found.via === 'claude' ? 'chat' : 'rules',
        sourceTurn: opts.sourceTurn,
      },
      now,
    );
    if (!r) continue;
    if (r.deduped) out.refreshed++;
    else out.memories.push(r.memory);
    // the student changed their mind: the memory this one replaces goes, when it is one Claude was shown, of the
    // same kind, about the same person and named by its exact words (never the one the new text was merged into)
    for (const old of m.replaces ?? []) {
      const gone = shown.find(
        (x) =>
          x.id !== r.memory.id &&
          x.kind === m.kind &&
          (x.personId ?? null) === (personId ?? null) &&
          memoryKey(x.text) === memoryKey(old),
      );
      if (gone && (await localForget(user.id, gone.id, now))) out.replaced.push(gone.text);
    }
  }

  if (found.recruiting) {
    const h = found.recruiting;
    out.goals = await applyRecruitingTargets(
      user,
      {
        functions: h.functions,
        roles: h.roles,
        industries: h.industries,
        locations: h.locations,
        organizations: h.organizations,
        cycleLabel: h.cycleLabel,
        phrase: h.phrase,
        stage: h.stage,
      },
      { evidence: h.quote, now },
    );
  }

  const p = found.profile;
  if (p) {
    const me = await db.users.get(user.id);
    if (me) {
      const patch: Parameters<typeof updateProfile>[1] = {};
      if (p.school && !me.school?.trim() && looksLikeSchool(p.school) && !looksLikeCompany(p.school))
        patch.school = p.school;
      if (p.majors?.length && !me.majors?.length) patch.majors = p.majors;
      if (p.graduationYear && !me.graduationYear) patch.graduationYear = p.graduationYear;
      if (p.currentCity && !me.currentCity?.trim()) patch.currentCity = p.currentCity;
      if (Object.keys(patch).length) {
        await updateProfile(user.id, patch);
        out.profile = Object.keys(patch);
      }
    }
  }
  return out;
}

const FIELD_WORDS: Record<string, string> = {
  school: 'school',
  majors: 'majors',
  graduationYear: 'graduation year',
  currentCity: 'city',
};

/** One or two short lines telling the student what Orbit kept, or undefined when nothing new was kept. */
export function learnedNote(l: Learned): string | undefined {
  const parts: string[] = [];
  if (l.memories.length)
    parts.push(
      `Noted for later: ${l.memories
        .slice(0, 3)
        .map((m) => m.text.replace(/[.\s]+$/, ''))
        .join('; ')}.`,
    );
  if (l.replaced.length)
    parts.push(
      `Forgot the old version: ${l.replaced
        .slice(0, 3)
        .map((t) => t.replace(/[.\s]+$/, ''))
        .join('; ')}.`,
    );
  const a = l.goals?.added;
  const goalBits = a
    ? [
        ...a.roles,
        ...a.industries,
        ...a.locations,
        ...a.organizations,
        ...(l.goals?.cycleChanged ? [l.goals.goals.cycleLabel] : []),
      ]
    : [];
  if (goalBits.length) parts.push(`Added to your goals: ${goalBits.slice(0, 6).join(', ')}.`);
  if (l.profile.length)
    parts.push(`Filled in your profile's ${l.profile.map((f) => FIELD_WORDS[f] ?? f).join(' and ')}.`);
  return parts.length ? parts.join(' ') : undefined;
}
