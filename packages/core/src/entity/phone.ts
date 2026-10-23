/**
 * Phone numbers as identities. A number is one person's (more than an address is: nobody shares a mobile with a
 * colleague), so two records with the same number are the same person (entity/resolve.ts). Numbers are compared in
 * one form, E.164 (+15551234567), read with libphonenumber-js (MIT; Google's libphonenumber metadata, Apache-2.0)
 * in the country the student's own numbers are written for: "(555) 123-4567" in Chicago is +1 555 123 4567 and
 * "020 7946 0958" in London is +44 20 7946 0958.
 *
 * Not imported by entity/resolve.ts on purpose: resolution compares numbers already in this form, so the server's
 * bundles do not carry the phone metadata.
 */
import {
  type CountryCode,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';
import { ZONE_COUNTRIES } from './zones.data';

/** Where numbers without a country code are read when nothing says otherwise. */
export const DEFAULT_PHONE_REGION: CountryCode = 'US';

let zoneCountry: Map<string, string> | undefined;

/** The country (ISO 3166 code) a tz time zone is in ("America/Chicago" → "US"), from the tz database. */
export function countryForTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  if (!zoneCountry) {
    zoneCountry = new Map();
    for (const row of ZONE_COUNTRIES) {
      const [cc, zones] = row.split(':');
      for (const z of zones?.split(' ') ?? []) if (cc) zoneCountry.set(z, cc);
    }
  }
  return zoneCountry.get(tz.trim());
}

/** Country names and big cities a student is likely to type as their city, for when the time zone says nothing. */
const PLACES: [RegExp, string][] = [
  [/\b(usa|united states|america)\b/, 'US'],
  [/\b(canada|toronto|vancouver|montreal|ottawa|waterloo)\b/, 'CA'],
  [/\b(uk|united kingdom|england|scotland|wales|london|oxford|cambridge, uk|edinburgh|manchester)\b/, 'GB'],
  [/\b(ireland|dublin)\b/, 'IE'],
  [/\b(india|mumbai|delhi|bangalore|bengaluru|hyderabad|chennai|pune|kolkata)\b/, 'IN'],
  [/\b(pakistan|karachi|lahore)\b/, 'PK'],
  [/\b(bangladesh|dhaka)\b/, 'BD'],
  [/\b(china|beijing|shanghai|shenzhen|guangzhou|hangzhou)\b/, 'CN'],
  [/\b(hong kong)\b/, 'HK'],
  [/\b(taiwan|taipei)\b/, 'TW'],
  [/\b(japan|tokyo|osaka|kyoto)\b/, 'JP'],
  [/\b(korea|seoul|busan)\b/, 'KR'],
  [/\b(singapore)\b/, 'SG'],
  [/\b(vietnam|hanoi|ho chi minh)\b/, 'VN'],
  [/\b(philippines|manila)\b/, 'PH'],
  [/\b(indonesia|jakarta)\b/, 'ID'],
  [/\b(malaysia|kuala lumpur)\b/, 'MY'],
  [/\b(australia|sydney|melbourne|brisbane|perth)\b/, 'AU'],
  [/\b(new zealand|auckland)\b/, 'NZ'],
  [/\b(germany|berlin|munich|hamburg|frankfurt)\b/, 'DE'],
  [/\b(france|paris|lyon)\b/, 'FR'],
  [/\b(spain|madrid|barcelona)\b/, 'ES'],
  [/\b(italy|rome|milan)\b/, 'IT'],
  [/\b(netherlands|amsterdam)\b/, 'NL'],
  [/\b(switzerland|zurich|geneva)\b/, 'CH'],
  [/\b(sweden|stockholm)\b/, 'SE'],
  [/\b(israel|tel aviv|jerusalem)\b/, 'IL'],
  [/\b(uae|dubai|abu dhabi)\b/, 'AE'],
  [/\b(brazil|sao paulo|rio de janeiro)\b/, 'BR'],
  [/\b(mexico)\b/, 'MX'],
  [/\b(nigeria|lagos)\b/, 'NG'],
  [/\b(kenya|nairobi)\b/, 'KE'],
];
/** "Austin, TX": a US state after the comma. */
const US_STATE =
  /,\s*(al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i;

/** The country a typed city is in, when it says ("Austin, TX", "London", "Mumbai, India"). */
export function countryForCity(city: string | undefined): string | undefined {
  if (!city?.trim()) return undefined;
  if (US_STATE.test(city)) return 'US';
  const c = city.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return PLACES.find(([re]) => re.test(c))?.[1];
}

const supported = (cc: string | undefined): cc is CountryCode => !!cc && isSupportedCountry(cc);

/**
 * The country the student's numbers are written for: their time zone's country, else their city's, else the US.
 * `numbers` (E.164 numbers they text, from Messages) wins when most of them are in another country: a student
 * visiting home for the summer still has a phone full of numbers from where they live.
 */
export function phoneRegionFor(
  user: { timezone?: string; currentCity?: string; homeCity?: string } | undefined,
  numbers: readonly string[] = [],
): CountryCode {
  const tz = countryForTimeZone(user?.timezone);
  const guess = supported(tz)
    ? tz
    : supported(countryForCity(user?.currentCity))
      ? (countryForCity(user?.currentCity) as CountryCode)
      : DEFAULT_PHONE_REGION;
  const intl = numbers.filter((n) => n.startsWith('+'));
  if (intl.length < 5) return guess;
  const byCode = new Map<string, { n: number; countries: Map<string, number> }>();
  for (const n of intl) {
    const p = parsePhoneNumberFromString(n);
    if (!p) continue;
    const e = byCode.get(p.countryCallingCode) ?? { n: 0, countries: new Map() };
    e.n++;
    if (p.country) e.countries.set(p.country, (e.countries.get(p.country) ?? 0) + 1);
    byCode.set(p.countryCallingCode, e);
  }
  const [code, top] = [...byCode.entries()].sort((a, b) => b[1].n - a[1].n)[0] ?? [];
  if (!code || !top || top.n < intl.length * 0.6 || code === getCountryCallingCode(guess)) return guess;
  // +1 is shared by the US, Canada and the Caribbean: the most common country among the numbers, else the US
  const country = [...top.countries.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return supported(country) ? country : code === '1' ? 'US' : guess;
}

/**
 * A phone number in E.164 (+15551234567), read in `region` when it has no country code. Short codes (verification
 * texts, under 7 digits) are not people and come back undefined. A leading 00 is an international prefix. A number
 * libphonenumber cannot place keeps its digits (+ and the digits as written), so the same number written the same
 * way still compares equal.
 */
export function toE164(raw: string | undefined, region: string = DEFAULT_PHONE_REGION): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(/^tel:/i, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 + 2) return undefined;
  if (!s.startsWith('+') && digits.startsWith('00')) s = `+${digits.slice(2)}`;
  const p = parsePhoneNumberFromString(s, supported(region) ? region : DEFAULT_PHONE_REGION);
  if (p?.isPossible()) return p.number;
  const d = s.replace(/\D/g, '');
  return d.length >= 7 ? `+${d}` : undefined;
}

/** True when two numbers are the same once both are in E.164 (either may be written any way). */
export function samePhone(a: string | undefined, b: string | undefined, region?: string): boolean {
  const x = toE164(a, region);
  return !!x && x === toE164(b, region);
}
