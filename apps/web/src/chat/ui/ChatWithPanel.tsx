import type { MouseEvent } from 'react';
import { PanelHost } from '../panel/PanelHost';
import { PanelProvider, usePanel } from '../panel/PanelProvider';
import { internalHrefOf } from '../panel/routes';
import { ChatHome } from './ChatHome';

/**
 * The chat and its side panel. Any link to one of the app's pages inside the conversation (a card's "Open profile",
 * a person's name, a draft's "Open in Drafts") opens that page in the panel instead of leaving the chat. Holding
 * a modifier key or middle-clicking still opens the real page.
 */
function ChatColumn() {
  const panel = usePanel();
  const onClickCapture = (e: MouseEvent) => {
    if (!panel || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target === '_blank' || a.hasAttribute('download') || 'noPanel' in a.dataset) return;
    const href = internalHrefOf(a);
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    panel.open(href, { focus: true });
  };
  return (
    <div className="flex-1 min-w-0 h-full" onClickCapture={onClickCapture}>
      <ChatHome />
    </div>
  );
}

export function ChatWithPanel() {
  return (
    <PanelProvider>
      <div className="relative h-full flex" data-testid="chat-with-panel">
        <ChatColumn />
        <PanelHost />
      </div>
    </PanelProvider>
  );
}
