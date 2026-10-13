import type { ReactNode } from 'react';
import { useMemo } from 'react';
import {
  createPath,
  UNSAFE_LocationContext as LocationContext,
  Navigate,
  UNSAFE_NavigationContext as NavigationContext,
  parsePath,
  Route,
  UNSAFE_RouteContext as RouteContext,
  Routes,
  type To,
} from 'react-router-dom';
import { LegacyRedirect } from '../../legacyRoutes';
import { CompanyPage } from '../../pages/Company';
import { Discover } from '../../pages/Discover';
import { InboxPage } from '../../pages/Inbox';
import { MapPage } from '../../pages/MapPage';
import { NotesNew } from '../../pages/NotesNew';
import { People } from '../../pages/People';
import { PersonPage } from '../../pages/Person';
import { Pipeline } from '../../pages/Pipeline';
import { SettingsPage } from '../../pages/Settings';
import { panelAnchorHref } from './routes';

/**
 * Runs the app's own pages inside the side panel. The panel is not a second router: it is a small navigation scope
 * layered over the app's router. Everything under it (Link, useNavigate, useParams, useSearchParams, Routes) reads
 * the panel's location, and every navigation inside it is handed to the panel host, which decides whether that
 * stays in the panel, closes it, or leaves for a real page. The pages run unchanged.
 */
export function PanelRouter({
  href,
  onNavigate,
  onGo,
  children,
}: {
  /** the route the panel shows, e.g. "/people/p4?tab=prep" */
  href: string;
  onNavigate: (to: string, mode: 'push' | 'replace') => void;
  onGo: (delta: number) => void;
  children: ReactNode;
}) {
  const location = useMemo(() => {
    const p = parsePath(href);
    return {
      pathname: p.pathname ?? '/',
      search: p.search ?? '',
      hash: p.hash ?? '',
      state: null,
      key: href,
    };
  }, [href]);
  const toPath = (to: To) => (typeof to === 'string' ? to : createPath(to));
  const navigator = useMemo(
    () => ({
      createHref: (to: To) => panelAnchorHref(toPath(to)),
      encodeLocation: (to: To) => {
        const p = typeof to === 'string' ? parsePath(to) : to;
        return { pathname: p.pathname ?? '', search: p.search ?? '', hash: p.hash ?? '' };
      },
      go: (delta: number) => onGo(delta),
      push: (to: To) => onNavigate(toPath(to), 'push'),
      replace: (to: To) => onNavigate(toPath(to), 'replace'),
    }),
    [onNavigate, onGo],
  );
  // The shapes below are the router's own (see its Router component); the types are internal, hence the casts.
  const navigation = useMemo(
    () => ({ basename: '/', navigator, static: false, future: {} }),
    [navigator],
  ) as unknown as React.ContextType<typeof NavigationContext>;
  const loc = useMemo(
    () => ({ location, navigationType: 'PUSH' }),
    [location],
  ) as unknown as React.ContextType<typeof LocationContext>;
  const route = useMemo(
    () => ({ outlet: null, matches: [], isDataRoute: false }),
    [],
  ) as unknown as React.ContextType<typeof RouteContext>;
  return (
    <NavigationContext.Provider value={navigation}>
      <LocationContext.Provider value={loc}>
        <RouteContext.Provider value={route}>{children}</RouteContext.Provider>
      </LocationContext.Provider>
    </NavigationContext.Provider>
  );
}

/** The pages the panel can show: the same ones the app routes to. */
export function PanelRoutes() {
  return (
    <Routes>
      <Route path="/today" element={<LegacyRedirect />} />
      <Route path="/pipeline" element={<Pipeline />} />
      <Route path="/people" element={<People />} />
      <Route path="/people/:id" element={<PersonPage />} />
      <Route path="/companies/:id" element={<CompanyPage />} />
      <Route path="/map" element={<MapPage />} />
      <Route path="/discover" element={<Discover />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/drafts" element={<Navigate to="/inbox" replace />} />
      <Route path="/notes/new" element={<NotesNew />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/settings/:section" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/people" replace />} />
    </Routes>
  );
}
