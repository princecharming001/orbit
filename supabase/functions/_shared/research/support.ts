/**
 * The support check (docs/plan/20 §4): after the brief is written, a fast model reads each claim beside the pages it
 * cites and says whether they say it. An unsupported claim is removed; a partly supported one stays in the brief,
 * marked, but never becomes an opener, a draft line or a fact. Only claims the check calls supported become facts.
 *
 * The verdict is kept on each claim as `support`: 'full', 'partial', or 'unchecked' when the check could not run (out
 * of time or money); an unchecked claim is treated like a partial one for drafts and facts.
 */
import type { ClaudeDep } from './deps';
import { carefulItems } from './dossier';
import { type DossierContent, type SupportClaim, supportSchema, supportSystem, supportUser } from './prompts';

export type Support = 'full' | 'partial' | 'unchecked';

/** A list section of the brief whose items carry `source_ids`. */
const LIST_SECTIONS = ['recently', 'in_common', 'openers', 'highlights', 'company', 'careful'] as const;
type ListSection = (typeof LIST_SECTIONS)[number];

/** How each part of the brief is named to the checker. */
const KIND: Record<string, string> = {
  who: 'summary',
  now: 'current role',
  recently: 'recent item',
  in_common: 'in common with the student',
  openers: 'opener',
  highlights: 'highlight',
  company: 'company news',
  careful: 'company caution',
};

interface Located {
  claim: SupportClaim;
  where: { section: 'now' | 'who' } | { section: ListSection; index: number };
}

function claimText(section: ListSection, item: Record<string, unknown>): string {
  if (section === 'highlights')
    return [item.title, item.summary].filter((x) => typeof x === 'string' && x).join(': ');
  return String(item.text ?? '');
}

/** Every checkable claim of a brief, numbered, with the source ids it cites. */
export function claimsOf(d: DossierContent, allSourceIds: string[]): Located[] {
  const out: Located[] = [];
  let n = 0;
  const add = (text: string, sourceIds: string[], where: Located['where']) => {
    if (!text.trim() || sourceIds.length === 0) return;
    out.push({ claim: { id: `C${++n}`, text, sourceIds, kind: KIND[where.section] }, where });
  };
  // "who" is a summary of everything: it may lean on any source
  add(d.who, allSourceIds, { section: 'who' });
  const nowText = [d.now.role, d.now.org && `at ${d.now.org}`, d.now.since && `since ${d.now.since}`]
    .filter(Boolean)
    .join(' ');
  add(nowText, d.now.source_ids, { section: 'now' });
  for (const section of LIST_SECTIONS) {
    const list = (section === 'careful' ? carefulItems(d.careful) : (d[section] ?? [])) as unknown as Record<
      string,
      unknown
    >[];
    list.forEach((item, index) => {
      add(claimText(section, item), (item.source_ids as string[]) ?? [], { section, index });
    });
  }
  return out;
}

export interface SupportResult {
  content: DossierContent;
  checked: boolean;
  costUsd: number;
  /** claims removed as unsupported, and claims kept as partly supported */
  removed: number;
  partial: number;
  supported: number;
  /** what was removed or kept out of the openers, for the live check only (never logged: it names the person) */
  dropped?: string[];
}

/** Mark every claim with `support` and drop what the check said is not supported. */
export function applyVerdicts(
  d: DossierContent,
  located: Located[],
  verdicts: Map<string, 'supported' | 'partial' | 'unsupported'> | null,
  fallbackWho: string,
): Omit<SupportResult, 'costUsd' | 'checked'> & { dropped: string[] } {
  const dropped: string[] = [];
  const mark = (id: string | undefined): Support | 'drop' => {
    if (!verdicts) return 'unchecked';
    const v = id ? verdicts.get(id) : undefined;
    if (v === 'supported') return 'full';
    if (v === 'partial') return 'partial';
    // a claim the checker skipped is not counted as supported
    return v === 'unsupported' ? 'drop' : 'unchecked';
  };
  const idOf = (pred: (w: Located['where']) => boolean) => located.find((l) => pred(l.where))?.claim.id;
  let removed = 0;
  let partial = 0;
  let supported = 0;
  const count = (s: Support | 'drop') => {
    if (s === 'drop') removed++;
    else if (s === 'partial') partial++;
    else if (s === 'full') supported++;
  };
  const whoMark = mark(idOf((w) => w.section === 'who'));
  count(whoMark);
  const nowMark = mark(idOf((w) => w.section === 'now'));
  count(nowMark);
  const out: DossierContent & Record<string, unknown> = {
    ...d,
    who: whoMark === 'drop' ? fallbackWho : d.who,
    now:
      nowMark === 'drop'
        ? { ...d.now, source_ids: [] }
        : ({ ...d.now, support: nowMark } as DossierContent['now']),
  };
  for (const section of LIST_SECTIONS) {
    const list = (section === 'careful' ? carefulItems(d.careful) : (d[section] ?? [])) as unknown as Record<
      string,
      unknown
    >[];
    const kept: Record<string, unknown>[] = [];
    list.forEach((item, index) => {
      const m = mark(idOf((w) => w.section === section && 'index' in w && w.index === index));
      count(m);
      if (m === 'drop') {
        dropped.push(`unsupported ${section}: ${claimText(section, item)}`);
        return;
      }
      // a partly supported opener is never offered: openers go into first messages as they are
      if (section === 'openers' && m === 'partial') {
        dropped.push(`partial opener: ${claimText(section, item)}`);
        return;
      }
      kept.push({ ...item, support: m });
    });
    (out as Record<string, unknown>)[section] = kept;
  }
  (out as Record<string, unknown>).who_support = whoMark === 'drop' ? 'full' : whoMark;
  if (whoMark === 'drop') dropped.push(`unsupported who: ${d.who}`);
  if (nowMark === 'drop') dropped.push(`unsupported now: ${d.now.role} at ${d.now.org}`);
  return { content: out as DossierContent, removed, partial, supported, dropped };
}

/**
 * Run the check (one call, on the fast model) and apply it. When the call cannot run or fails, every claim is marked
 * 'unchecked' and nothing is removed: the brief stays, but nothing from it becomes a fact or a draft line.
 */
export async function supportCheck(
  claude: ClaudeDep,
  d: DossierContent,
  sources: { id: string; text: string; url?: string; title?: string }[],
  opts: { budgetUsd: number; timeoutMs: number; fallbackWho: string },
): Promise<SupportResult> {
  const located = claimsOf(
    d,
    sources.map((s) => s.id),
  );
  const user = supportUser(
    located.map((l) => l.claim),
    sources,
  );
  // the fast model: $0.10/M in, $0.50/M out
  const est = (user.length / 4) * 0.1e-6 + 2000 * 0.5e-6;
  if (located.length === 0 || est > opts.budgetUsd || opts.timeoutMs < 3000) {
    const r = applyVerdicts(d, located, null, opts.fallbackWho);
    return { ...r, checked: false, costUsd: 0 };
  }
  const res = await claude.parse('support', supportSchema, {
    system: supportSystem,
    user,
    timeoutMs: opts.timeoutMs,
  });
  if (!res.ok) {
    const r = applyVerdicts(d, located, null, opts.fallbackWho);
    return { ...r, checked: false, costUsd: res.costUsd ?? 0 };
  }
  const verdicts = new Map(res.value.verdicts.map((v) => [v.id, v.verdict] as const));
  const r = applyVerdicts(d, located, verdicts, opts.fallbackWho);
  return { ...r, checked: true, costUsd: res.costUsd };
}
