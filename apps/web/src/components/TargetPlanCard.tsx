/**
 * The plan (plan 23 §4.1), one card wherever it opens (the Map, the company page, Discover, the chat home): the
 * posting in one line with its link and where the application stands, up to three people each with their role in
 * the plan, the way in as the Map shows it and the day, then Draft all three or Pick who. Nothing is drafted until
 * the student says so, and nothing is sent without their approval.
 */
import { TARGET_STATUS_LABELS, type TargetPlan, type TargetPlanStep } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { db } from '../db/schema';
import { setTargetDeadline, setTargetStatus } from '../engine/settings';
import { draftPlan, postingLine, whenText } from '../engine/targetPlan';
import { useSession } from '../state/session';
import { Avatar, Button, Card, cx, Input, Select, useToast } from '../ui';
import { CompanyLogo } from './CompanyLogo';
import { RouteBadge } from './map/RouteBadge';

const STEP_STATUS: Record<TargetPlanStep['status'], string | undefined> = {
  proposed: undefined,
  drafted: 'drafted, in Drafts',
  held: undefined,
  done: 'started',
};

export function TargetPlanCard({ plan, className }: { plan: TargetPlan; className?: string }) {
  const { user } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const target = useLiveQuery(() => db.targetCompanies.get(plan.targetCompanyId), [plan.targetCompanyId]);
  const people =
    useLiveQuery(
      async () =>
        new Map(
          (
            await db.people.bulkGet([
              ...plan.steps.map((s) => s.personId),
              ...plan.inPipeline.map((p) => p.personId),
            ])
          )
            .filter((p) => !!p)
            .map((p) => [p!.id, p!]),
        ),
      [plan.id, plan.builtAt],
    ) ?? new Map();
  const org = useLiveQuery(
    () => (target?.organizationId ? db.organizations.get(target.organizationId) : undefined),
    [target?.organizationId],
  );
  if (!user) return null;
  const now = new Date();
  const tz = user.timezone;
  const nameOf = (id: string) => people.get(id)?.firstName ?? 'them';
  const p = plan.posting;
  const open = plan.steps.filter((s) => s.status === 'proposed' || s.status === 'held');
  const draftAll = async (which?: string[]) => {
    setBusy(true);
    try {
      const r = await draftPlan(user, plan.id, which);
      toast.push({
        text:
          r.drafted === 0
            ? 'Nothing new to draft.'
            : `Drafted ${r.drafted === 1 ? 'one message' : `${r.drafted} messages`}${r.held ? `; ${r.held === 1 ? 'one waits' : `${r.held} wait`} for a reply first` : ''}. Nothing is sent until you approve it.`,
        tone: 'good',
        ttl: 7000,
      });
      if (r.drafted) nav('/inbox');
    } finally {
      setBusy(false);
      setPicking(false);
    }
  };
  return (
    <Card padded className={cx('max-w-[560px] w-full', className)} data-testid="target-plan">
      <div className="flex items-start gap-3">
        <CompanyLogo name={p.company} orgId={target?.organizationId} size={32} decorative />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[14.5px] leading-snug" data-testid="target-plan-title">
            {postingLine(p) || p.company}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
            {p.url && (
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink"
              >
                The posting <ExternalLink size={11} aria-hidden />
              </a>
            )}
            {target && (
              <label className="inline-flex items-center gap-1">
                <span>Target ·</span>
                <Select
                  value={target.status}
                  onChange={(e) => void setTargetStatus(target.id, e.target.value as never)}
                  className="h-7 text-[12.5px] text-ink-2"
                  aria-label="Where the application stands"
                  data-testid="target-plan-status"
                >
                  {Object.entries(TARGET_STATUS_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l.toLowerCase()}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {target && (
              <label className="inline-flex items-center gap-1">
                <span>Deadline</span>
                <Input
                  type="date"
                  value={target.deadline ?? ''}
                  onChange={(e) => void setTargetDeadline(target.id, e.target.value || undefined)}
                  className="!h-7 !text-[12px] w-[8.5rem]"
                  aria-label="Application deadline"
                />
              </label>
            )}
          </div>
        </div>
      </div>
      {plan.steps.length === 0 && (
        <p className="mt-3 text-[13px] text-ink-2" data-testid="target-plan-empty">
          {plan.cold
            ? `Nobody in your network touches ${p.company} yet. Connect LinkedIn, and Orbit finds who can get you in.`
            : `Everyone Orbit would pick at ${p.company} is already in your pipeline.`}
        </p>
      )}
      <ul className="mt-3 divide-y divide-line-2">
        {plan.steps.map((s) => {
          const person = people.get(s.personId);
          const name = person?.displayName ?? s.found?.name ?? 'Someone';
          const path = s.route.hops?.length
            ? { hops: s.route.hops, score: s.route.score, band: s.route.band ?? 'possible' }
            : undefined;
          return (
            <li
              key={s.personId}
              className="py-2.5 flex items-start gap-3"
              data-testid="target-plan-step"
              data-person-id={s.personId}
            >
              {picking && (
                <input
                  type="checkbox"
                  className="mt-3 w-4 h-4"
                  checked={picked.has(s.personId)}
                  disabled={s.status !== 'proposed' && s.status !== 'held'}
                  onChange={(e) =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(s.personId);
                      else next.delete(s.personId);
                      return next;
                    })
                  }
                  aria-label={`Draft for ${name}`}
                />
              )}
              <Avatar name={name} src={person?.photoUrl ?? s.found?.pictureUrl} id={s.personId} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {person ? (
                    <Link to={`/people/${person.id}`} className="font-medium text-[14px] hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span className="font-medium text-[14px]">{name}</span>
                  )}
                  <RouteBadge path={path} testId="target-plan-badge" />
                </div>
                <div className="text-[12.5px] text-ink-3 truncate">
                  {person?.currentTitle ?? s.found?.headline}
                </div>
                <div className="text-[12.5px] text-ink-2 mt-0.5" data-testid="target-plan-why">
                  {s.roleText} · {s.route.line}
                </div>
              </div>
              <div
                className="shrink-0 text-right text-[12px] text-ink-3 pt-0.5"
                data-testid="target-plan-when"
              >
                {STEP_STATUS[s.status] ?? whenText(s, nameOf, now, tz)}
              </div>
            </li>
          );
        })}
        {plan.inPipeline.map((x) => (
          <li
            key={x.personId}
            className="py-2 flex items-center gap-3 text-[12.5px]"
            data-testid="target-plan-pipeline"
          >
            <Avatar
              name={people.get(x.personId)?.displayName ?? ''}
              src={people.get(x.personId)?.photoUrl}
              id={x.personId}
              size={24}
            />
            <span className="font-medium text-ink-2">{people.get(x.personId)?.displayName}</span>
            <span className="text-ink-3">{x.line}</span>
          </li>
        ))}
      </ul>
      {open.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {picking ? (
            <>
              <Button
                variant="primary"
                disabled={busy || picked.size === 0}
                onClick={() => void draftAll([...picked])}
                data-testid="target-plan-draft-picked"
              >
                Draft {picked.size || ''}
              </Button>
              <Button variant="ghost" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void draftAll()}
                data-testid="target-plan-draft-all"
              >
                {open.length === 3
                  ? 'Draft all three'
                  : open.length === 1
                    ? 'Draft it'
                    : `Draft all ${open.length === 2 ? 'two' : open.length}`}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setPicked(new Set(open.map((s) => s.personId)));
                  setPicking(true);
                }}
                data-testid="target-plan-pick"
              >
                Pick who
              </Button>
            </>
          )}
        </div>
      )}
      {plan.more > 0 && org && (
        <Link
          to={`/companies/${org.id}`}
          className="mt-3 block text-[13px] text-ink-2 underline underline-offset-4 decoration-[#cfcdc9] hover:decoration-ink"
          data-testid="target-plan-more"
        >
          {plan.more} more {plan.more === 1 ? 'person' : 'people'} you can reach at {p.company}
        </Link>
      )}
    </Card>
  );
}
