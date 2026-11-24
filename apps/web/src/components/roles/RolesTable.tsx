/**
 * Plan 44 §2.3: the Roles table, the same sheet the student knows from Find people (ui/table, PickCircle, Shift for a
 * range, the action cell riding the right edge). Role, Company, Fit, Path, Where, Posted, then Save, Not for me
 * and Open posting.
 *
 * Narrow (a small window, the chat's side panel, a phone, a chat card): Role, Company and Fit stay; Path folds
 * under the role; Where and Posted open with the row. The page's own box decides (a container query), so the same
 * table fits the side panel; `compact` folds it always.
 *
 * The keyboard works as on the People table: arrows move, Enter opens, S saves, X says not for me.
 */
import { type DismissReason, normalizeCompany, type RoleMatch } from '@orbit/core';
import { Bookmark, BookmarkCheck, ExternalLink, X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { pathOf, postedWords, type RolePath, whereWords } from '../../engine/roles';
import { cx, PickCircle, Spinner } from '../../ui';
import { Clip, Table, TableBox, Td, Th, Tr } from '../../ui/table';
import { CompanyLogo } from '../CompanyLogo';
import { DismissMenu, FitCell, PathCell } from './parts';

/** The company's page when the student has it; else who they know there, on the map (as Find people links it). */
export function companyHref(name: string, paths?: Map<string, RolePath>): string {
  const orgId = paths?.get(normalizeCompany(name))?.orgId;
  return orgId ? `/companies/${orgId}` : `/map?reach=1&company=${encodeURIComponent(name)}`;
}

/** The strongest reason, or the cap that holds the score down, in a few words. */
export function whyWords(m: RoleMatch): { text: string; capped: boolean } {
  const cap = m.fit?.caps[0];
  if (cap) return { text: cap.label, capped: true };
  if (!m.fit && m.roughFit)
    return {
      text: `${Math.round(m.roughFit.skills * 100)}% of its skills by word${m.roughFit.level ? ', at your level' : ''}`,
      capped: false,
    };
  return { text: m.reason ?? m.answers?.reason ?? '', capped: false };
}

export function RolesTable({
  rows,
  paths,
  picked,
  onPick,
  onPickAll,
  active,
  onActive,
  onOpen,
  onSave,
  onDismiss,
  stretch,
  busy,
  compact,
  testId = 'roles-table',
}: {
  rows: RoleMatch[];
  paths?: Map<string, RolePath>;
  picked: Set<string>;
  /** `range`: Shift was held, so every row between the last one picked and this one goes the same way */
  onPick: (id: string, on: boolean, range: boolean) => void;
  onPickAll: (on: boolean) => void;
  /** the row the keyboard is on */
  active?: string;
  onActive: (id: string) => void;
  onOpen: (m: RoleMatch) => void;
  onSave: (m: RoleMatch) => void;
  onDismiss: (m: RoleMatch, reason: DismissReason) => void;
  /** rows shown as stretches (nothing fits 6 or more) */
  stretch?: Set<string>;
  /** the row whose action is being worked on */
  busy?: string;
  /** always fold Why and Path under the role (a chat card) */
  compact?: boolean;
  testId?: string;
}) {
  const [menu, setMenu] = useState<string>();
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const someOn = rows.some((r) => picked.has(r.id));
  // wide columns show from a width up; below it they fold under the role (or open with the row)
  const wide = compact ? 'hidden' : 'hidden @[64rem]:table-cell';
  const mid = compact ? 'hidden' : 'hidden @[76rem]:table-cell';
  const fold = compact ? '' : '@[64rem]:hidden';
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length || (e.target as HTMLElement).closest('input, [role=menu], [role=dialog]')) return;
    const at = Math.max(
      0,
      rows.findIndex((r) => r.id === active),
    );
    const cur = rows.find((r) => r.id === active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? (cur ? 1 : 0) : -1)))];
      if (next) onActive(next.id);
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      onOpen(cur);
    } else if ((e.key === 's' || e.key === 'S') && cur && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onSave(cur);
    } else if ((e.key === 'x' || e.key === 'X') && cur && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onDismiss(cur, 'other');
    }
  };
  return (
    <TableBox
      data-testid={testId}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label="Roles. Arrow keys move, Enter opens, S saves, X says not for me."
      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
    >
      <Table>
        <thead>
          <tr>
            <Th className="min-w-[140px] @[36rem]:min-w-[220px]">
              <span className="flex items-center gap-3">
                <span className="hidden @[36rem]:inline-flex">
                  <PickCircle
                    checked={allOn}
                    mixed={someOn && !allOn}
                    onChange={onPickAll}
                    label="Pick every role on this list"
                    size={18}
                    testId="roles-pick-all"
                  />
                </span>
                Role
              </span>
            </Th>
            <Th>Company</Th>
            <Th aria-sort="descending">Fit</Th>
            <Th className={cx(wide, 'min-w-[170px]')}>Path</Th>
            <Th className={mid}>Where</Th>
            <Th className={mid}>Posted</Th>
            <Th className="w-px hidden @[36rem]:table-cell">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const j = m.job;
            const path = pathOf(paths, j.companyName);
            const where = whereWords(j);
            const saved = m.status === 'saved' || m.status === 'applied' || m.status === 'interviewing';
            const isActive = active === m.id;
            return (
              <Tr
                key={m.id}
                className={cx(isActive && 'bg-canvas-2/70')}
                data-testid="role-row"
                data-id={m.id}
                data-active={isActive || undefined}
                onClick={() => onActive(m.id)}
              >
                <Td wrap className="py-1.5">
                  <span className="flex items-start gap-3 min-w-0">
                    {/* picking a range is for a keyboard and a mouse: not on a phone's width */}
                    <span className="hidden @[36rem]:inline-flex">
                      <PickCircle
                        checked={picked.has(m.id)}
                        onChange={() => {}}
                        onClick={(e) => {
                          e.stopPropagation();
                          onPick(m.id, !picked.has(m.id), e.shiftKey);
                          if (e.shiftKey) window.getSelection()?.removeAllRanges();
                        }}
                        label={`Pick ${j.title} at ${j.companyName}`}
                        size={18}
                        testId="role-pick"
                        className="mt-0.5"
                      />
                    </span>
                    <span className="flex min-w-0 flex-col leading-tight">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onActive(m.id);
                          onOpen(m);
                        }}
                        className="truncate text-left font-medium hover:underline max-w-[150px] @[36rem]:max-w-[300px] focus-visible:outline-none focus-visible:underline"
                        title={j.title}
                        data-testid="role-title"
                      >
                        {j.title}
                      </button>
                      {j.team && (
                        <span
                          className="mt-0.5 truncate text-[12px] text-ink-3 max-w-[150px] @[36rem]:max-w-[300px]"
                          title={j.team}
                        >
                          {j.team}
                        </span>
                      )}
                      {/* narrow: the way in, under the role */}
                      <span className={cx('mt-1 flex flex-col gap-0.5', fold)} data-testid="role-fold">
                        <span className="text-[12px] max-w-[150px] @[36rem]:max-w-[300px]">
                          <PathCell path={path} compact />
                        </span>
                      </span>
                    </span>
                  </span>
                </Td>
                <Td>
                  <Link
                    to={companyHref(j.companyName, paths)}
                    className="group/co flex items-center gap-2 min-w-0"
                    data-testid="role-company"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CompanyLogo name={j.companyName} domain={j.companyDomain} size={16} decorative />
                    <Clip
                      title={j.companyName}
                      max={160}
                      className="group-hover/co:underline max-w-[96px] @[36rem]:max-w-[160px]"
                    >
                      {j.companyName}
                    </Clip>
                  </Link>
                </Td>
                <Td className="tabular-nums">
                  <FitCell match={m} stretch={stretch?.has(m.id)} />
                </Td>
                <Td className={wide}>
                  <PathCell path={path} />
                </Td>
                <Td className={cx(mid, 'text-ink-2')} wrap>
                  <span className="block whitespace-nowrap" title={where.all}>
                    {where.place}
                  </span>
                  {where.term && (
                    <span className="block text-[12px] text-ink-3 whitespace-nowrap">{where.term}</span>
                  )}
                </Td>
                <Td className={cx(mid, 'text-ink-3')}>{postedWords(j)}</Td>
                <Td className="w-px hidden @[36rem]:table-cell sticky right-0 bg-canvas group-hover/row:bg-canvas-2">
                  <span className="relative flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSave(m);
                      }}
                      disabled={busy === m.id}
                      className={cx(
                        'inline-flex h-8 w-8 items-center justify-center rounded-[6px] hover:bg-canvas-2',
                        saved ? 'text-accent' : 'text-ink-3 hover:text-ink',
                      )}
                      title={saved ? 'Saved. Click to unsave' : 'Save'}
                      aria-label={saved ? `Unsave ${j.title}` : `Save ${j.title}`}
                      aria-pressed={saved}
                      data-testid="role-save"
                    >
                      {busy === m.id ? (
                        <Spinner />
                      ) : saved ? (
                        <BookmarkCheck size={16} />
                      ) : (
                        <Bookmark size={16} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(menu === m.id ? undefined : m.id);
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-3 hover:bg-canvas-2 hover:text-ink"
                      title="Not for me"
                      aria-label={`Not for me: ${j.title}`}
                      aria-haspopup="menu"
                      aria-expanded={menu === m.id}
                      data-testid="role-dismiss"
                    >
                      <X size={16} />
                    </button>
                    {j.url ? (
                      <a
                        href={j.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-3 hover:bg-canvas-2 hover:text-ink"
                        title="Open the posting"
                        aria-label={`Open the posting for ${j.title}`}
                        data-testid="role-open-posting"
                      >
                        <ExternalLink size={15} />
                      </a>
                    ) : (
                      <span className="w-8" />
                    )}
                    {menu === m.id && (
                      <DismissMenu
                        className="absolute right-0 top-full mt-1"
                        onClose={() => setMenu(undefined)}
                        onPick={(reason) => {
                          setMenu(undefined);
                          onDismiss(m, reason);
                        }}
                      />
                    )}
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableBox>
  );
}

/** The table while the first roles are read: its outline, rows of grey. */
export function RolesTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="loading-in rounded-[10px] border border-line bg-canvas"
      role="status"
      aria-busy="true"
      aria-label="Loading"
      data-testid="roles-skeleton"
    >
      <div className="h-11 border-b border-line bg-canvas-2/60" />
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex h-11 items-center gap-6 border-b border-line px-3 last:border-b-0"
          style={{ opacity: 1 - (i / rows) * 0.6 }}
        >
          <span className="skeleton block h-3 w-[28%] rounded" />
          <span className="skeleton block h-3 w-[14%] rounded" />
          <span className="skeleton block h-3 w-[8%] rounded" />
          <span className="skeleton block h-3 w-[22%] rounded" />
        </div>
      ))}
    </div>
  );
}
