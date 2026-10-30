/**
 * Drafts the simulation found that fail a hard check today (a validator-blocking issue or a placeholder), as
 * `persona/recipient/scenario`. Each runs as `it.fails` in sim-drafts.test.ts: when the writer is fixed the test
 * flips to failing, and the key should be removed from here. See docs/draft-sim-report-2026-10-30.md.
 */
export const KNOWN_HARD: ReadonlySet<string> = new Set<string>([]);
