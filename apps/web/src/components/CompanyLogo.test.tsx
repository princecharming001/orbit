import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import * as logoQueue from '../engine/logoQueue';
import { CompanyLogo, NoCompanyIcon, PersonCompanyLogo } from './CompanyLogo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fresh = 'https://media.licdn.com/dms/image/v2/enactus/company-logo_200_200?e=2147483647&v=beta&t=x';
const expired = 'https://media.licdn.com/dms/image/v2/enactus/company-logo_200_200?e=1700000000&v=beta&t=x';

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

async function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  await settle();
  return { host, unmount: () => act(() => root.unmount()) };
}

beforeEach(async () => {
  await wipeDatabase();
});

describe('CompanyLogo', () => {
  it("shows the company's own logo from LinkedIn before any guessed icon", async () => {
    await db.organizations.put({
      id: 'org_enactus',
      name: 'Enactus Berkeley',
      nameNormalized: 'enactus berkeley',
      domains: [],
      linkedinCompanyId: '777',
      logoUrl: fresh,
    });
    const { host, unmount } = await mount(
      <PersonCompanyLogo
        person={{
          currentOrganizationRaw: 'Enactus Berkeley',
          currentOrganizationId: 'org_enactus',
          emails: [],
        }}
      />,
    );
    const img = host.querySelector('[data-testid="company-logo"]') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(fresh);
    expect(img.dataset.source).toBe('linkedin');
    expect(img.title).toBe('Enactus Berkeley');
    await unmount();
    // by name alone too (a card that only knows the company's name)
    const byName = await mount(<CompanyLogo name="Enactus Berkeley" />);
    expect(byName.host.querySelector('img')?.getAttribute('src')).toBe(fresh);
    await byName.unmount();
  });

  it('skips an expired LinkedIn logo (it is fetched again) and shows LinkedIn’s plain placeholder, never letters', async () => {
    await db.organizations.put({
      id: 'org_enactus',
      name: 'Enactus Berkeley',
      nameNormalized: 'enactus berkeley',
      domains: [],
      logoUrl: expired,
    });
    const { host, unmount } = await mount(<CompanyLogo name="Enactus Berkeley" orgId="org_enactus" />);
    const tile = host.querySelector('[data-testid="company-logo"]') as HTMLElement;
    expect(tile.tagName).toBe('SPAN');
    expect(tile.dataset.fallback).toBe('true');
    expect(tile.textContent).toBe('');
    expect(tile.querySelector('svg')).not.toBeNull();
    expect(tile.getAttribute('aria-label')).toBe('Enactus Berkeley');
    await unmount();
  });

  it('falls back to the domain icon when the LinkedIn logo does not load', async () => {
    await db.organizations.put({
      id: 'org_stripe',
      name: 'Stripe',
      nameNormalized: 'stripe',
      domains: ['stripe.com'],
      logoUrl: fresh,
    });
    const { host, unmount } = await mount(<CompanyLogo name="Stripe" orgId="org_stripe" />);
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(fresh);
    await act(async () => {
      img.dispatchEvent(new Event('error'));
    });
    await settle();
    const next = host.querySelector('img')!;
    expect(next.getAttribute('src')).not.toBe(fresh);
    // Stripe's logo ships with the app
    expect(next.getAttribute('src')).toMatch(/\/logos\/stripe\.png$/);
    expect(next.dataset.source).toBe('bundled');
    await unmount();
  });

  it('a well-known university shows the logo shipped with the app until LinkedIn answers, and asks LinkedIn', async () => {
    const asked = vi.spyOn(logoQueue, 'wantCompanyLogo');
    const { host, unmount } = await mount(<CompanyLogo name="UC Berkeley" size={22} />);
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/\/logos\/berkeley\.png$/);
    // schools are looked up on LinkedIn like companies
    expect(asked).toHaveBeenCalledWith('UC Berkeley');
    asked.mockRestore();
    await unmount();
  });

  it('a school Orbit has no logo for shows the plain placeholder, never an icon service’s guess', async () => {
    const images: string[] = [];
    const real = globalThis.Image;
    globalThis.Image = class extends real {
      set src(v: string) {
        images.push(v);
      }
    } as typeof Image;
    try {
      const { host, unmount } = await mount(<CompanyLogo name="NYU Stern" size={22} />);
      const tile = host.querySelector('[data-testid="company-logo"]') as HTMLElement;
      expect(tile.tagName).toBe('SPAN');
      expect(tile.dataset.fallback).toBe('true');
      expect(tile.textContent).toBe('');
      expect(images).toEqual([]);
      await unmount();
    } finally {
      globalThis.Image = real;
    }
  });

  it('never makes a logo up: no name turned into a ".com", no work address, no icon service for a company', async () => {
    const asked = vi.spyOn(logoQueue, 'wantCompanyLogo');
    const images: string[] = [];
    const real = globalThis.Image;
    globalThis.Image = class extends real {
      set src(v: string) {
        images.push(v);
      }
    } as typeof Image;
    try {
      const { host, unmount } = await mount(
        <PersonCompanyLogo
          person={{
            currentOrganizationRaw: 'Nozomio',
            emails: ['arlan@nozomio.com'],
            primaryEmail: 'arlan@nozomio.com',
          }}
        />,
      );
      const tile = host.querySelector('[data-testid="company-logo"]') as HTMLElement;
      expect(tile.tagName).toBe('SPAN');
      expect(tile.textContent).toBe('');
      expect(images).toEqual([]);
      // the tile asks LinkedIn for the real one
      expect(asked).toHaveBeenCalledWith('Nozomio');
      await unmount();
    } finally {
      globalThis.Image = real;
      asked.mockRestore();
    }
  });

  it('a LinkedIn logo found later replaces the placeholder, and wins over a shipped logo', async () => {
    const { host, unmount } = await mount(<CompanyLogo name="Stripe" size={22} />);
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/\/logos\/stripe\.png$/);
    await act(async () => {
      await db.organizations.put({
        id: 'org_stripe',
        name: 'Stripe',
        nameNormalized: 'stripe',
        domains: [],
        linkedinCompanyId: '2135371',
        logoUrl: fresh,
      });
    });
    await settle();
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(fresh);
    expect(img.dataset.source).toBe('linkedin');
    await unmount();
  });

  it('shows a people icon for no company, not an empty square', async () => {
    const { host, unmount } = await mount(<NoCompanyIcon size={22} />);
    const tile = host.querySelector('[data-testid="no-company-icon"]')!;
    expect(tile.querySelector('svg')).not.toBeNull();
    await unmount();
  });
});
