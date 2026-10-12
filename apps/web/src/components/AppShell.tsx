import { useLiveQuery } from 'dexie-react-hooks';
import {
  Archive,
  Compass,
  Ellipsis,
  Inbox,
  LayoutGrid,
  Map as MapIcon,
  MessageSquare,
  NotebookPen,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  SquarePen,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChatEngine } from '../chat/engineContext';
import type { ChatConversation } from '../chat/types';
import { threadActions, useThread } from '../chat/ui/threadStore';
import { db } from '../db/schema';
import { dailyMaintenance } from '../engine/sync';
import { draftLists, startedDrafts } from '../engine/today';
import { useSession } from '../state/session';
import { Avatar, calendarDaysBetween, cx, modKeyLabel } from '../ui';
import { CommandPalette } from './CommandPalette';
import { DemoBanner } from './DemoBanner';
import { OutboxScheduler } from './OutboxScheduler';

const NAV_TOP = [
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/pipeline', label: 'Pipeline', icon: LayoutGrid },
  { to: '/people', label: 'People', icon: Users },
];
const NAV_MORE = [
  { to: '/map', label: 'Map', icon: MapIcon },
  { to: '/discover', label: 'Discover', icon: Compass },
  { to: '/inbox', label: 'Drafts', icon: Inbox },
];
const PHONE_TABS = [{ to: '/', label: 'Chat', icon: MessageSquare }, ...NAV_TOP];

const SIDEBAR_KEY = 'orbit:sidebar';

export function AppShell() {
  const { user, userId } = useSession();
  const nav = useNavigate();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const fillsScreen = pathname === '/map';
  const isChat = pathname === '/';
  const engine = useChatEngine();
  const chat = useMemo(() => threadActions(engine), [engine]);
  // a new page starts at its top, not where the last one was scrolled to (before any card scrolls itself into view)
  useLayoutEffect(() => {
    void pathname;
    if (mainRef.current) mainRef.current.scrollTop = 0;
    window.scrollTo(0, 0);
    setMore(false);
  }, [pathname]);
  // what waits on the student in Drafts: the "To send" tab (drafts worth sending today, not the ones that can wait,
  // and the drafts the student started) plus messages opened in the mail app or LinkedIn and not marked as sent
  const pending =
    useLiveQuery(async () => {
      if (!userId) return 0;
      const [suggestions, outbound, briefs] = await Promise.all([
        db.suggestions.where('userId').equals(userId).toArray(),
        db.outbound.where('userId').equals(userId).toArray(),
        db.briefs.where('userId').equals(userId).toArray(),
      ]);
      const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
      return (
        draftLists(suggestions, outbound, latest, new Date()).forToday.length +
        startedDrafts(outbound).length +
        outbound.filter((o) => o.status === 'handed_off').length
      );
    }, [userId]) ?? 0;
  const gmail =
    useLiveQuery(
      async () =>
        userId
          ? (await db.integrations.where('userId').equals(userId).toArray()).some(
              (i) => i.provider === 'google' && i.status === 'active',
            )
          : false,
      [userId],
    ) ?? false;
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
  // the phone's More sheet closes on Escape like any other sheet
  useEffect(() => {
    if (!more) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMore(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [more]);
  const toggleSidebar = () => {
    setExpanded((v) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, v ? '0' : '1');
      } catch {
        // storage blocked: the choice lasts for this page only
      }
      return !v;
    });
  };
  const newChat = () => {
    chat.newChat();
    nav('/');
  };
  const badge = pending > 0 && (
    <span
      className={cx(
        'text-[10.5px] bg-accent text-white rounded-full min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center tabular font-medium',
        expanded ? 'ml-auto' : 'absolute top-0.5 right-0.5',
      )}
      title={`${pending} message${pending === 1 ? '' : 's'} waiting on you: to send, or to mark as sent`}
      data-testid="approvals-badge"
    >
      {pending}
    </span>
  );
  const itemClass = (active: boolean) =>
    cx(
      'relative rounded-xl flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-colors',
      expanded ? 'h-10 px-2.5 gap-3 text-[14px]' : 'tip w-11 h-11 justify-center',
      active ? 'bg-accent-soft text-accent font-medium' : 'text-ink-2 hover:bg-white/70 hover:text-ink',
    );
  const railLink = (to: string, label: string, Icon: typeof Sun, extra?: ReactNode) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) => itemClass(isActive)}
      aria-label={label}
      data-tip={expanded ? undefined : label}
    >
      <Icon size={20} aria-hidden className="shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
      {extra}
    </NavLink>
  );
  const railButton = (label: string, Icon: typeof Sun, onClick: () => void, testId?: string) => (
    <button
      type="button"
      onClick={onClick}
      className={itemClass(false)}
      aria-label={label}
      data-tip={expanded ? undefined : label}
      data-testid={testId}
    >
      <Icon size={20} aria-hidden className="shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
    </button>
  );
  return (
    <div className="h-full flex">
      <OutboxScheduler />
      <aside
        className={cx(
          'shrink-0 hidden md:flex flex-col h-full border-r border-white/60 bg-white/45 backdrop-blur-[20px] backdrop-saturate-[160%] transition-[width] duration-200',
          expanded ? 'w-[260px] px-3' : 'w-16 px-2.5',
        )}
        data-testid="rail"
        data-expanded={expanded}
      >
        <div className={cx('h-14 flex items-center shrink-0', expanded ? 'px-1 gap-2' : 'justify-center')}>
          <NavLink
            to="/"
            onClick={chat.newChat}
            className="inline-flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Orbit home"
          >
            <Logo />
            {expanded && <span className="font-semibold tracking-tight text-[16px]">Orbit</span>}
          </NavLink>
          {expanded && (
            <button
              type="button"
              onClick={toggleSidebar}
              className="ml-auto w-9 h-9 rounded-lg inline-flex items-center justify-center text-ink-2 hover:bg-white/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Collapse sidebar"
              aria-expanded
              data-testid="sidebar-toggle"
            >
              <PanelLeft size={18} aria-hidden />
            </button>
          )}
        </div>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {!expanded && railButton('Expand sidebar', PanelLeft, toggleSidebar, 'sidebar-toggle')}
          {railButton('New chat', SquarePen, newChat, 'new-chat')}
          {NAV_TOP.map(({ to, label, icon }) => railLink(to, label, icon))}
          <div className="my-1.5 h-px bg-line mx-1" role="separator" />
          {NAV_MORE.map(({ to, label, icon }) =>
            railLink(to, label, icon, label === 'Drafts' ? badge : undefined),
          )}
        </nav>
        {expanded && <Recent chat={chat} />}
        <div className={cx('mt-auto pb-3 flex flex-col gap-1', !expanded && 'items-center')}>
          {railButton(
            `Search (${modKeyLabel() === 'Ctrl' ? 'Ctrl' : 'Command'} K)`,
            Search,
            () => setPalette(true),
            'rail-search',
          )}
          {railLink('/settings', 'Settings', Settings)}
          {user &&
            (expanded ? (
              <div
                className="mt-1 px-1.5 h-12 flex items-center gap-2.5 text-[13px]"
                data-testid="account-row"
              >
                <Avatar name={user.fullName} src={user.avatarUrl} id={user.id} size={30} />
                <div className="min-w-0">
                  <div className="font-medium truncate">{user.fullName}</div>
                  <div className="text-[12px] text-ink-3 truncate">
                    {gmail ? 'Gmail connected' : 'Local data'}
                  </div>
                </div>
              </div>
            ) : (
              <NavLink
                to="/settings/profile"
                className="tip mt-1 w-11 h-11 rounded-full inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={user.fullName}
                data-tip={user.fullName}
              >
                <Avatar name={user.fullName} src={user.avatarUrl} id={user.id} size={30} />
              </NavLink>
            ))}
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden h-12 shrink-0 border-b border-white/60 bg-white/50 backdrop-blur-[20px] flex items-center gap-1 px-3">
          <NavLink
            to="/"
            onClick={chat.newChat}
            className="inline-flex items-center gap-1.5"
            aria-label="Orbit home"
          >
            <Logo /> <span className="font-semibold">Orbit</span>
          </NavLink>
          <button
            onClick={() => setPalette(true)}
            className="ml-auto w-11 h-11 rounded-md inline-flex items-center justify-center hover:bg-white/70"
            aria-label="Search"
            title="Search people and actions"
          >
            <Search size={18} />
          </button>
          <NavLink
            to="/notes/new"
            className="h-11 px-2 rounded-md hover:bg-white/70 inline-flex items-center gap-1"
            aria-label="Add note"
            title="Add a note about a conversation"
            data-testid="mobile-add-note"
          >
            <NotebookPen size={18} aria-hidden /> <span className="text-[12px]">Add note</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cx(
                'w-11 h-11 rounded-md inline-flex items-center justify-center hover:bg-white/70',
                isActive && 'text-accent',
              )
            }
            aria-label="Settings"
            title="Settings"
            data-testid="mobile-settings"
          >
            <Settings size={18} />
          </NavLink>
        </header>
        <DemoBanner />
        <main
          ref={mainRef}
          className={cx('flex-1 min-h-0', isChat ? 'overflow-hidden' : 'overflow-y-auto scroll-thin')}
        >
          {isChat ? (
            <Outlet />
          ) : (
            <div
              className={cx(
                'max-w-[1120px] mx-auto px-4 md:px-8 py-6 pb-24 md:pb-8',
                // on a wide screen the map fills exactly the room under the header and the demo banner, so the page
                // never scrolls under it (focusing the canvas or a route would otherwise jump the page)
                fillsScreen && 'lg:h-full lg:flex lg:flex-col',
              )}
            >
              <Outlet />
            </div>
          )}
        </main>
        {more && (
          <div className="md:hidden fixed inset-0 z-40" data-testid="more-sheet">
            <div className="absolute inset-0 bg-ink/20" onClick={() => setMore(false)} />
            <div
              className="glass glass-strong absolute inset-x-2 bottom-16 rounded-[20px] p-2 fade-up"
              role="dialog"
              aria-label="More"
            >
              <div className="flex items-center justify-between px-2 h-9">
                <span className="text-[13px] font-medium text-ink-3">More</span>
                <button
                  type="button"
                  onClick={() => setMore(false)}
                  className="w-9 h-9 inline-flex items-center justify-center rounded-md"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
              {[
                ...NAV_MORE,
                { to: '/notes/new', label: 'Add note', icon: NotebookPen },
                { to: '/settings', label: 'Settings', icon: Settings },
              ].map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMore(false)}
                  className={({ isActive }) =>
                    cx(
                      'h-12 px-3 rounded-xl flex items-center gap-3 text-[15px]',
                      isActive ? 'bg-accent-soft text-accent' : 'hover:bg-white/70',
                    )
                  }
                >
                  <Icon size={20} aria-hidden className="text-ink-3" /> {label}
                  {label === 'Drafts' && pending > 0 && (
                    <span className="ml-auto text-[11px] bg-accent text-white rounded-full px-1.5 h-5 inline-flex items-center tabular">
                      {pending}
                    </span>
                  )}
                </NavLink>
              ))}
              {user && (
                <div className="mt-1 px-3 h-12 flex items-center gap-2.5 text-[13px] border-t border-line-2">
                  <Avatar name={user.fullName} src={user.avatarUrl} id={user.id} size={28} />
                  <span className="truncate">{user.fullName}</span>
                  <span className="ml-auto text-ink-3 text-[12px]">
                    {gmail ? 'Gmail connected' : 'Local data'}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        <nav
          className="md:hidden shrink-0 border-t border-white/60 bg-white/70 backdrop-blur-[20px] grid grid-cols-5 h-14 pb-[env(safe-area-inset-bottom)]"
          aria-label="Main"
          data-testid="tab-bar"
        >
          {PHONE_TABS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={to === '/' ? chat.newChat : undefined}
              className={({ isActive }) =>
                cx(
                  'relative min-w-0 min-h-11 flex flex-col items-center justify-center gap-0.5 text-[10.5px]',
                  isActive && !more ? 'text-accent' : 'text-ink-3',
                )
              }
            >
              <Icon size={20} aria-hidden />
              <span className="truncate max-w-full px-0.5">{label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            className={cx(
              'relative min-w-0 min-h-11 flex flex-col items-center justify-center gap-0.5 text-[10.5px]',
              more || NAV_MORE.some((n) => pathname.startsWith(n.to)) || pathname.startsWith('/settings')
                ? 'text-accent'
                : 'text-ink-3',
            )}
            aria-label="More"
            aria-expanded={more}
            data-testid="tab-more"
          >
            <Ellipsis size={20} aria-hidden />
            <span>More</span>
            {pending > 0 && (
              <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 h-4 px-1 rounded-full bg-accent text-white text-[9px] inline-flex items-center justify-center tabular">
                {pending}
              </span>
            )}
          </button>
        </nav>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

/** Recent conversations in the expanded sidebar, newest first, grouped by day, with rename and archive. */
function Recent({ chat }: { chat: ReturnType<typeof threadActions> }) {
  const engine = useChatEngine();
  const thread = useThread();
  const nav = useNavigate();
  const [items, setItems] = useState<ChatConversation[]>([]);
  const [editing, setEditing] = useState<{ id: string; title: string } | undefined>();
  useEffect(() => {
    let live = true;
    engine
      .listConversations()
      .then((xs) => live && setItems(xs))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [engine, thread.historyVersion]);
  const groups = useMemo(() => {
    const now = new Date();
    const g: Record<'Today' | 'Yesterday' | 'Earlier', ChatConversation[]> = {
      Today: [],
      Yesterday: [],
      Earlier: [],
    };
    for (const c of items) {
      const d = calendarDaysBetween(new Date(c.updatedAt), now);
      g[d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : 'Earlier'].push(c);
    }
    return g;
  }, [items]);
  const open = async (id: string) => {
    await chat.open(id);
    nav('/');
  };
  const commitRename = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    setEditing(undefined);
    if (title) await chat.rename(editing.id, title);
  };
  return (
    <div className="mt-4 flex-1 min-h-0 overflow-y-auto scroll-thin -mx-1 px-1" data-testid="recent">
      <div className="px-2.5 text-[12px] font-medium text-ink-3 mb-1">Recent</div>
      {items.length === 0 && <p className="px-2.5 text-[12.5px] text-ink-3">No conversations yet.</p>}
      {(Object.keys(groups) as (keyof typeof groups)[]).map(
        (k) =>
          groups[k].length > 0 && (
            <div key={k} className="mb-2" data-testid={`recent-${k.toLowerCase()}`}>
              <div className="px-2.5 text-[11px] uppercase tracking-wide text-ink-3 mt-2 mb-0.5">{k}</div>
              <ul>
                {groups[k].map((c) => (
                  <li key={c.id} className="group relative">
                    {editing?.id === c.id ? (
                      <input
                        ref={(el) => el?.focus()}
                        value={editing.title}
                        onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setEditing(undefined);
                        }}
                        className="w-full h-9 px-2.5 rounded-lg border border-accent bg-canvas text-[13.5px] focus:outline-none"
                        aria-label="Conversation title"
                        data-testid="recent-rename-input"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => open(c.id)}
                          className={cx(
                            'w-full h-9 px-2.5 pr-16 rounded-lg text-left text-[13.5px] truncate hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                            thread.conversation?.id === c.id && 'bg-white/80 font-medium',
                          )}
                          data-testid="recent-item"
                        >
                          {c.title}
                        </button>
                        <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            type="button"
                            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-ink-3 hover:bg-white hover:text-ink"
                            aria-label={`Rename ${c.title}`}
                            onClick={() => setEditing({ id: c.id, title: c.title })}
                            data-testid="recent-rename"
                          >
                            <Pencil size={13} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-ink-3 hover:bg-white hover:text-ink"
                            aria-label={`Archive ${c.title}`}
                            onClick={() => chat.archive(c.id)}
                            data-testid="recent-archive"
                          >
                            <Archive size={13} aria-hidden />
                          </button>
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ),
      )}
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="14" fill="none" stroke="#2F6BFF" strokeWidth="2" />
      <circle cx="16" cy="16" r="4" fill="#2F6BFF" />
      <circle cx="26" cy="10" r="2.5" fill="#3EC7F2" />
    </svg>
  );
}
