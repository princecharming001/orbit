/**
 * Invite a friend by email (plan 29 §A1), under the invite link in the side column. Someone already on Orbit sees a
 * request to accept; someone not on it gets a sign-in link that lands them in setup with the request waiting. Either
 * way they then show under Requested. When no mail goes out from this copy of Orbit, the link to send by hand shows
 * under the box.
 */
import { useState } from 'react';
import { Button, Input, useToast } from '../../ui';
import { EmailTypoHint } from '../EmailTypoHint';

const TAP = 'pointer-coarse:min-h-11';

export function InviteBox({
  onInvite,
  busy,
}: {
  /** returns the link to copy, or nothing when it failed (the caller said why) */
  onInvite: (
    email?: string,
  ) => Promise<{ link: string; status: 'sent' | 'requested' | 'link' | 'linkedin' } | undefined>;
  busy?: boolean;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string>();
  const send = async () => {
    const r = await onInvite(email.trim() || undefined);
    if (!r) return;
    // only a link nobody was sent is worth showing: the student has to pass it on themselves
    setLink(r.status === 'link' ? r.link : undefined);
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
          loading={busy}
          disabled={!email.trim()}
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
