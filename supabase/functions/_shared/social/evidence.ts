/**
 * The evidence on a "same person" question in plain lines (plan 43 §3.4), both ways, for the card the student reads:
 * "Both link to mayaokafor.com", "Their bio names Stripe", "The account follows 4,000 people". Written beside the raw
 * signals (kept as numbers) when the question is created. No em dashes and no exclamation marks: the student reads
 * these as they are.
 */

import { compareNames } from '@orbit/core/entity/names';
import {
  normalizeLink,
  type SocialAccount,
  type SocialCandidate,
  type SocialProof,
  type SocialSignal,
} from '@orbit/core/entity/social';
import { platformName } from './keys.ts';

export interface AskLines {
  for: string[];
  against: string[];
}

/** Following more than this many reads as an account that follows anyone back. */
const FOLLOWS_MANY = 2000;
/** More followers than this reads as a public figure's account, not a friend's. */
const FOLLOWED_BY_MANY = 10_000;

const count = (n: number) => Math.round(n).toLocaleString('en-US');

const PROOF_LINE: Record<SocialProof, string> = {
  own_links: 'Their own page links to this account',
  links_back: 'The account links to their LinkedIn',
  contact: 'The account shows an email or phone you have for them',
  address_book: 'Your contacts list this handle on their card',
};

/** A shared link as it reads: the site, no scheme or www ("mayaokafor.com", "github.com/maya"). */
function sharedLink(a: SocialAccount, c: SocialCandidate | undefined): string | undefined {
  const theirs = new Set((c?.links ?? []).map(normalizeLink).filter((l): l is string => !!l));
  for (const l of a.links ?? []) {
    const n = normalizeLink(l);
    if (n && theirs.has(n)) return n;
  }
  return undefined;
}

/**
 * Lines for one account and one person. `signals` are core's weighed signals (or `{proof}` when hard proof was
 * found but the student is asked anyway); `c` is the person as matching saw them, when the caller has it.
 */
export function askLines(
  a: SocialAccount,
  c: SocialCandidate | undefined,
  signals: Partial<Record<SocialSignal, number>> & { proof?: SocialProof },
): AskLines {
  const out: AskLines = { for: [], against: [] };
  const p = c?.person;
  const where = platformName(a.platform);
  if (signals.proof) out.for.push(PROOF_LINE[signals.proof]);
  const accountName = (a.name ?? '').trim();
  const personName = p ? (p.displayName || `${p.firstName ?? ''} ${p.lastName ?? ''}`).trim() : '';
  const name =
    typeof signals.name === 'number'
      ? signals.name
      : accountName && personName
        ? compareNames(accountName, personName).score
        : undefined;
  if (name !== undefined && accountName) {
    if (name >= 0.95) out.for.push(`The name on the account is ${accountName}`);
    else if (name >= 0.75) out.for.push(`A close name on the account: ${accountName}`);
    else out.against.push(`The name on the account is ${accountName}`);
  }
  if (signals.handle) out.for.push(`The handle @${a.username} spells their name`);
  const org = p?.currentOrganizationRaw?.trim();
  if (signals.employer_role_small) out.for.push(`Their bio names ${org || 'their employer'} and their role`);
  else if (signals.employer) out.for.push(`Their bio names ${org || 'their employer'}`);
  const school = p?.school?.trim();
  if (signals.school_year) out.for.push(`Their bio names ${school || 'their school'} and their class year`);
  else if (signals.school) out.for.push(`Their bio names ${school || 'their school'}`);
  if (signals.same_link) {
    const l = sharedLink(a, c);
    out.for.push(l ? `Both link to ${l}` : 'Both link to the same page');
  }
  if (signals.same_picture) out.for.push('The same profile picture');
  if (signals.place) {
    const city = p?.location?.split(',')[0]?.trim();
    out.for.push(city ? `Their bio names ${city}` : 'Their bio names the same city');
  }
  if (signals.rare_name) out.for.push('An uncommon last name, and it matches');
  if (signals.neighbours) {
    const n = c?.sharedNeighbours ?? signals.neighbours;
    out.for.push(
      n === 1 ? 'One person you know is tied to both' : `${count(n)} people you know are tied to both`,
    );
  }
  if (signals.public_figure) out.against.push('The account looks like a public figure');
  if (signals.other_handle) {
    const other = c?.otherHandles?.[0];
    out.against.push(
      other
        ? `They already have another ${where} account attached, @${other}`
        : `They already have another ${where} account attached`,
    );
  }
  if (typeof a.following === 'number' && a.following >= FOLLOWS_MANY)
    out.against.push(`The account follows ${count(a.following)} people`);
  if (typeof a.followers === 'number' && a.followers >= FOLLOWED_BY_MANY && !signals.public_figure)
    out.against.push(`The account has ${count(a.followers)} followers`);
  if (a.defaultPicture) out.against.push('The account has no profile picture');
  if (a.isPrivate) out.against.push('The account is private, so Orbit saw only its profile');
  return out;
}

/** The lines on a question reopened because the contact that proved a match came from an account taken back. */
export const CONTACT_DETACHED_LINES: AskLines = {
  for: ['An email or phone they share matched this account'],
  against: ['That email or phone came from an account you said was not theirs'],
};
