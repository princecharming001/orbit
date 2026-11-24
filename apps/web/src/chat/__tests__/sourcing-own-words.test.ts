/**
 * Chat sourcing reads its criteria from the student's own message. The model restates an ask before it searches and
 * tends to add what it knows of the student ("early-stage", "biotech"): none of that becomes a criterion column.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, type SearchForm } from '../../engine/peopleSearch';
import { type FindInput, onlySaid, statedAsk } from '../tools/network';

const form = (over: Partial<SearchForm> & { titles?: string[] } = {}): SearchForm => ({
  ask: over.ask ?? '',
  filters: { ...EMPTY_FILTERS, titles: over.titles ?? [] },
  criteria: over.criteria ?? [],
});
const crit = (text: string) => ({ id: text, text, need: 'nice' as const });
const input: FindInput = { purpose: 'fundraising', query: 'early-stage investors for a biotech startup' };

describe('the criteria are the student’s own', () => {
  it('"source 3 investors" searches investors with no criteria, whatever the model added', () => {
    const restated = form({
      titles: ['investor'],
      criteria: [crit('Invests at seed or early stage'), crit('Has invested in biotech companies')],
    });
    const mine = form({ titles: ['investor'] });
    const out = statedAsk(
      restated,
      mine,
      'source 3 investors',
      'early-stage investors for a biotech startup',
      {
        ...input,
        topic: 'biotech',
      },
    );
    expect(out.ask).toBe('source 3 investors');
    expect(out.form.criteria).toEqual([]);
    expect(out.form.filters.titles).toEqual(['investor']);
    // the topic the model named is not in the student's words either
    expect(out.named.topic).toBeUndefined();
  });

  it('a criterion the student stated stays', () => {
    const mine = form({ titles: ['investor'], criteria: [crit('Has invested in biotech companies')] });
    const out = statedAsk(form({ titles: ['investor'] }), mine, 'investors who have backed biotech', 'x', {
      ...input,
      topic: 'biotech',
    });
    expect(out.form.criteria.map((c) => c.text)).toEqual(['Has invested in biotech companies']);
    expect(out.named.topic).toBe('biotech');
  });

  it('a message that only points back leaves the restated ask to stand', () => {
    const restated = form({ titles: ['investor'], criteria: [crit('Has invested in biotech companies')] });
    const out = statedAsk(restated, form(), 'yes, find them', 'biotech investors', input);
    expect(out.ask).toBe('biotech investors');
    expect(out.form.criteria).toHaveLength(1);
  });

  it('keeps a named school or company only when the student wrote it', () => {
    const named = onlySaid(
      { ...input, school: 'UC Berkeley', organization: 'Stripe' },
      'professors at UC Berkeley',
    );
    expect(named.school).toBe('UC Berkeley');
    expect(named.organization).toBeUndefined();
  });
});
