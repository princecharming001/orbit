import type { ChatStage, Person } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, normalizeCompany, STAGE_LABELS } from '@orbit/core';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Chip, cx, EmptyState, relDate } from '../../ui';
import { CompanyLogo, NoCompanyIcon } from '../CompanyLogo';
import type { ChatRow } from './PipelineBoard';
import { STAGE_COLOR } from './shared';

const STAGE_ORDER: ChatStage[] = [...ACTIVE_STAGES, ...CLOSED_STAGES];
const NO_COMPANY = 'No company';

interface Group {
  key: string;
  name: string;
  orgId?: string;
  rows: ChatRow[];
  byStage: Map<ChatStage, number>;
  last?: string;
}

/**
 * The chats grouped by company: who is there, how far each chat has got (one bar, a segment per stage), and when
 * anything last happened. A row opens to the people themselves.
 */
export function CompaniesView({ rows, targetNames }: { rows: ChatRow[]; targetNames: Set<string> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const { chat, person } = row;
    const key = person.currentOrganizationId ?? person.currentOrganizationRaw ?? NO_COMPANY;
    const g: Group = groups.get(key) ?? {
      key,
      name: person.currentOrganizationRaw ?? NO_COMPANY,
      orgId: person.currentOrganizationId,
      rows: [],
      byStage: new Map(),
      last: undefined,
    };
    g.rows.push(row);
    g.byStage.set(chat.stage, (g.byStage.get(chat.stage) ?? 0) + 1);
    if (!g.last || chat.updatedAt > g.last) g.last = chat.updatedAt;
    groups.set(key, g);
  }
  // the most people first; the people with no company last
  const list = [...groups.values()].sort(
    (a, b) =>
      Number(a.key === NO_COMPANY) - Number(b.key === NO_COMPANY) ||
      b.rows.length - a.rows.length ||
      (b.last ?? '').localeCompare(a.last ?? ''),
  );
  if (!list.length) return <EmptyState title="No companies yet" />;
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ul
      className="border border-line rounded-[var(--radius-card)] divide-y divide-line bg-canvas"
      data-testid="companies-view"
    >
      {list.map((g) => {
        const expanded = open.has(g.key);
        const stages = STAGE_ORDER.filter((st) => g.byStage.has(st));
        const target = g.key !== NO_COMPANY && targetNames.has(normalizeCompany(g.name));
        return (
          <li key={g.key} data-testid="company-row">
            <button
              type="button"
              onClick={() => toggle(g.key)}
              aria-expanded={expanded}
              className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-canvas-2/60 transition-colors"
            >
              <ChevronRight
                size={14}
                aria-hidden
                className={cx('shrink-0 text-ink-3 transition-transform', expanded && 'rotate-90')}
              />
              {g.key === NO_COMPANY ? (
                <NoCompanyIcon size={22} />
              ) : (
                <CompanyLogo name={g.name} orgId={g.orgId} size={22} decorative />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className={cx('font-medium truncate', g.key === NO_COMPANY && 'text-ink-2')}>
                    {g.name}
                  </span>
                  {target && (
                    <Chip tone="accent" className="h-5" data-testid="company-target">
                      Target
                    </Chip>
                  )}
                </span>
                <span className="block text-[12px] text-ink-3">
                  {g.rows.length} {g.rows.length === 1 ? 'person' : 'people'} · last activity{' '}
                  {relDate(g.last)}
                </span>
              </span>
              {/* how far the chats here have got: one segment per stage, sized by how many */}
              <span className="hidden @2xl:flex w-56 shrink-0 flex-col gap-1.5" aria-hidden>
                <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-canvas-2">
                  {stages.map((st) => (
                    <span
                      key={st}
                      style={{ flexGrow: g.byStage.get(st), background: STAGE_COLOR[st] }}
                      title={`${STAGE_LABELS[st]}: ${g.byStage.get(st)}`}
                    />
                  ))}
                </span>
                <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-3">
                  {stages.map((st) => (
                    <span key={st} className="inline-flex items-center gap-1 whitespace-nowrap">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: STAGE_COLOR[st] }} />
                      {STAGE_LABELS[st]}
                      {g.byStage.get(st)! > 1 && <span className="tabular">{g.byStage.get(st)}</span>}
                    </span>
                  ))}
                </span>
              </span>
            </button>
            {expanded && (
              <ul className="pb-2 pl-[52px] pr-4" data-testid="company-people">
                {g.rows
                  .slice()
                  .sort((a, b) => STAGE_ORDER.indexOf(b.chat.stage) - STAGE_ORDER.indexOf(a.chat.stage))
                  .map(({ chat, person }) => (
                    <PersonLine key={chat.id} person={person} stage={chat.stage} />
                  ))}
                {g.orgId && (
                  <li className="pt-1">
                    <Link
                      to={`/companies/${g.orgId}`}
                      className="text-[12px] text-ink-3 hover:text-ink underline"
                    >
                      Open {g.name}
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PersonLine({ person, stage }: { person: Person; stage: ChatStage }) {
  return (
    <li className="flex items-center gap-2.5 py-1.5 min-w-0">
      <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={26} />
      <span className="min-w-0 flex-1">
        <Link
          to={`/people/${person.id}`}
          className="block text-[13.5px] font-medium truncate hover:underline"
        >
          {person.displayName}
        </Link>
        {(person.currentTitle || person.headline) && (
          <span className="block text-[12px] text-ink-3 truncate">
            {person.currentTitle ?? person.headline}
          </span>
        )}
      </span>
      <span className="shrink-0 inline-flex items-center gap-1.5 text-[12px] text-ink-2">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: STAGE_COLOR[stage] }} />
        {STAGE_LABELS[stage]}
      </span>
    </li>
  );
}
