import type { ChipSpec, ToolSpec } from '../types';

/**
 * Suggestion chips above the composer. Each one runs a tool directly through `execute()` with fixed arguments: no
 * parsing, no model call, the same in both modes, so the first click costs nothing.
 */
export const CHIPS: ChipSpec[] = [
  { id: 'brief', label: "Today's brief", tool: 'get_today_brief', input: {}, asUser: 'What is on today?' },
  {
    id: 'drafts',
    label: 'Unsent drafts',
    tool: 'list_drafts',
    input: { status: 'draft' },
    asUser: 'Show my unsent drafts.',
  },
  {
    id: 'quiet',
    label: 'Who went quiet?',
    tool: 'list_pipeline',
    input: { stage: 'no_response' },
    asUser: 'Who went quiet?',
  },
  { id: 'pipeline', label: 'My pipeline', tool: 'list_pipeline', input: {}, asUser: 'Show my pipeline.' },
];

/** The chips whose tool exists in this registry and accepts the chip's input. */
export function chipsFor(registry: ReadonlyMap<string, ToolSpec>): ChipSpec[] {
  return CHIPS.filter((c) => {
    const spec = registry.get(c.tool);
    return !!spec && spec.input.safeParse(c.input).success;
  });
}
