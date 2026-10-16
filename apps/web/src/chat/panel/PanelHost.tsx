import { ArrowLeft, ArrowUpRight, Maximize2, Minimize2, X } from 'lucide-react';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cx } from '../../ui';
import { usePanel } from './PanelProvider';
import { PanelRouter, PanelRoutes } from './PanelRouter';
import { panelKey, pathOf } from './routes';
import { usePanelTitle } from './usePanelTitle';

const WIDTH_KEY = 'orbit.panel.width';
const MIN_WIDTH = 420;

function readWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= MIN_WIDTH) return n;
  } catch {
    // storage can be blocked; the default width is fine
  }
  return Math.round(Math.min(680, Math.max(480, window.innerWidth * 0.42)));
}

function useIsDesktop(): boolean {
  const query = '(min-width: 768px)';
  const [match, setMatch] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return match;
}

function IconButton({
  label,
  onClick,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="h-8 w-8 shrink-0 rounded-lg inline-flex items-center justify-center text-ink-2 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {children}
    </button>
  );
}

/** The tab strip: the pages opened in this chat, the active one marked. Shown when there is more than one. */
function TabStrip() {
  const panel = usePanel()!;
  const activeId = panel.href ? panelKey(panel.href) : '';
  return (
    <div
      role="tablist"
      aria-label="Open in the panel"
      className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto scroll-thin border-b border-white/50 shrink-0"
      data-testid="panel-tabs"
    >
      {panel.tabs.map((t) => (
        <PanelTabButton key={t.id} id={t.id} href={t.href} active={t.id === activeId} />
      ))}
    </div>
  );
}

function PanelTabButton({ id, href, active }: { id: string; href: string; active: boolean }) {
  const panel = usePanel()!;
  const title = usePanelTitle(href);
  return (
    <div
      className={cx(
        'group inline-flex items-center h-8 rounded-lg text-[13px] max-w-[170px] shrink-0',
        active ? 'bg-[#f0efed] text-ink font-medium' : 'text-ink-2 hover:bg-canvas-2',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => !active && panel.open(href)}
        className="h-8 pl-2.5 pr-1 truncate rounded-l-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        data-testid={`panel-tab-${id}`}
      >
        {title}
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={() => panel.closeTab(id)}
        className="h-8 w-6 inline-flex items-center justify-center rounded-r-lg opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

/** Escape closes the panel, unless something else owns the key (a field, a dialog, the map canvas). */
function useEscapeToClose(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]:not([data-panel-sheet])')) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.matches('input, textarea, select, canvas, [contenteditable="true"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, close]);
}

/**
 * The side panel: the app's own pages shown next to the conversation (a bottom sheet on a phone), so a student can
 * read, edit and decide without leaving the chat. The chrome (back, title, open as page, expand, close, tabs) is
 * here; the body is the page itself, running in the panel's own navigation scope.
 */
export function PanelHost() {
  const panel = usePanel();
  const nav = useNavigate();
  const desktop = useIsDesktop();
  const rootRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(readWidth);
  const href = panel?.href;
  useEscapeToClose(!!href, panel?.close ?? (() => {}));
  // a click opened it: move focus into the panel so a keyboard student is not left behind in the thread
  useEffect(() => {
    if (href && panel?.focusOnOpen) rootRef.current?.focus();
  }, [href, panel?.focusOnOpen]);
  if (!panel || !href) return null;

  const path = pathOf(href);
  const isMap = path === '/map';
  const fills = isMap && panel.expanded;
  const openAsPage = () => nav(href);
  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const maxW = Math.max(MIN_WIDTH, window.innerWidth - 64 - 420);
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(maxW, Math.max(MIN_WIDTH, startW + (startX - ev.clientX))));
      setWidth(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        window.localStorage.setItem(WIDTH_KEY, String(latest));
      } catch {
        // not remembering the width is fine
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const keyResize = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = Math.min(
      Math.max(MIN_WIDTH, window.innerWidth - 64 - 420),
      Math.max(MIN_WIDTH, width + (e.key === 'ArrowLeft' ? 32 : -32)),
    );
    setWidth(next);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // not remembering the width is fine
    }
  };

  const header = (
    <header className="flex items-center gap-0.5 h-12 px-2 border-b border-white/50 shrink-0">
      {panel.canGoBack && (
        <IconButton label="Back" onClick={panel.goBack} testId="panel-back">
          <ArrowLeft size={17} aria-hidden />
        </IconButton>
      )}
      <PanelTitle href={href} />
      <IconButton label="Open as a page" onClick={openAsPage} testId="panel-open-page">
        <ArrowUpRight size={17} aria-hidden />
      </IconButton>
      {desktop && (
        <IconButton
          label={panel.expanded ? 'Shrink the panel' : 'Expand the panel'}
          onClick={() => panel.setExpanded(!panel.expanded)}
          testId="panel-expand"
        >
          {panel.expanded ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
        </IconButton>
      )}
      <IconButton label="Close the panel" onClick={panel.close} testId="panel-close">
        <X size={18} aria-hidden />
      </IconButton>
    </header>
  );
  const body = (
    <div
      className="flex-1 min-h-0 overflow-y-auto scroll-thin"
      data-testid="panel-body"
      data-panel-path={path}
    >
      <div
        className={cx(
          '@container',
          // the map keeps the app shell's own padding (it cancels it with negative margins); it fills the panel's
          // height once the panel is expanded, and scrolls with the rest below that
          isMap ? 'px-4 md:px-8 py-6 md:pb-8' : 'px-4 pt-4 pb-10',
          fills && 'h-full flex flex-col',
        )}
      >
        <PanelRouter key={panelKey(href)} href={href} onNavigate={panel.navigateInside} onGo={panel.go}>
          <PanelRoutes />
        </PanelRouter>
      </div>
    </div>
  );

  if (!desktop)
    return (
      <div className="fixed inset-0 z-50" data-testid="panel-sheet">
        <div className="absolute inset-0 bg-ink/25" onClick={panel.close} aria-hidden />
        <section
          ref={rootRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={`${panel.title || 'Panel'}`}
          data-panel-sheet
          data-testid="panel"
          className="sheet-in glass glass-strong absolute inset-x-0 bottom-0 top-[7vh] !rounded-b-none !rounded-t-[24px] flex flex-col overflow-hidden focus:outline-none"
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-ink/15 shrink-0" aria-hidden />
          {header}
          {panel.tabs.length > 1 && <TabStrip />}
          {body}
        </section>
      </div>
    );

  return (
    <aside
      ref={rootRef}
      tabIndex={-1}
      aria-label={`Side panel: ${panel.title}`}
      data-testid="panel"
      data-expanded={panel.expanded}
      className={cx(
        'panel-in glass glass-strong flex flex-col overflow-hidden focus:outline-none',
        panel.expanded ? 'absolute inset-2 z-30' : 'shrink-0 my-2 mr-2',
      )}
      style={panel.expanded ? undefined : { width }}
    >
      {!panel.expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={keyResize}
          className="absolute left-0 top-0 bottom-0 w-2.5 z-10 cursor-col-resize hover:bg-accent/10 focus-visible:outline-none focus-visible:bg-accent/20"
          data-testid="panel-resize"
        />
      )}
      {header}
      {panel.tabs.length > 1 && <TabStrip />}
      {body}
    </aside>
  );
}

function PanelTitle({ href }: { href: string }) {
  const title = usePanelTitle(href);
  return (
    <h2 className="font-semibold text-[14.5px] truncate px-1.5 min-w-0 flex-1" data-testid="panel-title">
      {title}
    </h2>
  );
}
