/**
 * Settings, Integrations: a quiet line under live LinkedIn saying how far filling in profiles has got (engine/enrichment):
 * profiles read, people from mail found on LinkedIn, how many wait for tomorrow's share, and whether web lookups are
 * set up on Orbit's server.
 */
import type { User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { enrichmentStatus } from '../engine/enrichment';
import { relDate } from '../ui';

export function EnrichmentStatusLine({ user }: { user: User }) {
  const s = useLiveQuery(() => enrichmentStatus(user), [user.id]);
  if (!s?.linkedin) return null;
  const parts = [
    `${s.profiles} ${s.profiles === 1 ? 'profile' : 'profiles'} filled in from LinkedIn`,
    s.matched ? `${s.matched} found from your mail and texts` : undefined,
    s.waiting ? `${s.waiting} waiting` : undefined,
  ].filter(Boolean);
  return (
    <div className="text-[12.5px] text-ink-3 space-y-0.5" data-testid="settings-enrichment-status">
      <p>
        {parts.join(' · ')}
        {s.lastRunAt ? ` · last looked ${relDate(s.lastRunAt)}` : ''}
      </p>
      {s.pauseReason && <p data-testid="settings-enrichment-paused">{s.pauseReason}</p>}
      {!s.demo && (
        <p data-testid="settings-enrichment-web">
          Web lookups (bios, personal sites): {s.web === 'on' ? 'on' : 'not set up on Orbit’s server'}
        </p>
      )}
    </div>
  );
}
