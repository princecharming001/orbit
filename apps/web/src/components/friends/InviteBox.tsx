/**
 * Invite a friend (plan 29 §A1): an email box and a link to copy. Someone already on Orbit sees a request to accept;
 * someone not on it gets a sign-in link that lands them in setup with the request waiting. Pending requests sit under
 * it with Accept, Decline and the one line that says what accepting shares.
 */
import type { FriendInvite } from '@orbit/core';
import { useState } from 'react';
import { Button, Input, useToast } from '../../ui';

const TAP = 'pointer-coarse:min-h-11';

export function InviteBox({
  pending,
  onInvite,
  onAccept,
  onDecline,
  busy,
}: {
  pending: FriendInvite[];
  /** returns the link to copy, or nothing when it failed (the caller said why) */
  onInvite: (email?: string) => Promise<{ link: string; status: 'sent' | 'requested' | 'link' } | undefined>;
  onAccept: (inv: FriendInvite) => void;
  onDecline: (inv: FriendInvite) => void;
  busy?: boolean;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string>();
  const send = async () => {
    const r = await onInvite(email.trim() || undefined);
    if (!r) return;
    setLink(r.link);
    if (r.status === 'requested')
      toast.push({ text: `They are on Orbit already: the request is waiting on them.`, tone: 'good' });
    else if (r.status === 'sent') toast.push({ text: `Invite sent to ${email.trim()}.`, tone: 'good' });
    else if (email.trim())
      toast.push({
        text: 'No mail goes out from this copy of Orbit yet: copy the link and send it yourself.',
        tone: 'neutral',
        ttl: 7000,
      });
    setEmail('');
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.push({ text: 'Link copied.', tone: 'good' });
    } catch {
      toast.push({ text: link, tone: 'neutral', ttl: 10_000 });
    }
  };
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="friend@school.edu"
          className="max-w-xs"
          aria-label="Your friend's email"
          data-testid="friends-invite-email"
        />
        <Button
          type="submit"
          variant="primary"
          className={TAP}
          loading={busy}
          data-testid="friends-invite-send"
        >
          Invite
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={TAP}
          onClick={() => {
            if (link) return void copy();
            void onInvite().then((r) => {
              if (!r) return;
              setLink(r.link);
              void navigator.clipboard?.writeText(r.link).catch(() => undefined);
            });
          }}
          data-testid="friends-invite-link"
        >
          {link ? 'Copy the link' : 'Get a link to send'}
        </Button>
      </form>
      {link && (
        <p className="text-[12.5px] text-ink-3 break-all" data-testid="friends-invite-link-text">
          {link}
        </p>
      )}
      {pending.length > 0 && (
        <ul className="divide-y divide-line-2" data-testid="friends-pending">
          {pending.map((inv) => (
            <li key={inv.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13.5px]">
              <span className="font-medium">{inv.name ?? inv.email}</span>
              {inv.direction === 'in' ? (
                <>
                  <span className="text-ink-3 text-[12.5px]">
                    wants to pool networks. Accepting shares your people the same way. Change it any time.
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      className={TAP}
                      onClick={() => onAccept(inv)}
                      data-testid="friends-accept"
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={TAP}
                      onClick={() => onDecline(inv)}
                      data-testid="friends-decline"
                    >
                      Decline
                    </Button>
                  </span>
                </>
              ) : (
                <span className="text-ink-3 text-[12.5px]">
                  {inv.name ? 'request sent, waiting on them' : 'invited, waiting on them'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
