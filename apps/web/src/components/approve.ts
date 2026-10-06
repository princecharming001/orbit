import type { OutboundMessage, User } from '@orbit/core';
import { approveAndSend, type HandoffVia, UNDO_WINDOW_MS, undoQueued } from '../engine/send';
import type { useToast } from '../ui';

type Toaster = ReturnType<typeof useToast>;

/** Write to the clipboard; true only when the browser confirmed the write. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function handoffToast(via: HandoffVia, copied: boolean, threaded: boolean): string {
  if (via === 'mailto')
    return threaded
      ? 'Opened in your mail app. Reply in the original thread if you can, then mark it as sent.'
      : 'Opened in your mail app. Mark as sent when you have sent it.';
  if (via === 'linkedin_connect')
    return copied
      ? 'Note copied. Click Connect on their profile, add a note and paste it.'
      : 'Their profile is open. Copy the note from the card, then Connect and add it.';
  return copied
    ? 'Copied. Paste it into LinkedIn and send, then mark it as sent.'
    : 'LinkedIn is open. Copy the message from the card and paste it there.';
}

/**
 * Approve from an editor. The LinkedIn copy starts inside the click (browsers drop clipboard access after long async
 * gaps), the hand-off opens only after approval succeeded, and the toast says exactly what happened. Returns the
 * error to show inline in the editor, if any.
 */
export async function runApproval(
  user: User,
  draft: OutboundMessage,
  body: string,
  subject: string | undefined,
  toast: Toaster,
  firstName?: string,
): Promise<string | undefined> {
  const copying = draft.channel === 'linkedin' ? copyText(body) : Promise.resolve(false);
  const r = await approveAndSend(user, draft.id, body, subject);
  const copied = await copying;
  if (!r.ok) return r.error;
  const name = firstName ?? 'them';
  if (r.status === 'handed_off') {
    window.open(r.handoffUrl, '_blank', 'noopener');
    toast.push({ text: handoffToast(r.via, copied, r.threaded), tone: 'good', ttl: 8000 });
  } else if (r.status === 'queued') {
    toast.push({
      text: `Sending to ${name} in ${Math.round(UNDO_WINDOW_MS / 1000)} seconds.`,
      ttl: UNDO_WINDOW_MS - 2000,
      action: {
        label: 'Undo',
        onClick: () => {
          undoQueued(user, draft.id).then((undone) =>
            toast.push({ text: undone ? 'Not sent. The draft is back.' : 'Too late, it already went out.' }),
          );
        },
      },
    });
  } else toast.push({ text: `Sent to ${name}.`, tone: 'good' });
  return undefined;
}
