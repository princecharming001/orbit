/**
 * The second half of an intro ask (plan 23 §4.3): the note the introducer can forward, its own text under a divider,
 * with Copy for the note alone and a line saying the student's part is saved for every ask. Edits here change this
 * ask's note; Settings changes the student's lines for every ask after.
 */
import type { OutboundMessage } from '@orbit/core';
import { useEffect, useState } from 'react';
import { db } from '../db/schema';
import { checkIntroNote } from '../engine/introNote';
import { useSession } from '../state/session';
import { Button, Textarea, useToast } from '../ui';
import { copyText } from './approve';

export function ForwardNote({ draft, introducer }: { draft: OutboundMessage; introducer: string }) {
  const { user } = useSession();
  const toast = useToast();
  const [text, setText] = useState(draft.forwardNote ?? '');
  useEffect(() => setText(draft.forwardNote ?? ''), [draft.id]);
  if (draft.forwardNote === undefined || !user) return null;
  const problems = checkIntroNote(text, user);
  return (
    <div className="mt-3 pt-3 border-t border-dashed border-line" data-testid="forward-note">
      <div className="flex items-center gap-2 mb-1">
        <span className="label-mono">The note {introducer} can forward</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto pointer-coarse:min-h-11"
          onClick={async () =>
            toast.push({ text: (await copyText(text)) ? 'Copied the note.' : 'Select the note and copy it.' })
          }
          data-testid="forward-note-copy"
        >
          Copy
        </Button>
      </div>
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          void db.outbound.update(draft.id, { forwardNote: e.target.value });
        }}
        rows={3}
        className="resize-y !text-[13px]"
        aria-label={`The note ${introducer} can forward`}
        data-testid="forward-note-text"
      />
      {problems.length > 0 && (
        <p className="text-[12px] text-warn mt-1" data-testid="forward-note-problem">
          {problems[0]}
        </p>
      )}
    </div>
  );
}
