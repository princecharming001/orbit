import { describe, expect, it } from 'vitest';
import { heuristicSignal } from '../email/triage';
import { splitSignature, stripQuotedReply } from '../text/email';
import type { ProposedTime } from '../types';
import { CORPUS_NOW, CORPUS_TZ } from './fixtures/email-corpus';
import { fromEmailCorpus, labelOf, type SignalExample, type SignalLabel } from './fixtures/reply-signals';
import { HOLDOUT } from './fixtures/reply-signals-holdout';
import { TRAIN } from './fixtures/reply-signals-train';

/**
 * Reply-signal corpus: the tuning part (the new examples plus the older email corpus) must pass in full; the held-out
 * part must stay at or above 95% with every hard decline and every intro right. Both print a confusion summary.
 */

function wall(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('month')}/${get('day')} ${get('hour').padStart(2, '0')}:${get('minute')}`;
}
function fmt(t: ProposedTime): string {
  const tz = t.timeZone ?? CORPUS_TZ;
  return `${wall(t.startIso, tz)}${t.endIso ? `-${wall(t.endIso, tz).slice(-5)}` : ''}`;
}

interface Outcome {
  label: SignalLabel;
  times: string[];
  zones: (string | undefined)[];
  followUpAfter?: string;
  /** what is wrong, empty when the example passes */
  errors: string[];
}

function classify(e: SignalExample): Outcome {
  const stripped = stripQuotedReply(e.body);
  const body = splitSignature(stripped).body || stripped;
  const r = heuristicSignal(body, e.direction ?? 'inbound', CORPUS_NOW, {
    timeZone: CORPUS_TZ,
    awaitingAnswer: e.awaiting,
  });
  const label = labelOf(r.signal, r.extraction);
  const times = r.extraction.proposedTimes.map(fmt);
  const zones = r.extraction.proposedTimes.map((t) => t.timeZone);
  const errors: string[] = [];
  if (label !== e.label) errors.push(`label ${label}, want ${e.label}`);
  if (e.times && JSON.stringify(times) !== JSON.stringify(e.times))
    errors.push(`times ${JSON.stringify(times)}, want ${JSON.stringify(e.times)}`);
  if (e.times && zones.some((z) => z !== e.zone)) errors.push(`zones ${zones.join(',')}, want ${e.zone}`);
  if (e.followUpAfter && r.extraction.followUpAfter !== e.followUpAfter)
    errors.push(`followUpAfter ${r.extraction.followUpAfter}, want ${e.followUpAfter}`);
  if (r.extraction.proposedTimes.some((t) => new Date(t.startIso).getTime() <= CORPUS_NOW.getTime()))
    errors.push('a proposed time has already passed');
  return { label, times, zones, followUpAfter: r.extraction.followUpAfter, errors };
}

/** "label: n right of m; confused with x (k), y (j)" per expected label, then the overall accuracy. */
function confusion(name: string, examples: SignalExample[]): { accuracy: number; text: string } {
  const rows = new Map<SignalLabel, { n: number; ok: number; as: Map<string, number> }>();
  let ok = 0;
  const misses: string[] = [];
  for (const e of examples) {
    const o = classify(e);
    const row = rows.get(e.label) ?? { n: 0, ok: 0, as: new Map() };
    row.n++;
    if (!o.errors.length) {
      row.ok++;
      ok++;
    } else {
      const as = o.label === e.label ? `${o.label} (times)` : o.label;
      row.as.set(as, (row.as.get(as) ?? 0) + 1);
      misses.push(`  ${e.id}: ${o.errors.join('; ')}`);
    }
    rows.set(e.label, row);
  }
  const accuracy = ok / examples.length;
  const lines = [...rows.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([label, r]) =>
        `  ${label.padEnd(14)} ${String(r.ok).padStart(3)}/${String(r.n).padEnd(3)}${
          r.as.size ? ` read as ${[...r.as].map(([k, v]) => `${k} x${v}`).join(', ')}` : ''
        }`,
    );
  const text = [
    `${name}: ${ok}/${examples.length} right (${(accuracy * 100).toFixed(1)}%)`,
    ...lines,
    ...(misses.length ? ['  misses:', ...misses] : []),
  ].join('\n');
  return { accuracy, text };
}

const TUNING = [...TRAIN, ...fromEmailCorpus()];

describe('reply-signal corpus', () => {
  it('is big enough, with about a fifth held out and no duplicate ids', () => {
    const all = [...TUNING, ...HOLDOUT];
    expect(all.length).toBeGreaterThanOrEqual(250);
    expect(HOLDOUT.length / all.length).toBeGreaterThanOrEqual(0.2);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(new Set(all.map((e) => e.body)).size).toBe(all.length);
  });

  describe('tuning part', () => {
    for (const e of TUNING)
      it(`${e.id}: ${e.label}`, () => {
        expect(classify(e).errors).toEqual([]);
      });
    it('prints its confusion summary', () => {
      const c = confusion('reply signals, tuning', TUNING);
      console.log(c.text);
      expect(c.accuracy).toBe(1);
    });
  });

  it('held-out part: at least 95% right, and every hard decline and every intro right', () => {
    const c = confusion('reply signals, held out', HOLDOUT);
    console.log(c.text);
    expect(c.accuracy).toBeGreaterThanOrEqual(0.95);
    const critical = HOLDOUT.filter((e) => ['decline_hard', 'intro', 'intro_handoff'].includes(e.label));
    expect(critical.length).toBeGreaterThan(0);
    for (const e of critical) expect(classify(e).errors, e.id).toEqual([]);
  });
});
