/**
 * Plan 44 §7: the companies that fit. The same matches grouped by company, each with its best role and score, how
 * many roles fit and the way in; then the student's target companies with nothing open that fits today, each with
 * Watch (Orbit says when a fitting role appears) and Find a way in. A company has no score of its own: its order is
 * its best role's score, then the warmth of the path.
 */
import { normalizeCompany, type RoleMatch, type TargetCompany } from '@orbit/core';
import { Eye, EyeOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { pathOf, type RolePath } from '../../engine/roles';
import { Button, cx } from '../../ui';
import { Clip, Table, TableBox, Td, Th, Tr } from '../../ui/table';
import { CompanyLogo } from '../CompanyLogo';
import { FitCell, PathCell } from './parts';
import { companyHref } from './RolesTable';

export interface CompanyGroup {
  key: string;
  name: string;
  domain?: string;
  best?: RoleMatch;
  fits: number;
  roles: number;
  path: RolePath;
}

/** The matches by company, best role first, then the warmest way in; then targets with nothing open. */
export function companyGroups(
  matches: RoleMatch[],
  paths: Map<string, RolePath> | undefined,
  targets: Pick<TargetCompany, 'nameRaw' | 'status'>[],
  watching: string[],
  minFit: number,
): { open: CompanyGroup[]; none: CompanyGroup[] } {
  const by = new Map<string, CompanyGroup>();
  for (const m of matches) {
    const key = normalizeCompany(m.job.companyName) || m.job.companyName.toLowerCase();
    const g = by.get(key) ?? {
      key,
      name: m.job.companyName,
      domain: m.job.companyDomain,
      fits: 0,
      roles: 0,
      path: pathOf(paths, m.job.companyName),
    };
    g.roles++;
    if ((m.fit?.score ?? 0) >= minFit) g.fits++;
    if (!g.best || (m.fit?.score ?? -1) > (g.best.fit?.score ?? -1)) g.best = m;
    by.set(key, g);
  }
  const open = [...by.values()].sort(
    (a, b) => (b.best?.fit?.score ?? -1) - (a.best?.fit?.score ?? -1) || b.path.level - a.path.level,
  );
  const names = [...targets.filter((t) => t.status !== 'closed').map((t) => t.nameRaw), ...watching];
  const none: CompanyGroup[] = [];
  for (const name of names) {
    const key = normalizeCompany(name) || name.toLowerCase();
    if (by.has(key) || none.some((g) => g.key === key)) continue;
    none.push({ key, name, fits: 0, roles: 0, path: pathOf(paths, name) });
  }
  return { open, none: none.sort((a, b) => b.path.level - a.path.level || a.name.localeCompare(b.name)) };
}

export function CompaniesView({
  open,
  none,
  paths,
  watching,
  onOpen,
  onWatch,
  onWayIn,
  busy,
}: {
  open: CompanyGroup[];
  none: CompanyGroup[];
  paths?: Map<string, RolePath>;
  watching: string[];
  onOpen: (m: RoleMatch) => void;
  onWatch: (name: string, on: boolean) => void;
  /** a role's way in, or the company's alone when nothing is open */
  onWayIn: (company: string, m?: RoleMatch) => void;
  busy?: string;
}) {
  const watched = (name: string) => watching.some((w) => normalizeCompany(w) === normalizeCompany(name));
  const row = (g: CompanyGroup) => (
    <Tr key={g.key} data-testid="roles-company-row" data-open={g.best ? 'true' : 'false'}>
      <Td>
        <Link
          to={companyHref(g.name, paths)}
          className="group/co flex items-center gap-2 min-w-0"
          data-testid="roles-company-name"
        >
          <CompanyLogo name={g.name} domain={g.domain} size={18} decorative />
          <Clip title={g.name} max={180} className="font-medium group-hover/co:underline">
            {g.name}
          </Clip>
        </Link>
      </Td>
      <Td>
        {g.best ? (
          <span className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => onOpen(g.best!)}
              className="truncate text-left hover:underline max-w-[260px]"
              title={g.best.job.title}
              data-testid="roles-company-best"
            >
              {g.best.job.title}
            </button>
            <FitCell match={g.best} />
          </span>
        ) : (
          <span className="text-ink-3" data-testid="roles-company-nothing">
            Nothing open that fits today
          </span>
        )}
      </Td>
      <Td className="tabular-nums text-ink-2" data-testid="roles-company-fits">
        {g.best ? `${g.fits} of ${g.roles}` : ''}
      </Td>
      <Td className="min-w-[170px]">
        <PathCell path={g.path} />
      </Td>
      <Td className="w-px sticky right-0 bg-canvas group-hover/row:bg-canvas-2">
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onWatch(g.name, !watched(g.name))}
            aria-pressed={watched(g.name)}
            className={cx(
              'inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[12.5px] hover:bg-canvas-2',
              watched(g.name) ? 'text-accent font-medium' : 'text-ink-2 hover:text-ink',
            )}
            title={watched(g.name) ? 'Stop watching' : 'Orbit tells you when a role here fits'}
            data-testid="roles-company-watch"
          >
            {watched(g.name) ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
            {watched(g.name) ? 'Watching' : 'Watch'}
          </button>
          <Button
            size="sm"
            onClick={() => onWayIn(g.name, g.best)}
            loading={busy === g.key}
            data-testid="roles-company-way-in"
          >
            Find a way in
          </Button>
        </span>
      </Td>
    </Tr>
  );
  return (
    <TableBox data-testid="roles-companies">
      <Table>
        <thead>
          <tr>
            <Th className="min-w-[180px]">Company</Th>
            <Th>Best role</Th>
            <Th>Roles that fit</Th>
            <Th>Way in</Th>
            <Th className="w-px">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {open.map(row)}
          {none.map(row)}
        </tbody>
      </Table>
    </TableBox>
  );
}
