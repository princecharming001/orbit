/**
 * The school field's suggestions: every active degree-granting US college (IPEDS) and universities elsewhere, with
 * the names students use ("UMich", "Cal", "Georgia Tech"). Built by scripts/schools/build.py into schools.json, which
 * is loaded the first time someone types in the field.
 */
import type { Suggestion } from '../ui/Suggest';

/** [name, domain, where, aliases joined by |, kind: 1 US four-year, 2 US two-year, 3 outside the US] */
type Row = [string, string, string, string, number];

export interface School {
  name: string;
  domain: string;
  where: string;
  aliases: string[];
  kind: 1 | 2 | 3;
}

let loaded: Promise<School[]> | undefined;

export function loadSchools(): Promise<School[]> {
  loaded ??= import('./schools.json').then((m) =>
    (m.default as Row[]).map(([name, domain, where, aliases, kind]) => ({
      name,
      domain,
      where,
      aliases: aliases ? aliases.split('|') : [],
      kind: kind as 1 | 2 | 3,
    })),
  );
  return loaded;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** How well a school matches what was typed: 0 for no match; higher is better. */
export function schoolScore(s: School, query: string): number {
  const q = fold(query);
  if (!q) return 0;
  const name = fold(s.name);
  let best = 0;
  const consider = (text: string, weight: number) => {
    if (!text) return;
    if (text === q) best = Math.max(best, 100 * weight);
    else if (text.startsWith(q))
      best = Math.max(best, (80 - Math.min(20, text.length - q.length) / 4) * weight);
    else if (text.split(' ').some((w) => w.startsWith(q))) best = Math.max(best, 60 * weight);
    else if (q.split(' ').every((w) => text.includes(w))) best = Math.max(best, 40 * weight);
    else if (text.includes(q)) best = Math.max(best, 30 * weight);
  };
  consider(name, 1);
  for (const a of s.aliases) consider(fold(a), 1.05);
  // "berkeley.edu", "umich" typed as a domain
  consider(s.domain.replace(/\.(edu|ac\.uk|edu\.[a-z]+)$/, ''), 0.9);
  if (!best) return 0;
  // the big schools first among equal matches: US four-year, then two-year, then abroad
  return best + (s.kind === 1 ? 3 : s.kind === 2 ? 1 : 0) + (name.includes('university') ? 1 : 0);
}

export async function suggestSchools(query: string, limit = 8): Promise<Suggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const all = await loadSchools();
  const scored: { s: School; score: number }[] = [];
  for (const s of all) {
    const score = schoolScore(s, q);
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);
  return scored.slice(0, limit).map(({ s }) => ({ value: s.name, sub: s.where }));
}

/** The school's web domain, for the email domain Orbit uses to spot alumni. */
export async function schoolDomainFor(name: string): Promise<string | undefined> {
  const all = await loadSchools();
  return all.find((s) => s.name === name)?.domain || undefined;
}
