/**
 * Places for network search (plan 32 §5.3, §18.16): a location string ("Fremont, California, United States",
 * "San Francisco Bay Area", "Bengaluru, Karnataka, India") read into a metro, a region and a country; a place the
 * student names ("SF", "the bay", "NYC", "India", "California") read into the same three.
 *
 * Data (`places.data.ts`, generated from GeoNames, CC BY 4.0) is passed in so the large table loads only when search
 * first runs. A place is residence only: "founders from India" means living in India, and the card says so.
 */

export interface PlacesData {
  /** [id, label, folded aliases, country code] */
  metros: [string, string, string[], string][];
  /** "name|region|country|metro", most populous first */
  cities: string[];
  countries: Record<string, string>;
  regions: Record<string, string[]>;
  usAbbr: Record<string, string>;
}

export interface PlaceRead {
  metro?: string;
  region?: string;
  country?: string;
  /** "remote" written in the location */
  remote?: boolean;
}

export interface PlaceTarget {
  /** what the student wrote */
  name: string;
  metro?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  label: string;
}

export interface PlaceIndex {
  read(location: string | undefined): PlaceRead | undefined;
  target(name: string): PlaceTarget | undefined;
  metroLabel(id: string): string | undefined;
  matches(read: PlaceRead | undefined, target: PlaceTarget): 'yes' | 'no' | 'unknown';
}

export function foldPlace(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  us: 'US',
  'u s': 'US',
  'united states of america': 'US',
  america: 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  uae: 'AE',
  emirates: 'AE',
  'south korea': 'KR',
  korea: 'KR',
  'republic of korea': 'KR',
  russia: 'RU',
  vietnam: 'VN',
  'viet nam': 'VN',
  holland: 'NL',
  'the netherlands': 'NL',
  czechia: 'CZ',
  'czech republic': 'CZ',
  turkiye: 'TR',
  iran: 'IR',
  taiwan: 'TW',
  'hong kong sar': 'HK',
  'mainland china': 'CN',
  prc: 'CN',
};
const REGION_GROUPS: Record<string, string[]> = {
  europe:
    'GB IE FR DE NL BE LU CH AT IT ES PT SE NO DK FI IS PL CZ SK HU RO BG GR HR SI RS EE LV LT UA'.split(' '),
  'latin america': 'MX GT HN SV NI CR PA CO VE EC PE BO CL AR UY PY BR DO CU PR'.split(' '),
  'southeast asia': 'SG MY ID TH VN PH KH LA MM BN'.split(' '),
  'middle east': 'AE SA QA KW BH OM IL JO LB TR EG IR IQ'.split(' '),
  africa: 'NG KE GH ZA EG MA ET TZ UG RW SN CI CM DZ TN'.split(' '),
  'east asia': 'CN JP KR TW HK MO MN'.split(' '),
  'south asia': 'IN PK BD LK NP BT MV'.split(' '),
};

export function buildPlaceIndex(data: PlacesData): PlaceIndex {
  const metroByAlias = new Map<string, string>();
  const metroLabel = new Map<string, string>();
  const metroCountry = new Map<string, string>();
  for (const [id, label, aliases, cc] of data.metros) {
    metroLabel.set(id, label);
    metroCountry.set(id, cc);
    metroByAlias.set(foldPlace(label), id);
    for (const a of aliases) if (!metroByAlias.has(a)) metroByAlias.set(a, id);
  }
  const countryByName = new Map<string, string>();
  for (const [cc, name] of Object.entries(data.countries)) countryByName.set(name, cc);
  for (const [a, cc] of Object.entries(COUNTRY_ALIASES)) countryByName.set(a, cc);
  const regionCountry = new Map<string, string>();
  for (const [cc, names] of Object.entries(data.regions))
    for (const n of names) if (!regionCountry.has(n)) regionCountry.set(n, cc);
  const usAbbr = new Map(Object.entries(data.usAbbr).map(([k, v]) => [k.toLowerCase(), v]));
  /** city name to its rows, most populous first */
  const cities = new Map<string, { region: string; cc: string; metro: string }[]>();
  for (const row of data.cities) {
    const [name, region, cc, metro] = row.split('|') as [string, string, string, string];
    let list = cities.get(name);
    if (!list) cities.set(name, (list = []));
    list.push({ region, cc, metro });
  }

  const countryOf = (t: string): string | undefined => countryByName.get(t);

  function read(location: string | undefined): PlaceRead | undefined {
    if (!location?.trim()) return undefined;
    const raw = location.trim();
    const t = foldPlace(raw);
    if (!t) return undefined;
    const remote = /\bremote\b/.test(t) || undefined;
    // "San Francisco Bay Area", "Greater Boston", "New York City Metropolitan Area"
    const metroWhole =
      metroByAlias.get(t) ??
      metroByAlias.get(t.replace(/^greater /, '').replace(/ (metropolitan|metro) area$| area$| region$/, ''));
    if (metroWhole) return { metro: metroWhole, country: metroCountry.get(metroWhole), remote };
    const parts = raw
      .split(',')
      .map((p) => foldPlace(p))
      .filter(Boolean);
    let country: string | undefined;
    let region: string | undefined;
    if (parts.length > 1) {
      const last = parts[parts.length - 1]!;
      country = countryOf(last);
      if (country) parts.pop();
    } else if (parts.length === 1) {
      const only = parts[0]!;
      country = countryOf(only);
      if (country) return { country, remote };
      const asRegion = regionCountry.get(only) ?? (usAbbr.has(only) ? 'US' : undefined);
      if (asRegion) return { region: usAbbr.get(only) ?? only, country: asRegion, remote };
    }
    if (parts.length > 1) {
      const r = parts[parts.length - 1]!;
      const full = usAbbr.get(r) ?? r;
      if (regionCountry.has(full)) {
        region = full;
        country ??= regionCountry.get(full);
        parts.pop();
      }
    }
    const city = parts[0];
    if (city) {
      const m = metroByAlias.get(city);
      const rows = cities.get(city) ?? [];
      const hit =
        rows.find((r) => (!country || r.cc === country) && (!region || r.region === region)) ??
        rows.find((r) => !country || r.cc === country);
      if (hit)
        return {
          metro: hit.metro || undefined,
          region: region ?? hit.region,
          country: country ?? hit.cc,
          remote,
        };
      if (m && (!country || metroCountry.get(m) === country))
        return { metro: m, region, country: country ?? metroCountry.get(m), remote };
    }
    if (country || region) return { region, country, remote };
    return remote ? { remote } : undefined;
  }

  function target(name: string): PlaceTarget | undefined {
    const whole = foldPlace(name);
    const t = whole.replace(/^(the|greater) /, '');
    if (!t) return undefined;
    if (t === 'remote' || t === 'anywhere remote') return { name, remote: true, label: 'Remote' };
    const metro = metroByAlias.get(whole) ?? metroByAlias.get(t);
    if (metro) return { name, metro, country: metroCountry.get(metro), label: metroLabel.get(metro)! };
    const cc = countryOf(t);
    if (cc) return { name, country: cc, label: data.countries[cc] ? titleCase(data.countries[cc]!) : name };
    const region = usAbbr.get(t) ?? (regionCountry.has(t) ? t : undefined);
    if (region) return { name, region, country: regionCountry.get(region) ?? 'US', label: titleCase(region) };
    const rows = cities.get(t);
    if (rows?.[0]) {
      const r = rows[0];
      return r.metro
        ? { name, metro: r.metro, country: r.cc, label: metroLabel.get(r.metro)! }
        : { name, region: r.region, country: r.cc, label: titleCase(t) };
    }
    return undefined;
  }

  function matches(r: PlaceRead | undefined, tg: PlaceTarget): 'yes' | 'no' | 'unknown' {
    if (!r) return 'unknown';
    if (tg.remote) return r.remote ? 'yes' : 'unknown';
    if (tg.metro) {
      if (r.metro) return r.metro === tg.metro ? 'yes' : 'no';
      if (r.country && tg.country && r.country !== tg.country) return 'no';
      return 'unknown';
    }
    if (tg.region) {
      if (r.region) return r.region === tg.region ? 'yes' : 'no';
      if (r.metro) {
        const cc = metroCountry.get(r.metro);
        if (cc !== tg.country) return 'no';
      }
      if (r.country && tg.country && r.country !== tg.country) return 'no';
      return 'unknown';
    }
    if (tg.country) {
      const cc = r.country ?? (r.metro ? metroCountry.get(r.metro) : undefined);
      return cc ? (cc === tg.country ? 'yes' : 'no') : 'unknown';
    }
    return 'unknown';
  }

  return { read, target, matches, metroLabel: (id) => metroLabel.get(id) };
}

/** A region of the world ("Europe", "Southeast Asia") as country codes. */
export function regionCountries(name: string): string[] | undefined {
  return REGION_GROUPS[foldPlace(name)];
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
