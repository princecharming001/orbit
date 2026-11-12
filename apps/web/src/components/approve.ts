import type { OutboundMessage, User } from '@orbit/core';
import { approveAndSend, type HandoffVia, UNDO_WINDOW_MS, undoQueued, withNote } from '../engine/send';
import type { useToast } from '../ui';

type Toaster = ReturnType<typeof useToast>;

/**
 * The next time a message the limits held back can go: the recipient's next working hours after the wait ends, or
 * from tomorrow when the day's limit is used up.
 */
export async function laterTime(
  user: User,
  draft: OutboundMessage,
  retryAt?: string,
  now = new Date(),
): Promise<Date | undefined> {
  const [{ db }, { nextBatchOpen, seeded }, { personZone }] = await Promise.all([
    import('../db/schema'),
    import('../engine/batchTime'),
    import('../engine/trust'),
  ]);
  const person = await db.people.get(draft.personId);
  const zone = (person && personZone(person)) || user.timezone || 'America/New_York';
  let from: Date;
  if (retryAt) from = new Date(Math.max(Date.parse(retryAt), now.getTime()));
  else {
    from = new Date(now);
    from.setDate(from.getDate() + 1);
    from.setHours(0, 0, 0, 0);
  }
  return nextBatchOpen(from, zone, 'steady', seeded(draft.id.length * 13 + now.getUTCHours()));
}

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
  if (url.startsWith('mailto:') || url.startsWith('sms:')) {
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
  if (via === 'sms') return 'Opened in Messages with your text written.';
  if (via === 'instagram_dm' || via === 'x_dm') {
    const where = via === 'x_dm' ? 'X' : 'Instagram';
    return copied
      ? `Copied. Paste it into your chat on ${where}, send it, then say it went.`
      : `${where} is open. Copy the message from the card, send it there, then say it went.`;
  }
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
  /** `handoff`: open LinkedIn or the mail app even when Orbit could send it itself */
  via?: 'handoff',
): Promise<string | undefined> {
  const name = firstName ?? 'them';
  // the copy starts inside the click (an await first would lose the browser's permission); a LinkedIn message Orbit
  // sends itself is copied too, which does no harm
  const copying =
    draft.channel === 'linkedin' || draft.channel === 'instagram' || draft.channel === 'x'
      ? copyText(draft.kind === 'intro_request' ? withNote(body, draft.forwardNote) : body)
      : Promise.resolve(false);
  const r = await approveAndSend(user, draft.id, body, subject, new Date(), via ? { via } : {});
  const copied = await copying;
  if (!r.ok) {
    // plan 38 §D: a limit that only means "not today" or "not yet" offers the next time it can go
    if ((r.code === 'daily_cap' || r.code === 'cooldown') && draft.channel === 'gmail' && !via) {
      const at = await laterTime(user, draft, r.retryAt);
      if (at) {
        const when = at.toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: user.timezone || undefined,
        });
        toast.push({
          text: r.error,
          ttl: 15_000,
          action: {
            label: `Send ${when} instead`,
            onClick: () => {
              void approveAndSend(user, draft.id, body, subject, new Date(), { scheduleAt: at }).then((s) =>
                toast.push(
                  s.ok
                    ? { text: `Scheduled for ${when}. It is under Drafts, Scheduled.`, tone: 'good' }
                    : { text: s.error, tone: 'bad' },
                ),
              );
            },
          },
        });
      }
    }
    return r.error;
  }
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
  } else if (r.status === 'scheduled') {
    // an account's email, approved on the server (plan 29 §B2.1): it goes after the undo window, or in their morning
    const soon = Date.parse(r.sendAt) - Date.now() <= 60_000;
    const at = new Date(r.sendAt).toLocaleString('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: user.timezone || undefined,
    });
    toast.push({
      text: soon
        ? `Sending to ${name} in ${Math.round(UNDO_WINDOW_MS / 1000)} seconds.`
        : `Approved. Gmail sends it to ${name} ${at}, in their morning.`,
      ttl: soon ? UNDO_WINDOW_MS - 2000 : 10_000,
      action: {
        label: soon ? 'Undo' : 'Stop it',
        onClick: () => {
          undoQueued(user, draft.id).then((undone) =>
            toast.push({ text: undone ? 'Not sent. The draft is back.' : 'Too late, it already went out.' }),
          );
        },
      },
    });
  } else
    toast.push({
      text: draft.channel === 'linkedin' ? `Sent to ${name} on LinkedIn.` : `Sent to ${name}.`,
      tone: 'good',
    });
  return undefined;
}
