/**
 * The words for a LinkedIn message Orbit could not send itself: why the server's send did not go, and why Orbit cannot
 * send from here at all (LinkedIn not connected, paused, signed out), each with the fix where there is one. Kept
 * apart from the engines so the sender, the sync and the screens all say the same thing.
 */
import { LINKEDIN_NOTE_MAX } from '@orbit/core';

/** Why Orbit cannot send a LinkedIn message itself right now. */
export type LinkedInBlock =
  /** no LinkedIn linked on the account */
  | 'not_connected'
  /** Orbit's server parked the link while the student was away */
  | 'paused'
  /** LinkedIn signed the account out */
  | 'signed_out'
  /** the sign-in is still going */
  | 'connecting'
  /** the link stopped on an error */
  | 'stopped'
  /** a draft or a person this browser cannot name to the server */
  | 'not_saved'
  /** the server could not be asked, or does not know this draft */
  | 'unavailable';

/** Where the student fixes it. */
export interface LinkedInFix {
  label: string;
  to: string;
}

const SETTINGS = '/settings/integrations';
const RECONNECT: LinkedInFix = { label: 'Reconnect LinkedIn', to: SETTINGS };

export const LINKEDIN_BLOCKS: Record<LinkedInBlock, { text: string; fix?: LinkedInFix }> = {
  not_connected: { text: 'LinkedIn is not connected. Reconnect it to send from Orbit.', fix: RECONNECT },
  paused: {
    text: 'LinkedIn is paused because you were away. Reconnect it to send from Orbit.',
    fix: RECONNECT,
  },
  signed_out: { text: 'LinkedIn signed Orbit out. Reconnect it to send from Orbit.', fix: RECONNECT },
  connecting: { text: 'LinkedIn is still connecting. Try again in a minute.' },
  stopped: {
    text: 'LinkedIn stopped working with Orbit. Check it in Settings, Integrations to send from Orbit.',
    fix: { label: 'Open Integrations', to: SETTINGS },
  },
  not_saved: { text: 'Orbit has not saved this to your account yet, so it cannot send it itself.' },
  unavailable: { text: 'Orbit could not send this itself just now. Try again in a moment.' },
};

/** The block a LinkedIn link's status on the server means; undefined when it is active. */
export function blockForStatus(status: string | undefined): LinkedInBlock | undefined {
  switch (status) {
    case 'active':
      return undefined;
    case 'parked':
      return 'paused';
    case 'needs_reauth':
      return 'signed_out';
    case 'connecting':
      return 'connecting';
    case 'error':
      return 'stopped';
    default:
      return 'not_connected';
  }
}

/** The server's code for a send that found no LinkedIn linked. */
export const NOT_CONNECTED_CODE = 'linkedin_not_connected';

/** Why the server's LinkedIn send did not go, for the student. */
export function linkedinSendError(code: string | null | undefined, length?: number): string {
  if (code === 'linkedin_note_too_long')
    return `You are not connected yet, so this goes as a connection request, and LinkedIn caps its note at ${LINKEDIN_NOTE_MAX} characters${length ? ` (this one is ${length})` : ''}. Trim it and send again.`;
  if (code === NOT_CONNECTED_CODE) return LINKEDIN_BLOCKS.not_connected.text;
  if (code === 'no_linkedin_member')
    return 'Orbit could not find them on LinkedIn. Open their profile from here and send it there.';
  if (code === 'linkedin_unconfirmed')
    return 'LinkedIn did not confirm the send. Check your chat with them on LinkedIn before sending again.';
  if (code === 'linkedin_needs_fresh_approval' || code === 'linkedin_never_auto')
    return 'LinkedIn messages go only on your tap. Press Send again.';
  if (code === 'linkedin_daily_cap')
    return 'You have sent as many LinkedIn messages as Orbit allows in a day. It resets at midnight.';
  if (code === 'linkedin_invite_daily_cap')
    return 'You have sent as many connection requests as Orbit allows in a day. Try again tomorrow.';
  if (code === 'linkedin_invite_weekly_cap')
    return 'You have sent as many connection requests as Orbit allows in a week. Try again in a few days.';
  if (code === 'do_not_contact') return 'They asked not to be contacted, so Orbit does not send this.';
  if (code === 'minor') return 'Their profile reads as someone under 18, so Orbit does not send this.';
  if (code === 'unanswered_limit')
    return 'You have written to them three times without an answer, so Orbit does not send another.';
  if (code === 'sensitive_category')
    return 'The message says something sensitive about them. Take that out and send again.';
  if (code === 'replied')
    return 'They wrote back since this was written. Read their message, then write again.';
  if (code === 'needs_input') return 'A line in the message is still blank. Fill it in and send again.';
  if (code === 'unipile_unconfigured') return 'Orbit cannot send LinkedIn messages right now.';
  if (code?.startsWith('unipile_4'))
    return 'LinkedIn would not take this message. They may have a pending request from you, or limit who can message them.';
  return 'LinkedIn did not take it just now. Try again in a moment.';
}

/** The reasons that stop a message whatever it is sent with: the same sentences for an email as for LinkedIn. */
const SHARED_STOPS = new Set([
  'do_not_contact',
  'minor',
  'unanswered_limit',
  'sensitive_category',
  'replied',
  'needs_input',
]);

/** Why an email the student wrote did not go from Orbit, in words. */
export function emailSendError(code: string | null | undefined): string {
  if (code && SHARED_STOPS.has(code)) return linkedinSendError(code);
  if (code === 'no_email' || code === 'no_recipient')
    return 'Orbit has no email address for them yet. Add one on their page, then send.';
  if (code === 'bounced' || code === 'hard_bounce')
    return 'That address did not take the email. Check it on their page, then send again.';
  if (code === 'daily_cap' || code === 'email_daily_cap')
    return 'You have sent as many emails as Orbit allows in a day. It resets at midnight.';
  if (code === 'google_reconnect' || code === 'no_send_scope' || code === 'invalid_grant')
    return 'Gmail needs to be connected again before Orbit can send. Reconnect it in Settings, then send again.';
  return 'Gmail did not take it just now. Try again in a moment.';
}
