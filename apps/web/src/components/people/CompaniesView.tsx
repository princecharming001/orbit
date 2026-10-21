import type { ChatStage } from '@orbit/core';
import { normalizeCompany, STAGE_LABELS } from '@orbit/core';
import { Link } from 'react-router-dom';
import { Chip, EmptyState, relDate } from '../../ui';
import { CompanyLogo } from '../CompanyLogo';
import type { ChatRow } from './PipelineBoard';
import { STAGE_COLOR } from './shared';

/** The chats grouped by company: how many people there, which stages, and when anything last happened. */
export function CompaniesView({ rows, targetNames }: { rows: ChatRow[]; targetNames: Set<string> }) {
  const groups = new Map<
    string,
    { name: string; orgId?: string; people: Set<string>; byStage: Map<ChatStage, number>; last?: string }
  >();
  for (const { chat, person } of rows) {
    const key = person.currentOrganizationId ?? person.currentOrganizationRaw ?? 'Independent';
    const g = groups.get(key) ?? {
      name: person.currentOrganizationRaw ?? 'Independent',
      orgId: person.currentOrganizationId,
      people: new Set(),
      byStage: new Map(),
      last: undefined,
    };
    g.people.add(person.id);
    g.byStage.set(chat.stage, (g.byStage.get(chat.stage) ?? 0) + 1);
    if (!g.last || chat.updatedAt > g.last) g.last = chat.updatedAt;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.people.size - a.people.size);
  if (!list.length) return <EmptyState title="No companies yet" />;
  // three columns, with the target mark and the last activity under the company, so it fits a phone without a sideways
  // scroll
  return (
    <div className="border border-line rounded-[var(--radius-card)] overflow-x-auto">
      <table className="w-full text-[13.5px]">
        <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
          <tr>
            {['Company', 'People', 'Stages'].map((h) => (
              <th key={h} className="text-left font-medium px-3 h-9">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {list.map((g) => (
            <tr key={g.name}>
              <td className="px-3 py-2 align-top">
                <span className="flex flex-wrap items-center gap-1.5 font-medium">
                  <CompanyLogo name={g.name} orgId={g.orgId} size={18} decorative />
                  {g.orgId ? (
                    <Link to={`/companies/${g.orgId}`} className="hover:underline">
                      {g.name}
                    </Link>
                  ) : (
                    g.name
                  )}
                  {targetNames.has(normalizeCompany(g.name)) && (
                    <Chip tone="accent" className="h-5">
                      Target
                    </Chip>
                  )}
                </span>
                <span className="block text-[12px] text-ink-3">Last activity {relDate(g.last)}</span>
              </td>
              <td className="px-3 py-2 align-top tabular">{g.people.size}</td>
              <td className="px-3 py-2 align-top">
                <span className="flex flex-wrap gap-1">
                  {[...g.byStage.entries()].map(([st, n]) => (
                    <Chip key={st}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: STAGE_COLOR[st] }} />
                      {STAGE_LABELS[st]} {n}
                    </Chip>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
