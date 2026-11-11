import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { flagOf, PhoneField, type PhoneValue, readPhone, searchCountries } from './PhoneField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
});

const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (id: string) => [...document.body.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

async function mount(props: Parameters<typeof PhoneField>[0] = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => act(() => root.unmount());
  const out: PhoneValue[] = [];
  await act(async () => root.render(<PhoneField onChange={(v) => out.push(v)} {...props} />));
  return out;
}

const type = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('reading numbers', () => {
  it('a US number in E.164 once whole, and not before', () => {
    expect(readPhone('(415) 555-0123', 'US')).toEqual({
      e164: '+14155550123',
      country: 'US',
      valid: true,
      empty: false,
    });
    expect(readPhone('415 555', 'US')).toMatchObject({ e164: null, valid: false });
    expect(readPhone('020 7946 0958', 'GB')).toMatchObject({ e164: '+442079460958', valid: true });
  });

  it('finds countries by name, code or dial code, the student own first when nothing is typed', () => {
    expect(
      searchCountries('', 'DE')
        .slice(0, 5)
        .map((c) => c.code),
    ).toEqual(['DE', 'US', 'CA', 'GB', 'IN']);
    expect(
      searchCountries('', 'US')
        .slice(0, 4)
        .map((c) => c.code),
    ).toEqual(['US', 'CA', 'GB', 'IN']);
    expect(searchCountries('uni').map((c) => c.code)).toEqual(expect.arrayContaining(['US', 'GB', 'AE']));
    expect(searchCountries('+44')[0]!.code).toBe('GB');
    expect(searchCountries('1')[0]!.code).toBe('US');
    expect(searchCountries('44').every((c) => c.dial.startsWith('+44'))).toBe(true);
    expect(searchCountries('zzzz')).toEqual([]);
    expect(flagOf('US')).toBe('🇺🇸');
  });
});

describe('the phone field', () => {
  it('formats as it is typed and gives the number in E.164 once it is whole', async () => {
    const out = await mount();
    const input = q('phone-input') as HTMLInputElement;
    expect(q('phone-country')!.dataset.country).toBe('US');
    await type(input, '4155550123');
    expect(input.value).toBe('(415) 555-0123');
    expect(out.at(-1)).toEqual({ e164: '+14155550123', country: 'US', valid: true, empty: false });
  });

  it('a pasted number with its own code switches the country', async () => {
    const out = await mount();
    const input = q('phone-input') as HTMLInputElement;
    await type(input, '+44 20 7946 0958');
    expect(q('phone-country')!.dataset.country).toBe('GB');
    expect(input.value).toBe('020 7946 0958');
    expect(out.at(-1)).toEqual({ e164: '+442079460958', country: 'GB', valid: true, empty: false });
  });

  it('backspace over formatting deletes a digit instead of sticking', async () => {
    await mount();
    const input = q('phone-input') as HTMLInputElement;
    await type(input, '415555');
    expect(input.value).toBe('(415) 555');
    await type(input, '(415) 555'.slice(0, -1) + '5'.slice(1));
    expect(input.value.replace(/\D/g, '')).toBe('41555');
  });

  it('says plainly when the number is not whole yet, after the field is left', async () => {
    await mount();
    const input = q('phone-input') as HTMLInputElement;
    await type(input, '415 555');
    expect(q('phone-hint')).toBeNull();
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(q('phone-hint')!.textContent).toBe("That doesn't look like a whole United States number yet.");
  });

  it('the country list searches, takes the keyboard, and keeps the digits in the new country', async () => {
    const out = await mount({ defaultCountry: 'CA' });
    await type(q('phone-input') as HTMLInputElement, '2079460958');
    await act(async () => q('phone-country')!.click());
    // the student own country first, then the pinned ones
    expect(
      qa('phone-country-option')
        .slice(0, 4)
        .map((o) => o.dataset.country),
    ).toEqual(['CA', 'US', 'GB', 'IN']);
    const search = q('phone-country-search') as HTMLInputElement;
    await type(search, 'united k');
    expect(qa('phone-country-option').map((o) => o.dataset.country)).toEqual(['GB']);
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(q('phone-country-list')).toBeNull();
    expect(q('phone-country')!.dataset.country).toBe('GB');
    expect(out.at(-1)).toEqual({ e164: '+442079460958', country: 'GB', valid: true, empty: false });
    // Esc closes without a change
    await act(async () => q('phone-country')!.click());
    await act(async () => {
      (q('phone-country-search') as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(q('phone-country-list')).toBeNull();
    expect(q('phone-country')!.dataset.country).toBe('GB');
  });

  it('opens on a saved number in its own country', async () => {
    await mount({ value: { e164: '+919812345678', country: 'IN' } });
    expect(q('phone-country')!.dataset.country).toBe('IN');
    const input = q('phone-input') as HTMLInputElement;
    expect(input.value.replace(/\D/g, '')).toMatch(/9812345678$/);
    // what it shows reads back as the same number
    expect(readPhone(input.value, 'IN').e164).toBe('+919812345678');
  });
});
