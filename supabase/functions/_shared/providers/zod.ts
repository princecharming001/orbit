/**
 * The one place the provider, research, sourcing and path modules get Zod from. It re-exports the app's jitless
 * `z` (zod/v4), so these modules type-check and run under the web suite today. When the functions are bundled
 * (§12.7) this line is the only one to repoint (e.g. to a `zod/v4` import-map entry in the function's deno.json).
 */
export { z } from '../../../../apps/web/src/zod';
