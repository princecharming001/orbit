import type { User } from '@orbit/core';
import { makeWrap } from '../../integrations/anthropic';
import type { ToolContext } from '../types';

/** A Tuesday afternoon: the demo's showcase chat happened this morning and the next one is tomorrow. */
export const NOW = new Date('2026-10-06T14:00:00');

let seq = 0;

/** A tool context the way the UI or the loop would build it; every field can be overridden. */
export function makeCtx(user: User, over: Partial<ToolContext> = {}): ToolContext {
  const nonce = 'testnonce01';
  return {
    user,
    now: NOW,
    conversationId: 'conv_test',
    nonce,
    wrap: makeWrap(nonce).wrap,
    caller: 'ui',
    toolUseId: `toolu_${++seq}`,
    ...over,
  };
}

export function nextToolUseId(): string {
  return `toolu_${++seq}`;
}
