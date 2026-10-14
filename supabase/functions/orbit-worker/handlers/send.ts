/**
 * send.draft (§8.5, §9.3, §16.3): sends one approved draft whose time has come. The claim is one conditional update,
 * so a duplicate message or a concurrent approve sends nothing twice; a provider 429/5xx throws so the queue backs
 * off and retries.
 */

import { sendDraft } from '../../_shared/sending/send.ts';
import { type AgentConfig, makeServices } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';

export function sendDraftHandler(config: AgentConfig): JobHandler {
  return async (job, ctx) => {
    const draftId = job.payload.draftId;
    if (typeof draftId !== 'string' || !/^[0-9a-f-]{36}$/i.test(draftId))
      throw new Error('send.draft needs a draftId');
    const s = makeServices(config, { db: ctx.db, now: ctx.now, queue: ctx.queue });
    await sendDraft(s, draftId);
  };
}
