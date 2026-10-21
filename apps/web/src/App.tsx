import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ChatEngineProvider } from './chat/engineContext';
import type { ChatEngine } from './chat/types';
import { ChatWithPanel } from './chat/ui/ChatWithPanel';
import { AppShell } from './components/AppShell';
import { AccountSync } from './components/account/AccountSync';
import { LegacyRedirect } from './legacyRoutes';
import { AuthApp } from './pages/AuthApp';
import { AuthDone } from './pages/AuthDone';
import { CompanyPage } from './pages/Company';
import { Discover } from './pages/Discover';
import { InboxPage } from './pages/Inbox';
import { Landing } from './pages/Landing';
import { MapPage } from './pages/MapPage';
import { NotesNew } from './pages/NotesNew';
import { Onboarding, onboardingPath } from './pages/Onboarding';
import { People } from './pages/People';
import { PersonPage } from './pages/Person';
import { SettingsPage } from './pages/Settings';
import { SessionProvider, useSession } from './state/session';
import { Spinner, ToastProvider } from './ui';

function Gate({ children }: { children: React.ReactNode }) {
  const { loading, user, userId } = useSession();
  const loc = useLocation();
  if (loading || (userId && !user))
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner />
      </div>
    );
  if (!userId) return <Navigate to="/" replace state={{ from: loc.pathname }} />;
  if (user && !user.onboardingCompletedAt && !loc.pathname.startsWith('/onboarding'))
    return <Navigate to={onboardingPath(user.onboardingStep)} replace />;
  return <>{children}</>;
}

/**
 * The app's layout route: the shell for someone signed in (with the chat at "/"), the landing page for everyone
 * else at "/". One shell instance serves every page, so moving between the chat and a page never remounts it.
 */
function Home() {
  const { loading, userId } = useSession();
  const loc = useLocation();
  if (loading)
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner />
      </div>
    );
  if (!userId)
    return loc.pathname === '/' ? <Landing /> : <Navigate to="/" replace state={{ from: loc.pathname }} />;
  return (
    <Gate>
      <AppShell />
    </Gate>
  );
}

export function App({ chatEngine }: { chatEngine?: ChatEngine }) {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <SessionProvider>
        <ChatEngineProvider engine={chatEngine}>
          <ToastProvider>
            <AccountSync />
            <Routes>
              {/* the landing page stays reachable for someone signed in (a bookmark, the demo's way back) */}
              <Route path="/welcome" element={<Landing />} />
              {/* Google sign-in comes back here in account mode (orbit-api redirects with #code or #error) */}
              <Route path="/auth/done" element={<AuthDone />} />
              <Route path="/auth/app" element={<AuthApp />} />
              <Route
                path="/onboarding/:step"
                element={
                  <Gate>
                    <Onboarding />
                  </Gate>
                }
              />
              <Route element={<Home />}>
                <Route index element={<ChatWithPanel />} />
                {/* Today's cards are in Drafts and its brief in the chat; the Pipeline is the People board */}
                <Route path="/today" element={<LegacyRedirect />} />
                <Route path="/pipeline" element={<LegacyRedirect />} />
                <Route path="/people" element={<People />} />
                <Route path="/people/:id" element={<PersonPage />} />
                <Route path="/companies/:id" element={<CompanyPage />} />
                <Route path="/map" element={<MapPage />} />
                <Route path="/discover" element={<Discover />} />
                <Route path="/inbox" element={<InboxPage />} />
                {/* the nav calls this page Drafts: a typed or bookmarked /drafts lands there too */}
                <Route path="/drafts" element={<Navigate to="/inbox" replace />} />
                <Route path="/notes/new" element={<NotesNew />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/:section" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ToastProvider>
        </ChatEngineProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
