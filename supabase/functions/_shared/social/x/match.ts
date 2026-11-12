/**
 * Matching an X account to a person (plan 43 §3.4 with X's rule on top, §5 "Matching people").
 *
 * X allows tying an X account to an off-X identity only from public information, from what the person gave, or with
 * their express consent. So on X only public proof attaches:
 *   - the person's own public links list the handle (`own_links`: their LinkedIn websites, a page Orbit's research
 *     confirmed is theirs)
 *   - the account links to the person's LinkedIn (`links_back`)
 * A score never attaches an X account, and the student is never asked "is this the same person" about X: their
 * say-so and their address book are neither public nor the person's own consent.
 */
import {
  matchSocialAccount,
  matchTargetAccount,
  type SocialAccount,
  type SocialCandidate,
  type SocialMatch,
  type SocialProof,
  socialProof,
} from '@orbit/core/entity/social';

/**
 * Whether proof that is not public (the student's say-so on a confirm card, a handle on a card in their address book)
 * may attach an X account. False until a lawyer has read X's developer policy on matching (plan 43 §5, §9, decision 5);
 * turning it on also lets the student be asked about accounts of people they know, as on Instagram.
 */
export const X_PRIVATE_PROOF_ALLOWED = false;

/** The proofs that rest on public information. */
export const X_PUBLIC_PROOFS: ReadonlySet<SocialProof> = new Set(['own_links', 'links_back']);

const allowed = (p: SocialProof) => X_PUBLIC_PROOFS.has(p) || X_PRIVATE_PROOF_ALLOWED;

function publicOnly(c: SocialCandidate): SocialCandidate {
  return X_PRIVATE_PROOF_ALLOWED ? c : { ...c, contactHandles: undefined };
}

/** Decide one X account against the people it could be. Attaches by public proof only, never asks. */
export function matchXAccount(
  a: SocialAccount,
  candidates: SocialCandidate[],
  opts: { rejected?: ReadonlySet<string> } = {},
): SocialMatch {
  if (a.platform !== 'x') throw new Error('matchXAccount is for X accounts');
  if (X_PRIVATE_PROOF_ALLOWED) return matchSocialAccount(a, candidates, opts);
  const pool = candidates.filter((c) => !opts.rejected?.has(c.person.id)).map(publicOnly);
  const proven = pool
    .map((c) => ({ c, proof: socialProof(a, c) }))
    .filter((x): x is { c: SocialCandidate; proof: SocialProof } => !!x.proof && allowed(x.proof));
  if (proven.length === 1)
    return { kind: 'attach', personId: proven[0]!.c.person.id, via: 'proof', proof: proven[0]!.proof };
  if (proven.length > 1) return { kind: 'none', reason: 'ambiguous' };
  return { kind: 'none', reason: pool.length ? 'low' : 'no_candidate' };
}

/** A target's X account: public proof only, as for every X account. */
export function matchXTarget(a: SocialAccount, target: SocialCandidate): SocialMatch {
  const m = matchTargetAccount(a, publicOnly(target));
  if (m.kind === 'attach' && m.via === 'proof' && allowed(m.proof)) return m;
  return { kind: 'none', reason: 'stranger' };
}
