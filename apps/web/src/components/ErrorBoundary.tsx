import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui';

const RELOAD_KEY = 'orbit.chunkReloadAt';

/** A lazy page's file that no longer exists: the app was deployed while this tab was open. */
export function isStaleChunk(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  const text = `${e?.name ?? ''} ${e?.message ?? String(error)}`;
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(
    text,
  );
}

/** Reloads once for a stale chunk; a second stale chunk within a minute shows the message instead of looping. */
function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

type Props = {
  children: ReactNode;
  /** the pathname: a new value clears the error (a prop, not a key, so a healthy page never remounts) */
  resetKey?: string;
};

/**
 * Catches a page that throws while rendering (a failed live query, a missing chunk after a deploy) so the rest of
 * the app stays up.
 */
export class ErrorBoundary extends Component<Props, { error: unknown; reloading: boolean }> {
  state = { error: null as unknown, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isStaleChunk(error) && reloadOnce()) {
      this.setState({ reloading: true });
      return;
    }
    console.error('[orbit] page error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.state.reloading) return null;
    return (
      <div
        className="h-full min-h-[240px] flex flex-col items-center justify-center gap-3 p-6 text-center"
        data-testid="error-boundary"
      >
        <p className="text-[14px] text-ink-2">Something went wrong on this page.</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}
