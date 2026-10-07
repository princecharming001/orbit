import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { CompanyPage } from './pages/Company';
import { Discover } from './pages/Discover';
import { InboxPage } from './pages/Inbox';
import { Landing } from './pages/Landing';
import { MapPage } from './pages/MapPage';
import { NotesNew } from './pages/NotesNew';
import { Onboarding, onboardingPath } from './pages/Onboarding';
import { People } from './pages/People';
import { PersonPage } from './pages/Person';
import { Pipeline } from './pages/Pipeline';
import { SettingsPage } from './pages/Settings';
import { Today } from './pages/Today';
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

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <SessionProvider>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route
              path="/onboarding/:step"
              element={
                <Gate>
                  <Onboarding />
                </Gate>
              }
            />
            <Route
              element={
                <Gate>
                  <AppShell />
                </Gate>
              }
            >
              <Route path="/today" element={<Today />} />
              <Route path="/pipeline" element={<Pipeline />} />
              <Route path="/people" element={<People />} />
              <Route path="/people/:id" element={<PersonPage />} />
              <Route path="/companies/:id" element={<CompanyPage />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/discover" element={<Discover />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/notes/new" element={<NotesNew />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/:section" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
