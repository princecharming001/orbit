/**
 * What a page was showing, kept while the page is off the screen.
 *
 * Every page is unmounted when the student leaves it (a route change, a tab inside Discover), so anything held in
 * `useState` was lost: a search typed, its results, the filter picked, the row opened. Coming back, by the back
 * button or by the tab, showed an empty page and ran the work again. `useViewState` is `useState` whose value lives
 * here instead of in the component, under a key the page chooses, so the page finds it again when it mounts.
 *
 * Because the value is set through this module and not through the component, work that finishes while the page is
 * away still lands: a search started in Find people goes on while the student looks at their network, and its rows
 * are there when they come back.
 *
 * It is kept for this visit only (one tab, until a reload). The address bar still holds what should survive a
 * reload or be shared as a link: the tab, a sort, a person.
 */
import { type Dispatch, type SetStateAction, useCallback, useSyncExternalStore } from 'react';

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function tell(key: string): void {
  for (const l of listeners.get(key) ?? []) l();
}

/** What is kept under a key right now (undefined when nothing was set). */
export function readView<T>(key: string): T | undefined {
  return values.get(key) as T | undefined;
}

/** Set what is kept under a key, from anywhere: a page, or work that outlived it. */
export function writeView<T>(key: string, next: SetStateAction<T>, initial?: T): void {
  const prev = (values.has(key) ? values.get(key) : initial) as T;
  const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
  if (values.has(key) && Object.is(values.get(key), value)) return;
  values.set(key, value);
  tell(key);
}

function subscribe(key: string, l: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(key);
  };
}

/**
 * `useState` that the page finds again after it was away. `key` names the value for the whole app, so it carries
 * the page and, where people differ, the user ("people:q:u1"). `initial` is used the first time only.
 */
export function useViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  if (!values.has(key)) values.set(key, typeof initial === 'function' ? (initial as () => T)() : initial);
  const value = useSyncExternalStore(
    useCallback((l: () => void) => subscribe(key, l), [key]),
    () => values.get(key) as T,
    () => values.get(key) as T,
  );
  const set = useCallback((next: SetStateAction<T>) => writeView<T>(key, next), [key]);
  return [value, set];
}

/** Forget what is kept: everything, or the keys that start with `prefix` (a user who signed out, a test). */
export function forgetViews(prefix = ''): void {
  for (const key of [...values.keys()])
    if (key.startsWith(prefix)) {
      values.delete(key);
      tell(key);
    }
}

// ---- where each page was scrolled to -------------------------------------------------------------------------

const scrolls = new Map<string, number>();
const MAX_SCROLLS = 80;

/** Remember how far down a history entry was scrolled (`key` is the router's location key). */
export function keepScroll(key: string, y: number): void {
  scrolls.delete(key);
  scrolls.set(key, y);
  if (scrolls.size > MAX_SCROLLS) {
    const oldest = scrolls.keys().next().value;
    if (oldest !== undefined) scrolls.delete(oldest);
  }
}

/** How far down a history entry was scrolled when the student left it, or 0. */
export function scrollOf(key: string): number {
  return scrolls.get(key) ?? 0;
}

/** Test hook. */
export function forgetScrolls(): void {
  scrolls.clear();
}
