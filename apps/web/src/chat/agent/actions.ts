import type { ResultEnvelope } from '../types';
import type { ChatStore } from './store';

/** How long an Approve button stays valid when the registry did not say. */
export const CONFIRMATION_TTL_MS = 15 * 60_000;

/**
 * Record one tool execution in `chatActions`, keyed by the tool_use id (or the chip or router run id), with the full
 * envelope the UI renders. A `needs_confirmation` envelope also gets a pending row under its confirmation id when the
 * registry did not store one, so the Approve button always finds what to run.
 */
export async function recordToolAction(
  store: ChatStore,
  a: {
    conversationId: string;
    userId: string;
    toolUseId: string;
    toolName: string;
    input: unknown;
    env: ResultEnvelope;
    messageId?: string;
    now: Date;
  },
): Promise<void> {
  const at = a.now.toISOString();
  await store.putAction({
    id: a.toolUseId,
    conversationId: a.conversationId,
    userId: a.userId,
    messageId: a.messageId,
    toolName: a.toolName,
    input: a.input,
    status: a.env.kind === 'error' ? 'error' : 'done',
    envelope: a.env,
    createdAt: at,
    updatedAt: at,
  });
  if (
    a.env.kind === 'needs_confirmation' &&
    a.env.confirmationId &&
    !(await store.getAction(a.env.confirmationId))
  ) {
    await store.putAction({
      id: a.env.confirmationId,
      conversationId: a.conversationId,
      userId: a.userId,
      messageId: a.messageId,
      toolName: a.toolName,
      input: a.input,
      status: 'pending',
      summary: a.env.summary,
      expiresAt: new Date(a.now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      createdAt: at,
      updatedAt: at,
    });
  }
}
