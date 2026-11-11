/**
 * A phone number with its country inside the field (plan 40), the way Quo and Revolut Business ask for one: the
 * flag and dial code on the left as one button that opens a searchable list of countries, the number on the right,
 * formatted as it is typed. Pasting a number that starts with its own code ("+44 20 7946 0958") switches the
 * country. The number comes out in E.164 ("+442079460958") once it is a whole, valid one.
 *
 * Numbers are read with libphonenumber-js (MIT; Google's libphonenumber metadata), the same library @orbit/core
 * reads contacts' numbers with, from its small "min" metadata.
 */
import {
  AsYouType,
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/min';
import { ChevronDown, Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../ui';

export interface PhoneValue {
  /** "+14155550123" once the number is whole and valid, else null */
  e164: string | null;
  /** the country the number is read for ("US") */
  country: string;
  valid: boolean;
  /** nothing typed: a saved number was cleared */
  empty: boolean;
}

/** For a calling code several countries share, the country people mean by it. */
const MAIN_FOR_CODE: Record<string, string> = {
  '1': 'US',
  '7': 'RU',
  '44': 'GB',
  '47': 'NO',
  '61': 'AU',
  '212': 'MA',
  '262': 'RE',
  '290': 'SH',
  '358': 'FI',
  '590': 'GP',
  '599': 'CW',
};

/** The countries pinned above the rest, after the student's own. */
const PINNED: CountryCode[] = ['US', 'CA', 'GB', 'IN'];

/** 🇺🇸 from "US": two regional indicator letters. */
export function flagOf(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) return '';
  return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let names: Intl.DisplayNames | undefined;
/** "United States" from "US". */
export function countryName(country: string): string {
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of(country) ?? country;
  } catch {
    return country;
  }
}

interface Country {
  code: CountryCode;
  name: string;
  dial: string;
}

let all: Country[] | undefined;
function countries(): Country[] {
  all ??= getCountries()
    .map((code) => ({ code, name: countryName(code), dial: `+${getCountryCallingCode(code)}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

const supported = (c: string | undefined): c is CountryCode =>
  !!c && (getCountries() as string[]).includes(c);

/** Countries matching what was typed in the list's search: a name ("uni"), a code ("gb") or a dial code ("+44"). */
export function searchCountries(query: string, first?: string): Country[] {
  const q = query.trim().toLowerCase();
  const list = countries();
  if (!q) {
    const top = [...new Set([...(supported(first) ? [first] : []), ...PINNED])];
    const pinned = top.map((c) => list.find((x) => x.code === c)!).filter(Boolean);
    return [...pinned, ...list.filter((c) => !top.includes(c.code))];
  }
  const digits = q.replace(/^\+/, '');
  if (/^\d+$/.test(digits)) {
    // a code several countries share opens on the one it is known for (+44 the UK, not Guernsey)
    const rank = (c: Country) =>
      (c.dial.slice(1) === digits ? 0 : 2) + (MAIN_FOR_CODE[c.dial.slice(1)] === c.code ? 0 : 1);
    return list.filter((c) => c.dial.slice(1).startsWith(digits)).sort((a, b) => rank(a) - rank(b));
  }
  const starts = list.filter(
    (c) =>
      c.name.toLowerCase().startsWith(q) ||
      c.name
        .toLowerCase()
        .split(/[\s(-]+/)
        .some((w) => w.startsWith(q)),
  );
  const rest = list.filter(
    (c) => !starts.includes(c) && (c.code.toLowerCase() === q || c.name.toLowerCase().includes(q)),
  );
  return [...starts, ...rest];
}

/** The number as it reads in its own country ("(415) 555-0123"), formatted as far as it is typed. */
function formatNational(digits: string, country: CountryCode): string {
  if (!digits) return '';
  // a whole number reads the way it is dialled there ("020 7946 0958", with the trunk 0); a part of one as typed
  const whole = parsePhoneNumberFromString(digits, country);
  if (whole?.isValid()) return whole.formatNational();
  return new AsYouType(country).input(digits);
}

/** What the field holds, read in a country. */
export function readPhone(text: string, country: CountryCode): PhoneValue {
  const p = parsePhoneNumberFromString(text, country);
  const valid = !!p && p.isValid();
  return {
    e164: valid ? p!.number : null,
    country: valid && p!.country ? p!.country : country,
    valid,
    empty: !text.replace(/\D/g, ''),
  };
}

export function PhoneField({
  value,
  defaultCountry = 'US',
  onChange,
  onBlur,
  variant = 'box',
  id,
  label = 'Phone number',
  autoFocus,
  disabled,
}: {
  /** a saved number to start from (E.164) and the country it was entered for */
  value?: { e164?: string | null; country?: string | null };
  /** where a number without a code is read: the student's country (from their time zone), else the US */
  defaultCountry?: string;
  onChange?: (v: PhoneValue) => void;
  onBlur?: (v: PhoneValue) => void;
  /** box: a bordered field like setup's; line: a hairline under it, like Settings */
  variant?: 'box' | 'line';
  id?: string;
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const start = useMemo(() => {
    const saved = value?.e164 ? parsePhoneNumberFromString(value.e164) : undefined;
    const country: CountryCode = supported(saved?.country)
      ? saved!.country!
      : supported(value?.country ?? undefined)
        ? (value!.country as CountryCode)
        : supported(defaultCountry)
          ? defaultCountry
          : 'US';
    return { country, text: saved ? formatNational(saved.nationalNumber, country) : '' };
    // a saved number read once, when the field opens or the saved number changes
  }, [value?.e164, value?.country, defaultCountry]);
  const [country, setCountry] = useState<CountryCode>(start.country);
  const [text, setText] = useState(start.text);
  const [touched, setTouched] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  useEffect(() => {
    setCountry(start.country);
    setText(start.text);
  }, [start]);

  const auto = useId();
  const inputId = id ?? `phone-${auto}`;
  const listId = `${inputId}-countries`;
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useMemo(() => searchCountries(query, start.country), [query, start.country]);
  const pinnedCount = query.trim() ? 0 : new Set([start.country, ...PINNED]).size;

  const current = readPhone(text, country);
  const emit = (t: string, c: CountryCode) => onChange?.(readPhone(t, c));

  // a click anywhere else closes the list
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    if (open) {
      setActive(0);
      search.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId]);

  const pick = (c: CountryCode) => {
    setCountry(c);
    setOpen(false);
    setQuery('');
    // the digits stay; they are read again in the new country
    const digits = text.replace(/\D/g, '');
    const next = formatNational(digits, c);
    setText(next);
    emit(next, c);
    input.current?.focus();
  };

  const type = (raw: string) => {
    // a number with its own code ("+44 20 ...") says which country it is in
    if (raw.trim().startsWith('+')) {
      const p = parsePhoneNumberFromString(raw);
      const asType = new AsYouType();
      asType.input(raw);
      const found = p?.country ?? asType.getCountry();
      if (found && supported(found)) {
        const national = p?.nationalNumber ?? asType.getNumber()?.nationalNumber ?? '';
        const next = formatNational(national, found);
        setCountry(found);
        setText(next);
        emit(next, found);
        return;
      }
    }
    let digits = raw.replace(/\D/g, '');
    // deleting a bracket or a dash deletes the digit before it, so backspace never sticks on formatting
    if (raw.length < text.length && digits === text.replace(/\D/g, '')) digits = digits.slice(0, -1);
    const next = formatNational(digits, country);
    setText(next);
    emit(next, country);
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(list.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = list[active];
      if (c) pick(c.code);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  };

  const showHint = touched && !!text.replace(/\D/g, '') && !current.valid;
  const line = variant === 'line';
  return (
    <div ref={wrap} className="relative" data-testid="phone-field">
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <div
        className={cx(
          'flex items-stretch transition-[border-color,box-shadow]',
          line
            ? 'h-10 border-b border-line focus-within:border-ink'
            : 'h-11 rounded-[10px] border border-line bg-white hover:border-[#d4d2ce] focus-within:border-[#a8a5a0] focus-within:ring-4 focus-within:ring-ink/[0.05]',
          disabled && 'opacity-60',
        )}
      >
        <button
          ref={button}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={cx(
            'flex shrink-0 items-center gap-1.5 text-[15px] text-ink focus-visible:outline-none focus-visible:bg-black/[0.03]',
            line ? 'pr-2.5' : 'rounded-l-[10px] pl-3 pr-2.5 hover:bg-black/[0.02]',
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={`Country: ${countryName(country)}, +${getCountryCallingCode(country)}`}
          data-testid="phone-country"
          data-country={country}
        >
          <span className="text-[17px] leading-none" aria-hidden>
            {flagOf(country)}
          </span>
          <span className="tabular-nums text-ink-2">+{getCountryCallingCode(country)}</span>
          <ChevronDown size={14} className="text-ink-3" aria-hidden />
        </button>
        <span className={cx('my-2.5 w-px bg-line', line && 'my-2')} aria-hidden />
        <input
          ref={input}
          id={inputId}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          // biome-ignore lint/a11y/noAutofocus: the step is about this one field
          autoFocus={autoFocus}
          disabled={disabled}
          value={text}
          placeholder={formatNational(examplePlaceholder(country), country) || 'Phone number'}
          onChange={(e) => type(e.target.value)}
          onBlur={() => {
            setTouched(true);
            onBlur?.(readPhone(text, country));
          }}
          aria-invalid={showHint || undefined}
          aria-describedby={showHint ? `${inputId}-hint` : undefined}
          className={cx(
            'min-w-0 flex-1 bg-transparent text-[15px] tabular-nums text-ink placeholder:text-[#a59f97] focus:outline-none',
            line ? 'pl-2.5' : 'rounded-r-[10px] pl-3 pr-3.5',
          )}
          data-testid="phone-input"
        />
      </div>
      {showHint && (
        <p id={`${inputId}-hint`} className="mt-1.5 text-[12.5px] text-ink-3" data-testid="phone-hint">
          That doesn't look like a whole {countryName(country)} number yet.
        </p>
      )}
      {open && (
        <div
          className="pop-in absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-[12px] border border-line bg-canvas shadow-[var(--shadow-card)] sm:right-auto sm:w-[320px]"
          data-testid="phone-country-list"
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={14} className="shrink-0 text-ink-3" aria-hidden />
            <input
              ref={search}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onListKey}
              placeholder="Search country or code"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={list[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              aria-label="Search countries"
              className="h-10 min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-4 focus:outline-none"
              data-testid="phone-country-search"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Countries"
            className="max-h-[260px] overflow-y-auto py-1"
          >
            {list.length ? (
              list.map((c, i) => (
                <div
                  key={c.code}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={c.code === country}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c.code)}
                  onKeyDown={onListKey}
                  className={cx(
                    'flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[14px]',
                    i === active ? 'bg-canvas-2' : '',
                    pinnedCount > 0 && i === pinnedCount - 1 && 'mb-1 border-b border-line-2 pb-2.5',
                  )}
                  data-testid="phone-country-option"
                  data-country={c.code}
                >
                  <span className="text-[17px] leading-none" aria-hidden>
                    {flagOf(c.code)}
                  </span>
                  <span className={cx('min-w-0 flex-1 truncate', c.code === country && 'font-medium')}>
                    {c.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-3">{c.dial}</span>
                </div>
              ))
            ) : (
              <div className="px-3 py-3 text-[13px] text-ink-3">No country matches that</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A plausible local number to show as the placeholder, formatted for the country (the US one is the familiar 555). */
function examplePlaceholder(country: CountryCode): string {
  const examples: Partial<Record<CountryCode, string>> = {
    US: '4155550123',
    CA: '6135550123',
    GB: '7400123456',
    IN: '9812345678',
    AU: '412345678',
  };
  return examples[country] ?? '';
}
