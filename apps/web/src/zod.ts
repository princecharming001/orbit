import { z } from 'zod/v4';

/**
 * The app runs under a Content-Security-Policy without 'unsafe-eval'. Zod's compiled object parsers probe
 * `new Function` when a schema is built, which the browser reports as a violation even though Zod falls back, so every
 * zod/v4 schema in the app is built jitless. Import `z` from here, not from 'zod/v4', so the setting is in place first.
 */
z.config({ jitless: true });

export { z };
