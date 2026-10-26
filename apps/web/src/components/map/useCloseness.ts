import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/schema';

/**
 * A key that changes when any of these people's closeness changes (plan 27: a warm reply landing rescores someone):
 * routes and mutual lists on screen re-rank on it. Undefined until read.
 */
export function useClosenessKey(ids: readonly string[]): string | undefined {
  const key = [...new Set(ids)].sort().join(',');
  return useLiveQuery(async () => {
    if (!key) return '';
    const people = await db.people.bulkGet(key.split(','));
    return `${key}#${people.map((p) => (p ? Math.round(p.strength * 100) : '')).join(',')}`;
  }, [key]);
}
