/**
 * The plan for the job the student pasted while setting up (plan 23 §4.1, `goals.currentJob`): built once LinkedIn
 * (or the connections file) is in, and shown on the first home screen after that, as the first thing they see. Kept
 * until they draft it or say Not now.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../db/schema';
import { useFlag } from '../engine/flags';
import { planFromInput } from '../engine/targetPlan';
import { useSession } from '../state/session';
import { Button } from '../ui';
import { TargetPlanCard } from './TargetPlanCard';

type Kept = { job: string; planId?: string; message?: string; dismissed?: boolean };
const keyOf = (userId: string) => `currentJob:plan:${userId}`;

export function CurrentJobPlan({ networkIn }: { networkIn: boolean }) {
  const { user, goals } = useSession();
  const on = useFlag('targetPlan');
  const job = goals?.currentJob;
  const jobKey = job ? job.url?.trim() || job.text?.trim() || '' : '';
  const kept = useLiveQuery(
    async () => (user ? (((await db.kv.get(keyOf(user.id)))?.value as Kept | undefined) ?? null) : null),
    [user?.id],
  );
  const [building, setBuilding] = useState(false);
  useEffect(() => {
    // undefined: still reading what was kept
    if (!on || !user || !jobKey || !networkIn || building || kept === undefined) return;
    if (kept && kept.job === jobKey) return;
    setBuilding(true);
    void planFromInput(user, jobKey)
      .then((r) =>
        db.kv.put({
          key: keyOf(user.id),
          value: (r.ok
            ? { job: jobKey, planId: r.plan.id }
            : { job: jobKey, message: r.message }) satisfies Kept,
        }),
      )
      .catch(() => undefined)
      .finally(() => setBuilding(false));
  }, [on, user?.id, jobKey, networkIn, kept?.job]);
  const plan = useLiveQuery(
    () => (kept?.planId ? db.targetPlans.get(kept.planId) : undefined),
    [kept?.planId],
  );
  if (!on || !user || !plan || kept?.dismissed || kept?.job !== jobKey) return null;
  // once every step is drafted or started, the plan has done its job here
  if (plan.steps.length && plan.steps.every((s) => s.status !== 'proposed')) return null;
  return (
    <div className="mb-5 flex flex-col items-center" data-testid="current-job-plan">
      <TargetPlanCard plan={plan} />
      <Button
        variant="ghost"
        size="sm"
        className="mt-1"
        onClick={() =>
          void db.kv.put({ key: keyOf(user.id), value: { ...kept, dismissed: true } satisfies Kept })
        }
      >
        Not now
      </Button>
    </div>
  );
}
