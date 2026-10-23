import type { Person, PersonSource } from '@orbit/core';
import { Link } from 'react-router-dom';
import { mergeEvidence } from '../engine/people';
import { Avatar, cx, LinkedInMark } from '../ui';

/** Where a record came from, in the student's words, so two records with one name can be told apart. */
const FROM: Partial<Record<PersonSource, string>> = {
  gmail: 'your email',
  calendar: 'your calendar',
  linkedin_csv: 'your LinkedIn connections',
  linkedin_profile: 'LinkedIn',
  linkedin_search: 'a LinkedIn search',
  manual: 'added by you',
  note: 'a note',
  imessage: 'your texts',
  tracker_import: 'your tracker',
  recommendation: 'Discover',
  enrichment: 'a lookup',
};

function sentenceList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * A person's name that opens where the student can see who they are: their LinkedIn profile in a new tab when Orbit
 * has it, else their page in Orbit.
 */
export function PersonNameLink({
  person,
  className,
  onNavigate,
  testId,
}: {
  person: Pick<Person, 'id' | 'displayName' | 'linkedinUrl'>;
  className?: string;
  /** called before an in-app link navigates (a sheet closes itself) */
  onNavigate?: () => void;
  testId?: string;
}) {
  const cls = cx('hover:underline underline-offset-2', className);
  if (person.linkedinUrl)
    return (
      <a
        href={person.linkedinUrl}
        target="_blank"
        rel="noreferrer noopener"
        className={cls}
        title={`${person.displayName} on LinkedIn`}
        data-testid={testId}
      >
        {person.displayName}
      </a>
    );
  return (
    <Link to={`/people/${person.id}`} onClick={onNavigate} className={cls} data-testid={testId}>
      {person.displayName}
    </Link>
  );
}

/** One of the two records: photo, the name as a link, what they do, their email, and where Orbit found them. */
function Record({ p, onNavigate }: { p: Person; onNavigate?: () => void }) {
  const role = [p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') || p.headline;
  const from = [...new Set(p.sources.map((s) => FROM[s]).filter(Boolean))];
  const details = [role, p.primaryEmailAsWritten ?? p.primaryEmail, p.location].filter(Boolean);
  return (
    <li className="flex items-start gap-2.5 min-w-0" data-testid="merge-record">
      <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <PersonNameLink
            person={p}
            onNavigate={onNavigate}
            className="font-medium truncate"
            testId="merge-record-name"
          />
          {p.linkedinUrl && <LinkedInMark url={p.linkedinUrl} name={p.displayName} />}
          <Link
            to={`/people/${p.id}`}
            onClick={onNavigate}
            className="ml-auto shrink-0 text-[12px] text-ink-3 hover:text-ink hover:underline"
            data-testid="merge-record-open"
          >
            Open in Orbit
          </Link>
        </div>
        {details.length > 0 && (
          <div className="text-[12.5px] text-ink-2 truncate" title={details.join(' · ')}>
            {details.join(' · ')}
          </div>
        )}
        <div className="text-[12px] text-ink-3 truncate">
          {from.length ? `From ${sentenceList(from as string[])}` : 'Nothing else on file'}
          {p.linkedinUrl ? '' : ' · no LinkedIn profile yet'}
        </div>
      </div>
    </li>
  );
}

/** Two records that may be one person, each with a link to see who it is, and what they share or not. */
export function MergePair({ a, b, onNavigate }: { a: Person; b: Person; onNavigate?: () => void }) {
  const ev = mergeEvidence(a, b);
  return (
    <div className="text-[13px]" data-testid="merge-pair">
      <ul className="rounded-[12px] bg-canvas-2 px-3 py-2.5 space-y-2.5">
        <Record p={a} onNavigate={onNavigate} />
        <Record p={b} onNavigate={onNavigate} />
      </ul>
      <p className="text-ink-3 text-[12px] mt-1.5" data-testid="merge-evidence">
        {ev.same.length ? `Both have ${sentenceList(ev.same)}.` : 'Their names look alike.'}
        {ev.differ.length ? ` But they have ${sentenceList(ev.differ)}.` : ''}
      </p>
    </div>
  );
}
