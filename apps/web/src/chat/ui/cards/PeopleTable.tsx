/**
 * A network search's result (plan 32 §6.8): who matches, closest first, in bands that never mix (sure, then likely).
 * Each row opens the map on the warm path to that person. Rows can be picked for routes or a draft together, and
 * marked "not a match" (kept, so the next search learns from it).
 */
import type { Person } from '@orbit/core';
import { ArrowRight, Check, ChevronDown, X } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isAccountMode as accountMode, callApi } from '../../../integrations/orbitApi';
import { Avatar, cx, LinkedInMark } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { ChoicesContext } from './Choices';
import { routesToEach, writeToEach } from './next';
import type { NextStep } from './parts';

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

/** "Co-Founder at Turnstone (YC W26)": the words without the batch, and the batch as its own tag. */
export function splitBatch(text: string | undefined): { text?: string; batch?: string } {
  if (!text) return {};
  const m = /\s*\(\s*(?:yc|y combinator)\s+([a-z]{1,6}\s?'?\d{2,4})\s*\)/i.exec(text);
  const yc = /\(\s*YC lists [^)]*\)/i.exec(text);
  let rest = text;
  if (m) rest = rest.replace(m[0], '');
  if (yc) rest = rest.replace(yc[0], '');
  return {
    text: rest.replace(/\s{2,}/g, ' ').trim() || undefined,
    batch: m?.[1]?.toUpperCase().replace(/\s/g, ''),
  };
}

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
    <div
      className="group/row relative flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-canvas-2 focus-within:bg-canvas-2"
      data-testid="people-table-item"
      data-band={r.band}
    >
      {/* the whole row opens the warm path; the controls inside sit above this link */}
      <Link
        to={`/map?reach=${encodeURIComponent(p.id)}`}
        className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={`Warm path to ${p.displayName}`}
        data-testid="people-table-path"
      />
      <div className="relative h-9 w-9 shrink-0">
        <div
          className={cx(
            'transition-opacity',
            onPick && (picking ? 'opacity-0' : 'group-hover/row:opacity-0'),
          )}
        >
          <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={36} />
        </div>
        {onPick && (
          <label
            className={cx(
              'absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded-full transition-opacity',
              picking ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-within:opacity-100',
            )}
          >
            <input
              type="checkbox"
              className="peer sr-only"
              checked={picked}
              onChange={(e) => onPick(e.target.checked)}
              aria-label={`Pick ${p.displayName}`}
              data-testid="pick-person"
            />
            <span
              className={cx(
                'flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40',
                picked ? 'border-ink bg-ink text-canvas' : 'border-[#cfccc6] bg-canvas',
              )}
              aria-hidden
            >
              {picked && <Check size={12} strokeWidth={3} />}
            </span>
          </label>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[14px] font-medium leading-5 text-ink">{p.displayName}</span>
          {p.linkedinUrl && (
            <span className="relative z-10 inline-flex">
              <LinkedInMark url={p.linkedinUrl} name={p.displayName} />
            </span>
          )}
          {warm && (
            <span className="ml-0.5 hidden shrink-0 items-center gap-1 text-[11.5px] font-medium text-good @xs:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
              {warm}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-5 text-ink-3">
          {batch && (
            <span
              className="shrink-0 rounded-[5px] bg-ember-soft px-1.5 text-[11px] font-semibold leading-[18px] text-ember"
              title={confirmedByYc ? "Listed as a founder on YC's page" : undefined}
            >
              YC {batch}
            </span>
          )}
          {text && <span className="truncate">{text}</span>}
          {r.lastTalk && (
            <span className="hidden shrink-0 @md:inline">
              <span aria-hidden className="mx-0.5 text-line">
                ·
              </span>
              talked {r.lastTalk}
            </span>
          )}
        </div>
      </div>
      <span
        className="pointer-events-none hidden shrink-0 items-center gap-1 text-[12px] font-medium text-ink-2 opacity-0 transition-opacity group-hover/row:opacity-100 @lg:inline-flex"
        aria-hidden
      >
        Warm path <ArrowRight size={13} />
      </span>
      <button
        type="button"
        className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 opacity-0 transition-opacity hover:bg-canvas hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover/row:opacity-100"
        aria-label={`${p.displayName} is not a match`}
        title="Not a match"
        onClick={onNotAMatch}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
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
  const { running } = useContext(ChoicesContext);
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
    <div
      className="@container isolate my-2 min-w-0 max-w-full overflow-hidden rounded-2xl border border-line bg-canvas text-[13.5px] leading-[1.45] shadow-[0_1px_2px_rgba(10,10,10,0.04)]"
      data-testid="result-people_table"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-2">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">
            {total ? `${total} ${total === 1 ? 'match' : 'matches'}` : 'No clear matches'}
          </div>
          {(t.relaxed || t.judgeUnavailable) && (
            <div className="mt-0.5 text-[12px] text-ink-3">
              {t.relaxed
                ? `Nobody matched exactly, so this loosened ${t.relaxed}.`
                : 'Checked from headlines only.'}
            </div>
          )}
        </div>
        {c.strong > 0 && c.likely > 0 && (
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
        )}
      </div>
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
      {(rows.length > FOLD + 1 || names.length > 0 || steps.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-2 px-3 py-2">
          {rows.length > FOLD + 1 && (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-canvas-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              data-testid="show-all"
            >
              {open ? 'Show fewer' : `Show all ${rows.length}`}
              <ChevronDown
                size={13}
                aria-hidden
                className={cx('transition-transform', open && 'rotate-180')}
              />
            </button>
          )}
          <span className="flex-1" />
          {names.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Picked people"
              data-testid="selection-bar"
            >
              <span className="px-1 text-[12.5px] text-ink-3" data-testid="selection-count">
                {names.length} picked
              </span>
              <button
                type="button"
                className="h-8 rounded-full px-2.5 text-[12.5px] font-medium text-ink-3 hover:bg-canvas-2 hover:text-ink"
                onClick={() => setPicked(new Set())}
                data-testid="selection-all"
              >
                Clear
              </button>
              {pickedSteps.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3 text-[12.5px] font-medium text-canvas hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50"
                  disabled={running}
                  title={s.message}
                  data-testid="selection-step"
                  onClick={() => void send(s.message)}
                >
                  {s.label}
                  <ArrowRight size={13} aria-hidden />
                </button>
              ))}
            </div>
          ) : (
            steps.map((s) => (
              <button
                key={s.label}
                type="button"
                className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-canvas-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50"
                disabled={running}
                title={s.message}
                data-testid="next-step"
                onClick={() => void send(s.message)}
              >
                {s.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
