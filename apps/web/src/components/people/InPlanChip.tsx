import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import { plansFor } from '../../engine/targetPlan';
import { Chip } from '../../ui';

/** "In your plan for Stripe" on someone's page (plan 23 §4.1): the plan they are part of, one tap away. */
export function InPlanChip({ userId, personId }: { userId: string; personId: string }) {
  const plans = useLiveQuery(() => plansFor(userId, personId), [userId, personId]);
  const plan = plans?.[0];
  const target = useLiveQuery(
    () => (plan ? db.targetCompanies.get(plan.targetCompanyId) : undefined),
    [plan?.targetCompanyId],
  );
  if (!plan) return null;
  const to = target?.organizationId ? `/companies/${target.organizationId}` : '/map';
  return (
    <Link to={to} data-testid="person-in-plan">
      <Chip tone="accent">In your plan for {plan.posting.company}</Chip>
    </Link>
  );
}
