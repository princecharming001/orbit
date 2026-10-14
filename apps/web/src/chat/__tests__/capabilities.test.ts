import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_IDS } from '../capabilities';
import { inputJsonSchema, registry, toolCountByKind, tools } from '../registry';

const DASHES = /[—–]/;

describe('capability manifest', () => {
  it('lists every inventory id once, with an area, a title, a kind and three utterances', () => {
    // the 181 of the capability inventory plus the networking agent's 20 (plan 16)
    expect(CAPABILITIES).toHaveLength(201);
    expect(CAPABILITY_IDS.size).toBe(201);
    for (const c of CAPABILITIES) {
      expect(c.id).toMatch(/^[a-z0-9_]+$/);
      expect(c.area.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(3);
      expect(['read', 'write', 'risky']).toContain(c.kind);
      expect(c.utterances).toHaveLength(3);
      for (const u of c.utterances) expect(u.trim().length).toBeGreaterThan(0);
      expect(`${c.title} ${c.utterances.join(' ')}`).not.toMatch(DASHES);
    }
  });
});

describe('registry coverage', () => {
  it('every capability id is claimed by at least one tool', () => {
    const claimed = new Set(tools.flatMap((t) => t.capabilities));
    const missing = CAPABILITIES.filter((c) => !claimed.has(c.id)).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('every tool claims at least one capability and no unknown ids', () => {
    // tools that only draw something in the chat serve no inventory capability
    const presentationOnly = new Set(['offer_choices']);
    for (const t of tools) {
      if (!presentationOnly.has(t.name)) expect(t.capabilities.length, t.name).toBeGreaterThan(0);
      const unknown = t.capabilities.filter((id) => !CAPABILITY_IDS.has(id));
      expect(unknown, t.name).toEqual([]);
    }
  });

  it('a risky capability is served by at least one risky tool', () => {
    for (const c of CAPABILITIES.filter((x) => x.kind === 'risky')) {
      const servers = tools.filter((t) => t.capabilities.includes(c.id));
      expect(
        servers.some((t) => t.kind === 'risky'),
        `${c.id} is served only by ${servers.map((t) => `${t.name} (${t.kind})`).join(', ')}`,
      ).toBe(true);
    }
  });

  it('names are unique, snake_case and sorted; the set is between 45 and 95 tools', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(names.length).toBeGreaterThanOrEqual(45);
    // 69 before plan 16's networking agent added 20
    expect(names.length).toBe(89);
    expect(names.length).toBeLessThanOrEqual(95);
    expect(registry.size).toBe(names.length);
    const counts = toolCountByKind();
    expect(counts.read + counts.write + counts.risky).toBe(names.length);
  });

  it('every description says when to call it, every field is described, and schemas are strict', () => {
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThanOrEqual(60);
      expect(t.description, t.name).toMatch(/call this (only )?(when|first|after|during|before)/i);
      expect(t.description).not.toMatch(DASHES);
      expect(t.progress, t.name).toBeTruthy();
      const schema = inputJsonSchema(t) as {
        type: string;
        additionalProperties?: boolean;
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties, t.name).toBe(false);
      for (const [field, def] of Object.entries(schema.properties ?? {}))
        expect(def.description, `${t.name}.${field}`).toBeTruthy();
    }
  });

  it('every risky tool explains itself on the Approve card', () => {
    for (const t of tools.filter((x) => x.kind === 'risky'))
      expect(t.summarizeIntent, t.name).toBeTypeOf('function');
  });
});
