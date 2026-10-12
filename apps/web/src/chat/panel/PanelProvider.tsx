import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { subscribeAutoOpen } from '../ui/threadStore';
import { setPanelHint } from './panelHint';
import { chatUrlWithPanel, panelFromSearch, panelizable, panelKey } from './routes';
import { usePanelTitle } from './usePanelTitle';

/**
 * The side panel's state. The address bar is the source of truth: the chat's URL carries the open page ("/?panel=
 * /people/p4"), so a refresh restores it, Back steps back through what the panel showed, and a link to it works.
 * Only the tab strip (which pages were opened in this chat) and the expanded flag live in memory.
 */

export interface PanelTab {
  /** the page's identity: its path, so a profile and its prep tab are one tab */
  id: string;
  /** the last route shown in this tab */
  href: string;
}

interface PanelEntryState {
  /** how many panel entries sit above the chat entry in history (0 for the first one) */
  depth: number;
  /** the entry below the first panel entry is the chat itself, so closing can step back to it */
  fromChat: boolean;
  /** the student asked for this (a click), so the panel takes focus; an assistant-opened panel does not */
  focus?: boolean;
}

export interface PanelApi {
  /** the route the panel shows, when open */
  href: string | undefined;
  title: string;
  tabs: PanelTab[];
  expanded: boolean;
  /** steps the panel can go back */
  canGoBack: boolean;
  /** the student's click opened it, so the panel takes focus */
  focusOnOpen: boolean;
  open: (href: string, opts?: { focus?: boolean }) => void;
  close: () => void;
  closeTab: (id: string) => void;
  goBack: () => void;
  setExpanded: (v: boolean) => void;
  /** navigation from inside the panel: a page link or a page's own navigate() */
  navigateInside: (to: string, mode: 'push' | 'replace') => void;
  go: (delta: number) => void;
}

const PanelContext = createContext<PanelApi | undefined>(undefined);

/** The panel, or undefined where there is none (the pages outside the chat, tests of single cards). */
export function usePanel(): PanelApi | undefined {
  return useContext(PanelContext);
}

const MAX_TABS = 6;

const entryState = (location: { state: unknown }): PanelEntryState | undefined =>
  (location.state as { orbitPanel?: PanelEntryState } | null)?.orbitPanel;

export function PanelProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const href = panelFromSearch(location.search);
  const entry = entryState(location);
  const depth = href ? (entry?.depth ?? 0) : 0;
  const fromChat = entry?.fromChat ?? false;
  const [tabs, setTabs] = useState<PanelTab[]>([]);
  const [expanded, setExpanded] = useState(false);
  const title = usePanelTitle(href);

  useEffect(() => {
    if (!href) {
      setExpanded(false);
      return;
    }
    const id = panelKey(href);
    setTabs((prev) => {
      const at = prev.findIndex((t) => t.id === id);
      if (at >= 0) return prev.map((t, i) => (i === at ? { ...t, href } : t));
      return [...prev, { id, href }].slice(-MAX_TABS);
    });
  }, [href]);

  // the assistant can read what the panel shows ("make it shorter")
  useEffect(() => {
    setPanelHint(href ? { href, title } : undefined);
    return () => setPanelHint(undefined);
  }, [href, title]);

  const latest = useRef({ href, depth, fromChat, tabs, navigate });
  latest.current = { href, depth, fromChat, tabs, navigate };

  const open = useCallback((target: string, opts?: { focus?: boolean }) => {
    const { href: cur, depth: d, fromChat: fc, navigate: nav } = latest.current;
    if (!panelizable(target)) return;
    const focus = opts?.focus ?? false;
    if (!cur) nav(chatUrlWithPanel(target), { state: { orbitPanel: { depth: 0, fromChat: true, focus } } });
    else if (panelKey(cur) === panelKey(target))
      nav(chatUrlWithPanel(target), {
        replace: true,
        state: { orbitPanel: { depth: d, fromChat: fc, focus } },
      });
    else nav(chatUrlWithPanel(target), { state: { orbitPanel: { depth: d + 1, fromChat: fc, focus } } });
  }, []);

  const close = useCallback(() => {
    const { href: cur, depth: d, fromChat: fc, navigate: nav } = latest.current;
    if (!cur) return;
    // back to the chat entry the first panel page was opened from; a refreshed or shared link has none to go back to
    if (fc) nav(-(d + 1));
    else nav('/', { replace: true });
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const { href: cur, tabs: all } = latest.current;
      const rest = all.filter((t) => t.id !== id);
      setTabs(rest);
      if (cur && panelKey(cur) === id) {
        const next = rest[rest.length - 1];
        if (next) open(next.href);
        else close();
      }
    },
    [open, close],
  );

  const goBack = useCallback(() => {
    if (latest.current.depth > 0) latest.current.navigate(-1);
  }, []);

  const navigateInside = useCallback(
    (to: string, mode: 'push' | 'replace') => {
      const { href: cur, depth: d, fromChat: fc, navigate: nav } = latest.current;
      const path = to.startsWith('/') ? to : `/${to}`;
      if (path === '/' || path === '') return close();
      if (!panelizable(path)) return nav(path);
      const replace = mode === 'replace';
      nav(chatUrlWithPanel(path), {
        replace,
        state: { orbitPanel: { depth: replace ? d : d + 1, fromChat: cur ? fc : true } },
      });
    },
    [close],
  );

  const go = useCallback((delta: number) => latest.current.navigate(delta), []);

  // the assistant just made or found what the student asked for: show it (not on a phone, where it would cover the chat)
  useEffect(
    () =>
      subscribeAutoOpen((target) => {
        if (typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches)
          return;
        open(target);
      }),
    [open],
  );

  const api = useMemo<PanelApi>(
    () => ({
      href,
      title,
      tabs,
      expanded,
      canGoBack: depth > 0,
      focusOnOpen: !!entry?.focus,
      open,
      close,
      closeTab,
      goBack,
      setExpanded,
      navigateInside,
      go,
    }),
    [href, title, tabs, expanded, depth, entry?.focus, open, close, closeTab, goBack, navigateInside, go],
  );
  return <PanelContext.Provider value={api}>{children}</PanelContext.Provider>;
}
