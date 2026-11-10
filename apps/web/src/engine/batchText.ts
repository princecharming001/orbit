/**
 * The words of a batch (plan 38 §B2): the student's own message with `{first}`, `{company}`, `{title}`, `{school}`
 * filled in per person, what is left unfilled (that message waits for a line), and whether the messages read so much
 * alike that a spam filter would group them. Pure.
 */

export const TEMPLATE_FIELDS = ['first', 'last', 'name', 'company', 'title', 'school'] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

export const FIELD_LABELS: Record<TemplateField, string> = {
  first: 'First name',
  last: 'Last name',
  name: 'Full name',
  company: 'Company',
  title: 'Title',
  school: 'School',
};

export interface FillPerson {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  currentOrganizationRaw?: string;
  currentTitle?: string;
  school?: string;
}

const FIELD = /\{\{?\s*(first|last|name|company|title|school)\s*\}?\}/gi;

function fieldValue(f: TemplateField, p: FillPerson): string | undefined {
  const v =
    f === 'first'
      ? p.firstName || p.displayName?.split(/\s+/)[0]
      : f === 'last'
        ? p.lastName || p.displayName?.split(/\s+/).slice(1).join(' ')
        : f === 'name'
          ? p.displayName
          : f === 'company'
            ? p.currentOrganizationRaw
            : f === 'title'
              ? p.currentTitle
              : p.school;
  return v?.trim() || undefined;
}

/** The message for one person, and the fields Orbit could not fill for them (left in braces). */
export function fillTemplate(text: string, p: FillPerson): { text: string; missing: TemplateField[] } {
  const missing = new Set<TemplateField>();
  const out = text.replace(FIELD, (_whole, name: string) => {
    const f = name.toLowerCase() as TemplateField;
    const v = fieldValue(f, p);
    if (!v) {
      missing.add(f);
      return `{${f}}`;
    }
    return v;
  });
  return { text: out, missing: [...missing] };
}

/** The fields a message uses, in order, once each. */
export function fieldsIn(text: string): TemplateField[] {
  return [...new Set([...text.matchAll(FIELD)].map((m) => m[1]!.toLowerCase() as TemplateField))];
}

function shingles(text: string, drop: string[]): Set<string> {
  let t = text.toLowerCase();
  for (const d of drop) if (d) t = t.split(d.toLowerCase()).join(' ');
  const words = t
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** How alike two messages are, 0 to 1, with each one's own names taken out first. */
export function likeness(a: string, b: string, drop: string[] = []): number {
  const x = shingles(a, drop);
  const y = shingles(b, drop);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / (x.size + y.size - both);
}

/** Two messages that read this alike count as the same to a filter. */
export const SAME_ABOVE = 0.8;

/**
 * How many of the messages have a near twin in the batch. Checked against a few others each, so a long batch stays
 * quick: the same words to many people show up in any sample.
 */
export function nearTwins(msgs: { body: string; names: string[] }[]): number {
  let n = 0;
  for (let i = 0; i < msgs.length; i++) {
    for (let j = 0; j < msgs.length && j < 12; j++) {
      if (i === j) continue;
      if (likeness(msgs[i]!.body, msgs[j]!.body, [...msgs[i]!.names, ...msgs[j]!.names]) >= SAME_ABOVE) {
        n++;
        break;
      }
    }
  }
  return n;
}
