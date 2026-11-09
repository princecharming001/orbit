/**
 * A network search's result (plan 32 §6.8): who matches, closest first, in bands that never mix (sure, then likely).
 * Each row opens the map on the warm path to that person. Rows can be picked for routes or a draft together, and
 * marked "not a match" (kept, so the next search learns from it).
 */
import type { Person } from '@orbit/core';
import { useEffect, useState } from 'react';
import { isAccountMode as accountMode, callApi } from '../../../integrations/orbitApi';
import { cx } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { routesToEach, writeToEach } from './next';
import type { NextStep } from './parts';
import { BatchTag, Dot, NameTag, PeopleFooter, PeopleShell, PersonLine, splitBatch } from './people';

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
  /** LinkedIn profiles read for this search while the student waited */
  profilesRead?: number;
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

const WARM_WORD: Record<string, string | undefined> = {
  close: 'Close',
  strong: 'Know well',
  warm: 'Warm',
  light: undefined,
  faint: undefined,
};

const FOLD = 8;
type Filter = 'all' | 'strong' | 'likely';

export { splitBatch };

function Row({
  r,
  picking,
  picked,
  onPick,
  onNotAMatch,
}: {
  r: TableRow;
  picking: boolean;
  picked: boolean;
  onPick?: (on: boolean) => void;
  onNotAMatch: () => void;
}) {
  const p = r.person;
  const { text, batch } = splitBatch(
    r.evidence ?? [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at '),
  );
  const warm = WARM_WORD[r.warmth];
  const confirmedByYc = /\(\s*YC lists /i.test(r.evidence ?? '');
  return (
    <PersonLine
      name={p.displayName}
      avatar={{ id: p.id, src: p.photoUrl }}
      linkedinUrl={p.linkedinUrl}
      tag={warm && <NameTag tone="good">{warm}</NameTag>}
      line={
        <>
          {batch && (
            <BatchTag batch={batch} title={confirmedByYc ? "Listed as a founder on YC's page" : undefined} />
          )}
          {text && <span className="truncate">{text}</span>}
          {r.lastTalk && (
            <span className="hidden shrink-0 @md:inline">
              <Dot />
              talked {r.lastTalk}
            </span>
          )}
        </>
      }
      to={`/map?reach=${encodeURIComponent(p.id)}`}
      goLabel="Warm path"
      linkLabel={`Warm path to ${p.displayName}`}
      pick={onPick ? { picking, picked, onPick } : undefined}
      onDismiss={{ label: `${p.displayName} is not a match`, run: onNotAMatch }}
      testId="people-table-item"
      linkTestId="people-table-path"
      data={{ band: r.band }}
    />
  );
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
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState(false);
  // a tab's own rows: the first page lists confirmed matches first, so the likely ones may not be on it at all
  const [byBand, setByBand] = useState<Partial<Record<'strong' | 'likely', TableRow[] | 'gone'>>>({});
  const setId = t?.setId;
  const onPage = t && filter !== 'all' ? t.rows.filter((r) => r.band === filter).length : 0;
  const wanted = t && filter !== 'all' ? t.counts[filter] : 0;
  const need = filter !== 'all' && !byBand[filter] && onPage < wanted;
  useEffect(() => {
    if (!need || !setId) return;
    let live = true;
    void import('../../tools/search')
      .then((m) => m.bandTableRows(setId, filter))
      .catch(() => undefined)
      .then((list) => {
        if (live) setByBand((b) => ({ ...b, [filter]: list ?? 'gone' }));
      });
    return () => {
      live = false;
    };
  }, [need, setId, filter]);
  if (!t) return null;
  const listed = t.rows.filter((r) => !hidden.has(r.person.id) && r.band !== 'unchecked' && r.band !== 'no');
  const bandList = filter === 'all' ? undefined : byBand[filter];
  const rows =
    filter === 'all'
      ? listed
      : Array.isArray(bandList)
        ? bandList.filter((r) => !hidden.has(r.person.id))
        : listed.filter((r) => r.band === filter);
  const shown = open || rows.length <= FOLD + 1 ? rows : rows.slice(0, FOLD);
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
  const total = c.strong + c.likely;
  const names = listed.filter((r) => picked.has(r.person.id)).map((r) => r.person.displayName);
  const pickedSteps = [routesToEach(names), writeToEach(names)].filter((s): s is NextStep => !!s);
  const steps: NextStep[] = [];
  if (t.remaining > 0)
    steps.push({
      label: `Check ${Math.min(40, t.remaining)} more`,
      message: 'Check more people in that search',
    });
  if (listed.length >= 25) steps.push({ label: 'Load more', message: 'Show more of those results' });
  const canPick = listed.length > 1;
  const tabs: { id: Filter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: total },
    { id: 'strong', label: 'Confirmed', n: c.strong },
    { id: 'likely', label: 'Likely', n: c.likely },
  ];
  let lastBand: string | undefined;
  return (
    <PeopleShell
      testId="result-people_table"
      title={total ? `${total} ${total === 1 ? 'match' : 'matches'}` : 'No clear matches'}
      sub={
        t.relaxed
          ? `Nobody matched exactly, so this loosened ${t.relaxed}.`
          : t.judgeUnavailable
            ? 'Checked from headlines only.'
            : undefined
      }
      aside={
        c.strong > 0 &&
        c.likely > 0 && (
          <div className="flex rounded-full bg-canvas-2 p-0.5" role="tablist" aria-label="Show">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={filter === tab.id}
                className={cx(
                  'h-7 rounded-full px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  filter === tab.id
                    ? 'bg-canvas text-ink shadow-[0_1px_2px_rgba(10,10,10,0.08)]'
                    : 'text-ink-3 hover:text-ink',
                )}
                onClick={() => setFilter(tab.id)}
                data-testid={`people-filter-${tab.id}`}
              >
                {tab.label} <span className="tabular-nums text-ink-3">{tab.n}</span>
              </button>
            ))}
          </div>
        )
      }
    >
      {shown.length === 0 ? (
        <div className="px-4 pb-4 text-ink-2" data-testid="people-empty">
          {need
            ? 'Loading…'
            : filter !== 'all' && wanted > 0
              ? `The ${wanted} ${filter === 'likely' ? 'likely' : 'confirmed'} matches are past this page. Ask again to see them.`
              : 'Nobody to show.'}
        </div>
      ) : (
        <ul className="px-1.5 pb-1.5">
          {shown.map((r) => {
            const head = filter === 'all' && r.band !== lastBand && r.band === 'likely' && lastBand;
            lastBand = r.band;
            return (
              <li key={r.person.id} className="list-none">
                {head && (
                  <div
                    className="mx-2.5 mt-2 mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3"
                    role="heading"
                    aria-level={4}
                  >
                    Likely
                    <span className="h-px flex-1 bg-line-2" aria-hidden />
                  </div>
                )}
                <Row
                  r={r}
                  picking={picked.size > 0}
                  picked={picked.has(r.person.id)}
                  onPick={
                    canPick
                      ? (on) =>
                          setPicked((cur) => {
                            const next = new Set(cur);
                            if (on) next.add(r.person.id);
                            else next.delete(r.person.id);
                            return next;
                          })
                      : undefined
                  }
                  onNotAMatch={() => notAMatch(r)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <PeopleFooter
        fold={{ folds: rows.length > FOLD + 1, open, toggle: () => setOpen((v) => !v) }}
        total={rows.length}
        picked={names.length}
        onClear={() => setPicked(new Set())}
        pickedSteps={pickedSteps}
        steps={steps}
        send={send}
      />
    </PeopleShell>
  );
}
