/**
 * Steps 4 and 5 of the waterfall: the web (Exa search with page text; Firecrawl as its fallback) for bios, personal
 * sites and GitHub, then paid people-data APIs (Apollo, People Data Labs). Each runs only when Orbit's server has a
 * key for it (function secrets EXA_API_KEY, FIRECRAWL_API_KEY, APOLLO_API_KEY, PDL_API_KEY); otherwise it is a no-op
 * and Settings says "not set up". Only Exa is wired today; the others are listed so their switch exists.
 *
 * A web page is kept only when it names the person in full and also their company or school: a namesake's page is
 * worse than none.
 */
import type { Person } from '@orbit/core';
import { stripDiacritics } from '@orbit/core';
import type { ProviderStatus, WebResult } from '../../integrations/enrichmentProxy';
import type { Hints } from './match';

export interface PeopleDataProvider {
  id: 'exa' | 'firecrawl' | 'apollo' | 'people_data_labs';
  label: string;
  /** the waterfall step it belongs to */
  step: 4 | 5;
  /** the function secret that switches it on */
  secret: string;
  configured(s: ProviderStatus | undefined): boolean;
  /** wired: Orbit calls it when configured; unwired ones are only reported */
  wired: boolean;
}

export const PROVIDERS: PeopleDataProvider[] = [
  { id: 'exa', label: 'Exa (web)', step: 4, secret: 'EXA_API_KEY', configured: (s) => !!s?.exa, wired: true },
  {
    id: 'firecrawl',
    label: 'Firecrawl (web pages)',
    step: 4,
    secret: 'FIRECRAWL_API_KEY',
    configured: (s) => !!s?.firecrawl,
    wired: false,
  },
  {
    id: 'apollo',
    label: 'Apollo',
    step: 5,
    secret: 'APOLLO_API_KEY',
    configured: (s) => !!s?.apollo,
    wired: false,
  },
  {
    id: 'people_data_labs',
    label: 'People Data Labs',
    step: 5,
    secret: 'PDL_API_KEY',
    configured: (s) => !!s?.peopleDataLabs,
    wired: false,
  },
];

const fold = (s: string | undefined) =>
  stripDiacritics(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The web results that are surely about this person, with how sure: their full name plus their company or school. */
export function keepWebResults(
  person: Pick<Person, 'firstName' | 'lastName'>,
  hints: Hints,
  results: WebResult[],
): { url: string; title?: string; confidence: number }[] {
  const name = fold(`${person.firstName} ${person.lastName}`);
  const anchors = [...hints.companies, ...hints.schools].map(fold).filter((a) => a.length >= 3);
  return results
    .filter((r) => !/linkedin\.com\//i.test(r.url))
    .map((r) => {
      const text = ` ${fold(`${r.title ?? ''} ${r.snippet ?? ''}`)} `;
      const named = text.includes(` ${name} `);
      const anchored = anchors.some((a) => text.includes(` ${a} `));
      return { url: r.url, title: r.title, confidence: named && anchored ? 0.8 : named ? 0.5 : 0 };
    })
    .filter((r) => r.confidence >= 0.8)
    .slice(0, 3);
}
