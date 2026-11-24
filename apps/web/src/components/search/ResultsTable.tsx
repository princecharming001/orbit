import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CriterionForm, ResultRow } from '../../engine/peopleSearch';
import { Avatar, Button, cx, GmailLogo, LinkedInMark, PickCircle, Spinner } from '../../ui';
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
        : p.kind === 'shared'
          ? (p.note ?? p.label)
          : p.kind === 'intro'
            ? `${p.note ?? `${p.label} can introduce you`}. ${strength} between you and ${p.label.split(' ')[0]}`
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
  /** `range`: Shift was held, so everyone between the last row picked and this one goes the same way */
  onPick: (key: string, on: boolean, range: boolean) => void;
  onPickAll: (on: boolean) => void;
  /** row key → the person they became */
  added: Record<string, string>;
  adding?: string;
  onAdd: (row: ResultRow) => void;
  finding?: string;
  onFindEmail: (row: ResultRow) => void;
}) {
  // every row can be picked, and none is picked until the student picks it
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.key));
  const someOn = rows.some((r) => picked.has(r.key));
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
                  label="Pick everyone on this list"
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
                className="w-[220px] min-w-[180px] max-w-[260px]"
                title={unchecked ? 'Not checked yet: Orbit could not read each person against this.' : c.text}
                data-testid="find-criterion-head"
              >
                {/* two lines at most, the whole of it on hover: a long criterion does not make the header tall */}
                <span className="line-clamp-2">{c.text}</span>
                {c.need === 'nice' && (
                  <span className="block text-[12px] font-normal text-ink-3">Nice to have</span>
                )}
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
                    <PickCircle
                      checked={picked.has(r.key)}
                      // the whole pick is read from the click, where Shift is known (a range pick)
                      onChange={() => {}}
                      onClick={(e) => {
                        onPick(r.key, !picked.has(r.key), e.shiftKey);
                        // Shift-click also extends the page's text selection: not wanted here
                        if (e.shiftKey) window.getSelection()?.removeAllRanges();
                      }}
                      label={`Pick ${r.name}`}
                      size={18}
                      testId="find-pick"
                    />
                    <Avatar name={r.name} src={r.photoUrl} id={personId} size={24} />
                    <span className="flex min-w-0 flex-col py-0.5 leading-tight">
                      {personId ? (
                        <Link
                          to={`/people/${personId}`}
                          className="truncate font-medium hover:underline max-w-[260px]"
                          title={r.evidence ?? r.name}
                          data-testid="find-name"
                        >
                          {r.name}
                        </Link>
                      ) : (
                        <span
                          className="truncate font-medium max-w-[260px]"
                          title={r.evidence ?? r.name}
                          data-testid="find-name"
                        >
                          {r.name}
                        </span>
                      )}
                      {r.headline && (
                        // the line under their name on LinkedIn: who they say they are
                        <span
                          className="mt-0.5 truncate text-[12px] font-normal text-ink-3 max-w-[260px]"
                          title={r.headline}
                          data-testid="find-headline"
                        >
                          {r.headline}
                        </span>
                      )}
                    </span>
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
                        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded hover:bg-canvas-2"
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
                        <GmailLogo />
                      </a>
                    ) : r.recommendationId || r.personId ? (
                      // no address yet: the logo greyed out, and a click looks theirs up
                      <button
                        type="button"
                        disabled={finding === r.key}
                        onClick={() => onFindEmail(r)}
                        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded hover:bg-canvas-2 disabled:cursor-wait [&:hover_svg]:opacity-70"
                        title={
                          r.emailStatus === 'not found'
                            ? 'No email found yet. Click to look again'
                            : 'Find their email'
                        }
                        aria-label={
                          r.emailStatus === 'not found'
                            ? `No email found for ${r.name} yet. Look again`
                            : `Find the email of ${r.name}`
                        }
                        data-testid={r.emailStatus === 'not found' ? 'find-email-none' : 'find-email-lookup'}
                      >
                        {finding === r.key ? <Spinner /> : <GmailLogo muted />}
                      </button>
                    ) : (
                      <span
                        className="inline-flex h-[22px] w-[22px] items-center justify-center"
                        title="No email yet"
                        role="img"
                        aria-label="No email yet"
                      >
                        <GmailLogo muted />
                      </span>
                    )}
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
                    // the company's page when the student has it; else who they know there, on the map
                    <Link
                      to={
                        r.companyId
                          ? `/companies/${r.companyId}`
                          : `/map?reach=1&company=${encodeURIComponent(r.company)}`
                      }
                      className="group/co flex items-center gap-2 min-w-0"
                      data-testid="find-company"
                    >
                      <CompanyLogo name={r.company} size={16} decorative />
                      <Clip title={r.company} max={170} className="group-hover/co:underline">
                        {r.company}
                      </Clip>
                    </Link>
                  ) : null}
                </Td>
                <Td className="tabular-nums" data-testid="find-match">
                  {r.match}%
                </Td>
                {r.checks.map((k) => (
                  <Td key={k.id} data-testid="find-check">
                    <span className="flex items-center gap-2 min-w-0">
                      <Thumb answer={k.answer} detail={k.evidence} testId="find-thumb" />
                      {/* the words the answer rests on, so a thumb is never taken on trust */}
                      {k.evidence && (k.answer === 'yes' || k.answer === 'likely') ? (
                        <Clip title={k.evidence} max={200} className="text-[12.5px] text-ink-3">
                          {k.evidence.replace(/^"|"$/g, '')}
                        </Clip>
                      ) : null}
                    </span>
                  </Td>
                ))}
                {/* a row with Add (or the link it becomes) keeps it in reach however many columns the search has: the
                    cell rides the right edge. A row with neither has nothing to keep, and covers nothing. */}
                <Td
                  className={cx(
                    'w-px',
                    isNew || added[r.key]
                      ? 'sticky right-0 bg-canvas group-hover/row:bg-canvas-2'
                      : 'text-right',
                  )}
                >
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
