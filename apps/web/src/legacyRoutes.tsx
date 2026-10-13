/**
 * Addresses from before the chat became home: Today and the Pipeline were pages of their own. Bookmarks, saved chat
 * threads and old links still point at them, so the router and the chat's side panel send them where that content
 * lives now.
 */
import { Navigate, useLocation } from 'react-router-dom';

/**
 * Where an address from before Today and Pipeline were folded in goes now, or undefined when it is not one of
 * them. Today's cards live in Drafts (a link to one card or person opens it there) and its brief in the chat; the
 * Pipeline is the People page, its table the list of people with a chat.
 */
export function legacyHref(href: string): string | undefined {
  const [path = '', query = ''] = href.split('#')[0]!.split('?');
  const params = new URLSearchParams(query);
  if (path === '/today') {
    const card = params.get('card');
    const person = params.get('person');
    if (card) return `/inbox?card=${encodeURIComponent(card)}`;
    if (person) return `/inbox?person=${encodeURIComponent(person)}`;
    return '/';
  }
  if (path === '/pipeline') {
    const v = params.get('view');
    const out = new URLSearchParams();
    if (v === 'table') {
      out.set('view', 'list');
      out.set('f', 'chats');
    } else out.set('view', v === 'companies' ? 'companies' : 'board');
    // "who went quiet" stays the filter it was, whichever view it opens
    if (params.get('quiet') === '1' || params.get('filter') === 'quiet') {
      if (out.get('f')) out.set('f', 'quiet');
      else out.set('quiet', '1');
    }
    return `/people?${out}`;
  }
  return undefined;
}

/** The route element for an old address: it sends the page on, replacing the old entry in the history. */
export function LegacyRedirect() {
  const loc = useLocation();
  return <Navigate to={legacyHref(loc.pathname + loc.search) ?? '/'} replace />;
}
