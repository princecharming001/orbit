export interface LinkedInConnectionRow {
  firstName: string;
  lastName: string;
  url?: string;
  email?: string;
  company?: string;
  position?: string;
  connectedOn?: string; // ISO date
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseConnectedOn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    if (mo !== undefined)
      return new Date(Date.UTC(Number(m[3]), mo, Number(m[1]))).toISOString().slice(0, 10);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** Parses LinkedIn's Connections.csv (tolerates the "Notes:" preamble lines before the header). */
export function parseConnectionsCsv(text: string): { rows: LinkedInConnectionRow[]; skipped: number } {
  const all = parseCsv(text);
  const headerIdx = all.findIndex((r) => r.some((c) => /^first name$/i.test(c.trim())));
  if (headerIdx < 0) return { rows: [], skipped: all.length };
  const header = all[headerIdx]!.map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const iFirst = col('first name');
  const iLast = col('last name');
  const iUrl = col('url');
  const iEmail = col('email address');
  const iCompany = col('company');
  const iPos = col('position');
  const iOn = col('connected on');
  const rows: LinkedInConnectionRow[] = [];
  let skipped = 0;
  for (const r of all.slice(headerIdx + 1)) {
    const first = (r[iFirst] ?? '').trim();
    const last = (r[iLast] ?? '').trim();
    if (!first && !last) {
      skipped++;
      continue;
    }
    rows.push({
      firstName: first,
      lastName: last,
      url: (iUrl >= 0 ? r[iUrl] : '')?.trim() || undefined,
      email: (iEmail >= 0 ? r[iEmail] : '')?.trim() || undefined,
      company: (iCompany >= 0 ? r[iCompany] : '')?.trim() || undefined,
      position: (iPos >= 0 ? r[iPos] : '')?.trim() || undefined,
      connectedOn: parseConnectedOn(iOn >= 0 ? r[iOn] : undefined),
    });
  }
  return { rows, skipped };
}
