import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db } from '../db/schema';
import { type CompanyReach, reachCompany } from '../engine/graph';
import { useSession } from '../state/session';
import { Avatar, Card, Chip, PageHeader, Spinner } from '../ui';
import { StrengthDots } from './Pipeline';

export function CompanyPage() {
  const { id } = useParams();
  const { userId } = useSession();
  const org = useLiveQuery(() => (id ? db.organizations.get(id) : undefined), [id]);
  const tc = useLiveQuery(
    () =>
      userId && id
        ? db.targetCompanies
            .where('userId')
            .equals(userId)
            .filter((t) => t.organizationId === id)
            .first()
        : undefined,
    [userId, id],
  );
  const [reach, setReach] = useState<CompanyReach>();
  useEffect(() => {
    if (userId && org) reachCompany(userId, org.name).then(setReach);
  }, [userId, org?.id]);
  if (!org) return null;
  return (
    <div>
      <PageHeader
        title={org.name}
        subtitle={[org.industry, org.sizeBucket ? `${org.sizeBucket} people` : undefined, org.domains[0]]
          .filter(Boolean)
          .join(' · ')}
        actions={tc ? <Chip tone="accent">Target · {tc.status}</Chip> : undefined}
      />
      {!reach ? (
        <Spinner />
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          <Section
            title="People there now"
            items={reach.direct.map((d) => ({
              person: d.person,
              strength: d.strength,
              alum: !!d.person.isAlumni,
            }))}
          />
          <Section
            title="Former employees you know"
            items={reach.former.map((d) => ({
              person: d.person,
              strength: d.strength,
              note: d.endedAt ? `left ${d.endedAt.slice(0, 4)}` : 'former',
            }))}
          />
          <Card>
            <div className="font-medium mb-2">Two-hop routes</div>
            {reach.twoHop.length === 0 && (
              <p className="text-ink-3 text-[13px]">No indirect routes found yet.</p>
            )}
            <ul className="space-y-2 text-[13px]">
              {reach.twoHop.map((t) => (
                <li key={t.target.id}>
                  <Link to={`/map?reach=${t.target.id}`} className="font-medium hover:underline">
                    {t.target.displayName}
                  </Link>
                  <div className="text-ink-3">
                    {t.path.hops.map((h) => h.text).join(' → ')} · {t.path.band.replace('_', ' ')}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  items,
}: {
  title: string;
  items: {
    person: { id: string; displayName: string; currentTitle?: string; photoUrl?: string };
    strength: number;
    note?: string;
    /** went to the student's school: a badge on the row, not a second list */
    alum?: boolean;
  }[];
}) {
  return (
    <Card>
      <div className="font-medium mb-2">
        {title} <span className="text-ink-3 font-normal text-[12px]">{items.length}</span>
      </div>
      {items.length === 0 && <p className="text-ink-3 text-[13px]">None yet.</p>}
      <ul className="space-y-2">
        {items.slice(0, 12).map((i) => (
          <li key={i.person.id} className="flex items-center gap-2 text-[13.5px]">
            <Avatar name={i.person.displayName} src={i.person.photoUrl} id={i.person.id} size={26} />
            <Link to={`/people/${i.person.id}`} className="font-medium hover:underline">
              {i.person.displayName}
            </Link>
            {i.alum && <Chip>Alum</Chip>}
            <span className="text-ink-3 truncate">
              {i.person.currentTitle}
              {i.note ? ` · ${i.note}` : ''}
            </span>
            <span className="ml-auto">
              <StrengthDots v={i.strength} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
