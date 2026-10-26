import { lazy } from 'react';
import { Spinner } from '../ui';

/**
 * The app's pages, each loaded the first time it is shown, so opening Orbit downloads only the shell and the chat.
 * The app's routes and the chat's side panel share these.
 */
export const Landing = lazy(() => import('./Landing').then((m) => ({ default: m.Landing })));
export const LogInPage = lazy(() => import('./LogIn').then((m) => ({ default: m.LogInPage })));
export const RemoveMePage = lazy(() => import('./RemoveMe').then((m) => ({ default: m.RemoveMePage })));
export const Onboarding = lazy(() => import('./Onboarding').then((m) => ({ default: m.Onboarding })));
export const MapPage = lazy(() => import('./MapPage').then((m) => ({ default: m.MapPage })));
export const SettingsPage = lazy(() => import('./Settings').then((m) => ({ default: m.SettingsPage })));
export const PersonPage = lazy(() => import('./Person').then((m) => ({ default: m.PersonPage })));
export const People = lazy(() => import('./People').then((m) => ({ default: m.People })));
export const InboxPage = lazy(() => import('./Inbox').then((m) => ({ default: m.InboxPage })));
export const ChatsPage = lazy(() => import('./Chats').then((m) => ({ default: m.ChatsPage })));
export const Discover = lazy(() => import('./Discover').then((m) => ({ default: m.Discover })));
export const CompanyPage = lazy(() => import('./Company').then((m) => ({ default: m.CompanyPage })));
export const NotesNew = lazy(() => import('./NotesNew').then((m) => ({ default: m.NotesNew })));

/** What shows while a page loads. */
export function PageLoading() {
  return (
    <div className="h-full flex items-center justify-center">
      <Spinner />
    </div>
  );
}
