import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PanelApi, PanelProvider, usePanel } from '../panel/PanelProvider';
import { getPanelHint } from '../panel/panelHint';
import {
  chatUrlWithPanel,
  internalHrefOf,
  panelFromSearch,
  panelizable,
  panelKey,
  pathOf,
  staticTitle,
} from '../panel/routes';
import { applyEvent, resetThread, subscribeAutoOpen } from '../ui/threadStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('panel routes', () => {
  it('knows which pages open in the panel', () => {
    for (const ok of [
      '/people',
      '/people?view=list&f=chats',
      '/people/p4',
      '/people/p4?tab=prep',
      '/companies/o1',
      '/map',
      '/map?reach=1',
      '/discover',
      '/inbox?draft=out_1',
      '/drafts',
      '/notes/new',
      '/settings',
      '/settings/integrations',
    ])
      expect(panelizable(ok), ok).toBe(true);
    // Today and the Pipeline are gone: their old links are sent on, never opened as pages of their own
    for (const no of [
      '/',
      '/welcome',
      '/onboarding/profile',
      '/people/p4/extra',
      '/nope',
      '',
      '/today',
      '/pipeline',
    ])
      expect(panelizable(no), no).toBe(false);
  });

  it('keys a tab by its page, not its query', () => {
    expect(panelKey('/people/p4?tab=prep')).toBe('/people/p4');
    expect(panelKey('/inbox?draft=out_1')).toBe('/inbox');
    expect(panelKey('/drafts')).toBe('/inbox');
    expect(pathOf('/map?reach=1#x')).toBe('/map');
  });

  it('puts the open page in the chat address and reads it back', () => {
    const url = chatUrlWithPanel('/people/p4?tab=prep');
    expect(url).toBe('/?panel=%2Fpeople%2Fp4%3Ftab%3Dprep');
    expect(panelFromSearch(url.slice(1))).toBe('/people/p4?tab=prep');
    expect(panelFromSearch('?panel=%2Fwelcome')).toBeUndefined();
    expect(panelFromSearch('?panel=https%3A%2F%2Fevil.example')).toBeUndefined();
    expect(panelFromSearch('')).toBeUndefined();
    // an old Today or Pipeline link in the address opens what shows it now
    expect(panelFromSearch('?panel=%2Fpipeline%3Fview%3Dtable')).toBe('/people?view=list&f=chats');
    expect(panelFromSearch('?panel=%2Ftoday%3Fcard%3Ds_1')).toBe('/inbox?card=s_1');
    expect(panelFromSearch('?panel=%2Ftoday')).toBeUndefined();
  });

  it('turns an in-app anchor into a panel href and leaves other links alone', () => {
    const a = (href: string) => {
      const el = document.createElement('a');
      el.setAttribute('href', href);
      return el;
    };
    // vitest serves from "/" so the base path is empty
    expect(internalHrefOf(a('/people/p4?tab=prep'))).toBe('/people/p4?tab=prep');
    expect(internalHrefOf(a('/map'))).toBe('/map');
    expect(internalHrefOf(a('/welcome'))).toBeUndefined();
    expect(internalHrefOf(a('mailto:daniel@stripe.com'))).toBeUndefined();
    expect(internalHrefOf(a('https://example.com/people/p4'))).toBeUndefined();
    expect(internalHrefOf(a('#top'))).toBeUndefined();
    // a link saved in an older chat thread opens where its content lives now
    expect(internalHrefOf(a('/pipeline?quiet=1'))).toBe('/people?view=board&quiet=1');
    expect(internalHrefOf(a('/today?person=p4'))).toBe('/inbox?person=p4');
    expect(internalHrefOf(a('/today'))).toBeUndefined();
  });

  it('gives static pages plain titles', () => {
    expect(staticTitle('/people?view=board')).toBe('People');
    expect(staticTitle('/today')).toBe('Orbit');
    expect(staticTitle('/settings/integrations')).toBe('Connections');
    expect(staticTitle('/inbox?draft=x')).toBe('Drafts');
    expect(staticTitle('/people/p4')).toBe('Profile');
  });
});

describe('PanelProvider', () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  let api: PanelApi;
  let loc: { pathname: string; search: string; state: unknown };

  function Probe() {
    const p = usePanel()!;
    api = p;
    const l = useLocation();
    loc = { pathname: l.pathname, search: l.search, state: l.state };
    return null;
  }

  async function mount(initial = '/') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={[initial]}>
          <PanelProvider>
            <Probe />
          </PanelProvider>
        </MemoryRouter>,
      );
    });
  }
  const run = (fn: () => void) => act(async () => fn());

  beforeEach(() => resetThread());
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
  });

  it('opens a page, keeps depth, and closes back to the chat', async () => {
    await mount();
    expect(api.href).toBeUndefined();
    await run(() => api.open('/people/p4'));
    expect(api.href).toBe('/people/p4');
    expect(loc.search).toContain('panel=');
    expect((loc.state as { orbitPanel: { depth: number } }).orbitPanel.depth).toBe(0);
    expect(api.canGoBack).toBe(false);

    // another page opens on top; the same page replaces in place
    await run(() => api.open('/people?view=board'));
    expect(api.href).toBe('/people?view=board');
    expect(api.canGoBack).toBe(true);
    expect(api.tabs.map((t) => t.id)).toEqual(['/people/p4', '/people']);
    await run(() => api.open('/people?view=list'));
    expect(api.tabs).toHaveLength(2);

    await run(() => api.goBack());
    expect(api.href).toBe('/people/p4');
    await run(() => api.close());
    expect(api.href).toBeUndefined();
    expect(loc.pathname).toBe('/');
  });

  it('keeps one tab per page and moves on when a tab closes', async () => {
    await mount();
    await run(() => api.open('/inbox'));
    await run(() => api.open('/people/p4'));
    await run(() => api.open('/people/p4?tab=prep'));
    expect(api.tabs.map((t) => t.id)).toEqual(['/inbox', '/people/p4']);
    expect(api.tabs[1]!.href).toBe('/people/p4?tab=prep');
    await run(() => api.closeTab('/people/p4'));
    expect(api.href).toBe('/inbox');
    expect(api.tabs.map((t) => t.id)).toEqual(['/inbox']);
    await run(() => api.closeTab('/inbox'));
    expect(api.href).toBeUndefined();
  });

  it('handles navigation from inside the panel', async () => {
    await mount();
    await run(() => api.open('/people'));
    await run(() => api.navigateInside('/people/p4', 'push'));
    expect(api.href).toBe('/people/p4');
    expect(api.canGoBack).toBe(true);
    await run(() => api.navigateInside('/people/p4?tab=facts', 'replace'));
    expect(api.href).toBe('/people/p4?tab=facts');
    // the chat itself closes the panel
    await run(() => api.navigateInside('/', 'push'));
    expect(api.href).toBeUndefined();
  });

  it('restores a panel from the address and tells the assistant what it shows', async () => {
    await mount('/?panel=%2Fpeople%3Fview%3Dboard');
    expect(api.href).toBe('/people?view=board');
    expect(api.canGoBack).toBe(false);
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(getPanelHint()).toMatchObject({ href: '/people?view=board', title: 'People' });
    await run(() => api.close());
    expect(getPanelHint()).toBeUndefined();
  });

  it('ignores a page the panel cannot show', async () => {
    await mount();
    await run(() => api.open('/welcome'));
    expect(api.href).toBeUndefined();
  });

  it('opens a panel when a live tool result asks, and not for anything else', async () => {
    await mount();
    const seen: string[] = [];
    const off = subscribeAutoOpen((h) => seen.push(h));
    await act(async () => {
      applyEvent('t1', {
        type: 'tool_result',
        toolUseId: 'u1',
        envelope: { kind: 'draft', data: {}, summary: 'x', href: '/inbox?draft=out_1', autoOpen: true },
      });
      applyEvent('t1', {
        type: 'tool_result',
        toolUseId: 'u2',
        envelope: { kind: 'person', data: {}, summary: 'x', href: '/people/p4' },
      });
      applyEvent('t1', {
        type: 'tool_result',
        toolUseId: 'u3',
        envelope: { kind: 'text', data: {}, summary: 'x', autoOpen: true },
      });
    });
    off();
    expect(seen).toEqual(['/inbox?draft=out_1']);
  });
});
