import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brokenPhoto, onScreenRank, resetPhotoSignalsForTests } from '../engine/photoSignals';
import { Avatar } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const licdn = (name: string, e = 1_900_000_000) =>
  `https://media.licdn.com/dms/image/v2/${name}?e=${e}&v=beta&t=x`;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetPhotoSignalsForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (src: string | undefined) =>
  act(() => root.render(<Avatar name="Morgan Lee" src={src} id="p_morgan" size={28} />));
const img = () => host.querySelector('img');
const fail = () => act(() => img()!.dispatchEvent(new Event('error')));

describe('Avatar', () => {
  it('shows the picture, tells the queue who is on screen, and falls back to the initials after one retry', () => {
    render(licdn('one'));
    expect(img()?.getAttribute('src')).toBe(licdn('one'));
    expect(onScreenRank().has('p_morgan')).toBe(true);
    expect(host.textContent).toBe('');
    // a load that fails is tried once more with a fresh element
    fail();
    expect(img()?.getAttribute('src')).toBe(licdn('one'));
    expect(brokenPhoto('p_morgan')).toBeUndefined();
    // then the initials, and the queue hears which link failed
    fail();
    expect(img()).toBeNull();
    expect(host.textContent).toBe('ML');
    expect(brokenPhoto('p_morgan')).toBe(licdn('one'));
    // a fresh link from the queue is tried again
    render(licdn('two'));
    expect(img()?.getAttribute('src')).toBe(licdn('two'));
  });

  it('never tries a LinkedIn link past its expiry, and leaves the screen when unmounted', () => {
    render(licdn('old', 1_700_000_000));
    expect(img()).toBeNull();
    expect(host.textContent).toBe('ML');
    // the student's own picture has no expiry to check
    render('https://example.com/me.jpg');
    expect(img()?.getAttribute('src')).toBe('https://example.com/me.jpg');
    act(() => root.unmount());
    root = createRoot(host);
    expect(onScreenRank().has('p_morgan')).toBe(false);
  });
});

describe('Avatar reads the person’s own photo', () => {
  it('a card with an old link or none shows the photo the record has now, and follows it when it changes', async () => {
    const { db } = await import('../db/schema');
    const now = new Date().toISOString();
    await db.people.put({
      id: 'p_record',
      userId: 'u_photo',
      displayName: 'Rae Kim',
      firstName: 'Rae',
      photoUrl: licdn('fresh'),
      createdAt: now,
      updatedAt: now,
    } as never);
    const settle = async () => {
      for (let i = 0; i < 8; i++) await act(() => new Promise((r) => setTimeout(r, 10)));
    };
    // the card was given an expired link (a chat answer made weeks ago): the record's fresh one shows
    act(() => root.render(<Avatar name="Rae Kim" src={licdn('stale', 1_700_000_000)} id="p_record" />));
    await settle();
    expect(img()?.getAttribute('src')).toBe(licdn('fresh'));
    // no link at all: still the record's
    act(() => root.render(<Avatar name="Rae Kim" id="p_record" />));
    await settle();
    expect(img()?.getAttribute('src')).toBe(licdn('fresh'));
    // the photo queue writes a newer one: the avatar follows it
    await db.people.update('p_record', { photoUrl: licdn('newer') });
    await settle();
    expect(img()?.getAttribute('src')).toBe(licdn('newer'));
    // an id that is not a person keeps the link it was given
    act(() => root.render(<Avatar name="Sam" src="https://example.com/sam.jpg" id="Sam-0" />));
    await settle();
    expect(img()?.getAttribute('src')).toBe('https://example.com/sam.jpg');
  });
});
