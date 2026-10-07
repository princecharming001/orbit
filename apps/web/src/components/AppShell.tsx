import { useLiveQuery } from 'dexie-react-hooks';
import { Compass, Inbox, LayoutGrid, Map as MapIcon, Plus, Search, Settings, Sun, Users } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { isMessageSuggestion } from '../engine/brief';
import { dailyMaintenance } from '../engine/sync';
import { useSession } from '../state/session';
import { Avatar, cx, Kbd, modKeyLabel } from '../ui';
import { CommandPalette } from './CommandPalette';
import { OutboxScheduler } from './OutboxScheduler';

const NAV = [
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/pipeline', label: 'Pipeline', icon: LayoutGrid },
  { to: '/people', label: 'People', icon: Users },
  { to: '/map', label: 'Map', icon: MapIcon },
  { to: '/discover', label: 'Discover', icon: Compass },
  { to: '/inbox', label: 'Approvals', icon: Inbox },
];

export function AppShell() {
  const { user, userId } = useSession();
  const nav = useNavigate();
  const [palette, setPalette] = useState(false);
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // a new page starts at its top, not where the last one was scrolled to (before any card scrolls itself into view)
  useLayoutEffect(() => {
    void pathname;
    if (mainRef.current) mainRef.current.scrollTop = 0;
    window.scrollTo(0, 0);
  }, [pathname]);
  const pending =
    useLiveQuery(
      () =>
        userId
          ? db.suggestions
              .where('userId')
              .equals(userId)
              // the same list as the Approvals page: every message waiting for the student's OK
              .filter((s) => s.status === 'pending' && isMessageSuggestion(s.kind))
              .count()
          : 0,
      [userId],
    ) ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (user?.onboardingCompletedAt) dailyMaintenance(user).catch(console.error);
  }, [user?.id, user?.onboardingCompletedAt]);
  return (
    <div className="h-full flex">
      <OutboxScheduler />
      <aside className="w-[232px] shrink-0 border-r border-line bg-canvas-2/60 hidden md:flex flex-col">
        <div className="h-14 px-4 flex items-center gap-2">
          <Logo />
          <span className="font-semibold tracking-tight">Orbit</span>
        </div>
        <button
          onClick={() => setPalette(true)}
          aria-label={`Search (${modKeyLabel() === 'Ctrl' ? 'Ctrl' : 'Command'} K)`}
          className="mx-3 mb-3 h-9 rounded-lg border border-line bg-canvas flex items-center gap-2 px-3 text-ink-3 text-[13px] hover:bg-canvas-2"
        >
          <Search size={14} /> Search{' '}
          <span className="ml-auto flex gap-0.5">
            <Kbd>{modKeyLabel()}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <nav className="px-2 flex flex-col gap-0.5" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cx(
                  'h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-[14px]',
                  isActive
                    ? 'bg-canvas text-ink font-medium shadow-[0_1px_0_rgba(0,0,0,0.03)] border border-line'
                    : 'text-ink-2 hover:bg-canvas hover:text-ink border border-transparent',
                )
              }
            >
              <Icon size={16} className="text-ink-3" />
              {label}
              {label === 'Approvals' && pending > 0 && (
                <span
                  className="ml-auto text-[11px] bg-accent text-white rounded-full px-1.5 h-5 inline-flex items-center tabular"
                  title={`${pending} message${pending === 1 ? '' : 's'} waiting for your OK`}
                  data-testid="approvals-badge"
                >
                  {pending}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto p-2 flex flex-col gap-0.5">
          <button
            onClick={() => nav('/notes/new')}
            className="h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-[14px] text-ink-2 hover:bg-canvas hover:text-ink"
          >
            <Plus size={16} className="text-ink-3" /> Add note
          </button>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cx(
                'h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-[14px]',
                isActive
                  ? 'bg-canvas text-ink font-medium border border-line'
                  : 'text-ink-2 hover:bg-canvas hover:text-ink border border-transparent',
              )
            }
          >
            <Settings size={16} className="text-ink-3" /> Settings
          </NavLink>
          {user && (
            <div className="mt-2 px-2.5 h-10 flex items-center gap-2 text-[13px]">
              <Avatar name={user.fullName} src={user.avatarUrl} id={user.id} size={24} />
              <span className="truncate">{user.fullName}</span>
            </div>
          )}
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden h-12 border-b border-line flex items-center gap-1 px-3">
          <Logo /> <span className="font-semibold ml-1">Orbit</span>
          <button
            onClick={() => setPalette(true)}
            className="ml-auto p-2.5 rounded-md hover:bg-canvas-2"
            aria-label="Search"
            title="Search people and actions"
          >
            <Search size={18} />
          </button>
          <NavLink
            to="/notes/new"
            className="p-2.5 rounded-md hover:bg-canvas-2"
            aria-label="Add note"
            title="Add a note about a conversation"
            data-testid="mobile-add-note"
          >
            <Plus size={18} />
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => cx('p-2.5 rounded-md hover:bg-canvas-2', isActive && 'text-accent')}
            aria-label="Settings"
            title="Settings"
            data-testid="mobile-settings"
          >
            <Settings size={18} />
          </NavLink>
        </header>
        <main ref={mainRef} className="flex-1 min-h-0 overflow-y-auto scroll-thin">
          <div className="max-w-[1120px] mx-auto px-4 md:px-8 py-6 pb-24 md:pb-8">
            <Outlet />
          </div>
        </main>
        <nav className="md:hidden border-t border-line bg-canvas grid grid-cols-6 h-14" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cx(
                  'relative min-w-0 flex flex-col items-center justify-center gap-0.5 text-[10px]',
                  isActive ? 'text-accent' : 'text-ink-3',
                )
              }
            >
              <Icon size={18} aria-hidden />
              <span className="truncate max-w-full px-0.5">{label}</span>
              {label === 'Approvals' && pending > 0 && (
                <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 h-4 px-1 rounded-full bg-accent text-white text-[9px] inline-flex items-center justify-center tabular">
                  {pending}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="14" fill="none" stroke="#5B5BD6" strokeWidth="2" />
      <circle cx="16" cy="16" r="4" fill="#5B5BD6" />
      <circle cx="26" cy="10" r="2.5" fill="#5B5BD6" />
    </svg>
  );
}
