/**
 * Plan 23's pieces each sit behind a flag in db.kv (`flag:targetPlan`, `flag:chatsView`, `flag:activityLine`,
 * `flag:weekReview`, `flag:trustLadder`), read when a page mounts. A flag is on unless its row says false, so one
 * commit that writes false (or a student's own kv row) turns a piece off without reverting its code.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';

export type Flag = 'targetPlan' | 'chatsView' | 'activityLine' | 'weekReview' | 'trustLadder';

/** Flags turned off for everyone, here in the code: the one-commit off switch. */
const OFF: ReadonlySet<Flag> = new Set<Flag>([]);

export async function flagOn(flag: Flag): Promise<boolean> {
  if (OFF.has(flag)) return false;
  const row = await db.kv.get(`flag:${flag}`).catch(() => undefined);
  return row?.value !== false;
}

/** The flag for a component; on while it is being read, so a page never flickers a piece out and back in. */
export function useFlag(flag: Flag): boolean {
  return useLiveQuery(() => flagOn(flag), [flag]) ?? !OFF.has(flag);
}
