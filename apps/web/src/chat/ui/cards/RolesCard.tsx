/**
 * Plan 44 §2.6: roles the chat found, as the Roles table (the same component, folded to fit a card): Role, Company and
 * Fit, with the reason and the way in under each role. Save and Not for me work here; a role opens on Roles in the
 * side panel. Each row reads the kept copy, so saving it on Roles shows here too. No card while Roles is off.
 */
import type { DismissReason, RoleMatch } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RolesTable } from '../../../components/roles/RolesTable';
import { db } from '../../../db/schema';
import { useFeature } from '../../../engine/features';
import { actOnMatch, pathsFor, roleOpened } from '../../../engine/roles';
import { useSession } from '../../../state/session';
import { usePanel } from '../../panel/PanelProvider';
import type { ResultEnvelope } from '../../types';
import { findInternships, wayIntoRole } from './next';
import { NextSteps, OpenInApp } from './parts';
import { readRoles } from './shapes';

export function RolesCard({
  env,
  send,
}: {
  env: ResultEnvelope;
  /** sends a next step as the student's turn */
  send?: (text: string) => Promise<void> | void;
}) {
  const { userId } = useSession();
  const on = useFeature('roles', userId);
  const data = readRoles(env.data);
  const panel = usePanel();
  const nav = useNavigate();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const anchor = useRef<string | undefined>(undefined);
  const ids = data?.matches.map((m) => `${userId}:${m.id}`) ?? [];
  // the kept copy wins: a role saved or hidden since shows as it stands now
  const kept = useLiveQuery(
    async () =>
      new Map((await db.roleMatches.bulkGet(ids)).filter((r) => !!r).map((r) => [r!.match.id, r!.match])),
    [ids.join('|')],
  );
  const companies = data?.matches.map((m) => m.job.companyName) ?? [];
  const paths = useLiveQuery(
    () => (userId ? pathsFor(userId, companies) : undefined),
    [userId, companies.join('|')],
  );
  if (!on || !userId || !data) return null;
  const rows = data.matches.map((m) => kept?.get(m.id) ?? m).filter((m) => m.status !== 'dismissed');
  const open = (m: RoleMatch) => {
    roleOpened(userId, m);
    const href = `/roles?role=${encodeURIComponent(m.id)}`;
    if (panel) panel.open(href, { focus: true });
    else nav(href);
  };
  const act = async (m: RoleMatch, status: RoleMatch['status'], reason?: DismissReason) => {
    setBusy(m.id);
    try {
      await actOnMatch({ id: userId }, m, status, reason);
    } finally {
      setBusy(undefined);
    }
  };
  const pick = (id: string, isOn: boolean, range: boolean) => {
    const from = range && anchor.current ? rows.findIndex((r) => r.id === anchor.current) : -1;
    const to = rows.findIndex((r) => r.id === id);
    setPicked((p) => {
      const next = new Set(p);
      const span =
        from >= 0 && to >= 0 ? rows.slice(Math.min(from, to), Math.max(from, to) + 1) : [rows[to]!];
      for (const r of span) if (r) isOn ? next.add(r.id) : next.delete(r.id);
      return next;
    });
    anchor.current = id;
  };
  return (
    <div className="rounded-[14px] border border-line bg-canvas p-3 @container" data-testid="result-roles">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <span className="min-w-0 truncate text-[13px] text-ink-3" title={data.query}>
          {data.stretch ? `${data.query}: nothing fits 6 or more yet, these are the closest` : data.query}
        </span>
        <OpenInApp href={env.href ?? '/roles'} label="Roles" className="shrink-0 -mr-1.5" />
      </div>
      {rows.length ? (
        <RolesTable
          rows={rows}
          paths={paths}
          picked={picked}
          onPick={pick}
          onPickAll={(isOn) => setPicked(isOn ? new Set(rows.map((r) => r.id)) : new Set())}
          active={active}
          onActive={setActive}
          onOpen={open}
          onSave={(m) => void act(m, m.status === 'new' ? 'saved' : 'new')}
          onDismiss={(m, r) => void act(m, 'dismissed', r)}
          busy={busy}
          compact
          testId="roles-card-table"
        />
      ) : (
        <p className="px-1 py-2 text-[13.5px] text-ink-2">{env.summary}</p>
      )}
      {send && rows[0] && (
        <NextSteps
          steps={[
            wayIntoRole(rows[0].job.title, rows[0].job.companyName),
            ...(rows.some((r) => r.job.level === 'intern') ? [] : [findInternships]),
          ]}
          send={send}
        />
      )}
    </div>
  );
}
