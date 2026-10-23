import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { CompanyLogo, PersonCompanyLogo } from './CompanyLogo';

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

  it('skips an expired LinkedIn logo (it is fetched again) and falls back to the letter tile', async () => {
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
    expect(tile.textContent).toBe('E');
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
    expect(next.getAttribute('src')).toContain('stripe.com');
    await unmount();
  });
});
