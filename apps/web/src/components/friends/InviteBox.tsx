/**
 * Invite a friend by email (plan 29 §A1), under the invite link in the side column. Someone already on Orbit sees a
 * request to accept; someone not on it gets a sign-in link that lands them in setup with the request waiting. Either
 * way they then show under Requested. The email goes from the student's own Gmail (Orbit's address when they have
 * none connected); when no email went out, the box says so and shows the link to send by hand. One address gets one
 * invite: a second tap, or the same address again, is the invite already waiting, and nothing is sent twice.
 */
import { useRef, useState } from 'react';
import { Button, Input, useToast } from '../../ui';
import { EmailTypoHint } from '../EmailTypoHint';

const TAP = 'pointer-coarse:min-h-11';

export interface InviteOutcome {
  link: string;
  status: 'sent' | 'requested' | 'link' | 'linkedin';
  /** this address had an invite waiting already: nothing was sent a second time */
  already?: boolean;
  via?: 'gmail' | 'orbit';
  /** an address was given and no email went out: nothing could send one, or the send failed */
  notSent?: 'none' | 'failed';
}

/** What to tell the student after Invite: what went out, to whom, from where, or that nothing did and what to do. */
export function inviteSaid(
  r: InviteOutcome,
  to: string,
): { text: string; tone: 'good' | 'neutral' | 'bad'; ttl?: number } {
  if (r.status === 'requested')
    return {
      text: r.already
        ? 'You already asked them. The request is waiting on them.'
        : 'They are on Orbit already: the request is waiting on them.',
      tone: 'good',
    };
  if (r.status === 'sent')
    return r.already
      ? {
          text: `You already invited ${to}. The invite is waiting on them, so nothing was sent again.`,
          tone: 'neutral',
          ttl: 7000,
        }
      : {
          text: r.via === 'gmail' ? `Invite sent to ${to} from your Gmail.` : `Invite sent to ${to}.`,
          tone: 'good',
        };
  if (r.notSent === 'failed')
    return {
      text: `The email to ${to} did not go out. Copy the link below and send it yourself, or tap Invite to try again.`,
      tone: 'bad',
      ttl: 9000,
    };
  return {
    text: `Orbit could not email ${to}: connect Gmail in Settings, or copy the link below and send it yourself.`,
    tone: 'neutral',
    ttl: 9000,
  };
}

export function InviteBox({
  onInvite,
  busy,
}: {
  /** returns the link to copy, or nothing when it failed (the caller said why) */
  onInvite: (email?: string) => Promise<InviteOutcome | undefined>;
  busy?: boolean;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string>();
  // one invite at a time: Enter and a click together, or a second tap while the first is out, send once
  const out = useRef(false);
  const [sending, setSending] = useState(false);
  const send = async () => {
    const to = email.trim();
    if (out.current || !to) return;
    out.current = true;
    setSending(true);
    try {
      const r = await onInvite(to);
      if (!r) return;
      // only a link nobody was sent is worth showing: the student has to pass it on themselves
      setLink(r.status === 'link' ? r.link : undefined);
      toast.push(inviteSaid(r, to));
      setEmail('');
    } finally {
      out.current = false;
      setSending(false);
    }
  };
  return (
    <div className="space-y-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Or invite by email"
          className="min-w-0 flex-1 h-11 rounded-[10px] px-3.5 text-[13.5px]"
          aria-label="Your friend's email"
          data-testid="friends-invite-email"
        />
        <Button
          type="submit"
          variant={email.trim() ? 'primary' : 'secondary'}
          className={`h-11 rounded-[10px] !shadow-none ${TAP} disabled:opacity-100 disabled:text-ink-3`}
          loading={busy || sending}
          disabled={!email.trim() || sending}
          data-testid="friends-invite-send"
        >
          Invite
        </Button>
      </form>
      <EmailTypoHint email={email} onFix={setEmail} />
      {link && (
        <p className="text-[12.5px] text-ink-3 break-all" data-testid="friends-invite-link-text">
          {link}
        </p>
      )}
    </div>
  );
}
