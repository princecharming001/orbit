import { type WhySignals, whyThem } from '@orbit/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersonPoint } from '../../engine/personPoints';
import { WhyThem } from './parts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-10-06T10:00:00');
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(signals: Omit<WhySignals, 'now'>, points: PersonPoint[] = []) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <WhyThem
          reasons={whyThem({ ...signals, now }, { filler: false })}
          points={points}
          firstName={signals.firstName}
          testId="why"
        />
      </MemoryRouter>,
    ),
  );
  const el = host.querySelector('[data-testid="why"]')!;
  const shown = (sel: string) =>
    [...el.querySelectorAll<HTMLElement>(sel)].filter((x) => !x.className.includes('hidden'));
  return { el, shown };
}

const amara: Omit<WhySignals, 'now'> = {
  firstName: 'Amara',
  title: 'Associate Product Manager',
  company: 'Ramp',
  goal: {
    company: { name: 'Ramp', priority: 2 },
    role: { title: 'Associate Product Manager', function: 'product management' },
  },
  warmPath: {
    name: 'Lena',
    id: 'p-lena',
    fullName: 'Lena Novak',
    how: 'worked with Amara at Ramp (2021 to 2023)',
  },
  history: {
    theyWroteAt: '2026-05-12T15:00:00',
    talk: { fromThem: 1, fromYou: 0, channel: 'email', lastFrom: 'them', subject: 'Re: Summer internships' },
  },
  school: { name: 'Cornell University', degree: 'BS', gradYear: 2021, myGradYear: 2027 },
  city: { name: 'New York', why: 'target' },
};

describe('Why them on a card', () => {
  it('leads with one sentence on why this person, then the reasons as full sentences', () => {
    const { el, shown } = render(amara);
    expect(el.querySelector('[data-testid="why-summary"]')?.textContent).toBe(
      'Worth writing to because Amara is an Associate Product Manager at Ramp, a company on your target list, and is one introduction away through Lena.',
    );
    const lines = shown('[data-testid="why-reason"]').map((l) => l.textContent?.replace(/^•/, ''));
    expect(lines).toEqual([
      'Lena Novak, who worked with Amara at Ramp (2021 to 2023), could introduce you.',
      'Wrote to you by email on May 12 about “Summer internships”; you have not replied yet.',
      'Also went to Cornell University (BS, class of 2021), 6 years ahead of you.',
    ]);
    // the summary and three reasons show; nothing hides the substance
    expect(el.textContent).not.toMatch(/\+\d+ more/);
  });

  it('links a named person to their page', () => {
    const { el } = render(amara);
    const link = el.querySelector<HTMLAnchorElement>('a[href="/people/p-lena"]');
    expect(link?.textContent).toBe('Lena Novak');
  });

  it('keeps more than four lines tidy: the rest go behind Show more, in place', () => {
    const points: PersonPoint[] = [{ kind: 'standout', text: 'Previously at Brex' }];
    const { el, shown } = render(amara, points);
    const more = el.querySelector<HTMLButtonElement>('[data-testid="rec-points-more"]')!;
    expect(more.textContent).toBe('Show more');
    expect(shown('[data-testid="rec-points"]')).toHaveLength(0);
    act(() => more.click());
    expect(more.textContent).toBe('Show less');
    expect(shown('[data-testid="rec-points"]')[0]?.textContent).toContain('Previously at Brex');
  });

  it('shows every line when there is nothing behind them, and no Show more', () => {
    const { el } = render({ firstName: 'Jo', goal: { company: { name: 'Figma', priority: 1 } } });
    expect(el.querySelector('[data-testid="why-summary"]')?.textContent).toBe(
      'Worth writing to because Jo works at Figma, one of your top target companies.',
    );
    expect(el.querySelectorAll('[data-testid="why-reason"]')).toHaveLength(0);
    expect(el.querySelector('[data-testid="rec-points-more"]')).toBeNull();
  });
});
