import { Check, Mail, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CriterionForm, ResultRow } from '../../engine/peopleSearch';
import { Avatar, Button, cx, LinkedInMark, PickCircle, Spinner } from '../../ui';
import { Bars, Clip, Table, TableBox, Td, Th, Thumb, Tr } from '../../ui/table';
import { CompanyLogo } from '../CompanyLogo';

const PATH_WORDS = ['No tie yet', 'A light tie', 'A warm tie', 'A strong tie', 'A close tie'];

function PathCell({ row }: { row: ResultRow }) {
  const p = row.path;
  if (!p) return <span className="text-ink-3">No path yet</span>;
  const strength = PATH_WORDS[p.level] ?? PATH_WORDS[0]!;
  const words =
    p.kind === 'direct'
      ? `${strength} with you`
      : p.kind === 'second'
        ? 'A connection of one of your LinkedIn connections'
        : `${p.label} can introduce you. ${strength} with you`;
  return (
    <span className="flex items-center gap-2 min-w-0" data-testid="result-path" data-kind={p.kind}>
      {p.kind === 'intro' && p.personId ? (
        <Avatar name={p.label} id={p.personId} size={22} />
      ) : (
        <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-canvas-2 text-ink-3">
          <Users size={12} />
        </span>
      )}
      {p.kind === 'intro' && p.personId ? (
        <Link to={`/people/${p.personId}`} className="truncate font-medium hover:underline" title={words}>
          {p.label}
        </Link>
      ) : (
        <span className="truncate" title={words}>
          {p.label}
        </span>
      )}
      <Bars level={p.level} label={words} testId="result-path-bars" />
    </span>
  );
}

/**
 * Search results as one sheet: who, their profile, the warm path, title, company, how well they match, and a column
 * for each criterion. Someone the student already has links to their page; someone new has Add.
 */
export function ResultsTable({
  rows,
  criteria,
  unchecked,
  picked,
  onPick,
  onPickAll,
  added,
  adding,
  onAdd,
  finding,
  onFindEmail,
}: {
  rows: ResultRow[];
  criteria: CriterionForm[];
  /** the criteria could not be read against people: their header says so */
  unchecked?: boolean;
  picked: Set<string>;
  onPick: (key: string, on: boolean) => void;
  onPickAll: (on: boolean) => void;
  /** row key → the person they became */
  added: Record<string, string>;
  adding?: string;
  onAdd: (row: ResultRow) => void;
  finding?: string;
  onFindEmail: (row: ResultRow) => void;
}) {
  const canPick = rows.filter((r) => r.recommendationId && !added[r.key]);
  const allOn = canPick.length > 0 && canPick.every((r) => picked.has(r.key));
  const someOn = canPick.some((r) => picked.has(r.key));
  return (
    <TableBox data-testid="find-results">
      <Table>
        <thead>
          <tr>
            <Th className="min-w-[200px]">
              <span className="flex items-center gap-3">
                <PickCircle
                  checked={allOn}
                  mixed={someOn && !allOn}
                  onChange={onPickAll}
                  label="Pick everyone new on this list"
                  size={18}
                  testId="find-pick-all"
                />
                Name
              </span>
            </Th>
            <Th>Profiles</Th>
            <Th className="min-w-[170px]">Paths</Th>
            <Th>Title</Th>
            <Th>Company</Th>
            <Th aria-sort="descending">Match</Th>
            {criteria.map((c) => (
              <Th
                key={c.id}
                wrap
                className="min-w-[150px] max-w-[220px]"
                title={unchecked ? 'Not checked yet: Orbit could not read each person against this.' : c.text}
                data-testid="find-criterion-head"
              >
                {c.text}
                {c.need === 'nice' && <span className="ml-1 font-normal text-ink-3">(nice to have)</span>}
              </Th>
            ))}
            <Th className="w-px">
              <span className="sr-only">Add</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const personId = added[r.key] ?? r.personId;
            const isNew = !!r.recommendationId && !added[r.key];
            return (
              <Tr key={r.key} data-testid="find-result" data-own={r.personId ? 'true' : 'false'}>
                <Td>
                  <span className="flex items-center gap-3 min-w-0">
                    {isNew ? (
                      <PickCircle
                        checked={picked.has(r.key)}
                        onChange={(on) => onPick(r.key, on)}
                        label={`Pick ${r.name}`}
                        size={18}
                        testId="find-pick"
                      />
                    ) : (
                      <span
                        className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center text-ink-3"
                        title={r.personId ? 'Already in your Orbit' : 'Added'}
                      >
                        <Check size={13} />
                      </span>
                    )}
                    <Avatar name={r.name} src={r.photoUrl} id={personId} size={24} />
                    {personId ? (
                      <Link
                        to={`/people/${personId}`}
                        className="truncate font-medium hover:underline max-w-[220px]"
                        title={r.evidence ?? r.name}
                        data-testid="find-name"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      <span
                        className="truncate font-medium max-w-[220px]"
                        title={r.evidence ?? r.name}
                        data-testid="find-name"
                      >
                        {r.name}
                      </span>
                    )}
                  </span>
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5">
                    {r.linkedinUrl ? (
                      <LinkedInMark url={r.linkedinUrl} name={r.name} testId="find-linkedin" />
                    ) : (
                      <span className="w-[18px]" />
                    )}
                    {r.email ? (
                      <a
                        href={`mailto:${r.email}`}
                        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded text-ink-2 hover:bg-canvas-2 hover:text-ink"
                        title={
                          r.emailConfidence === 'guess'
                            ? `${r.email} (a guess, not confirmed)`
                            : r.emailConfidence === 'pattern'
                              ? `${r.email} (the company's usual pattern)`
                              : r.email
                        }
                        aria-label={`Email ${r.name} at ${r.email}`}
                        data-testid="find-email"
                      >
                        <Mail size={14} />
                      </a>
                    ) : r.recommendationId && r.emailStatus === 'not looked up' ? (
                      <button
                        type="button"
                        disabled={finding === r.key}
                        onClick={() => onFindEmail(r)}
                        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded text-ink-3 hover:bg-canvas-2 hover:text-ink disabled:opacity-60"
                        title="Find their email"
                        aria-label={`Find the email of ${r.name}`}
                        data-testid="find-email-lookup"
                      >
                        {finding === r.key ? <Spinner /> : <Mail size={14} />}
                      </button>
                    ) : r.emailStatus === 'not found' ? (
                      <span
                        className="inline-flex h-[22px] w-[22px] items-center justify-center text-line"
                        title="No email found"
                        role="img"
                        aria-label="No email found"
                        data-testid="find-email-none"
                      >
                        <Mail size={14} />
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td>
                  <PathCell row={r} />
                </Td>
                <Td className="text-ink-3">
                  <Clip title={r.title} max={300}>
                    {r.title ?? ''}
                  </Clip>
                </Td>
                <Td>
                  {r.company ? (
                    <span className="flex items-center gap-2 min-w-0">
                      <CompanyLogo name={r.company} size={16} decorative />
                      <Clip title={r.company} max={170}>
                        {r.company}
                      </Clip>
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums" data-testid="find-match">
                  {r.match}%
                </Td>
                {r.checks.map((k) => (
                  <Td key={k.id} data-testid="find-check">
                    <Thumb answer={k.answer} detail={k.evidence} testId="find-thumb" />
                  </Td>
                ))}
                <Td className={cx('w-px', !isNew && !added[r.key] && 'text-right')}>
                  {isNew ? (
                    <Button
                      size="sm"
                      onClick={() => onAdd(r)}
                      disabled={adding === r.key}
                      data-testid="find-add"
                    >
                      {adding === r.key ? <Spinner /> : null} Add
                    </Button>
                  ) : added[r.key] ? (
                    <Link
                      to={`/people/${added[r.key]}`}
                      className="text-[13px] font-medium underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
                      data-testid="find-open"
                    >
                      Added, open
                    </Link>
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableBox>
  );
}
