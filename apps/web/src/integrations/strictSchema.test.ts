/**
 * The answer format the model is held to keeps its "one of these values" rules. The SDK's own transform writes them
 * into the description as a note, where the API does not enforce them, so an answer could say `"\"must\""` and be
 * thrown away whole; strictSchema puts them back.
 */
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { liftKeywords, strictSchema } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { INTERPRET_SYSTEM, interpretSchema } from '../engine/peopleSearch';

type Node = Record<string, unknown>;
const walk = (s: unknown, visit: (n: Node) => void): void => {
  if (Array.isArray(s)) return s.forEach((x) => walk(x, visit));
  if (!s || typeof s !== 'object') return;
  visit(s as Node);
  for (const v of Object.values(s as Node)) walk(v, visit);
};
/** descriptions that still end in the SDK's note with an enum or a const in it */
const notes = (schema: unknown): string[] => {
  const out: string[] = [];
  walk(schema, (n) => {
    if (
      typeof n.description === 'string' &&
      /(^|\n\n)\{(?:[^\n]*, )?(?:enum|const): [^\n]*\}$/.test(n.description)
    )
      out.push(n.description);
  });
  return out;
};

describe('the SDK writes enum out as a note; strictSchema puts it back', () => {
  const need = z.enum(['must', 'nice']);
  const schema = z.object({
    plain: z.enum(['x', 'y']),
    said: need.describe('"nice" unless it cannot be met without it.'),
    list: z.array(z.object({ need })),
    only: z.literal('fixed'),
    free: z.string().describe('Any words, even {enum: ["a"]} written by hand in the middle of a sentence.'),
    count: z.number().int(),
  });
  const sent = zodOutputFormat(schema as never).schema as Node;

  it('the SDK alone loses them (the reason this exists)', () => {
    expect(notes(sent).length).toBeGreaterThan(0);
    const props = sent.properties as Record<string, Node>;
    expect(props.plain!.enum).toBeUndefined();
  });

  it('every enum and const is a rule again, in fields, in lists, and in shared definitions', () => {
    const strict = strictSchema(sent);
    const props = strict.properties as Record<string, Node>;
    expect(props.plain).toEqual({ type: 'string', enum: ['x', 'y'] });
    expect(props.only).toMatchObject({ const: 'fixed' });
    const defs = strict.$defs as Record<string, Node> | undefined;
    const shared = defs ? Object.values(defs)[0]! : props.said!;
    expect(shared.enum).toEqual(['must', 'nice']);
    expect(notes(strict)).toEqual([]);
    // the input is not changed
    expect(notes(sent).length).toBeGreaterThan(0);
  });

  it('a field’s own description stays, and words a person wrote are never read as a rule', () => {
    const strict = strictSchema(sent);
    const props = strict.properties as Record<string, Node>;
    expect(props.free!.description).toBe(
      'Any words, even {enum: ["a"]} written by hand in the middle of a sentence.',
    );
    expect(props.free!.enum).toBeUndefined();
    expect(liftKeywords('How sure.\n\n{enum: ["a","b"]}')).toEqual({
      description: 'How sure.',
      lifted: { enum: ['a', 'b'] },
    });
    // what the SDK could not place and the API does not enforce stays a note
    expect(liftKeywords('{enum: ["a, b","c}"], minLength: 2}')).toEqual({
      description: '{minLength: 2}',
      lifted: { enum: ['a, b', 'c}'] },
    });
    expect(liftKeywords('{minimum: 0, const: 3}')).toEqual({
      description: '{minimum: 0}',
      lifted: { const: 3 },
    });
    expect(liftKeywords('Just words.')).toEqual({ description: 'Just words.', lifted: {} });
  });

  it('a property that happens to be called enum or description is left alone', () => {
    const odd = strictSchema({
      type: 'object',
      properties: { enum: { type: 'string', description: '{enum: ["a"]}' }, description: { type: 'string' } },
    });
    expect((odd.properties as Record<string, Node>).enum).toEqual({ type: 'string', enum: ['a'] });
    expect((odd.properties as Record<string, Node>).description).toEqual({ type: 'string' });
  });
});

describe('reading a sentence into a search', () => {
  it('the format sent holds must or nice, and each level, to their own words', () => {
    const strict = strictSchema(zodOutputFormat(interpretSchema as never).schema) as Node;
    expect(notes(strict)).toEqual([]);
    const enums: unknown[][] = [];
    walk(strict, (n) => {
      if (Array.isArray(n.enum)) enums.push(n.enum);
    });
    expect(enums).toContainEqual(['must', 'nice']);
    expect(enums.some((e) => e.includes('vp') && e.includes('senior'))).toBe(true);
    expect(INTERPRET_SYSTEM).not.toMatch(/[—!]/);
  });
});
