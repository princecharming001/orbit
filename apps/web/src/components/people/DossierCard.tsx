import type { Dossier, Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import {
  type Claim,
  chooseCandidate,
  dossierView,
  getDossier,
  type ResearchResult,
  researchPerson,
} from '../../engine/research';
import { Button, Card, Spinner } from '../../ui';

const POLL_MS = 5_000;
const POLL_TRIES = 36;

/** A claim with its numbered source links ("[1]"), each opening the page it came from. */
function Cited({ claim, sources }: { claim: Claim; sources: { n: number; url?: string; title?: string }[] }) {
  return (
    <>
      {claim.date ? <span className="text-ink-3">{claim.date}: </span> : null}
      {claim.text}
      {claim.sources.map((n) => {
        const s = sources.find((x) => x.n === n);
        return s?.url ? (
          <a
            key={n}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-0.5 align-super text-[10px] text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
            title={s.title ?? s.url}
            data-testid="dossier-source"
          >
            [{n}]
          </a>
        ) : (
          <span key={n} className="ml-0.5 align-super text-[10px] text-ink-3">
            [{n}]
          </span>
        );
      })}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="text-[11.5px] uppercase tracking-wide text-ink-3 mb-1">{title}</div>
      <div className="text-[13px] text-ink-2 leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * The research card on the person page (plan 16 §5.3), account mode only: who they are, what they do now, recent
 * items, what you have in common, your history, three openers and anything to be careful about, every web claim with
 * its numbered source. "Research" asks the server for it; a name shared by two people asks which one.
 */
export function DossierCard({ person, userId }: { person: Person; userId: string }) {
  const stored = useLiveQuery(
    async () =>
      (await db.dossiers.where('personId').equals(person.id).toArray()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )[0] ?? null,
    [person.id],
  );
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void getDossier({ id: userId }, person.id);
    return () => {
      alive.current = false;
    };
  }, [userId, person.id]);

  /** Wait for a queued dossier: ask again every few seconds until it is ready or a couple of minutes pass. */
  const waitFor = async () => {
    setWaiting(true);
    try {
      for (let i = 0; i < POLL_TRIES && alive.current; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const r = await getDossier({ id: userId }, person.id);
        if (!r.ok || (r.dossier && r.dossier.status !== 'pending')) return;
      }
    } finally {
      if (alive.current) setWaiting(false);
    }
  };
  const after = (r: ResearchResult) => {
    if (!r.ok) setError(r.message);
    else if (r.status === 'queued' || r.status === 'pending') void waitFor();
  };
  const research = async (refresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      after(await researchPerson({ id: userId }, person.id, { refresh }));
    } finally {
      setBusy(false);
    }
  };
  const choose = async (index: number) => {
    setBusy(true);
    setError(undefined);
    try {
      after(await chooseCandidate({ id: userId }, person.id, index));
    } finally {
      setBusy(false);
    }
  };

  const d: Dossier | null | undefined = stored;
  const v = d ? dossierView(d) : undefined;
  const pending = waiting || v?.status === 'pending';
  return (
    <Card data-testid="dossier-card">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">Research</div>
        {v && !pending && v.status !== 'needs_disambiguation' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => research(true)}
            disabled={busy}
            title={`Look ${person.firstName || 'them'} up again`}
            data-testid="dossier-refresh"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Refresh
          </Button>
        ) : null}
      </div>
      {pending ? (
        <p
          className="mt-2 flex items-center gap-2 text-[13px] text-ink-3"
          role="status"
          data-testid="dossier-pending"
        >
          <Spinner /> Researching {person.firstName || 'them'}. This takes about a minute.
        </p>
      ) : !v ? (
        <div className="mt-2">
          <p className="text-[13px] text-ink-3">
            Orbit can look {person.firstName || 'them'} up: what they work on now, what they said recently,
            what you have in common, and a few good openers, each with its source.
          </p>
          <Button
            size="sm"
            variant="primary"
            className="mt-3"
            onClick={() => research(false)}
            disabled={busy}
            data-testid="dossier-research"
          >
            {busy ? <Spinner className="border-white/30 border-t-white" /> : null} Research
          </Button>
        </div>
      ) : v.status === 'needs_disambiguation' ? (
        <div className="mt-2" data-testid="dossier-choices">
          <p className="text-[13px] text-ink-2">
            More than one person matches {person.displayName}. Which one is yours?
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {v.candidates.map((c) => (
              <Button
                key={c.index}
                size="sm"
                variant="secondary"
                className="justify-start whitespace-normal text-left h-auto py-1.5"
                onClick={() => choose(c.index)}
                disabled={busy}
                data-testid="dossier-choice"
              >
                {c.label}
              </Button>
            ))}
          </div>
        </div>
      ) : v.status === 'failed' ? (
        <div className="mt-2">
          <p className="text-[13px] text-ink-3">Research didn't work this time.</p>
          <Button size="sm" className="mt-2" onClick={() => research(true)} disabled={busy}>
            Try again
          </Button>
        </div>
      ) : (
        <div data-testid="dossier-content">
          {v.who ? <p className="mt-2 text-[13.5px] text-ink">{v.who}</p> : null}
          {v.now ? (
            <Section title="Now">
              <Cited claim={v.now} sources={v.sources} />
            </Section>
          ) : null}
          {/* the whole brief (career, highlights, openers, sources) lives on the About tab */}
          <Link
            to={`/people/${person.id}?tab=facts`}
            className="mt-3 inline-flex items-center gap-1 text-[13px] text-accent hover:underline"
            data-testid="dossier-open-about"
          >
            See everything on About <ArrowRight size={13} />
          </Link>
          {v.status === 'partial' ? (
            <p className="mt-3 text-[12px] text-ink-3">
              Some sources could not be reached, so this is partial.
            </p>
          ) : null}
        </div>
      )}
      {error ? (
        <p className="mt-2 text-[12.5px] text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
