/**
 * The tools a student is offered: every tool, less the ones whose feature is off for them (plan 44 §9.4). The model
 * is never shown such a tool and the no-key router never routes to it, so with Roles off there is no chat tool and no
 * card. The registry itself keeps every tool (the counting tests and Approve read it).
 */
import { featureOn } from '../engine/features';

const FEATURE_TOOLS: Record<string, 'roles'> = { find_roles: 'roles' };

export function offeredTools<T>(registry: ReadonlyMap<string, T>, userId: string): ReadonlyMap<string, T> {
  const off = Object.entries(FEATURE_TOOLS).filter(([, f]) => !featureOn(f, userId));
  if (!off.length) return registry;
  const out = new Map(registry);
  for (const [name] of off) out.delete(name);
  return out;
}
