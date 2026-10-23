/**
 * Person page: who the student knows who also knows this person, from live LinkedIn (Unipile), or for the sample
 * student from the demo's own people. Open when there are some; a collapsed line when there are none or LinkedIn is
 * not connected live. Looked up once per person per visit to the app.
 */
import type { Person, User } from '@orbit/core';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { type MutualsResult, mutualsFor } from '../engine/linkedinLive';
import { useShowReasoning } from '../state/showReasoning';
import { Avatar, Card, LinkedInMark } from '../ui';

const SHOWN = 6;

const cache = new Map<string, MutualsResult>();

/** tests only */
export function resetMutualsCache(): void {
  cache.clear();
}

export function MutualConnections({ user, person }: { user: User; person: Person }) {
  const reasons = useShowReasoning();
  const key = `${user.id}:${person.id}`;
  const [result, setResult] = useState<MutualsResult | undefined>(() => cache.get(key));
  const [all, setAll] = useState(false);
  // the photos Orbit keeps for the mutuals it knows, for when LinkedIn sent none
  const [photos, setPhotos] = useState<Map<string, string>>(new Map());
  const knownIds = useMemo(
    () => (result?.mutuals ?? []).map((m) => m.personId).filter((id): id is string => !!id),
    [result],
  );
  useEffect(() => {
    if (!knownIds.length) return;
    let live = true;
    void db.people.bulkGet(knownIds).then((ps) => {
      if (!live) return;
      setPhotos(new Map(ps.filter((p) => p?.photoUrl).map((p) => [p!.id, p!.photoUrl!])));
    });
    return () => {
      live = false;
    };
  }, [knownIds]);
  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setResult(hit);
      return;
    }
    setResult(undefined);
    setAll(false);
    const ctrl = new AbortController();
    let live = true;
    mutualsFor(user, person, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok && r.reason === 'error') return;
        cache.set(key, r);
        if (live) setResult(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [key, user, person]);
  if (!result) return null;
  const mutuals = result.mutuals;
  if (!mutuals.length)
    return (
      <Card>
        <details data-testid="person-mutuals">
          <summary className="cursor-pointer font-medium">Mutual connections</summary>
          <p className="mt-2 text-[13px] text-ink-3" data-testid="person-mutuals-none">
            {result.ok ? `No mutual connections with ${person.firstName} on LinkedIn.` : result.message}
          </p>
        </details>
      </Card>
    );
  return (
    <Card>
      <div data-testid="person-mutuals">
        <div className="font-medium mb-2">
          Mutual connections <span className="text-ink-3 font-normal">· {mutuals.length}</span>
        </div>
        <ul className="space-y-2">
          {(all ? mutuals : mutuals.slice(0, SHOWN)).map((m) => (
            <li
              key={`${m.name}:${m.memberId ?? ''}`}
              className="flex items-center gap-2.5 text-[13px] min-w-0"
            >
              <Avatar
                name={m.name}
                src={m.pictureUrl ?? (m.personId ? photos.get(m.personId) : undefined)}
                id={m.personId ?? m.name}
                size={30}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  {m.personId ? (
                    <Link
                      to={`/people/${m.personId}`}
                      className="font-medium hover:underline truncate"
                      data-testid="person-mutual"
                    >
                      {m.name}
                    </Link>
                  ) : (
                    <span className="font-medium truncate" data-testid="person-mutual">
                      {m.name}
                    </span>
                  )}
                  {m.url && /linkedin\.com/i.test(m.url) && (
                    <LinkedInMark url={m.url} name={m.name} testId="person-mutual-linkedin" />
                  )}
                </div>
                {m.headline && <div className="text-[12px] text-ink-3 truncate">{m.headline}</div>}
              </div>
            </li>
          ))}
        </ul>
        {mutuals.length > SHOWN && (
          <button
            type="button"
            className="mt-2 text-[12px] font-medium text-ink-2 hover:text-ink underline-offset-2 hover:underline"
            onClick={() => setAll((v) => !v)}
            data-testid="person-mutuals-more"
          >
            {all ? 'Show fewer' : `Show all ${mutuals.length}`}
          </button>
        )}
        {reasons && (
          <p className="mt-2 text-[12px] text-ink-3">
            {result.ok && result.source === 'demo'
              ? 'Sample connections from the demo.'
              : 'From your LinkedIn.'}{' '}
            Ask one of them to put in a word.
          </p>
        )}
      </div>
    </Card>
  );
}
