import type { GoalKind, SourcedCandidate } from '@orbit/core';
import { GOAL_KINDS } from '@orbit/core';
import { Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { activeGoals, GOAL_KIND_LABELS } from '../../engine/goals';
import { addSourced, providerNames, searchPeople } from '../../engine/sourcing';
import { Avatar, Button, Chip, cx, EmptyState, Input, Spinner } from '../../ui';

const PLACEHOLDER: Record<GoalKind, string> = {
  recruiting: 'Product managers at fintech startups',
  advice: 'Alumni who moved from banking to tech',
  fundraising: 'Seed investors in climate software',
  sales: 'Heads of operations at dental clinics',
  hiring: 'Backend engineers in New York',
  cofounder: 'Engineers interested in health care',
  community: 'Founders in Ithaca',
  collaboration: 'Researchers working on graph neural networks',
};

/**
 * Discover's "Find people" tab (plan 16 §6, account mode): pick what it is for, describe who, and Orbit searches
 * LinkedIn, Apollo, the web and Semantic Scholar on its server. Each result says why it ranks there; someone you
 * already know says so; Add puts them in your pipeline.
 */
export function FindPeople({ userId }: { userId: string }) {
  const [purpose, setPurpose] = useState<GoalKind>('recruiting');
  const [goalId, setGoalId] = useState<string>();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<SourcedCandidate[]>();
  const [quiet, setQuiet] = useState<{ unconfigured: string[]; relaxed: string[] }>({
    unconfigured: [],
    relaxed: [],
  });
  const [added, setAdded] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string>();
  useEffect(() => {
    // start from the student's first active goal
    activeGoals(userId).then((gs) => {
      if (gs[0]) {
        setPurpose(gs[0].kind);
        setGoalId(gs[0].id);
      }
    });
  }, [userId]);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await searchPeople({ id: userId }, { purpose, query, goalId });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setResults(r.value.results);
      setQuiet({ unconfigured: r.value.unconfigured ?? [], relaxed: r.value.relaxed ?? [] });
    } finally {
      setBusy(false);
    }
  };
  const add = async (c: SourcedCandidate) => {
    setAdding(c.id);
    setError(undefined);
    try {
      const r = await addSourced({ id: userId }, [c.id]);
      if (!r.ok) setError(r.message);
      else if (r.people[0]) setAdded((a) => ({ ...a, [c.id]: r.people[0]!.id }));
    } finally {
      setAdding(undefined);
    }
  };

  return (
    <div data-testid="find-people">
      <form onSubmit={search} className="space-y-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="What it is for">
          {GOAL_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={purpose === k}
              onClick={() => {
                setPurpose(k);
                setGoalId(undefined);
              }}
              className={cx(
                'h-8 px-3 rounded-full text-[13px] transition-colors',
                purpose === k ? 'bg-ink text-white' : 'bg-canvas-2 text-ink-2 hover:text-ink',
              )}
              data-testid={`find-purpose-${k}`}
            >
              {GOAL_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={PLACEHOLDER[purpose]}
            aria-label="Who are you looking for"
            className="flex-1 min-w-0"
            data-testid="find-query"
          />
          <Button type="submit" variant="primary" disabled={busy} data-testid="find-search">
            {busy ? <Spinner className="border-white/30 border-t-white" /> : <Search size={14} />} Search
          </Button>
        </div>
      </form>
      {error ? (
        <p className="mt-3 text-[13px] text-bad" role="alert">
          {error}
        </p>
      ) : null}
      {results && results.length === 0 ? (
        <div className="mt-5">
          <EmptyState title="No one found yet" body="Try fewer words, or a broader role or place." />
        </div>
      ) : null}
      {results && results.length > 0 ? (
        <ul
          className="mt-5 border border-line rounded-[var(--radius-card)] divide-y divide-line"
          data-testid="find-results"
        >
          {results.map((c) => {
            const personId = added[c.id] ?? c.knownPersonId;
            return (
              <li key={c.id} className="p-3 flex items-start gap-3" data-testid="find-result">
                <Avatar name={c.name} id={c.id} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.knownPersonId ? <Chip tone="good">You know them</Chip> : null}
                  </div>
                  <div className="text-[12.5px] text-ink-3">
                    {[c.title, c.org, c.location].filter(Boolean).join(' · ')}
                  </div>
                  {c.reasons.length ? (
                    <ul className="mt-1 text-[12.5px] text-ink-2 space-y-0.5" data-testid="find-reasons">
                      {c.reasons.slice(0, 3).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="shrink-0">
                  {personId ? (
                    <Link
                      to={`/people/${personId}`}
                      className="text-[13px] font-medium text-accent hover:underline"
                    >
                      {added[c.id] ? 'Added, open' : 'Open'}
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => add(c)}
                      disabled={adding === c.id}
                      data-testid="find-add"
                    >
                      {adding === c.id ? <Spinner /> : null} Add
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {results && (quiet.relaxed.length > 0 || quiet.unconfigured.length > 0) ? (
        <p className="mt-3 text-[12px] text-ink-3" data-testid="find-quiet">
          {quiet.relaxed.length ? `To find more, Orbit left out: ${quiet.relaxed.join(', ')}. ` : ''}
          {quiet.unconfigured.length ? `Not searched yet: ${providerNames(quiet.unconfigured)}.` : ''}
        </p>
      ) : null}
    </div>
  );
}
