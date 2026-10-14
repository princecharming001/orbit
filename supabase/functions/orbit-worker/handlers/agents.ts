/** The P4–P5 job kinds, bound to the provider keys and fakes in `config`. */
import type { AgentConfig } from '../../_shared/services.ts';
import type { JobHandler } from '../worker.ts';
import { cadenceUser } from './cadence.ts';
import { enrichDossier } from './enrich.ts';
import { sendDraftHandler } from './send.ts';
import { sourceSearch } from './source.ts';

export function agentHandlers(config: AgentConfig = { env: {} }): Record<string, JobHandler> {
  return {
    'enrich.dossier': enrichDossier(config),
    'source.search': sourceSearch(config),
    'send.draft': sendDraftHandler(config),
    'cadence.user': cadenceUser(config),
  };
}
