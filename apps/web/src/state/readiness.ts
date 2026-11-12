/**
 * Plan 40: one place that knows where the first import stands, for the sidebar chip, the chat's banner and the last
 * setup screen. Account mode only (local mode reads nothing in the background).
 *
 * It asks orbit-notify every few seconds while anything is still coming in and the tab is visible, every few minutes
 * once Orbit is ready, and falls back to the /sync/status the app already polls when orbit-notify does not answer.
 * When readiness turns `ready` in front of the student (it was not ready earlier in this visit), listeners hear it
 * once, so the app can say "Orbit is ready" at that moment and not on every load after.
 */
import type { Readiness, ReadinessInput } from '@orbit/core';
import { useEffect, useState } from 'react';
import {
  type NotifyStatus,
  notifyStatus,
  readinessFromSync,
  textsReadiness,
  withTextsStep,
} from '../engine/notify';
import { subscribeSyncStatus, syncStatusNow } from '../engine/serverSync';
import { accountUser, isAccountMode, isSignedIn } from '../integrations/orbitApi';

export interface ReadinessView {
  readiness: Readiness;
  /** the server's answer, with the contact row; undefined when it came from /sync/status */
  notify?: NotifyStatus;
}

export const WHILE_SYNCING_MS = 6_000;
export const WHEN_READY_MS = 5 * 60_000;

let view: ReadinessView | undefined;
let sawNotReady = false;
const listeners = new Set<(v: ReadinessView | undefined) => void>();
const readyListeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let running = 0;
let lastServer = 0;

function set(next: ReadinessView | undefined): void {
  const was = view?.readiness.state;
  if (JSON.stringify(next) === JSON.stringify(view)) return;
  view = next;
  const now = next?.readiness.state;
  if (now && now !== 'ready' && now !== 'nothing') sawNotReady = true;
  for (const l of listeners) l(view);
  if (now === 'ready' && was !== 'ready' && sawNotReady) for (const l of readyListeners) l();
}

export function readinessNow(): ReadinessView | undefined {
  return view;
}

/** Ask now: the server first, else what /sync/status says. */
export async function refreshReadiness(): Promise<ReadinessView | undefined> {
  if (!isAccountMode() || !isSignedIn()) {
    set(undefined);
    return undefined;
  }
  const [s, texts] = await Promise.all([
    notifyStatus().catch(() => undefined),
    textsReadiness(accountUser()?.id).catch(() => undefined),
  ]);
  lastTexts = texts;
  if (s) {
    lastServer = Date.now();
    set({ readiness: withTextsStep(s.readiness, texts), notify: s });
  } else {
    const fromSync = readinessFromSync(syncStatusNow());
    // a server answer from a moment ago stays: a missed poll is not news
    if (fromSync && Date.now() - lastServer > 3 * WHILE_SYNCING_MS)
      set({ readiness: withTextsStep(fromSync, texts) });
  }
  return view;
}

/** the Texts step as last read (plan 43 §6), added to readiness however it came */
let lastTexts: ReadinessInput['texts'];

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!running) return;
  const wait =
    view?.readiness.state === 'ready' || view?.readiness.state === 'nothing'
      ? WHEN_READY_MS
      : WHILE_SYNCING_MS;
  timer = setTimeout(async () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await refreshReadiness();
    schedule();
  }, wait);
}

/** Start watching (the app shell does this once); the returned function stops it. */
export function watchReadiness(): () => void {
  running++;
  void refreshReadiness().then(schedule);
  const offSync = subscribeSyncStatus((s) => {
    // without a server answer, the sync status is the next best thing
    if (!view?.notify) {
      const r = readinessFromSync(s);
      if (r) set({ readiness: withTextsStep(r, lastTexts) });
    }
  });
  const onVisible = () => {
    if (document.visibilityState === 'visible') void refreshReadiness().then(schedule);
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    running = Math.max(0, running - 1);
    offSync();
    document.removeEventListener('visibilitychange', onVisible);
    if (!running && timer) clearTimeout(timer);
  };
}

export function useReadiness(): ReadinessView | undefined {
  const [v, setV] = useState(readinessNow);
  useEffect(() => {
    listeners.add(setV);
    setV(readinessNow());
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}

/** Called once when Orbit becomes ready in front of the student. */
export function onBecameReady(fn: () => void): () => void {
  readyListeners.add(fn);
  return () => {
    readyListeners.delete(fn);
  };
}

/** Test hook. */
export function resetReadinessForTests(next?: ReadinessView): void {
  view = undefined;
  sawNotReady = false;
  lastServer = 0;
  if (next) set(next);
}

/** Test hook: set what the watch would have heard. */
export function setReadinessForTests(next: ReadinessView | undefined): void {
  set(next);
}
