import { Download, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
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
import { Button, cx, EmptyState, Spinner } from '../../ui';
import { CriteriaDialog } from '../search/CriteriaDialog';
import { FiltersDialog } from '../search/FiltersDialog';
import { ResultsTable } from '../search/ResultsTable';

/**
 * Discover's "Find people" tab: one sentence says who, Orbit reads it into filters and criteria the student can open
 * and change, searches the student's own network and (with an Orbit account) people outside it, and lists everyone
 * in one table: the warm path to each, how well they match, and an answer for every criterion.
 */
export function FindPeople({ userId }: { userId: string }) {
  const { user } = useSession();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<SearchForm>();
  const [phase, setPhase] = useState<'idle' | 'reading' | 'searching'>('idle');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<PeopleSearchResult>();
  const [dialog, setDialog] = useState<'filters' | 'criteria'>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string>();
  const [addingMany, setAddingMany] = useState(false);
  const [finding, setFinding] = useState<string>();
  // a slower search that finishes after a newer one started is dropped
  const run = useRef(0);
  const busy = phase !== 'idle';
  const who = { id: userId, school: user?.school ?? '' };

  const search = async (next: SearchForm) => {
    const mine = ++run.current;
    setPhase('searching');
    setError(undefined);
    setPicked(new Set());
    try {
      const r = await runPeopleSearch(who, next);
      if (mine !== run.current) return;
      setForm(r.form);
      setResult(r);
    } catch (e) {
      if (mine === run.current)
        setError(e instanceof Error ? e.message : 'The search did not finish. Try again.');
    } finally {
      if (mine === run.current) setPhase('idle');
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const ask = query.replace(/\s+/g, ' ').trim();
    if (!ask || busy) return;
    const mine = ++run.current;
    setPhase('reading');
    setError(undefined);
    const { form: read } = await interpretAsk(ask);
    if (mine !== run.current) return;
    await search(read);
  };

  const patch = (rowKey: string, change: Partial<ResultRow>) =>
    setResult((r) =>
      r ? { ...r, rows: r.rows.map((x) => (x.key === rowKey ? { ...x, ...change } : x)) } : r,
    );

  const add = async (rows: ResultRow[]) => {
    const ids = rows.map((r) => r.recommendationId).filter((x): x is string => !!x);
    if (!ids.length) return;
    setError(undefined);
    const r = await addSourced({ id: userId }, ids);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    // the server answers in the order asked
    setAdded((a) => {
      const next = { ...a };
      rows.forEach((row, i) => {
        const p = r.people[i];
        if (p) next[row.key] = p.id;
      });
      return next;
    });
    setPicked((p) => {
      const next = new Set(p);
      for (const row of rows) next.delete(row.key);
      return next;
    });
  };

  const lookUp = async (row: ResultRow) => {
    if (!row.recommendationId) return;
    setFinding(row.key);
    setError(undefined);
    try {
      const r = await findEmail({ id: userId }, row.recommendationId);
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
  const pickedRows = rows.filter((r) => picked.has(r.key) && r.recommendationId && !added[r.key]);
  const nFilters = form ? countFilters(form.filters) : 0;
  const extras = form ? extraWords(form) : [];
  const toolButton =
    'inline-flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-ink-2 hover:bg-canvas-2 hover:text-ink disabled:opacity-50';

  return (
    <div data-testid="find-people">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <form onSubmit={submit} className="flex min-w-[260px] flex-1 items-center gap-2 sm:max-w-[640px]">
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
          {pickedRows.length > 0 && (
            <Button
              size="sm"
              variant="primary"
              disabled={addingMany}
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
            onPick={(key, on) =>
              setPicked((p) => {
                const next = new Set(p);
                if (on) next.add(key);
                else next.delete(key);
                return next;
              })
            }
            onPickAll={(on) =>
              setPicked(
                on
                  ? new Set(rows.filter((r) => r.recommendationId && !added[r.key]).map((r) => r.key))
                  : new Set(),
              )
            }
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
