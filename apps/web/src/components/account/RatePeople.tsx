import type { Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../../db/schema';
import { type Closeness, peopleToRate, rateCloseness } from '../../engine/closeness';
import { Avatar } from '../../ui';
import { ClosenessPicker } from './ClosenessPicker';

/** Ten people to rate 1 to 5 (setup's optional step); each answer is saved at once. */
export function RatePeople({ userId }: { userId: string }) {
  const [people, setPeople] = useState<Person[]>();
  const [error, setError] = useState<string>();
  const labels = useLiveQuery(() => db.tieLabels.where('userId').equals(userId).toArray(), [userId]) ?? [];
  const byPerson = new Map(labels.map((l) => [l.personId, l.closeness]));
  useEffect(() => {
    // chosen once, so a rated person does not jump off the list
    peopleToRate(userId).then(setPeople);
  }, [userId]);
  if (!people) return null;
  if (!people.length)
    return (
      <p className="text-center text-[14px] text-ink-3" data-testid="ob-rate-empty">
        No one to rate yet. Orbit is still reading your email, so you can skip this.
      </p>
    );
  const rate = async (p: Person, c: Closeness) => {
    setError(undefined);
    const r = await rateCloseness({ id: userId }, p.id, c);
    if (!r.ok) setError(r.message);
  };
  return (
    <div>
      <ul className="space-y-2" data-testid="ob-rate-list">
        {people.map((p) => (
          <li
            key={p.id}
            className="rounded-xl border border-[#e6e8ec] bg-white px-3.5 py-3"
            data-testid="ob-rate-person"
          >
            <div className="flex items-center gap-3 mb-2">
              <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={28} />
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink truncate">{p.displayName}</div>
                <div className="text-[12.5px] text-ink-3 truncate">
                  {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ')}
                </div>
              </div>
            </div>
            <ClosenessPicker name={p.displayName} value={byPerson.get(p.id)} onPick={(c) => rate(p, c)} />
          </li>
        ))}
      </ul>
      {error && (
        <p className="mt-3 text-[13px] text-bad text-center" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
