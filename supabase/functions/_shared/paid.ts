/**
 * A job error thrown after a paid call (plan 34 A6). The worker retries such a job once at most, then dead-letters it,
 * so a handler that keeps failing after its model call does not pay for that call five times. Handlers wrap the error
 * with `markPaid` once a paid call has gone out; the worker asks `isPaidError`.
 */
export type PaidError = Error & { paid: true };

/** The same error (an Error made from anything else), marked as thrown after a paid call. */
export function markPaid(err: unknown): PaidError {
  const e =
    err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'job failed after a paid call');
  return Object.assign(e, { paid: true as const });
}

/** Whether an error was thrown after a paid call. */
export function isPaidError(err: unknown): err is PaidError {
  return !!err && typeof err === 'object' && (err as { paid?: unknown }).paid === true;
}
