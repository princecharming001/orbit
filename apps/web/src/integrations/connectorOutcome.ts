/**
 * What the connector adapters (unipile.ts, village.ts) share: a typed outcome instead of a throw, the proxy's
 * "unconfigured" answer, and the explicit switch tests use to pick how connectors behave in a browser under
 * automation.
 */

export type ConnectorFailureReason = 'unconfigured' | 'timeout' | 'error';

/** A connector call's result: the value, or why there is none. */
export type ConnectorOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ConnectorFailureReason; message: string; status?: number };

export function connectorFailure(
  reason: ConnectorFailureReason,
  message: string,
  status?: number,
): { ok: false; reason: ConnectorFailureReason; message: string; status?: number } {
  return { ok: false, reason, message, status };
}

/** The proxy's answer when the provider key is not pasted yet: 503 with x-orbit-connector: unconfigured. */
export function isUnconfigured(res: Pick<Response, 'status' | 'headers'>): boolean {
  return res.status === 503 && res.headers.get('x-orbit-connector') === 'unconfigured';
}

/**
 * How connectors behave, chosen explicitly by a test:
 * - `live`: the real proxy from the build (the default for a person using Orbit)
 * - `off`: as if the build had no proxy
 * - `unconfigured`: as if the proxy answered that its key is not pasted yet (the fallback copy shows)
 * - `mock`: every account uses the mock connector the sample student uses
 *
 * An end-to-end test sets `window.__ORBIT_CONNECTORS__` before the app loads. A browser under automation that set
 * nothing gets `off`, so no test ever reaches the real proxy by accident; the sample student's mock works either way.
 */
export type ConnectorTestMode = 'live' | 'off' | 'unconfigured' | 'mock';

let modeOverride: ConnectorTestMode | undefined;

/** Unit-test hook for the same switch; undefined restores the default. */
export function setConnectorModeForTests(mode: ConnectorTestMode | undefined): void {
  modeOverride = mode;
}

export function automationOverride(): ConnectorTestMode {
  if (modeOverride) return modeOverride;
  const g = globalThis as { __ORBIT_CONNECTORS__?: unknown };
  const chosen = g.__ORBIT_CONNECTORS__;
  if (chosen === 'live' || chosen === 'off' || chosen === 'unconfigured' || chosen === 'mock') return chosen;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return 'off';
  return 'live';
}
