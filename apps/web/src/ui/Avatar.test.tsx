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
