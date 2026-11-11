import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import { namedPeople } from './names';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
});

const rows = {
  ui: {
    rows: [
      {
        person: {
          id: 'p1',
          displayName: 'Andrew Israel',
          linkedinUrl: 'https://www.linkedin.com/in/andrewisrael',
        },
      },
      { person: { id: 'p2', displayName: 'Chris Pisarski' } },
      { person: { id: 'p3', displayName: 'Jai' } },
    ],
  },
  forModel: { people: [{ displayName: 'Hidden Person', id: 'x' }] },
};

describe('names in an answer', () => {
  it('reads the people a card named, with LinkedIn when known, longest names first', () => {
    const people = namedPeople([rows, undefined]);
    expect(people.map((p) => p.name)).toEqual(['Chris Pisarski', 'Andrew Israel']);
    expect(people.find((p) => p.name === 'Andrew Israel')).toMatchObject({
      href: 'https://www.linkedin.com/in/andrewisrael',
      external: true,
    });
    expect(people.find((p) => p.name === 'Chris Pisarski')).toMatchObject({
      href: '/people/p2',
      external: false,
    });
  });

  it('bolds and links each name, in plain words and inside bold', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const people = namedPeople([rows]);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <Markdown
            text="You talked with **Andrew Israel** at PropelAuth and Chris Pisarski at Crustdata."
            people={people}
          />
        </MemoryRouter>,
      );
    });
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="md-person"]')];
    expect(links.map((a) => a.textContent)).toEqual(['Andrew Israel', 'Chris Pisarski']);
    expect(links[0]!.getAttribute('href')).toBe('https://www.linkedin.com/in/andrewisrael');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(links[1]!.getAttribute('href')).toBe('/people/p2');
    expect(host.textContent).toBe(
      'You talked with Andrew Israel at PropelAuth and Chris Pisarski at Crustdata.',
    );
  });
  it('people found outside the network link to their LinkedIn; a row about someone in Orbit links to their page', () => {
    const found = {
      ui: {
        items: [
          {
            id: 'rec_1',
            href: 'https://bio.example.edu/belfu',
            person: { name: 'Belfu Berkol', linkedinUrl: 'https://www.linkedin.com/in/belfu-berkol' },
          },
          { id: 'rec_2', known: 'p9', href: '/people/p9', person: { name: 'Vivaan Gupta' } },
          // a company is not a person
          { name: 'Addition Therapeutics', url: 'https://addition.bio' },
        ],
      },
    };
    const people = namedPeople([found]);
    expect(people.find((p) => p.name === 'Belfu Berkol')).toMatchObject({
      href: 'https://www.linkedin.com/in/belfu-berkol',
      external: true,
    });
    expect(people.find((p) => p.name === 'Vivaan Gupta')).toMatchObject({
      href: '/people/p9',
      external: false,
    });
    expect(people.some((p) => p.name === 'Addition Therapeutics')).toBe(false);
  });
});
