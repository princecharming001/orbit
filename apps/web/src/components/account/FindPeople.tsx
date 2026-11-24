import { Download, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createBatch } from '../../engine/batch';
import {
  type CriterionForm,
  countFilters,
  extraWords,
  type FilterForm,
  interpretAsk,
  type PeopleSearchResult,
  type ResultRow,
  resultsCsv,
  runPeopleSearch,
  type SearchForm,
} from '../../engine/peopleSearch';
import { addSourced, findEmail } from '../../engine/sourcing';
import { isServerUser } from '../../integrations/orbitApi';
import { useSession } from '../../state/session';
import { readView, useViewState, writeView } from '../../state/viewState';
import { Button, cx, EmptyState, Spinner } from '../../ui';
import { CriteriaDialog } from '../search/CriteriaDialog';
import { FiltersDialog } from '../search/FiltersDialog';
import { ResultsTable } from '../search/ResultsTable';

/**
 * One search in Find people: what was asked, what Orbit read it as, where the work stands and what came back. It is
 * kept outside the component (state/viewState), so it is still there when the student comes back to the tab, by the
 * tab itself or by the back button after opening someone, and a search that was still running goes on meanwhile and
 * lands here.
 */
interface FindSession {
  query: string;
  form?: SearchForm;
  phase: 'idle' | 'reading' | 'searching';
  error?: string;
  result?: PeopleSearchResult;
  picked: Set<string>;
  /** row key -> the person it was added as */
  added: Record<string, string>;
  /** counts the searches started: a slower one that finishes after a newer one began is dropped */
  run: number;
}
const NO_SESSION: FindSession = { query: '', phase: 'idle', picked: new Set(), added: {}, run: 0 };
/** Where Discover's own Find people keeps its search. */
export const findPeopleKey = (userId: string) => `find-people:${userId}`;
const findKey = findPeopleKey;

/** A search that already ran somewhere else (the chat ran it): the sentence and what came back. */
export interface FindSeed {
  query: string;
  result: PeopleSearchResult;
}
const seeded = (seed: FindSeed): FindSession => ({
  ...NO_SESSION,
  query: seed.query,
  form: seed.result.form,
  result: seed.result,
});

/**
 * Show a search in Discover's Find people as it stands somewhere else: the table in a chat card, opened in Discover,
 * is the same search with the same picks, not a new one.
 */
export function carryFindPeople(fromKey: string, userId: string, fallback?: FindSeed): void {
  const from = readView<FindSession>(fromKey) ?? (fallback ? seeded(fallback) : undefined);
  if (from) writeView<FindSession>(findKey(userId), { ...from, phase: 'idle' }, NO_SESSION);
}

/**
 * Discover's "Find people" tab: one sentence says who, Orbit reads it into filters and criteria the student can open
 * and change, searches the student's own network and (with an Orbit account) people outside it, and lists everyone
 * in one table: the warm path to each, how well they match, and an answer for every criterion.
 */
export function FindPeople({
  userId,
  storeKey,
  seed,
  embedded,
}: {
  userId: string;
  /** where this table keeps its search (the chat gives each card its own); Discover's own by default */
  storeKey?: string;
  /** a search that already ran: shown as it is, no second search */
  seed?: FindSeed;
  /** inside a chat card: the sentence was said in the chat, so there is no search box, only the table and its tools */
  embedded?: boolean;
}) {
  const { user } = useSession();
  const key = storeKey ?? findKey(userId);
  const [session] = useViewState<FindSession>(key, () => (seed ? seeded(seed) : NO_SESSION));
  // the work below outlives this component, so it reads and writes the session by its key, never through a closure
  const now = () => readView<FindSession>(key) ?? NO_SESSION;
  const change = (part: Partial<FindSession> | ((s: FindSession) => Partial<FindSession>)) =>
    writeView<FindSession>(
      key,
      (s) => ({ ...s, ...(typeof part === 'function' ? part(s) : part) }),
      NO_SESSION,
    );
  const { query, form, phase, error, result, picked, added } = session;
  const setQuery = (q: string) => change({ query: q });
  const setError = (e: string | undefined) => change({ error: e });
  const setPicked = (next: Set<string> | ((p: Set<string>) => Set<string>)) =>
    change((s) => ({ picked: typeof next === 'function' ? next(s.picked) : next }));
  const [dialog, setDialog] = useState<'filters' | 'criteria'>();
  const [adding, setAdding] = useState<string>();
  const [addingMany, setAddingMany] = useState(false);
  const [finding, setFinding] = useState<string>();
  const busy = phase !== 'idle';
  const who = { id: userId, school: user?.school ?? '' };

  const search = async (next: SearchForm) => {
    const mine = now().run + 1;
    change({ run: mine, phase: 'searching', error: undefined, picked: new Set() });
    try {
      const r = await runPeopleSearch(who, next);
      if (mine !== now().run) return;
      change({ form: r.form, result: r });
    } catch (e) {
      if (mine === now().run)
        change({ error: e instanceof Error ? e.message : 'The search did not finish. Try again.' });
    } finally {
      if (mine === now().run) change({ phase: 'idle' });
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const ask = query.replace(/\s+/g, ' ').trim();
    if (!ask || busy) return;
    const mine = now().run + 1;
    change({ run: mine, phase: 'reading', error: undefined });
    const { form: read } = await interpretAsk(ask);
    if (mine !== now().run) return;
    await search(read);
  };

  const patch = (rowKey: string, part: Partial<ResultRow>) =>
    change((s) =>
      s.result
        ? {
            result: {
              ...s.result,
              rows: s.result.rows.map((x) => (x.key === rowKey ? { ...x, ...part } : x)),
            },
          }
        : {},
    );

  /** Adds people found outside to the student's Orbit; returns row key → the person they became. */
  const add = async (rows: ResultRow[], keepPicked = false): Promise<Record<string, string> | undefined> => {
    const todo = rows.filter((r) => r.recommendationId);
    const ids = todo.map((r) => r.recommendationId!);
    if (!ids.length) return {};
    setError(undefined);
    const r = await addSourced({ id: userId }, ids);
    if (!r.ok) {
      setError(r.message);
      return undefined;
    }
    // the server answers in the order asked
    const made: Record<string, string> = {};
    todo.forEach((row, i) => {
      const p = r.people[i];
      if (p) made[row.key] = p.id;
    });
    change((s) => {
      const nextPicked = new Set(s.picked);
      if (!keepPicked) for (const row of todo) nextPicked.delete(row.key);
      return { added: { ...s.added, ...made }, picked: nextPicked };
    });
    return made;
  };

  const lookUp = async (row: ResultRow) => {
    const who = row.recommendationId
      ? { recommendationId: row.recommendationId }
      : row.personId
        ? { personId: row.personId }
        : undefined;
    if (!who) return;
    setFinding(row.key);
    setError(undefined);
    try {
      const r = await findEmail({ id: userId }, who);
      if (!r.ok) setError(r.message);
      else if (r.value.email)
        patch(row.key, {
          email: r.value.email,
          emailConfidence: r.value.emailConfidence,
          emailStatus: undefined,
        });
      else patch(row.key, { emailStatus: 'not found' });
    } finally {
      setFinding(undefined);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([resultsCsv(result)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'orbit-search.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveFilters = (filters: FilterForm) => {
    setDialog(undefined);
    if (!form) return;
    void search({ ...form, filters });
  };
  const saveCriteria = (criteria: CriterionForm[]) => {
    setDialog(undefined);
    if (!form) return;
    void search({ ...form, criteria });
  };

  const rows = result?.rows ?? [];
  const pickedAll = rows.filter((r) => picked.has(r.key));
  // the picked people not in the student's Orbit yet
  const pickedRows = pickedAll.filter((r) => r.recommendationId && !added[r.key]);
  // the row a range pick starts from: the last one picked or unpicked by a plain click
  const anchor = useRef<string | undefined>(undefined);
  const pick = (key: string, on: boolean, range: boolean) => {
    const from = range && anchor.current ? rows.findIndex((r) => r.key === anchor.current) : -1;
    const to = rows.findIndex((r) => r.key === key);
    setPicked((p) => {
      const next = new Set(p);
      const span =
        from >= 0 && to >= 0 ? rows.slice(Math.min(from, to), Math.max(from, to) + 1) : [rows[to]!];
      for (const r of span) {
        if (!r) continue;
        if (on) next.add(r.key);
        else next.delete(r.key);
      }
      return next;
    });
    anchor.current = key;
  };
  const nav = useNavigate();
  const [writing, setWriting] = useState(false);
  /** Send to many with everyone picked: people found outside are added to the student's Orbit first. */
  const writeToPicked = async () => {
    if (!user || !pickedAll.length) return;
    setWriting(true);
    try {
      const made = (await add(pickedRows, true)) ?? {};
      const ids = pickedAll
        .map((r) => made[r.key] ?? added[r.key] ?? r.personId)
        .filter((x): x is string => !!x);
      if (!ids.length) return;
      const b = await createBatch(user, ids);
      nav(`/send?batch=${b.id}`);
    } finally {
      setWriting(false);
    }
  };
  const nFilters = form ? countFilters(form.filters) : 0;
  const extras = form ? extraWords(form) : [];
  const toolButton =
    'inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-ink-2 hover:bg-canvas-2 hover:text-ink disabled:opacity-50';

  return (
    <div data-testid="find-people">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <form
          onSubmit={submit}
          className={cx(
            'min-w-[260px] flex-1 items-center gap-2 sm:max-w-[640px]',
            embedded ? 'hidden' : 'flex',
          )}
        >
          <label className="relative block min-w-0 flex-1">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Investors at VC firms in London"
              aria-label="Who are you looking for"
              className="h-10 w-full rounded-[10px] border border-line bg-canvas pl-10 pr-3 text-[14.5px] outline-none transition-colors focus:border-ink placeholder:text-[#a59f97]"
              data-testid="find-query"
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !query.trim()} data-testid="find-search">
            {busy ? <Spinner className="border-white/30 border-t-white" /> : null} Search
          </Button>
        </form>
        {form && (
          <div className="flex items-center gap-1" data-testid="find-tools">
            <button
              type="button"
              className={toolButton}
              onClick={() => setDialog('filters')}
              disabled={busy}
              title="Edit filters"
              aria-label={`Edit filters, ${nFilters} set`}
              data-testid="find-filters"
            >
              <SlidersHorizontal size={16} />
              <span className="min-w-5 rounded-full bg-canvas-2 px-1.5 text-center text-[12px] tabular-nums text-ink">
                {nFilters}
              </span>
            </button>
            <button
              type="button"
              className={toolButton}
              onClick={() => setDialog('criteria')}
              disabled={busy}
              title="Edit criteria"
              aria-label={`Edit criteria, ${form.criteria.length} set`}
              data-testid="find-criteria"
            >
              <Sparkles size={16} />
              <span className="min-w-5 rounded-full bg-canvas-2 px-1.5 text-center text-[12px] tabular-nums text-ink">
                {form.criteria.length}
              </span>
            </button>
            {result && (
              <span className="ml-2 text-[14px] text-ink-3" data-testid="find-count" aria-live="polite">
                {rows.length} {rows.length === 1 ? 'match' : 'matches'}
              </span>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {pickedAll.length > 0 && (
            <span className="flex items-center gap-2 text-[13px] text-ink-3" data-testid="find-picked">
              <span className="tabular-nums">{pickedAll.length} picked</span>
              <button
                type="button"
                className="rounded px-1 underline decoration-line underline-offset-4 hover:text-ink"
                onClick={() => {
                  setPicked(new Set());
                  anchor.current = undefined;
                }}
                data-testid="find-pick-clear"
              >
                Clear
              </button>
            </span>
          )}
          {pickedAll.length > 0 && (
            <Button
              size="sm"
              disabled={writing || addingMany}
              onClick={writeToPicked}
              title="Write to everyone picked in Send to many"
              data-testid="find-write-picked"
            >
              {writing ? <Spinner /> : null} Write to {pickedAll.length}
            </Button>
          )}
          {pickedRows.length > 0 && (
            <Button
              size="sm"
              variant="primary"
              disabled={addingMany || writing}
              onClick={async () => {
                setAddingMany(true);
                try {
                  await add(pickedRows);
                } finally {
                  setAddingMany(false);
                }
              }}
              data-testid="find-add-picked"
            >
              {addingMany ? <Spinner className="border-white/30 border-t-white" /> : null} Add{' '}
              {pickedRows.length}
            </Button>
          )}
          {rows.length > 0 && (
            <button
              type="button"
              className={cx(toolButton, 'w-9 justify-center px-0')}
              onClick={download}
              title="Download as a spreadsheet"
              aria-label="Download as a spreadsheet"
              data-testid="find-download"
            >
              <Download size={16} />
            </button>
          )}
        </div>
      </div>

      {busy && (
        <p className="mt-4 text-[13px] text-ink-3" aria-busy="true" data-testid="find-busy">
          {phase === 'reading'
            ? 'Reading what you asked for…'
            : isServerUser(userId) && form?.filters.reach !== 'mine'
              ? 'Searching your network and beyond…'
              : 'Searching your network…'}
        </p>
      )}
      {error ? (
        <p className="mt-3 text-[13px] text-bad" role="alert">
          {error}
        </p>
      ) : null}

      {result && !busy && rows.length === 0 ? (
        <div className="mt-5" data-testid="find-empty">
          <EmptyState
            title="No one found yet"
            body={
              result.notes[0] ??
              (nFilters + (form?.criteria.length ?? 0) > 1
                ? 'Open the filters or the criteria and switch one to nice to have, or remove it.'
                : 'Try fewer words, or a broader role or place.')
            }
          />
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className={cx('mt-4', busy && 'opacity-60')}>
          <ResultsTable
            rows={rows}
            criteria={form?.criteria ?? []}
            unchecked={result?.unchecked}
            picked={picked}
            onPick={pick}
            onPickAll={(on) => {
              setPicked(on ? new Set(rows.map((r) => r.key)) : new Set());
              anchor.current = undefined;
            }}
            added={added}
            adding={adding}
            onAdd={async (row) => {
              setAdding(row.key);
              try {
                await add([row]);
              } finally {
                setAdding(undefined);
              }
            }}
            finding={finding}
            onFindEmail={(row) => void lookUp(row)}
          />
        </div>
      ) : null}
      {result && !busy ? (
        <div className="mt-3 space-y-1 text-[12.5px] text-ink-3" data-testid="find-quiet">
          {rows.length > 0 && (
            <p data-testid="find-split">
              {result.counts.network} you already know
              {isServerUser(userId) && form?.filters.reach !== 'mine' ? `, ${result.counts.outside} new` : ''}
              .
            </p>
          )}
          {result.unchecked && (form?.criteria.length ?? 0) > 0 && (
            <p data-testid="find-unchecked">
              Orbit could not read each person against the criteria just now, so those columns show what is
              not known.
            </p>
          )}
          {extras.length > 0 && <p data-testid="find-extra">Also asked: {extras.join('; ')}.</p>}
          {result.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
          {result.outsideMessage && <p data-testid="find-outside-error">{result.outsideMessage}</p>}
        </div>
      ) : null}

      {form && (
        <>
          <FiltersDialog
            open={dialog === 'filters'}
            filters={form.filters}
            onClose={() => setDialog(undefined)}
            onSave={saveFilters}
            canSearchOutside={isServerUser(userId)}
            userId={userId}
          />
          <CriteriaDialog
            open={dialog === 'criteria'}
            criteria={form.criteria}
            onClose={() => setDialog(undefined)}
            onSave={saveCriteria}
          />
        </>
      )}
    </div>
  );
}
