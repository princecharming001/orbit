import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/schema';
import { pathOf, staticTitle } from './routes';

/** The panel's title in words: a person's name, a company's name, "Message to Daniel", else the page's name. */
export function usePanelTitle(href: string | undefined): string {
  const path = href ? pathOf(href) : '';
  const search = href?.includes('?') ? href.slice(href.indexOf('?')) : '';
  const personId = path.startsWith('/people/') ? path.slice('/people/'.length) : undefined;
  const orgId = path.startsWith('/companies/') ? path.slice('/companies/'.length) : undefined;
  const draftId = path === '/inbox' || path === '/drafts' ? new URLSearchParams(search).get('draft') : null;
  const resolved = useLiveQuery(async () => {
    if (personId) return (await db.people.get(personId))?.displayName;
    if (orgId) return (await db.organizations.get(orgId))?.name;
    if (draftId) {
      const m = await db.outbound.get(draftId);
      const p = m?.personId ? await db.people.get(m.personId) : undefined;
      return p ? `Message to ${p.displayName.split(' ')[0]}` : 'Message';
    }
    return undefined;
  }, [personId, orgId, draftId]);
  if (!href) return '';
  return resolved ?? staticTitle(href);
}
