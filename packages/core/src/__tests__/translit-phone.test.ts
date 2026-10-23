import anyAscii from 'any-ascii';
import { describe, expect, it } from 'vitest';
import { doubleMetaphone } from '../entity/doubleMetaphone';
import { foldName, nameBlockKeys } from '../entity/names';
import { countryForCity, countryForTimeZone, phoneRegionFor, samePhone, toE164 } from '../entity/phone';
import { transliterate } from '../entity/translit';
import { stripDiacritics } from '../text/normalize';

describe('transliteration (any-ascii, vendored)', () => {
  it('gives exactly what any-ascii gives for every character of the blocks it keeps', () => {
    const ranges: [number, number][] = [
      [0x80, 0x20ff],
      [0x3000, 0x31ff],
      [0x4e00, 0x9fff],
      [0xac00, 0xd7a3],
      [0xff00, 0xffef],
    ];
    let checked = 0;
    for (const [from, to] of ranges)
      for (let cp = from; cp <= to; cp++) {
        // surrogates are not characters
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const c = String.fromCodePoint(cp);
        if (transliterate(c) !== anyAscii(c))
          expect({ cp: cp.toString(16), got: transliterate(c) }).toEqual({
            cp: cp.toString(16),
            got: anyAscii(c),
          });
        checked++;
      }
    expect(checked).toBeGreaterThan(40_000);
  });

  it('writes names in Latin letters, CJK and Hangul by syllable', () => {
    expect(transliterate('Łukasz Żółć')).toBe('Lukasz Zolc');
    expect(transliterate('Иван Петров')).toBe('Ivan Petrov');
    expect(transliterate('王伟', { syllables: true })).toBe('Wang Wei');
    expect(transliterate('김민준', { syllables: true })).toBe('Gim Min Jun');
    // a block left out (emoji) renders as nothing
    expect(transliterate('🙂')).toBe('');
  });

  it('stripDiacritics also folds the Latin letters that have no accent to strip', () => {
    expect(stripDiacritics('Søren Łukasz Straße Æsir Đorđe Þór')).toBe(
      'Soren Lukasz Strasse Aesir Dorde Thor',
    );
    expect(stripDiacritics('José Núñez')).toBe('Jose Nunez');
  });
});

describe('double metaphone (vendored)', () => {
  it('gives the codes upstream gives (checked against double-metaphone 2.0.1 on 2,267 names)', () => {
    expect(doubleMetaphone('michael')).toEqual(['MKL', 'MXL']);
    expect(doubleMetaphone('Xavier')).toEqual(['SF', 'SFR']);
    expect(doubleMetaphone('Filipowicz')).toEqual(['FLPTS', 'FLPFX']);
    expect(doubleMetaphone('Hugh')).toEqual(['H', 'H']);
    expect(doubleMetaphone('Steven')[0]).toBe(doubleMetaphone('Stephen')[0]);
  });

  it('files sound-alike and East Asian surnames under a shared key', () => {
    const shared = (a: string, b: string) =>
      nameBlockKeys(foldName(a)).some((k) => nameBlockKeys(foldName(b)).includes(k));
    expect(shared('김민준', 'Minjun Kim')).toBe(true);
    expect(shared('이서연', 'Seoyeon Lee')).toBe(true);
    expect(shared('Wang Wei', 'Wei Wang')).toBe(true);
    expect(shared('Meyer Lansky', 'Maier Lansky')).toBe(true);
    expect(shared('Priya Patel', 'Daniel Kim')).toBe(false);
  });
});

describe('phone numbers (libphonenumber-js)', () => {
  it('writes numbers in E.164 for the country they are written for', () => {
    expect(toE164('(555) 123-4567')).toBe('+15551234567');
    expect(toE164('1-555-123-4567')).toBe('+15551234567');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('020 7946 0958', 'GB')).toBe('+442079460958');
    expect(toE164('0044 20 7946 0958')).toBe('+442079460958');
    expect(toE164('98765 43210', 'IN')).toBe('+919876543210');
    expect(toE164('010-1234-5678', 'KR')).toBe('+821012345678');
    expect(toE164('tel:+1-555-123-4567')).toBe('+15551234567');
    // verification short codes are not people
    expect(toE164('28849')).toBeUndefined();
    expect(samePhone('(555) 123-4567', '+1 555 123 4567')).toBe(true);
  });

  it("reads the student's country from their time zone, their city, or the numbers they text", () => {
    expect(countryForTimeZone('America/Chicago')).toBe('US');
    expect(countryForTimeZone('Europe/London')).toBe('GB');
    expect(countryForTimeZone('Asia/Calcutta')).toBe('IN');
    expect(countryForTimeZone('Etc/UTC')).toBeUndefined();
    expect(countryForCity('Austin, TX')).toBe('US');
    expect(countryForCity('Bengaluru, India')).toBe('IN');
    expect(phoneRegionFor({ timezone: 'Europe/London' })).toBe('GB');
    expect(phoneRegionFor({ timezone: 'Etc/UTC', currentCity: 'Toronto' })).toBe('CA');
    expect(phoneRegionFor(undefined)).toBe('US');
    // visiting India for the summer with a phone full of US numbers: the numbers win
    const us = ['+14155552671', '+12125550123', '+13125550101', '+16175550100', '+12065550111'];
    expect(phoneRegionFor({ timezone: 'Asia/Kolkata' }, us)).toBe('US');
    expect(phoneRegionFor({ timezone: 'Asia/Kolkata' }, us.slice(0, 2))).toBe('IN');
  });
});
