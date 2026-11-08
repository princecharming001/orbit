/**
 * The people a turn's results named (search rows, routes, a profile), so the answer's words can bold each name and link
 * it to their LinkedIn profile, or to their page in Orbit when LinkedIn is not known. Read from the cards' own data,
 * not from the model's formatting, so it holds whatever the answer's wording.
 */
export interface NamedPerson {
  name: string;
  href: string;
  external: boolean;
}

const LINKEDIN = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s"'<>]+$/i;

function visit(v: unknown, out: Map<string, NamedPerson>, depth: number): void {
  if (!v || typeof v !== 'object' || depth > 5) return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 200)) visit(x, out, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  const name = typeof o.displayName === 'string' ? o.displayName.trim() : '';
  // a person: a name with two words at least, and an id or a profile (a company has neither shape)
  if (name && /\S+\s+\S+/.test(name) && name.length <= 80 && !out.has(name.toLowerCase())) {
    const li = typeof o.linkedinUrl === 'string' && LINKEDIN.test(o.linkedinUrl) ? o.linkedinUrl : undefined;
    const id = typeof o.id === 'string' ? o.id : undefined;
    if (li || id)
      out.set(name.toLowerCase(), {
        name,
        href: li ?? `/people/${encodeURIComponent(id!)}`,
        external: !!li,
      });
  }
  for (const [k, x] of Object.entries(o)) if (k !== 'forModel') visit(x, out, depth + 1);
}

/** Everyone named in these results, longest names first (so "Andrew Israel" wins over a shorter overlap). */
export function namedPeople(datas: unknown[]): NamedPerson[] {
  const out = new Map<string, NamedPerson>();
  for (const d of datas) visit(d, out, 0);
  return [...out.values()].sort((a, b) => b.name.length - a.name.length);
}
