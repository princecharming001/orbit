import { describe, expect, it } from 'vitest';
import { stripQuotedReply } from '../text/email';

/** Reply headers from more clients and languages (after crisp-oss/email-reply-parser, MIT). */
const REPLY = 'Sounds good, Thursday works.';
const CASES: [string, string][] = [
  ['Italian', 'Il giorno 3 nov 2026, alle ore 09:12, Marco Rossi <marco@example.it> ha scritto:'],
  ['Polish', 'W dniu 3.11.2026 o 09:12, Anna Nowak <anna@example.pl> pisze:'],
  ['Swedish', 'Den 3 nov. 2026 kl. 09:12 skrev Erik Lund <erik@example.se>:'],
  ['Finnish', 'ti 3.11.2026 klo 9.12 Aino Virtanen <aino@example.fi> kirjoitti:'],
  ['Chinese', '在 2026年11月3日 09:12，王伟 <wei@example.cn> 写道：'],
  ['Korean', '2026. 11. 3. 오전 9:12, Kim <kim@example.kr>님이 작성:'],
  ['Japanese', '2026/11/03 9:12、Sato <sato@example.jp>のメッセージ:'],
  ['name on date at time', 'Dana Park on Tue, Nov 3, 2026 at 9:12 AM wrote:'],
  ['bare From line', 'From: Dana Park <dana@example.com>'],
  ['German Von line', 'Von: Lena Weber <lena@example.de>'],
  ['Danish separator', '-------- Oprindelig besked --------'],
  ['French separator', "-------- Message d'origine --------"],
];

describe('stripQuotedReply: reply headers in more clients and languages', () => {
  it.each(CASES)('%s', (_label, header) => {
    expect(stripQuotedReply(`${REPLY}\n\n${header}\n> earlier message\n> more of it`)).toBe(REPLY);
  });

  it('drops a localized mobile footer', () => {
    expect(stripQuotedReply(`${REPLY}\n\nEnvoyé de mon iPhone`)).toBe(REPLY);
    expect(stripQuotedReply(`${REPLY}\n\nGesendet von meinem iPad`)).toBe(REPLY);
  });

  it('keeps an ordinary sentence that starts like a header', () => {
    const body =
      'Il progetto is going well.\nFrom: the team, thanks again.\nDen of thieves was a good movie.';
    expect(stripQuotedReply(body)).toBe(body);
  });
});
