import { useLiveQuery } from 'dexie-react-hooks';
import {
  Archive,
  CalendarClock,
  Compass,
  Ellipsis,
  Inbox,
  LogOut,
  Map as MapIcon,
  MessageSquare,
  NotebookPen,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Settings,
  SquarePen,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChatEngine } from '../chat/engineContext';
import type { ChatConversation } from '../chat/types';
import { threadActions, useThread } from '../chat/ui/threadStore';
import { db } from '../db/schema';
import { dailyMaintenance } from '../engine/sync';
import { draftLists, startedDrafts } from '../engine/today';
import { PageLoading, preloadPages } from '../pages/lazyPages';
import { useSession } from '../state/session';
import { Avatar, calendarDaysBetween, cx, Skeleton, useToast } from '../ui';
import { ActivityLine } from './ActivityLine';
import { RatePrompt } from './account/RatePrompt';
import { useTrackPlace } from './BackLink';
import { CommandPalette } from './CommandPalette';
import { DemoBanner } from './DemoBanner';
import { LinkedInAutoSync } from './LinkedInAutoSync';
import { LinkedInProgressBanner } from './LinkedInProgressBanner';
import { MeetingNotesAutoSync } from './MeetingNotesAutoSync';
import { MorningBrief } from './MorningBrief';
import { NotesWatch } from './NotesWatch';
import { OutboxScheduler } from './OutboxScheduler';
import { ReplyWatch } from './ReplyWatch';
import { useLogOut } from './useLogOut';
import { WeekReviewLauncher } from './WeekReview';

// the chat is home (New chat and the logo open it); People holds the board and the list, Drafts what waits to be sent
const NAV_TOP = [
  { to: '/people', label: 'People', icon: Users },
  { to: '/inbox', label: 'Drafts', icon: Inbox },
  // plan 23 §4.4: the page a student opens at 2:50 pm, one tap from anywhere
  { to: '/chats', label: 'Chats', icon: CalendarClock },
];
const NAV_MORE = [
  { to: '/map', label: 'Map', icon: MapIcon },
  { to: '/discover', label: 'Discover', icon: Compass },
];
const PHONE_TABS = [
  { to: '/', label: 'Chat', icon: MessageSquare },
  ...NAV_TOP.filter((n) => n.to !== '/chats'),
  { to: '/map', label: 'Map', icon: MapIcon },
];
/** The phone's More sheet: what does not fit in the tab bar. */
const PHONE_MORE = [
  { to: '/chats', label: 'Chats', icon: CalendarClock },
  { to: '/discover', label: 'Discover', icon: Compass },
  { to: '/notes/new', label: 'Add note', icon: NotebookPen },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const SIDEBAR_KEY = 'orbit:sidebar';

export function AppShell() {
  const { user, userId } = useSession();
  const nav = useNavigate();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  // labelled by default, as Tsenta's sidebar is; a student who collapses it keeps the icon rail
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const { pathname } = useLocation();
  useTrackPlace();
  const mainRef = useRef<HTMLElement>(null);
  const fillsScreen = pathname === '/map';
  // pages read as text (settings, notes, one person) keep a column you can read across; boards, lists and grids take
  // the room the screen has, so a wide screen shows more at once instead of margins
  const reading = /^\/(settings|notes)(\/|$)/.test(pathname);
  const focused = /^\/(people|companies)\/[^/]+/.test(pathname);
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
  const logOut = useLogOut();
  // today's chats still ahead: the Chats badge
  const chatsToday =
    useLiveQuery(async () => {
      if (!userId) return 0;
      const now = new Date();
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return db.events
        .where('startAt')
        .between(new Date(now.getTime() - 4 * 3_600_000).toISOString(), end.toISOString(), true, true)
        .filter(
          (e) =>
            e.userId === userId &&
            e.status !== 'cancelled' &&
            (!!e.isCoffeeChat || !!e.chatId) &&
            Date.parse(e.endAt) > now.getTime(),
        )
        .count();
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
  // every page downloads while the app sits idle, so moving between them never waits on the network
  useEffect(() => preloadPages(), []);
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
        'tabular font-medium inline-flex items-center justify-center rounded-full',
        expanded
          ? 'ml-auto text-[11px] min-w-[22px] h-[20px] px-1.5 bg-accent-soft text-accent border border-[#d3e5dc]'
          : 'absolute top-1 right-1 text-[10px] min-w-[16px] h-[16px] px-1 bg-ember text-white',
      )}
      title={`${pending} message${pending === 1 ? '' : 's'} waiting on you: to send, or to mark as sent`}
      data-testid="approvals-badge"
    >
      {pending}
    </span>
  );
  const chatsBadge = chatsToday > 0 && (
    <span
      className={cx(
        'tabular font-medium inline-flex items-center justify-center rounded-full',
        expanded
          ? 'ml-auto text-[11px] min-w-[22px] h-[20px] px-1.5 bg-canvas-2 text-ink-2 border border-line'
          : 'absolute top-1 right-1 text-[10px] min-w-[16px] h-[16px] px-1 bg-ink text-white',
      )}
      title={`${chatsToday} chat${chatsToday === 1 ? '' : 's'} today`}
      data-testid="chats-badge"
    >
      {chatsToday}
    </span>
  );
  const itemClass = (active: boolean) =>
    cx(
      'relative rounded-[10px] flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 transition-colors duration-150',
      expanded ? 'h-9 px-2.5 gap-2.5 text-[14px]' : 'tip w-11 h-11 justify-center',
      // Tsenta's active item: a soft grey fill and a short dark bar at the left edge
      active
        ? cx(
            'bg-[#f0efed] text-ink font-medium',
            expanded &&
              "before:content-[''] before:absolute before:-left-3 before:top-2 before:bottom-2 before:w-[3px] before:rounded-r before:bg-ink",
          )
        : 'text-ink-2 hover:bg-[#f5f4f2] hover:text-ink',
    );
  const railLink = (to: string, label: string, Icon: typeof Users, extra?: ReactNode) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) => itemClass(isActive)}
      aria-label={label}
      data-tip={expanded ? undefined : label}
    >
      <Icon size={expanded ? 17 : 19} strokeWidth={1.75} aria-hidden className="shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
      {extra}
    </NavLink>
  );
  const railButton = (label: string, Icon: typeof Users, onClick: () => void, testId?: string) => (
    <button
      type="button"
      onClick={onClick}
      className={itemClass(false)}
      aria-label={label}
      data-tip={expanded ? undefined : label}
      data-testid={testId}
    >
      <Icon size={expanded ? 17 : 19} strokeWidth={1.75} aria-hidden className="shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
    </button>
  );
  return (
    <div className="h-full flex">
      <OutboxScheduler />
      <ReplyWatch />
      <NotesWatch />
      <WeekReviewLauncher />
      <LinkedInAutoSync />
      <MeetingNotesAutoSync />
      <LinkedInProgressBanner />
      <MorningBrief />
      <RatePrompt />
      <aside
        className={cx(
          'shrink-0 hidden md:flex flex-col h-full border-r border-line bg-canvas transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
          expanded ? 'w-[248px] px-3' : 'w-16 px-2.5',
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
            {expanded && <span className="font-medium tracking-[-0.01em] text-[16px]">Orbit</span>}
          </NavLink>
          {expanded && (
            <button
              type="button"
              onClick={toggleSidebar}
              className="ml-auto w-9 h-9 rounded-lg inline-flex items-center justify-center text-ink-2 hover:bg-canvas-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Collapse sidebar"
              aria-expanded
              data-testid="sidebar-toggle"
            >
              <PanelLeft size={18} aria-hidden />
            </button>
          )}
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {!expanded && railButton('Expand sidebar', PanelLeft, toggleSidebar, 'sidebar-toggle')}
          {expanded && <div className="h-2" aria-hidden />}
          {railButton('New chat', SquarePen, newChat, 'new-chat')}
          {NAV_TOP.map(({ to, label, icon }) =>
            railLink(
              to,
              label,
              icon,
              label === 'Drafts' ? badge : label === 'Chats' ? chatsBadge : undefined,
            ),
          )}
          <div className="my-2 h-px bg-line mx-2.5" role="separator" />
          {NAV_MORE.map(({ to, label, icon }) => railLink(to, label, icon))}
        </nav>
        {expanded && <Recent chat={chat} />}
        <div className={cx('mt-auto pb-3 pt-2 flex flex-col gap-0.5', !expanded && 'items-center')}>
          {/* what Orbit is doing, in one quiet line above the account row (plan 23 §4.7) */}
          <ActivityLine compact={!expanded} className={expanded ? 'mb-1' : undefined} />
          {railLink('/settings', 'Settings', Settings)}
          {user && <AccountMenu user={user} gmail={gmail} expanded={expanded} />}
        </div>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden h-12 shrink-0 border-b border-line bg-canvas/90 backdrop-blur-md flex items-center gap-1 px-3">
          <NavLink
            to="/"
            onClick={chat.newChat}
            className="inline-flex items-center gap-1.5"
            aria-label="Orbit home"
          >
            <Logo /> <span className="font-medium tracking-[-0.01em]">Orbit</span>
          </NavLink>
          <NavLink
            to="/notes/new"
            className="ml-auto h-11 px-2 rounded-md hover:bg-canvas-2 inline-flex items-center gap-1"
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
                'w-11 h-11 rounded-md inline-flex items-center justify-center hover:bg-canvas-2',
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
          className={cx('flex-1 min-h-0 bg-page', isChat ? 'overflow-hidden' : 'overflow-y-auto scroll-thin')}
        >
          {isChat ? (
            <Outlet />
          ) : (
            <div
              // a soft fade as the student moves between sections (keyed on the section, so a person page to the
              // next person does not replay it)
              key={pathname.split('/')[1]}
              className={cx(
                'page-in',
                // the page's own layout (columns, side by side or stacked) follows this box, so the same page also fits the chat's side panel
                // the map takes the whole width, edge to edge: the orbit needs the room; every other page reads in a column
                fillsScreen
                  ? '@container pb-24 md:pb-0'
                  : cx(
                      '@container mx-auto px-4 md:px-8 xl:px-10 py-6 md:py-9 pb-24 md:pb-10',
                      reading ? 'max-w-[1120px]' : focused ? 'max-w-[1320px]' : 'max-w-[1800px]',
                    ),
                // on a wide screen the map fills exactly the room under the header and the demo banner, so the page
                // never scrolls under it (focusing the canvas or a route would otherwise jump the page)
                fillsScreen && 'lg:h-full lg:flex lg:flex-col',
              )}
            >
              <Suspense fallback={<PageLoading path={pathname} />}>
                <Outlet />
              </Suspense>
            </div>
          )}
        </main>
        {more && (
          <div className="md:hidden fixed inset-0 z-40" data-testid="more-sheet">
            <div className="absolute inset-0 bg-black/20" onClick={() => setMore(false)} />
            <div
              className="glass glass-strong absolute inset-x-2 bottom-16 rounded-[18px] p-2 sheet-in"
              role="dialog"
              aria-label="More"
            >
              <div className="flex items-center justify-between px-2 h-9">
                <span className="label-mono">More</span>
                <button
                  type="button"
                  onClick={() => setMore(false)}
                  className="w-9 h-9 inline-flex items-center justify-center rounded-md"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
              <ActivityLine below className="px-0.5 pb-1" />
              {PHONE_MORE.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMore(false)}
                  className={({ isActive }) =>
                    cx(
                      'h-12 px-3 rounded-[12px] flex items-center gap-3 text-[15px]',
                      isActive ? 'bg-[#f0efed] text-ink font-medium' : 'hover:bg-canvas-2',
                    )
                  }
                >
                  <Icon size={20} aria-hidden className="text-ink-3" /> {label}
                </NavLink>
              ))}
              {user && (
                <div className="mt-1 px-3 h-12 flex items-center gap-2.5 text-[13px] border-t border-line-2">
                  <Avatar name={user.fullName} src={user.avatarUrl} id={user.id} size={28} />
                  <span className="truncate">{user.fullName}</span>
                  <button
                    type="button"
                    onClick={() => void logOut()}
                    className="ml-auto h-8 px-3 rounded-full inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
                    data-testid="drawer-log-out"
                  >
                    <LogOut size={14} aria-hidden /> Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        <nav
          className="md:hidden shrink-0 border-t border-line bg-canvas/95 backdrop-blur-md grid grid-cols-5 h-14 pb-[env(safe-area-inset-bottom)]"
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
                  isActive && !more ? 'text-ink font-medium' : 'text-ink-3',
                )
              }
            >
              <Icon size={20} aria-hidden />
              <span className="truncate max-w-full px-0.5">{label}</span>
              {label === 'Drafts' && pending > 0 && (
                <span
                  className="absolute top-1.5 left-1/2 ml-2 min-w-4 h-4 px-1 rounded-full bg-ember text-white text-[9px] inline-flex items-center justify-center tabular"
                  data-testid="tab-drafts-badge"
                >
                  {pending}
                </span>
              )}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            className={cx(
              'relative min-w-0 min-h-11 flex flex-col items-center justify-center gap-0.5 text-[10.5px]',
              more || PHONE_MORE.some((n) => pathname.startsWith(n.to))
                ? 'text-ink font-medium'
                : 'text-ink-3',
            )}
            aria-label="More"
            aria-expanded={more}
            data-testid="tab-more"
          >
            <Ellipsis size={20} aria-hidden />
            <span>More</span>
          </button>
        </nav>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

/**
 * The student at the foot of the sidebar: a quiet row (an avatar alone when the sidebar is narrow) that opens a small
 * menu above it, with their profile and settings, and Log out.
 */
function AccountMenu({
  user,
  gmail,
  expanded,
}: {
  user: { id: string; fullName: string; avatarUrl?: string };
  gmail: boolean;
  expanded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const logOut = useLogOut();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx(
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-colors',
          expanded
            ? 'mt-2 w-full px-2.5 h-12 rounded-[10px] text-ink flex items-center gap-2.5 text-[13px] text-left hover:bg-canvas-2'
            : 'tip mt-1 w-11 h-11 rounded-full inline-flex items-center justify-center',
          open && expanded && 'bg-canvas-2',
        )}
        aria-label={expanded ? undefined : user.fullName}
        data-tip={expanded ? undefined : user.fullName}
        data-testid="account-row"
      >
        <Avatar name={user.fullName} src={user.avatarUrl} id={user.id} size={30} />
        {expanded && (
          <div className="min-w-0">
            <div className="font-medium truncate">{user.fullName}</div>
            <div className="text-[12px] text-ink-3 truncate">{gmail ? 'Gmail connected' : 'Local data'}</div>
          </div>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className={cx(
            'pop-in absolute z-50 bottom-full mb-1.5 w-56 rounded-[12px] border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]',
            expanded ? 'left-0' : 'left-0',
          )}
          data-testid="account-menu"
        >
          <NavLink
            to="/settings/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="h-9 px-2.5 rounded-[8px] flex items-center gap-2 text-[13.5px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
          >
            <Settings size={15} aria-hidden /> Profile and settings
          </NavLink>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logOut();
            }}
            className="w-full h-9 px-2.5 rounded-[8px] flex items-center gap-2 text-[13.5px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
            data-testid="log-out"
          >
            <LogOut size={15} aria-hidden /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Recent conversations in the expanded sidebar: the pinned ones on top, then the rest newest first, grouped by day,
 * each with pin, rename and archive.
 */
function Recent({ chat }: { chat: ReturnType<typeof threadActions> }) {
  const engine = useChatEngine();
  const thread = useThread();
  const nav = useNavigate();
  // undefined until the first list arrives: the sidebar shows lines, never "No conversations yet", meanwhile
  const [items, setItems] = useState<ChatConversation[]>();
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
    const g: Record<'Pinned' | 'Today' | 'Yesterday' | 'Earlier', ChatConversation[]> = {
      Pinned: [],
      Today: [],
      Yesterday: [],
      Earlier: [],
    };
    for (const c of items ?? []) {
      if (c.pinnedAt) {
        g.Pinned.push(c);
        continue;
      }
      const d = calendarDaysBetween(new Date(c.updatedAt), now);
      g[d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : 'Earlier'].push(c);
    }
    return g;
  }, [items]);
  const toast = useToast();
  const open = async (id: string) => {
    try {
      await chat.open(id);
    } catch {
      // archived or deleted in another tab since the list was read: say so, and let the list catch up
      toast.push({ text: 'That conversation is no longer here.', tone: 'bad' });
      engine
        .listConversations()
        .then(setItems)
        .catch(() => undefined);
      return;
    }
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
      <div className="label-mono px-2.5 mb-1">Recent</div>
      {items === undefined && (
        <div className="px-2.5 pt-1 space-y-2.5 loading-in" aria-hidden data-testid="recent-loading">
          {['78%', '62%', '70%'].map((w) => (
            <Skeleton key={w} className="h-2.5" style={{ width: w }} />
          ))}
        </div>
      )}
      {items?.length === 0 && <p className="px-2.5 text-[12.5px] text-ink-3">No conversations yet.</p>}
      {(Object.keys(groups) as (keyof typeof groups)[]).map(
        (k) =>
          groups[k].length > 0 && (
            <div key={k} className="mb-2" data-testid={`recent-${k.toLowerCase()}`}>
              <div className="px-2.5 text-[11.5px] text-ink-3 mt-2 mb-0.5">{k}</div>
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
                        className="w-full h-9 px-2.5 rounded-[10px] border border-ink/30 bg-canvas text-[13.5px] focus:outline-none"
                        aria-label="Conversation title"
                        data-testid="recent-rename-input"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => open(c.id)}
                          className={cx(
                            'w-full h-8 px-2.5 pr-24 rounded-[10px] text-left text-[13.5px] text-ink-2 truncate hover:bg-[#f5f4f2] hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20',
                            thread.conversation?.id === c.id && 'bg-[#f0efed] text-ink font-medium',
                          )}
                          data-testid="recent-item"
                        >
                          {c.title}
                        </button>
                        <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            type="button"
                            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-ink-3 hover:bg-white hover:text-ink"
                            aria-label={c.pinnedAt ? `Unpin ${c.title}` : `Pin ${c.title}`}
                            title={c.pinnedAt ? 'Unpin' : 'Pin to the top'}
                            onClick={() => chat.pin(c.id, !c.pinnedAt)}
                            data-testid={c.pinnedAt ? 'recent-unpin' : 'recent-pin'}
                          >
                            {c.pinnedAt ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
                          </button>
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

/** Orbit's mark: one orbit round a centre, with a single moon on it, in plain ink lines. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden
      className="shrink-0 text-ink"
      data-testid="logo"
    >
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="6.2"
        transform="rotate(-25 16 16)"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="16" cy="16" r="3.6" fill="currentColor" />
      <circle cx="23.4" cy="8.3" r="2.5" fill="currentColor" />
    </svg>
  );
}
