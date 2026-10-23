import { ArrowLeft } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** True inside the chat's side panel, which has its own way back: no back link there. */
export const InPanel = createContext(false);

/** The last page the student was on that is not a person's page, with its query (the map's search and route). */
let lastPlace: string | undefined;

const isPersonPage = (path: string) => /^\/people\/[^/?]+/.test(path);

/** Kept by the app shell as the student moves around, so a person's page knows the way back. */
export function useTrackPlace(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!isPersonPage(pathname)) lastPlace = `${pathname}${search}`;
  }, [pathname, search]);
}

export function setLastPlaceForTests(place: string | undefined): void {
  lastPlace = place;
}

/** "Back to map", "Back to People"…: the page a path belongs to, said the way the nav says it. */
export function backLabel(path: string): string {
  const p = path.split('?')[0] ?? '';
  if (p.startsWith('/map')) return 'Back to map';
  if (p.startsWith('/people')) return 'Back to People';
  if (p.startsWith('/discover')) return 'Back to Discover';
  if (p.startsWith('/inbox')) return 'Back to Drafts';
  if (p.startsWith('/companies')) return 'Back to the company';
  if (p.startsWith('/settings')) return 'Back to Settings';
  if (p === '/' || p === '') return 'Back to chat';
  return 'Back';
}

/**
 * A back link at the top of a person's page, to the page it was opened from, as it was left (the map with its
 * search and route). Read once when the page opens, so switching tabs on it does not change where it goes.
 * Nothing on a page opened straight from a link.
 */
export function BackLink() {
  const nav = useNavigate();
  const inPanel = useContext(InPanel);
  const [from] = useState(() => lastPlace);
  if (!from || inPanel) return null;
  return (
    <button
      type="button"
      onClick={() => nav(from)}
      className="inline-flex items-center gap-1.5 -ml-1 mb-3 px-1 h-8 rounded-md text-[13px] text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      data-testid="back-link"
    >
      <ArrowLeft size={14} aria-hidden />
      {backLabel(from)}
    </button>
  );
}
