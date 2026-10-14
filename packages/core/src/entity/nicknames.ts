import { stripDiacritics } from '../text/normalize';
import { NICKNAME_DATA } from './nicknames.data';

/**
 * Given-name variants from carltonnorthern/nicknames (Apache-2.0, vendored in nicknames.csv; see nicknames.NOTICE).
 * Each name maps to the names it is directly related to, in both directions (elizabeth → liz, liz → elizabeth).
 * Two nicknames of one name are not variants of each other: "Ron" is short for Aaron and for Ronald, so linking
 * siblings would join unrelated names. Built once, at module load.
 */
export const NICKNAME_VARIANTS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const s = map.get(a) ?? new Set<string>();
    s.add(b);
    map.set(a, s);
  };
  for (const row of NICKNAME_DATA) {
    const i = row.indexOf(':');
    const name = row.slice(0, i);
    for (const nick of row.slice(i + 1).split(' ')) {
      if (!nick) continue;
      link(name, nick);
      link(nick, name);
    }
  }
  return map;
})();

const key = (s: string) => stripDiacritics(s).toLowerCase().trim();

/** The names directly related to a given name (empty when the table does not know it). */
export function nameVariants(first: string): ReadonlySet<string> {
  return NICKNAME_VARIANTS.get(key(first)) ?? new Set();
}

/** True when two different given names are a name and its nickname (Elizabeth/Liz, William/Bill, Kit/Christopher). */
export function isFirstNameVariant(a: string, b: string): boolean {
  const x = key(a);
  const y = key(b);
  if (!x || !y || x === y) return false;
  return NICKNAME_VARIANTS.get(x)?.has(y) ?? false;
}
