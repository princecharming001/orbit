/**
 * Which in-app routes can open in the side panel, and the helpers that turn a route into the chat's address
 * ("/?panel=/people/p4") and back. The panel embeds the app's own pages, so any page route works; the landing
 * page, onboarding and the chat itself do not.
 */
import { legacyHref } from '../../legacyRoutes';

/** The router's basename without a trailing slash ("/orbit" on Pages, "" in dev). */
export const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');

const PANEL_ROUTES: RegExp[] = [
  /^\/people(\/[^/]+)?$/,
  /^\/companies\/[^/]+$/,
  /^\/map$/,
  /^\/discover$/,
  /^\/inbox$/,
  /^\/drafts$/,
  /^\/notes\/new$/,
  /^\/settings(\/[^/]+)?$/,
];

/** The path part of an in-app href ("/people/p4?tab=facts&prep=1" gives "/people/p4"). */
export function pathOf(href: string): string {
  return href.split('#')[0]!.split('?')[0]!;
}

/** Whether this in-app href (path with optional query) can open in the panel. */
export function panelizable(href: string): boolean {
  const path = pathOf(href);
  return PANEL_ROUTES.some((r) => r.test(path));
}

/** The identity of a panel tab: the page, not its query, so a person's profile and its prep tab are one tab. */
export function panelKey(href: string): string {
  const path = pathOf(href);
  return path === '/drafts' ? '/inbox' : path;
}

/** The chat's address with this href open in the panel. */
export function chatUrlWithPanel(href: string): string {
  return `/?panel=${encodeURIComponent(href)}`;
}

/** An old Today or Pipeline href (a saved thread, a bookmark) as the page that shows it now; any other unchanged. */
function current(href: string): string {
  return legacyHref(href) ?? href;
}

/** The panel's href from the chat's search string, when it is one the panel can show. */
export function panelFromSearch(search: string): string | undefined {
  const raw = new URLSearchParams(search).get('panel');
  if (!raw?.startsWith('/')) return undefined;
  const href = current(raw);
  return panelizable(href) ? href : undefined;
}

/** The full URL (with the app's base path) an anchor inside the panel points to, so middle-click still works. */
export function panelAnchorHref(href: string): string {
  return `${BASENAME}${chatUrlWithPanel(href)}`;
}

/**
 * The in-app href an anchor element points to, when it stays inside this app and the panel can show it. Anchors that
 * open a new tab, download, or carry a modifier key are left alone by the caller.
 */
export function internalHrefOf(anchor: HTMLAnchorElement): string | undefined {
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#') || /^(mailto|tel|sms):/i.test(raw)) return undefined;
  let path: string;
  try {
    const u = new URL(raw, window.location.href);
    if (u.origin !== window.location.origin) return undefined;
    path = u.pathname + u.search;
  } catch {
    return undefined;
  }
  if (BASENAME) {
    if (path !== BASENAME && !path.startsWith(`${BASENAME}/`)) return undefined;
    path = path.slice(BASENAME.length) || '/';
  }
  path = current(path);
  return panelizable(path) ? path : undefined;
}

const STATIC_TITLES: Record<string, string> = {
  '/people': 'People',
  '/map': 'Map',
  '/discover': 'Discover',
  '/inbox': 'Drafts',
  '/drafts': 'Drafts',
  '/notes/new': 'Add a note',
  '/settings': 'Settings',
  '/settings/integrations': 'Connections',
};

/** A title that needs no lookup; people, companies and drafts resolve theirs from the database. */
export function staticTitle(href: string): string {
  const path = pathOf(href);
  if (STATIC_TITLES[path]) return STATIC_TITLES[path];
  if (path.startsWith('/people/')) return 'Profile';
  if (path.startsWith('/companies/')) return 'Company';
  if (path.startsWith('/settings/')) return 'Settings';
  return 'Orbit';
}
