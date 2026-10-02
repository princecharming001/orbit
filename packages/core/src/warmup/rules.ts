import type { WarmUpAction, WarmUpPlan } from '../types';

/**
 * LinkedIn warm-up: before a cold LinkedIn message, spend a few days being visible to the person
 * (view profile, react to a recent post, leave one thoughtful comment). Done by the student by hand via deep links;
 * Orbit schedules, reminds, tracks, and only then suggests the outreach. No automation touches LinkedIn.
 */
export function linkedinActivityUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}/recent-activity/all/`;
}
export function linkedinProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}/`;
}
export function linkedinMessageUrl(slug: string): string {
  return `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(slug)}`;
}

export function buildWarmUpPlan(slug: string, startedAt: Date, warmUpDays = 4): WarmUpPlan {
  const day = (n: number, h = 10) => {
    const d = new Date(startedAt);
    d.setDate(d.getDate() + n);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const actions: WarmUpAction[] = [
    {
      id: 'w1',
      kind: 'view_profile',
      label: 'View their profile and follow them',
      url: linkedinProfileUrl(slug),
      dueAt: day(0),
    },
    {
      id: 'w2',
      kind: 'react_post',
      label: 'React to one recent post that you genuinely find useful',
      url: linkedinActivityUrl(slug),
      dueAt: day(Math.max(1, Math.floor(warmUpDays / 2))),
    },
    {
      id: 'w3',
      kind: 'comment_post',
      label: 'Leave one specific, non-flattering comment (a question or an added point)',
      url: linkedinActivityUrl(slug),
      dueAt: day(Math.max(2, warmUpDays - 1)),
    },
  ];
  return { startedAt: startedAt.toISOString(), readyAt: day(warmUpDays, 9), actions };
}

export function warmUpProgress(
  plan: WarmUpPlan,
  now: Date,
): { done: number; total: number; ready: boolean; nextAction?: WarmUpAction; overdue: boolean } {
  const done = plan.actions.filter((a) => a.doneAt).length;
  const skipped = plan.actions.filter((a) => a.skippedAt).length;
  const next = plan.actions.find((a) => !a.doneAt && !a.skippedAt);
  const ready =
    now.getTime() >= new Date(plan.readyAt).getTime() && done >= 1
      ? true
      : done + skipped === plan.actions.length;
  const overdue = !!next && new Date(next.dueAt).getTime() < now.getTime() - 86_400_000;
  return { done, total: plan.actions.length, ready, nextAction: next, overdue };
}
