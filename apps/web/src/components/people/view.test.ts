import { describe, expect, it } from 'vitest';
import { legacyHref } from '../../legacyRoutes';
import { peopleFilterOf, peopleHref, peopleViewOf } from './view';

const q = (s: string) => new URLSearchParams(s);

describe('the People page address', () => {
  it('opens on the board, and reads the list and companies views', () => {
    expect(peopleViewOf(q(''))).toBe('board');
    expect(peopleViewOf(q('view=list'))).toBe('list');
    expect(peopleViewOf(q('view=companies'))).toBe('companies');
    // the Pipeline's table is the list now; anything unknown is the board
    expect(peopleViewOf(q('view=table'))).toBe('list');
    expect(peopleViewOf(q('view=bogus'))).toBe('board');
  });

  it('reads the filter from f, then from the older quiet=1', () => {
    expect(peopleFilterOf(q(''))).toBe('all');
    expect(peopleFilterOf(q('f=chats'))).toBe('chats');
    expect(peopleFilterOf(q('f=hidden'))).toBe('hidden');
    expect(peopleFilterOf(q('quiet=1'))).toBe('quiet');
    expect(peopleFilterOf(q('view=board&quiet=1'))).toBe('quiet');
    expect(peopleFilterOf(q('f=alumni&quiet=1'))).toBe('alumni');
    expect(peopleFilterOf(q('f=nonsense'))).toBe('all');
  });

  it('writes an address that leaves out the default filter', () => {
    expect(peopleHref('board')).toBe('/people?view=board');
    expect(peopleHref('list', 'chats')).toBe('/people?view=list&f=chats');
  });
});

describe('addresses from before Today and the Pipeline were folded in', () => {
  it('sends Today to the chat, and a link to one card or person to Drafts', () => {
    expect(legacyHref('/today')).toBe('/');
    expect(legacyHref('/today?card=s_12')).toBe('/inbox?card=s_12');
    expect(legacyHref('/today?person=p4')).toBe('/inbox?person=p4');
  });

  it('sends the Pipeline to the People page, keeping the view and who went quiet', () => {
    expect(legacyHref('/pipeline')).toBe('/people?view=board');
    expect(legacyHref('/pipeline?view=table')).toBe('/people?view=list&f=chats');
    expect(legacyHref('/pipeline?view=companies')).toBe('/people?view=companies');
    expect(legacyHref('/pipeline?quiet=1')).toBe('/people?view=board&quiet=1');
    expect(legacyHref('/pipeline?filter=quiet')).toBe('/people?view=board&quiet=1');
    expect(legacyHref('/pipeline?view=table&quiet=1')).toBe('/people?view=list&f=quiet');
  });

  it('leaves every other address alone', () => {
    for (const href of ['/', '/people', '/people/p4', '/inbox?card=x', '/map?reach=1', '/todayish'])
      expect(legacyHref(href)).toBeUndefined();
  });

  it('every address it gives opens on what it asked for', () => {
    const to = new URL(`http://x${legacyHref('/pipeline?view=table')}`);
    expect(peopleViewOf(to.searchParams)).toBe('list');
    expect(peopleFilterOf(to.searchParams)).toBe('chats');
    const quiet = new URL(`http://x${legacyHref('/pipeline?quiet=1')}`);
    expect(peopleViewOf(quiet.searchParams)).toBe('board');
    expect(peopleFilterOf(quiet.searchParams)).toBe('quiet');
  });
});
