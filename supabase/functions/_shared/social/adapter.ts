/**
 * What Orbit needs from Instagram (through Unipile) and from X (its own API), as one interface (plan 43 §4, §5), so
 * the follow graph, the lookup job, the chat writer and matching are written once. Each platform implements it in
 * its own module (`instagram.ts`, `x/adapter.ts`); tests use a fake that follows the same shapes.
 *
 * Every call an adapter makes is paid for first through `SocialBudget`: Instagram by count in rolling windows
 * (Unipile advises about 100 actions a day and 10 an hour), X by money ($0.01 per person or message read). A call the
 * budget refuses is not made, and the caller stops and resumes later.
 */
import type { SocialAccount, SocialPlatform } from '@orbit/core/entity/social';

/** A profile read: the account, plus what the platform says about the reader's relation to it. */
export interface SocialProfileRead {
  account: SocialAccount;
  /** Instagram only: how many accounts the reader follows that also follow this account (plan 43 §3.6 step 3) */
  mutualCount?: number;
  /** the reader follows this account / this account follows the reader */
  relation?: { following: boolean; followedBy: boolean };
}

/** One page of a follow list. */
export interface SocialListPage {
  /** the platform ids on this page */
  ids: string[];
  /** whatever profile fields came with the page (names, handles, pictures), for accounts that turn out to matter */
  accounts?: SocialAccount[];
  /** X: each returned account's relation to the reader, when the platform reports it */
  relations?: Record<string, { following: boolean; followedBy: boolean }>;
  cursor?: string;
  /** the count the platform reports for the whole list, when it does */
  total?: number;
}

export interface SocialChat {
  chatId: string;
  /** everyone in the chat, the student included */
  participants: number;
  /** the other people, by platform account id */
  others: { accountId: string; username?: string; name?: string }[];
  lastAt?: string;
}

export interface SocialMessage {
  messageId: string;
  chatId: string;
  at: string;
  /** the student wrote it */
  fromStudent: boolean;
  senderAccountId: string;
  /** what was written; empty for a reaction, a shared post, a sticker */
  text: string;
  /** something was written (not only a reaction or a shared item) */
  hasWords: boolean;
}

export interface SocialPage<T> {
  items: T[];
  cursor?: string;
}

export type SocialList = 'followers' | 'following';

/** The kinds of call a budget is charged for. */
export type SocialCallKind = 'profile' | 'list' | 'chats' | 'messages' | 'send' | 'search';

export interface SocialAdapter {
  platform: SocialPlatform;
  /** largest page a list read returns (Instagram followers: 25; X: 1000) */
  pageSize(list: SocialList): number;
  /** the student's own account */
  me(): Promise<SocialProfileRead>;
  /** any account by platform id or handle */
  profile(ref: string): Promise<SocialProfileRead>;
  listPage(accountId: string, list: SocialList, cursor?: string): Promise<SocialListPage>;
  chats(cursor?: string): Promise<SocialPage<SocialChat>>;
  messages(chatId: string, cursor?: string): Promise<SocialPage<SocialMessage>>;
  /** send in an existing chat, or start one with an account; always after the student's tap */
  send(
    to: { chatId?: string; accountId?: string },
    text: string,
  ): Promise<{ messageId: string; chatId: string }>;
  /** look an account up by name, when the platform allows it (for finding a target's account) */
  search?(query: string): Promise<SocialAccount[]>;
}

/** Charged before each call; false means the call must not be made now. */
export interface SocialBudget {
  spend(kind: SocialCallKind, opts?: { units?: number; caller?: string }): Promise<boolean>;
  /** Instagram: when a refused kind can be tried again; X: undefined */
  retryAt?(kind: SocialCallKind): Promise<Date | undefined>;
}

/** Thrown by an adapter when the platform says the account must sign in again. */
export class SocialSignInNeeded extends Error {
  constructor(readonly platform: SocialPlatform) {
    super(`${platform} needs you to sign in again`);
  }
}

/** Thrown when the budget refused a call: the caller saves its place and resumes later. */
export class SocialBudgetSpent extends Error {
  constructor(
    readonly kind: SocialCallKind,
    readonly retryAt?: Date,
  ) {
    super(`budget spent for ${kind}`);
  }
}
