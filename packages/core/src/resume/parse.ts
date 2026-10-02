import type { ResumeFacet } from '../types';

const SECTION =
  /^(experience|work experience|professional experience|employment|education|projects?|skills|technical skills|interests|activities|leadership|summary|objective|awards|publications|certifications)\b[:\s]*$/i;
const SKILL_SPLIT = /[,;•|]/;
const DATE_RANGE =
  /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})\s*(?:-|–|—|to)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}|present|current)/i;
const STOP = new Set([
  'the',
  'and',
  'with',
  'for',
  'that',
  'this',
  'from',
  'into',
  'using',
  'used',
  'across',
  'over',
  'under',
  'while',
  'where',
  'which',
  'their',
  'them',
  'they',
  'have',
  'has',
  'had',
  'was',
  'were',
  'our',
  'your',
  'you',
  'are',
  'but',
  'not',
  'all',
  'any',
  'can',
  'will',
  'per',
  'via',
  'led',
  'built',
  'worked',
  'team',
  'university',
  'school',
  'college',
  'student',
]);

export function extractKeywords(text: string, max = 12): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z+#.]{2,}/g) ?? []) {
    if (STOP.has(w) || w.length < 4) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function toIsoMonth(s: string): string | undefined {
  const t = s.toLowerCase();
  if (/present|current/.test(t)) return undefined;
  const m = t.match(/([a-z]{3})[a-z]*\.?\s+(\d{4})/);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mo = months.indexOf(m[1]!);
    return mo >= 0 ? `${m[2]}-${String(mo + 1).padStart(2, '0')}-01` : `${m[2]}-01-01`;
  }
  const y = t.match(/(\d{4})/);
  return y ? `${y[1]}-01-01` : undefined;
}

/** Heuristic resume parser over plain text. Good enough to seed facets the student then confirms. */
export function heuristicResumeParse(text: string, resumeId: string): ResumeFacet[] {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim());
  let section = 'summary';
  const facets: ResumeFacet[] = [];
  let current: { header: string; body: string[] } | undefined;
  let id = 0;
  const push = () => {
    if (!current) return;
    const header = current.header;
    const body = current.body.join(' ').trim();
    const dr = header.match(DATE_RANGE) ?? body.match(DATE_RANGE);
    const kind: ResumeFacet['kind'] = section.startsWith('edu')
      ? 'education'
      : section.startsWith('project')
        ? 'project'
        : section.startsWith('lead') || section.startsWith('activ')
          ? 'experience'
          : 'experience';
    const [title, org] = header.split(/\s+[-–—|@]\s+|,\s+/).map((s) => s.replace(DATE_RANGE, '').trim());
    facets.push({
      id: `${resumeId}-f${id++}`,
      resumeId,
      kind,
      title: title || undefined,
      organizationName: org || undefined,
      startDate: dr ? toIsoMonth(dr[1]!) : undefined,
      endDate: dr ? toIsoMonth(dr[2]!) : undefined,
      text: `${header}. ${body}`.slice(0, 1200),
      keywords: extractKeywords(`${header} ${body}`),
      confirmed: false,
    });
    current = undefined;
  };
  for (const line of lines) {
    if (!line) continue;
    if (SECTION.test(line)) {
      push();
      section = line.toLowerCase();
      continue;
    }
    if (section.includes('skill')) {
      const items = line
        .split(SKILL_SPLIT)
        .map((s) => s.replace(/^[a-z ]+:/i, '').trim())
        .filter((s) => s.length > 1 && s.length < 40);
      if (items.length)
        facets.push({
          id: `${resumeId}-f${id++}`,
          resumeId,
          kind: 'skill_group',
          text: items.join(', '),
          keywords: items.map((i) => i.toLowerCase()),
          confirmed: false,
        });
      continue;
    }
    if (section.includes('interest')) {
      facets.push({
        id: `${resumeId}-f${id++}`,
        resumeId,
        kind: 'interest',
        text: line,
        keywords: extractKeywords(line, 6),
        confirmed: false,
      });
      continue;
    }
    if (section === 'summary' || section.includes('objective')) {
      const last = facets.find((f) => f.kind === 'summary');
      if (last) last.text = `${last.text} ${line}`.slice(0, 600);
      else
        facets.push({
          id: `${resumeId}-f${id++}`,
          resumeId,
          kind: 'summary',
          text: line,
          keywords: extractKeywords(line, 8),
          confirmed: false,
        });
      continue;
    }
    const isBullet = /^[-•*▪◦]/.test(line);
    const looksHeader =
      !isBullet &&
      (DATE_RANGE.test(line) ||
        (line.length < 90 &&
          /[A-Z]/.test(line[0] ?? '') &&
          !/[.!?]$/.test(line) &&
          (current === undefined || current.body.length > 0)));
    if (looksHeader) {
      push();
      current = { header: line.replace(/^[-•*▪◦]\s*/, ''), body: [] };
    } else if (current) current.body.push(line.replace(/^[-•*▪◦]\s*/, ''));
    else current = { header: line, body: [] };
  }
  push();
  return facets.filter((f) => f.text.length > 8);
}
