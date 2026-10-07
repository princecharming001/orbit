import { describe, expect, it } from 'vitest';
import { addEdge, makeGraph, toReachPath } from '../graph/paths';
import {
  CHANNEL_LABELS,
  FACT_TYPE_LABELS,
  FUNCTION_LABELS,
  functionCodeFor,
  functionLabel,
  functionPhrase,
  MESSAGE_KIND_LABELS,
  NOTE_SOURCE_LABELS,
  REACH_BAND_LABELS,
  RELATIONSHIP_LABELS,
  TARGET_STATUS_LABELS,
  TOUCHPOINT_LABELS,
} from '../labels';
import { STAGE_LABELS } from '../pipeline/transitions';
import { recommendPeople } from '../recommend/score';
import type { Person, RecruitingGoals } from '../types';

describe('labels', () => {
  const maps = {
    FUNCTION_LABELS,
    MESSAGE_KIND_LABELS,
    CHANNEL_LABELS,
    RELATIONSHIP_LABELS,
    TARGET_STATUS_LABELS,
    REACH_BAND_LABELS,
    FACT_TYPE_LABELS,
    NOTE_SOURCE_LABELS,
    TOUCHPOINT_LABELS,
    STAGE_LABELS,
  };
  it('never shows an internal code: no underscores, no all-lowercase codes, capitalised', () => {
    for (const [name, m] of Object.entries(maps))
      for (const [code, label] of Object.entries(m)) {
        expect(label, `${name}.${code}`).not.toMatch(/_/);
        expect(label, `${name}.${code}`).not.toBe(code);
        expect(label[0], `${name}.${code}`).toBe(label[0]!.toUpperCase());
        expect(label, `${name}.${code}`).not.toMatch(/[–—!]/);
      }
  });
  it('maps function codes both ways', () => {
    expect(functionLabel('swe')).toBe('Software engineering');
    expect(functionPhrase('pm')).toBe('product management');
    expect(functionPhrase('data')).toBe('data science and ML');
    expect(functionLabel('Biotech')).toBe('Biotech');
    expect(functionCodeFor('PM')).toBe('pm');
    expect(functionCodeFor('Product management')).toBe('pm');
    expect(functionCodeFor('banking')).toBe('ib');
    expect(functionCodeFor('underwater basket weaving')).toBeUndefined();
  });
});

describe('copy that used to leak codes', () => {
  it('recommendation reason names the function in words, not as a code', () => {
    const person: Person = {
      id: 'p1',
      userId: 'u',
      displayName: 'Priya Patel',
      firstName: 'Priya',
      lastName: 'Patel',
      currentTitle: 'Product Manager',
      currentOrganizationRaw: 'Figma',
      relationshipType: 'unknown',
      strength: 0.1,
      isAlumni: false,
      isHuman: true,
      sources: ['linkedin_csv'],
      emails: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as unknown as Person;
    const goals: RecruitingGoals = {
      userId: 'u',
      cycleLabel: 'Summer 2027',
      targetRoles: [],
      targetFunctions: ['swe', 'pm'],
      targetIndustries: [],
      targetLocations: [],
      ambition: 2,
    };
    const recs = recommendPeople({
      userId: 'u',
      user: { school: 'Michigan', majors: [] },
      goals,
      targetCompanies: [{ id: 't', userId: 'u', nameRaw: 'Figma', priority: 1, status: 'researching' }],
      resumeFacets: [],
      people: [person],
      chats: [],
      pathStrength: () => 0,
      recentlyRecommended: new Set(),
      now: new Date('2026-10-01T12:00:00Z'),
    });
    const texts = recs.flatMap((r) => r.reasons.map((x) => x.text));
    expect(texts).toContain('Works in product management (Product Manager)');
    expect(texts.join(' ')).not.toMatch(/\b(swe|pm)\b/);
  });
  it('a direct connection is never banded a long shot', () => {
    const g = makeGraph();
    addEdge(g, 'user', 'p', 0.05, 'strength', 'connected on LinkedIn');
    expect(toReachPath(g, ['user', 'p']).band).toBe('possible');
    addEdge(g, 'p', 't', 0.1, 'co_tenure', 'worked together');
    expect(toReachPath(g, ['user', 'p', 't']).band).toBe('long_shot');
  });
});
