// Builds index.html for the chat review gallery from the per-case JSON the gallery spec writes.
// node scripts/chat-gallery/build.mjs <GALLERY_DIR>  (writes <GALLERY_DIR>/index.html; screenshots go under shots/ when published)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '/tmp/orbit-gallery';
const here = new URL('.', import.meta.url).pathname;
const order = ['n', 'm', 's', 'd', 'p', 'w', 'g', 'x'];
const cases = readdirSync(dir)
  .filter((f) => /^[a-z]\d\d\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((s) => s.length)
  .map((shots) => ({ id: shots[0].id, group: shots[0].group, turns: shots }))
  .sort((a, b) => order.indexOf(a.id[0]) - order.indexOf(b.id[0]) || a.id.localeCompare(b.id));

const tpl = readFileSync(join(here, 'page.html'), 'utf8');
writeFileSync(join(dir, 'index.html'), tpl.replace('/*CASES*/[]', JSON.stringify(cases)));
console.log(`${cases.length} cases, ${cases.reduce((n, c) => n + c.turns.length, 0)} shots`);
