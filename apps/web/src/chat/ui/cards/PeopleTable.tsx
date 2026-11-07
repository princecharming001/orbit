/**
 * A network search's result (plan 32 §6.8): who matches, with the evidence for each, in bands that never mix (sure,
 * likely, could not check), the counts behind them and what limited the answer. Rows can be picked for routes or a
 * draft together, and marked "not a match" (kept, so the next search learns from it).
 */
import type { Person } from '@orbit/core';
import { X } from 'lucide-react';
import { Fragment, useState } from 'react';
import { isAccountMode as accountMode, callApi } from '../../../integrations/orbitApi';
import { Chip } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { routesToEach, writeToEach } from './next';
import {
  CardHead,
  GlassCard,
  type NextStep,
  NextSteps,
  PersonRow,
  PickBox,
  SelectionBar,
  useFold,
} from './parts';

interface TableRow {
  person: Pick<
    Person,
    'id' | 'displayName' | 'currentTitle' | 'currentOrganizationRaw' | 'photoUrl' | 'linkedinUrl'
  >;
  band: 'strong' | 'likely' | 'unchecked' | 'no';
  evidence?: string;
  missing?: string;
  warmth: string;
  lastTalk?: string;
}

interface TableData {
  setId: string;
  ask: string;
  askHash: string;
  counts: { strong: number; likely: number; uncheckedListed: number; uncheckedSilent: number };
  notes: string[];
  relaxed?: string;
  unknownBy: { label: string; n: number }[];
  remaining: number;
  judgeFailed: number;
  judgeUnavailable: boolean;
  unsupported: string[];
  rows: TableRow[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function readTable(d: unknown): TableData | undefined {
  const o = obj(d);
  const ui = obj('ui' in o ? o.ui : o);
  if (!Array.isArray(ui.rows) || typeof ui.setId !== 'string') return undefined;
  return ui as unknown as TableData;
}

const BAND_HEAD: Record<TableRow['band'], string | undefined> = {
  strong: undefined,
  likely: 'Likely',
  unchecked: 'Could not check',
  no: undefined,
};

const WARM_WORD: Record<string, string | undefined> = {
  close: 'close',
  strong: 'know well',
  warm: 'warm',
  light: undefined,
  faint: undefined,
};

function subLine(r: TableRow): string | undefined {
  const parts: string[] = [];
  if (r.band === 'unchecked' && r.missing) parts.push(r.missing);
  else if (r.evidence) parts.push(r.evidence);
  if (r.lastTalk) parts.push(`talked ${r.lastTalk}`);
  return parts.join(' · ') || undefined;
}

export function PeopleTableCard({
  env,
  send,
}: {
  env: ResultEnvelope;
  send: (text: string) => Promise<void> | void;
}) {
  const t = readTable(env.data);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const rows = (t?.rows ?? []).filter((r) => !hidden.has(r.person.id));
  const fold = useFold(rows, 8);
  if (!t) return null;
  const notAMatch = (r: TableRow) => {
    setHidden((h) => new Set(h).add(r.person.id));
    // kept on the server for an account; a local student's label lives only in this card
    if (accountMode())
      void callApi('/search/labels', {
        personId: r.person.id,
        askHash: t.askHash,
        ask: t.ask,
        verdict: 'no',
      }).catch(() => undefined);
  };
  const c = t.counts;
  const unchecked = c.uncheckedListed + c.uncheckedSilent;
  const names = rows.filter((r) => picked.has(r.person.id)).map((r) => r.person.displayName);
  const pickedSteps = [routesToEach(names), writeToEach(names)].filter((s): s is NextStep => !!s);
  const steps: NextStep[] = [];
  if (t.remaining > 0)
    steps.push({
      label: `Check ${Math.min(40, t.remaining)} more`,
      message: 'Check more people in that search',
    });
  if (rows.length && rows.length >= 25)
    steps.push({ label: 'Show more', message: 'Show more of those results' });
  const limits: string[] = [];
  if (unchecked)
    limits.push(
      `${unchecked} more could not be checked${t.unknownBy[0] ? `: ${t.unknownBy[0].label} is not on file for them` : ''}.`,
    );
  if (t.relaxed) limits.push(`Nobody matched exactly, so this loosened ${t.relaxed}.`);
  if (t.judgeUnavailable) limits.push('Some matches rest on headlines alone: the AI check is off right now.');
  else if (t.judgeFailed) limits.push(`${t.judgeFailed} could not be checked by the AI this time.`);
  if (t.unsupported.length) limits.push(`Orbit cannot check ${t.unsupported.join(', ')}.`);
  let lastBand: string | undefined;
  return (
    <GlassCard kind="people_table">
      <CardHead title={env.summary.split('. ')[0]?.replace(/\.$/, '')} />
      {t.notes.length > 0 && <div className="text-[12px] text-ink-3 -mt-1 mb-1.5">{t.notes.join(' ')}</div>}
      {rows.length === 0 ? (
        <div className="text-ink-2">Nobody to show.</div>
      ) : (
        <div className="divide-y divide-line-2">
          {fold.shown.map((r) => {
            const head = r.band !== lastBand ? BAND_HEAD[r.band] : undefined;
            lastBand = r.band;
            const warm = WARM_WORD[r.warmth];
            return (
              <Fragment key={r.person.id}>
                {head && (
                  <div
                    className="pt-2 pb-1 text-[11.5px] font-medium uppercase tracking-wide text-ink-3"
                    role="heading"
                    aria-level={4}
                  >
                    {head}
                  </div>
                )}
                <div
                  className="group flex items-center gap-2 min-w-0"
                  data-testid="people-table-item"
                  data-band={r.band}
                >
                  {rows.length > 1 && (
                    <PickBox
                      checked={picked.has(r.person.id)}
                      onChange={(on) =>
                        setPicked((cur) => {
                          const next = new Set(cur);
                          if (on) next.add(r.person.id);
                          else next.delete(r.person.id);
                          return next;
                        })
                      }
                      label={r.person.displayName}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <PersonRow
                      person={r.person}
                      sub={subLine(r)}
                      aside={
                        warm ? (
                          <Chip tone={warm === 'close' || warm === 'know well' ? 'good' : 'neutral'}>
                            {warm}
                          </Chip>
                        ) : undefined
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-full text-ink-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    aria-label={`${r.person.displayName} is not a match`}
                    title="Not a match"
                    onClick={() => notAMatch(r)}
                  >
                    <X size={13} aria-hidden />
                  </button>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
      {fold.more}
      {limits.length > 0 && <div className="mt-2 text-[12.5px] text-ink-3">{limits.join(' ')}</div>}
      {rows.length > 1 && (
        <SelectionBar
          count={names.length}
          total={fold.shown.length}
          onAll={() => setPicked(new Set(fold.shown.map((r) => r.person.id)))}
          onClear={() => setPicked(new Set())}
          steps={pickedSteps}
          send={send}
        />
      )}
      {!names.length && <NextSteps steps={steps} send={send} />}
    </GlassCard>
  );
}
