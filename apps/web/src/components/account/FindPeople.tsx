import type { GoalKind, SourcedCandidate } from '@orbit/core';
import { GOAL_KINDS } from '@orbit/core';
import { Search } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Dot, EmailLine, NameTag, PeopleShell, PersonLine } from '../../chat/ui/cards/people';
import { activeGoals, GOAL_KIND_LABELS } from '../../engine/goals';
import { addSourced, findEmail, providerNames, searchPeople, tierChip } from '../../engine/sourcing';
import { Button, cx, EmptyState, Input, Spinner } from '../../ui';

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
  const [finding, setFinding] = useState<string>();
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

  const lookUp = async (c: SourcedCandidate) => {
    setFinding(c.id);
    setError(undefined);
    try {
      const r = await findEmail({ id: userId }, c.id);
      if (!r.ok) setError(r.message);
      else
        setResults((rs) =>
          rs?.map((x) =>
            x.id === c.id
              ? r.value.email
                ? {
                    ...x,
                    email: r.value.email,
                    emailConfidence: r.value.emailConfidence,
                    emailStatus: undefined,
                  }
                : { ...x, emailStatus: 'not found' }
              : x,
          ),
        );
    } finally {
      setFinding(undefined);
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
        <div className="mt-5" data-testid="find-results">
          <PeopleShell
            testId="find-results-card"
            title={`${results.length} ${results.length === 1 ? 'person' : 'people'}`}
            sub={(() => {
              const withEmail = results.filter((c) => c.email);
              const verified = withEmail.filter((c) => c.emailConfidence === 'verified').length;
              return withEmail.length
                ? `${withEmail.length} ${withEmail.length === 1 ? 'email' : 'emails'}${verified ? `, ${verified} verified` : ''}`
                : undefined;
            })()}
          >
            <ul className="px-1.5 pb-1.5">
              {results.map((c) => {
                const personId = added[c.id] ?? c.knownPersonId;
                const why = c.evidence?.[0] ?? c.why ?? c.reasons[0];
                const chip = tierChip(c);
                return (
                  <li key={c.id} className="list-none">
                    <PersonLine
                      name={c.name}
                      avatar={{ id: c.id }}
                      linkedinUrl={c.linkedinUrl}
                      tag={
                        chip && (
                          <NameTag tone={(c.tier ?? 9) <= 2 || c.knownPersonId ? 'good' : 'quiet'}>
                            {chip}
                          </NameTag>
                        )
                      }
                      line={
                        <span className="truncate">
                          {[[c.title, c.org].filter(Boolean).join(' at '), c.location]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      }
                      extra={
                        c.email || why || c.emailStatus ? (
                          <>
                            {c.email && (
                              <EmailLine email={c.email} sureness={c.emailConfidence} testId="find-email" />
                            )}
                            {!c.email && c.emailStatus === 'not looked up' && !personId && (
                              <button
                                type="button"
                                data-testid="find-email-lookup"
                                disabled={finding === c.id}
                                onClick={() => void lookUp(c)}
                                className="text-[13px] text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink disabled:opacity-60"
                              >
                                {finding === c.id ? 'Looking up email' : 'Find email'}
                              </button>
                            )}
                            {!c.email && c.emailStatus === 'not found' && (
                              <span className="text-[13px] text-ink-2" data-testid="find-email-none">
                                No email found
                              </span>
                            )}
                            {(c.email || c.emailStatus) && why && <Dot />}
                            {why && (
                              <span className="truncate" data-testid="find-context" title={why}>
                                {why}
                              </span>
                            )}
                          </>
                        ) : undefined
                      }
                      to={personId ? `/people/${personId}` : undefined}
                      href={personId ? undefined : c.url}
                      linkLabel={personId ? `Open ${c.name}` : `The page ${c.name} was found on`}
                      trailing={
                        personId ? (
                          <Link
                            to={`/people/${personId}`}
                            className="text-[13px] font-medium text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
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
                        )
                      }
                      testId="find-result"
                    />
                  </li>
                );
              })}
            </ul>
          </PeopleShell>
        </div>
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
