/**
 * Person page: who the student knows who also knows this person, from live LinkedIn (Unipile), or for the sample
 * student from the demo's own people. Open when there are some; a collapsed line when there are none or LinkedIn is
 * not connected live. Looked up once per person per visit to the app.
 */
import type { Person, User } from '@orbit/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type MutualsResult, mutualsFor } from '../engine/linkedinLive';
import { Avatar, Card } from '../ui';

const cache = new Map<string, MutualsResult>();

/** tests only */
export function resetMutualsCache(): void {
  cache.clear();
}

export function MutualConnections({ user, person }: { user: User; person: Person }) {
  const key = `${user.id}:${person.id}`;
  const [result, setResult] = useState<MutualsResult | undefined>(() => cache.get(key));
  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setResult(hit);
      return;
    }
    setResult(undefined);
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
        <ul className="space-y-1.5">
          {mutuals.slice(0, 6).map((m) => (
            <li key={`${m.name}:${m.memberId ?? ''}`} className="flex items-center gap-2 text-[13px] min-w-0">
              <Avatar name={m.name} id={m.personId ?? m.name} size={22} />
              <div className="min-w-0">
                {m.personId ? (
                  <Link
                    to={`/people/${m.personId}`}
                    className="font-medium hover:underline"
                    data-testid="person-mutual"
                  >
                    {m.name}
                  </Link>
                ) : (
                  <span className="font-medium" data-testid="person-mutual">
                    {m.name}
                  </span>
                )}
                {m.headline && <div className="text-[12px] text-ink-3 truncate">{m.headline}</div>}
              </div>
            </li>
          ))}
        </ul>
        {mutuals.length > 6 && (
          <p className="mt-1.5 text-[12px] text-ink-3">And {mutuals.length - 6} more.</p>
        )}
        <p className="mt-2 text-[12px] text-ink-3">
          {result.ok && result.source === 'demo'
            ? 'Sample connections from the demo.'
            : 'From your LinkedIn.'}{' '}
          Ask one of them to put in a word.
        </p>
      </div>
    </Card>
  );
}
