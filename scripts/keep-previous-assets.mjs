#!/usr/bin/env node
/**
 * Carry the live site's files into the build about to be published, so a tab opened before this deploy still finds
 * every file it loads later (a chat, a page, a dialog loaded on demand). GitHub Pages replaces the whole site on each
 * deploy and the file names change with their content, so without this an open tab failed with "Failed to fetch
 * dynamically imported module" the first time it needed a part it had not loaded yet.
 *
 * Starts at the live index.html and follows every assets/… file the live files name, copying the ones the new build
 * does not have (never overwriting one it does). Best effort: a site that cannot be reached leaves the build as it is.
 *
 * usage: node scripts/keep-previous-assets.mjs <live site url> <dist dir>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [site, dist] = process.argv.slice(2);
if (!site || !dist) {
  console.log('keep-previous-assets: no site or dist given, nothing kept');
  process.exit(0);
}
const base = site.endsWith('/') ? site : `${site}/`;
const ASSET = /assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2?|svg|png|webp|json)/g;
const MAX_FILES = 600;

async function get(path) {
  const r = await fetch(new URL(path, base), { redirect: 'follow' });
  if (!r.ok) return undefined;
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const index = await get('index.html');
  if (!index) {
    console.log(`keep-previous-assets: ${base} did not answer, nothing kept`);
    return;
  }
  const seen = new Set();
  const queue = [...new Set(index.toString('utf8').match(ASSET) ?? [])];
  let kept = 0;
  while (queue.length && seen.size < MAX_FILES) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const body = await get(path).catch(() => undefined);
    if (!body) continue;
    if (/\.(js|css)$/.test(path))
      for (const next of body.toString('utf8').match(ASSET) ?? []) if (!seen.has(next)) queue.push(next);
    const out = join(dist, path);
    if (existsSync(out)) continue;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
    kept++;
  }
  console.log(`keep-previous-assets: ${seen.size} live files checked, ${kept} carried into this build`);
}

main().catch((e) => console.log(`keep-previous-assets: stopped (${e instanceof Error ? e.message : e}), nothing more kept`));
