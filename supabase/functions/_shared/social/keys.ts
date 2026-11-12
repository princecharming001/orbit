/** How rows name a social account (plan 43 §3.3, §3.4): the identity kind per platform and a person's source account. */
import type { SocialPlatform } from '@orbit/core/entity/social';

/** The person identity kind that holds an account's platform id ("instagram_id", "x_id"). */
export const identityKind = (p: SocialPlatform) => `${p}_id` as const;
/** people.source_account of a person made from an account. */
export const sourceAccount = (p: SocialPlatform, id: string) => `${p}:${id}`;
/** facts.source_table of a fact read from an account's bio or links. */
export const factSource = (p: SocialPlatform, id: string) => `social:${p}:${id}`;
/** The platform's name as the student reads it. */
export const platformName = (p: SocialPlatform) => (p === 'instagram' ? 'Instagram' : 'X');
