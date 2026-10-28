import { lazy } from 'react';
import { Skeleton, SkeletonCards, SkeletonRows } from '../ui';

/**
 * The app's pages, each loaded the first time it is shown, so opening Orbit downloads only the shell and the chat.
 * The app's routes and the chat's side panel share these.
 */
const load = {
  Landing: () => import('./Landing').then((m) => ({ default: m.Landing })),
  LogInPage: () => import('./LogIn').then((m) => ({ default: m.LogInPage })),
  RemoveMePage: () => import('./RemoveMe').then((m) => ({ default: m.RemoveMePage })),
  Onboarding: () => import('./Onboarding').then((m) => ({ default: m.Onboarding })),
  MapPage: () => import('./MapPage').then((m) => ({ default: m.MapPage })),
  SettingsPage: () => import('./Settings').then((m) => ({ default: m.SettingsPage })),
  PersonPage: () => import('./Person').then((m) => ({ default: m.PersonPage })),
  People: () => import('./People').then((m) => ({ default: m.People })),
  InboxPage: () => import('./Inbox').then((m) => ({ default: m.InboxPage })),
  ChatsPage: () => import('./Chats').then((m) => ({ default: m.ChatsPage })),
  Discover: () => import('./Discover').then((m) => ({ default: m.Discover })),
  CompanyPage: () => import('./Company').then((m) => ({ default: m.CompanyPage })),
  NotesNew: () => import('./NotesNew').then((m) => ({ default: m.NotesNew })),
};
export const Landing = lazy(load.Landing);
export const LogInPage = lazy(load.LogInPage);
export const RemoveMePage = lazy(load.RemoveMePage);
export const Onboarding = lazy(load.Onboarding);
export const MapPage = lazy(load.MapPage);
export const SettingsPage = lazy(load.SettingsPage);
export const PersonPage = lazy(load.PersonPage);
export const People = lazy(load.People);
export const InboxPage = lazy(load.InboxPage);
export const ChatsPage = lazy(load.ChatsPage);
export const Discover = lazy(load.Discover);
export const CompanyPage = lazy(load.CompanyPage);
export const NotesNew = lazy(load.NotesNew);

let preloaded = false;
/**
 * Once the app is open and idle, the in-app pages download in the background (as Linear and Notion do), so moving
 * between pages never waits on the network. A failed download is simply tried again when the page is opened.
 */
export function preloadPages(): void {
  if (preloaded) return;
  preloaded = true;
  const pages = [
    load.People,
    load.PersonPage,
    load.InboxPage,
    load.Discover,
    load.SettingsPage,
    load.ChatsPage,
    load.CompanyPage,
    load.MapPage,
    load.NotesNew,
  ];
  const next = () => {
    const page = pages.shift();
    if (!page) return;
    page()
      .catch(() => undefined)
      .finally(() => idle(next));
  };
  idle(next);
}
function idle(fn: () => void) {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 200);
}

/**
 * What shows while a page loads: the outline of that page (its header, then rows, cards or sections in grey), the way
 * Linear, Notion and LinkedIn do, so a click always changes the screen at once and never leaves it blank. It fades in
 * after a beat (`.loading-in`), so a page that is already downloaded shows no flash at all. `path` picks the outline;
 * without it, a generic one.
 */
export function PageLoading({ path = '' }: { path?: string }) {
  const kind =
    /^\/people\/[^/]+/.test(path) || /^\/companies\//.test(path)
      ? 'profile'
      : /^\/(people|chats|inbox)/.test(path)
        ? 'list'
        : /^\/settings/.test(path)
          ? 'settings'
          : 'cards';
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="loading-in"
      data-testid="page-loading"
    >
      {kind === 'profile' ? (
        <div className="flex items-center gap-4 mb-8">
          <Skeleton className="w-16 h-16 rounded-full shrink-0" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ) : (
        <div className="mb-8 space-y-2.5">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      )}
      {kind === 'list' ? (
        <SkeletonRows rows={8} divided />
      ) : kind === 'settings' ? (
        <div className="space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-[var(--radius-card)] border border-line p-5 space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          ))}
        </div>
      ) : (
        <SkeletonCards count={kind === 'profile' ? 2 : 3} />
      )}
    </div>
  );
}
