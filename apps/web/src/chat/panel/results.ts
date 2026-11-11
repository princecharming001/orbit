/**
 * A card button's result shown in the side panel (plan 42): the button runs its tool in place, its envelope is kept
 * here under the button's action id, and the panel opens "/result/<id>" to draw it as the same card the chat would,
 * with every button on it working. Nothing is added to the thread.
 *
 * The cache holds what this tab ran; a reload reads the same envelope from the action row the run recorded
 * (db.chatActions), so a panel address keeps working after a refresh.
 */
import { db } from '../../db/schema';
import type { ResultEnvelope } from '../types';

export interface PanelResult {
  toolName: string;
  envelope: ResultEnvelope;
  /** the panel's title: what the button did ("Draft to Zain", "Routes to 3 people") */
  title?: string;
}

const RESULT_PATH = '/result/';
const cache = new Map<string, PanelResult>();

/** The panel address of a result. */
export const resultHref = (id: string) => `${RESULT_PATH}${encodeURIComponent(id)}`;

/** The action id a result address names, or undefined for any other address. */
export function resultIdOf(path: string): string | undefined {
  if (!path.startsWith(RESULT_PATH)) return undefined;
  try {
    return decodeURIComponent(path.slice(RESULT_PATH.length)) || undefined;
  } catch {
    return undefined;
  }
}

export function rememberPanelResult(id: string, result: PanelResult): void {
  cache.set(id, result);
}

/** What this tab ran, at once (no lookup). */
export function panelResultNow(id: string): PanelResult | undefined {
  return cache.get(id);
}

/** What a result address shows: this tab's run, else the action row it recorded. */
export async function loadPanelResult(id: string): Promise<PanelResult | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const row = await db.chatActions.get(id);
  if (!row?.envelope) return null;
  return { toolName: row.toolName, envelope: row.envelope, title: row.origin?.label };
}

export function resetPanelResultsForTests(): void {
  cache.clear();
}
