/**
 * The answer format sent to the model, with its "one of these values" rules put back.
 *
 * The Anthropic SDK turns a zod schema into the JSON schema a structured answer is held to. Its transform keeps only
 * the keywords it knows and writes every other one into the field's description as text. `enum` and `const` are among
 * the ones it writes out, although the API enforces both. So a field that may only be "must" or "nice" was sent as
 * any string with the note `{enum: ["must","nice"]}`, the model now and then answered `"\"must\""` or another word,
 * the answer failed its own schema, and the whole reading was thrown away (a search then fell back to rules).
 *
 * `strictSchema` walks the transformed schema and moves those two keywords back where the API reads them.
 */

/** The value that follows `key: ` at `at` in the SDK's note, as text (a JSON value, by bracket and quote matching). */
function jsonAt(text: string, at: number): string | undefined {
  const first = text[at];
  if (first === undefined) return undefined;
  if (first !== '[' && first !== '{' && first !== '"') {
    // a bare number, true, false or null
    const m = text.slice(at).match(/^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)/i);
    return m?.[0];
  }
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') {
        inString = false;
        if (depth === 0) return text.slice(at, i + 1);
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return undefined;
}

const KEPT = ['enum', 'const'] as const;

/**
 * One description as the SDK left it: the keywords the API enforces are taken out of the note and returned, the rest
 * of the description stays as it was.
 */
export function liftKeywords(description: string): { description?: string; lifted: Record<string, unknown> } {
  const lifted: Record<string, unknown> = {};
  // the note is the last brace group of the description: "{key: value, key: value}"
  const open = description.lastIndexOf('{');
  const noteAt = (() => {
    // the note starts the description, or follows a blank line after the field's own words
    for (let i = description.length - 1; i >= 0; i--) {
      if (description[i] !== '{') continue;
      if (
        (i === 0 || description.slice(0, i).endsWith('\n\n')) &&
        /^\{[A-Za-z$_][\w$]*: /.test(description.slice(i))
      )
        return i;
    }
    return -1;
  })();
  if (open < 0 || noteAt < 0 || !description.trimEnd().endsWith('}')) return { description, lifted };
  let note = description.slice(noteAt + 1, description.trimEnd().length - 1);
  for (const key of KEPT) {
    const m = new RegExp(`(^|, )${key}: `).exec(note);
    if (!m) continue;
    const start = m.index + m[0].length;
    const raw = jsonAt(note, start);
    if (raw === undefined) continue;
    try {
      lifted[key] = JSON.parse(raw);
    } catch {
      continue;
    }
    note = `${note.slice(0, m.index)}${m[1] && m.index === 0 ? '' : ''}${note.slice(start + raw.length)}`;
    note = note.replace(/^, /, '');
  }
  const before = description.slice(0, noteAt).replace(/\n\n$/, '');
  const rest = note.trim() ? `{${note}}` : '';
  const text = [before, rest].filter(Boolean).join('\n\n');
  return { ...(text ? { description: text } : {}), lifted };
}

/** The schema with `enum` and `const` back on the fields they belong to, everywhere in it. Never changes its input. */
export function strictSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((x) => strictSchema(x)) as unknown as T;
  if (!schema || typeof schema !== 'object') return schema;
  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // names of properties and definitions are data, not keywords: only their schemas are walked
    if ((k === 'properties' || k === '$defs') && v && typeof v === 'object' && !Array.isArray(v))
      out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, strictSchema(s)]));
    else out[k] = strictSchema(v);
  }
  if (typeof node.description === 'string' && node.enum === undefined && node.const === undefined) {
    const { description, lifted } = liftKeywords(node.description);
    if (Object.keys(lifted).length) {
      if (description === undefined) delete out.description;
      else out.description = description;
      Object.assign(out, lifted);
    }
  }
  return out as T;
}
