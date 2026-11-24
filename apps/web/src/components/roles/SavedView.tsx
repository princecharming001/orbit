/**
 * Plan 44 §2.1: Saved. What the student kept, with where it stands (saved, applied, interviewing). A role the company
 * took down stays here, marked "No longer listed". A saved role at a company that is already one of the student's
 * targets says so and links to that target's plan: the two lists stay separate (a target is one company with one
 * role; several roles at one company can be saved).
 */
import { type MatchStatus, normalizeCompany, type RoleMatch, type TargetCompany } from '@orbit/core';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RolePath } from '../../engine/roles';
import { Chip, Select } from '../../ui';
import { Clip, Table, TableBox, Td, Th, Tr } from '../../ui/table';
import { CompanyLogo } from '../CompanyLogo';
import { FitCell, STATUS_WORDS } from './parts';
import { companyHref } from './RolesTable';

export function SavedView({
  rows,
  paths,
  targets,
  onOpen,
  onStatus,
}: {
  rows: RoleMatch[];
  paths?: Map<string, RolePath>;
  targets: Pick<TargetCompany, 'nameRaw' | 'organizationId' | 'role'>[];
  onOpen: (m: RoleMatch) => void;
  onStatus: (m: RoleMatch, s: MatchStatus) => void;
}) {
  const targetOf = (company: string) =>
    targets.find((t) => normalizeCompany(t.nameRaw) === normalizeCompany(company));
  return (
    <TableBox data-testid="roles-saved">
      <Table>
        <thead>
          <tr>
            <Th className="min-w-[220px]">Role</Th>
            <Th>Company</Th>
            <Th>Fit</Th>
            <Th>Where it stands</Th>
            <Th>Target</Th>
            <Th className="w-px">
              <span className="sr-only">Posting</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const j = m.job;
            const closed = !!j.closedAt || m.state === 'gone';
            const t = targetOf(j.companyName);
            return (
              <Tr key={m.id} data-testid="roles-saved-row" data-closed={closed || undefined}>
                <Td>
                  <span className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpen(m)}
                      className="truncate text-left font-medium hover:underline max-w-[280px]"
                      title={j.title}
                    >
                      {j.title}
                    </button>
                    {closed && (
                      <Chip tone="neutral" data-testid="roles-saved-closed">
                        No longer listed
                      </Chip>
                    )}
                  </span>
                </Td>
                <Td>
                  <Link
                    to={companyHref(j.companyName, paths)}
                    className="group/co flex items-center gap-2 min-w-0"
                  >
                    <CompanyLogo name={j.companyName} domain={j.companyDomain} size={16} decorative />
                    <Clip title={j.companyName} max={160} className="group-hover/co:underline">
                      {j.companyName}
                    </Clip>
                  </Link>
                </Td>
                <Td className="tabular-nums">
                  <FitCell match={m} />
                </Td>
                <Td>
                  <Select
                    value={m.status}
                    onChange={(e) => onStatus(m, e.target.value as MatchStatus)}
                    aria-label={`Where ${j.title} stands`}
                    className="h-8 text-[12.5px]"
                    data-testid="roles-saved-status"
                  >
                    {(['saved', 'applied', 'interviewing'] as const).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_WORDS[s]}
                      </option>
                    ))}
                    <option value="new">Not saved</option>
                  </Select>
                </Td>
                <Td className="text-ink-2" data-testid="roles-saved-target">
                  {t?.organizationId ? (
                    <Link
                      to={`/companies/${t.organizationId}`}
                      className="underline decoration-line underline-offset-4 hover:decoration-ink"
                      title={t.role ? `A target, for ${t.role}` : 'One of your targets'}
                    >
                      A target, see the plan
                    </Link>
                  ) : t ? (
                    'A target'
                  ) : (
                    <span className="text-ink-3">Not a target</span>
                  )}
                </Td>
                <Td className="w-px">
                  {j.url && !closed ? (
                    <a
                      href={j.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-3 hover:bg-canvas-2 hover:text-ink"
                      title="Open the posting"
                      aria-label={`Open the posting for ${j.title}`}
                    >
                      <ExternalLink size={15} />
                    </a>
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
