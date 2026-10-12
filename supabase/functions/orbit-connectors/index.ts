import { defaultOrigins, makeHandler } from './connectors.ts';

Deno.serve(
  makeHandler({
    unipileKey: Deno.env.get('UNIPILE_API_KEY') || undefined,
    unipileBase: Deno.env.get('UNIPILE_BASE_URL') || undefined,
    villageKey: Deno.env.get('VILLAGE_API_KEY') || undefined,
    villageBase: Deno.env.get('VILLAGE_BASE_URL') || 'https://api.village.do',
    origins: defaultOrigins,
  }),
);
