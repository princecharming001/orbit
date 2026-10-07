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

/**
 * Open a hand-off. A mailto link goes through an anchor click (no blank tab, and it is not a popup); LinkedIn opens in
 * a new tab. Returns false when the browser blocked the tab, so the caller can offer a button that opens it inside a
 * fresh click.
 */
export function openHandoff(url: string): boolean {
  if (url.startsWith('mailto:')) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.click();
    return true;
  }
  // no 'noopener' feature here: with it window.open always returns null and a blocked tab cannot be detected
  const w = window.open(url, '_blank');
  if (!w) return false;
  try {
    w.opener = null;
  } catch {}
  return true;
}

export function handoffToast(via: HandoffVia, copied: boolean, _threaded: boolean): string {
  // the card underneath says what to do next, so the toast only says what just happened
  if (via === 'mailto') return 'Opened in your mail app.';
  if (via === 'linkedin_connect')
    return copied
      ? 'Note copied. Click Connect on their profile, add a note and paste it.'
      : 'Their profile is open. Copy the note from the card, then Connect and add it.';
  return copied
    ? 'Copied. Paste it into LinkedIn and send it.'
    : 'LinkedIn is open. Copy the message from the card and paste it there.';
}

/**
 * Approve from an editor. The LinkedIn copy starts inside the click (browsers drop clipboard access after long async
 * gaps), the hand-off opens only after approval succeeded, and the toast says exactly what happened: "Copied" only
 * when the clipboard write succeeded, and an Open button when the browser blocked the tab. Returns the error to show
 * inline in the editor, if any.
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
    const url = r.handoffUrl;
    if (openHandoff(url))
      toast.push({ text: handoffToast(r.via, copied, r.threaded), tone: 'good', ttl: 8000 });
    else
      toast.push({
        text: copied
          ? 'Copied. Your browser blocked the LinkedIn tab, so open it here.'
          : 'Your browser blocked the LinkedIn tab, so open it here and copy the message from the card.',
        ttl: 15_000,
        action: { label: 'Open LinkedIn', onClick: () => openHandoff(url) },
      });
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
