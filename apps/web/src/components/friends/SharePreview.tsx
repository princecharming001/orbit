/**
 * "See exactly what Ana sees" (plan 29 §A1): the student's own projection, row for row, as a friend's Map would show
 * it. Name, title, company, school, alum, a closeness word. Never an address, a note or a score: there is none to show.
 */
import type { FriendShare, FriendShareMode } from '@orbit/core';
import { CLOSENESS_WORDS, SHARE_MODE_LABELS } from '../../engine/friends';
import { Avatar, Chip, LinkedInMark } from '../../ui';

export function SharePreview({
  mode,
  shares,
  total,
  friendFirst,
}: {
  mode: FriendShareMode;
  shares: FriendShare[];
  total: number;
  friendFirst?: string;
}) {
  const who = friendFirst ?? 'A friend';
  return (
    <div className="space-y-2" data-testid="share-preview">
      <p className="text-[13px] text-ink-2">
        {mode === 'none'
          ? `${who} sees nothing yet.`
          : `${who} sees these ${total} ${total === 1 ? 'person' : 'people'} (${SHARE_MODE_LABELS[mode].toLowerCase()}): the name, title, company and school, whether they are your alum, and how well you know them in a word. Nothing else.`}
      </p>
      {shares.length > 0 && (
        <ul className="divide-y divide-line-2 max-h-[60vh] overflow-y-auto">
          {shares.map((s) => (
            <li
              key={s.personId}
              className="py-2 flex items-center gap-2.5 text-[13px]"
              data-testid="share-preview-row"
            >
              <Avatar name={s.displayName} id={s.personId} size={26} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.displayName}</span>
                <span className="text-ink-3">
                  {s.title ? ` · ${s.title}` : ''}
                  {s.company ? ` · ${s.company}` : ''}
                  {s.school ? ` · ${s.school}` : ''}
                </span>
                {s.linkedinSlug && (
                  <LinkedInMark url={`https://www.linkedin.com/in/${s.linkedinSlug}`} name={s.displayName} />
                )}
              </span>
              {s.isAlumni && <Chip>Alum</Chip>}
              <Chip tone={s.closeness === 3 ? 'good' : s.closeness === 2 ? 'accent' : 'neutral'}>
                {CLOSENESS_WORDS[s.closeness]}
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
