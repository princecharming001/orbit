import type {
  ActionItem,
  Affiliation,
  AuditEntry,
  Brief,
  CalendarEvent,
  CoffeeChat,
  Dossier,
  Edge,
  EmailMessage,
  EmailThread,
  FeedbackEvent,
  Goal,
  MeetingNote,
  MemoryKind,
  MergeSuggestion,
  Notification,
  Organization,
  OutboundMessage,
  Person,
  PersonFact,
  Recommendation,
  RecruitingGoals,
  Resume,
  ResumeFacet,
  StageEvent,
  Suggestion,
  TargetCompany,
  Touchpoint,
  User,
  UserSettings,
} from '@orbit/core';
import Dexie, { type EntityTable } from 'dexie';
import type { ChatAction, ChatConversation, ChatMessage } from '../chat/types';

export interface IntegrationAccount {
  id: string;
  userId: string;
  provider:
    | 'google'
    | 'linkedin_csv'
    | 'linkedin_live'
    | 'granola'
    | 'fathom'
    | 'fireflies'
    | 'wispr'
    | 'calcom'
    | 'wispr_export'
    | 'tracker_import'
    | 'imessage'
    | 'demo';
  externalAccountId?: string;
  /** live LinkedIn: the token Orbit's server gave this browser for the account; account calls carry it */
  accessToken?: string;
  /**
   * an app connected by signing in (Cal.com, Fathom, Granola, Wispr Flow): `accessToken` expires and is renewed with
   * this; `clientId` is the id the app gave Orbit when it registered itself there (Granola, Wispr Flow)
   */
  oauth?: { refreshToken?: string; expiresAt?: string; clientId?: string };
  status: 'active' | 'needs_reauth' | 'revoked' | 'error' | 'instructions_shown';
  scopes: string[];
  syncState: Record<string, unknown>;
  lastSyncedAt?: string;
  lastError?: string;
  connectedAt: string;
}

export interface StyleProfile {
  userId: string;
  card: import('@orbit/core').StyleCard;
  updatedAt: string;
  /** messages the student pasted in as examples of how they write */
  samples?: string[];
}

export interface KV {
  key: string;
  value: unknown;
}

/** The student's own closeness rating of a person, 1 ("barely know") to 5 ("very close") (plan 16 §3.5). */
export interface TieLabelRow {
  personId: string;
  userId: string;
  closeness: 1 | 2 | 3 | 4 | 5;
  /** the score the model gave before the rating, so the page can say what changed */
  modelScore?: number;
  updatedAt: string;
}

/** A tie score as orbit.tie_scores sends it (account mode); the person row carries the same numbers. */
export interface TieScoreRow {
  personId: string;
  userId: string;
  score: number;
  band: string;
  explanation: string[];
  contributions?: Record<string, number>;
  modelVersion?: string;
  computedAt?: string;
  [k: string]: unknown;
}

/** One way to reach a person (orbit.person_identities): an address, a LinkedIn id or slug. */
export interface PersonIdentityRow {
  id: string;
  userId: string;
  personId: string;
  kind: string;
  [k: string]: unknown;
}

/** An introduction asked for (orbit.intro_requests), kept so the chat can say what came of it. */
/**
 * What the student said about two people (plan 21 §3.5): they don't really know each other (`blocked`: never a hop
 * until undone) or they're close. One row per pair and kind; aId < bId.
 */
export interface PairNote {
  /** `${userId}:${aId}|${bId}:${kind}` */
  id: string;
  userId: string;
  aId: string;
  bId: string;
  kind: 'blocked' | 'close';
  at: string;
}

/** One post of someone's, as Orbit keeps it for plan 21: no text, only what it says about who engages with whom. */
export interface EngagementPost {
  id: string;
  at?: string;
  /** the member id of the person whose post this one reposts */
  repostOf?: string;
  /** member ids of the people it mentions */
  mentions: string[];
  /** how many people it tagged in all */
  tagged: number;
}

/**
 * What LinkedIn showed of one person's public activity (plan 21 §4), kept 30 days and dropped when LinkedIn is
 * disconnected: their recent posts, the posts they reacted to and commented on (with the post's author where LinkedIn
 * gives it), and who commented under their latest posts. Ids, dates and counts only: never anyone's words.
 */
export interface EngagementRow {
  /** `${userId}:${memberId}` */
  id: string;
  userId: string;
  memberId: string;
  /** when each part was read (profileAt: their profile, for followers and recommendations) */
  profileAt?: string;
  postsAt?: string;
  reactionsAt?: string;
  commentsAt?: string;
  threadsAt?: string;
  posts?: EngagementPost[];
  /** posts (or comments) they reacted to, with that post's author */
  reactions?: { postId: string; authorId: string }[];
  comments?: { id: string; postId: string; at?: string; threadId?: string }[];
  /** top-level comments under their own posts, by post id */
  threads?: Record<string, { id: string; commenterId: string; at?: string }[]>;
  /** LinkedIn would not show this person's activity (a locked or private profile) */
  unavailableAt?: string;
}

export interface IntroRequestRow {
  id: string;
  userId: string;
  [k: string]: unknown;
}

/**
 * A change the student made in account mode that the server has not taken yet: the table and the row's id, read
 * fresh when it is pushed, so several edits to one row go up as one change (engine/serverSync.ts).
 */
export interface OutboxRow {
  /** `${table}:${id}` */
  key: string;
  /** the orbit table the change goes to (chats, stage_events, notes, people, drafts, tie_labels, memories) */
  table: string;
  /** the local row's id (for tie_labels, the person's id) */
  id: string;
  op: 'upsert' | 'delete';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/**
 * Someone the student texts, from the Mac's Messages: how much and when, and the last few messages for their page.
 * Kept in this browser only; the messages themselves are never sent anywhere.
 */
export interface TextThread {
  /** the person's id: one thread per person, whichever numbers or addresses they text from */
  id: string;
  userId: string;
  personId: string;
  /** the numbers and addresses the texts came from (+15551234567, name@icloud.com) */
  handles: string[];
  inCount: number;
  outCount: number;
  firstAt: string;
  lastAt: string;
  /** the latest messages, oldest first */
  recent: { at: string; fromMe: boolean; text: string }[];
  importedAt: string;
}

/**
 * Something the student told Orbit that it keeps for later chats, in this browser (local mode; account mode keeps
 * memories on the server). The same shape as the server's memories: what to remember in the third person, the
 * student's own words it came from, a kind, an importance and the chat turn it came from. Forgetting one blanks its
 * words and marks it deleted.
 */
export interface LocalMemory {
  id: string;
  userId: string;
  kind: MemoryKind;
  /** at most 200 characters, in the third person ("Prefers morning calls") */
  text: string;
  /** the student's own words it came from */
  quote?: string;
  /** the person it is about */
  personId?: string;
  /** 0..1 */
  importance: number;
  /** 'remember': the student asked; 'chat': read from a chat turn by Claude; 'rules': read by Orbit's own rules */
  source: 'remember' | 'chat' | 'rules';
  /** the conversation and message it came from */
  sourceTurn?: { conversationId: string; seq: number };
  createdAt: string;
  lastSeenAt: string;
  deletedAt?: string;
}

/**
 * One deep-research call this browser made (docs/plan/20 §7): what kind, what it cost and when, for the month's count
 * and the dollars Settings shows. No brief content: that is the dossier row.
 */
export interface ResearchRun {
  id: string;
  userId: string;
  personId: string;
  kind: 'quick' | 'deeper';
  /** YYYY-MM, the allowance month */
  month: string;
  status: string;
  costUsd: number;
  createdAt: string;
}

export class OrbitDB extends Dexie {
  users!: EntityTable<User, 'id'>;
  settings!: EntityTable<UserSettings, 'userId'>;
  goals!: EntityTable<RecruitingGoals, 'userId'>;
  targetCompanies!: EntityTable<TargetCompany, 'id'>;
  resumes!: EntityTable<Resume, 'id'>;
  resumeFacets!: EntityTable<ResumeFacet, 'id'>;
  organizations!: EntityTable<Organization, 'id'>;
  people!: EntityTable<Person, 'id'>;
  affiliations!: EntityTable<Affiliation, 'id'>;
  edges!: EntityTable<Edge, 'id'>;
  touchpoints!: EntityTable<Touchpoint, 'id'>;
  threads!: EntityTable<EmailThread, 'id'>;
  messages!: EntityTable<EmailMessage, 'id'>;
  events!: EntityTable<CalendarEvent, 'id'>;
  chats!: EntityTable<CoffeeChat, 'id'>;
  stageEvents!: EntityTable<StageEvent, 'id'>;
  notes!: EntityTable<MeetingNote, 'id'>;
  facts!: EntityTable<PersonFact, 'id'>;
  actionItems!: EntityTable<ActionItem, 'id'>;
  outbound!: EntityTable<OutboundMessage, 'id'>;
  suggestions!: EntityTable<Suggestion, 'id'>;
  briefs!: EntityTable<Brief, 'id'>;
  recommendations!: EntityTable<Recommendation, 'id'>;
  feedback!: EntityTable<FeedbackEvent, 'id'>;
  notifications!: EntityTable<Notification, 'id'>;
  audit!: EntityTable<AuditEntry, 'id'>;
  merges!: EntityTable<MergeSuggestion, 'id'>;
  integrations!: EntityTable<IntegrationAccount, 'id'>;
  styles!: EntityTable<StyleProfile, 'userId'>;
  kv!: EntityTable<KV, 'key'>;
  chatConversations!: EntityTable<ChatConversation, 'id'>;
  chatMessages!: EntityTable<ChatMessage, 'id'>;
  chatActions!: EntityTable<ChatAction, 'id'>;
  userGoals!: EntityTable<Goal, 'id'>;
  tieLabels!: EntityTable<TieLabelRow, 'personId'>;
  tieScores!: EntityTable<TieScoreRow, 'personId'>;
  dossiers!: EntityTable<Dossier, 'id'>;
  personIdentities!: EntityTable<PersonIdentityRow, 'id'>;
  introRequests!: EntityTable<IntroRequestRow, 'id'>;
  outbox!: EntityTable<OutboxRow, 'key'>;
  textThreads!: EntityTable<TextThread, 'id'>;
  memories!: EntityTable<LocalMemory, 'id'>;
  researchRuns!: EntityTable<ResearchRun, 'id'>;
  pairNotes!: EntityTable<PairNote, 'id'>;
  engagement!: EntityTable<EngagementRow, 'id'>;

  constructor(name = 'orbit') {
    super(name);
    this.version(1).stores({
      users: 'id, email',
      settings: 'userId',
      goals: 'userId',
      targetCompanies: 'id, userId, organizationId',
      resumes: 'id, userId',
      resumeFacets: 'id, resumeId',
      organizations: 'id, nameNormalized',
      people:
        'id, userId, nameNormalized, primaryEmail, linkedinSlug, currentOrganizationId, strength, lastInteractionAt, *emails',
      affiliations: 'id, userId, personId, organizationId',
      edges: 'id, userId, personAId, personBId',
      touchpoints: 'id, userId, personId, occurredAt, [personId+refTable+refId]',
      threads: 'id, userId, externalThreadId, lastMessageAt, chatId',
      messages: 'id, userId, threadId, externalMessageId, sentAt, fromPersonId',
      events: 'id, userId, externalEventId, startAt, chatId',
      chats: 'id, userId, personId, stage, threadId',
      stageEvents: 'id, userId, chatId, status, createdAt',
      notes: 'id, userId, occurredAt, chatId, matchStatus, [source+externalId]',
      facts: 'id, userId, personId, type',
      actionItems: 'id, userId, personId, chatId, status, dueAt',
      outbound: 'id, userId, personId, chatId, status, sentAt, suggestionId',
      suggestions: 'id, userId, status, kind, personId, chatId, dedupeKey, briefId, priorityScore',
      briefs: 'id, userId, briefDate, [userId+kind+briefDate]',
      recommendations: 'id, userId, personId, status, score',
      feedback: 'id, userId, kind, createdAt',
      notifications: 'id, userId, createdAt, readAt',
      audit: 'id, userId, createdAt',
      merges: 'id, userId, status',
      integrations: 'id, userId, provider',
      styles: 'userId',
      kv: 'key',
    });
    // the chat on the home page: conversations, their whole content blocks (append-only) and every tool execution
    // or pending confirmation
    this.version(2).stores({
      chatConversations: 'id, userId, updatedAt',
      chatMessages: 'id, conversationId, [conversationId+seq]',
      chatActions: 'id, conversationId, status, createdAt',
    });
    // plan 16: goals of every kind (the v1 `goals` row stays: it is the recruiting goal's details), the student's
    // closeness ratings, and in account mode the server's scores, dossiers, identities and intro requests, plus the
    // outbox of changes waiting for the server
    this.version(3).stores({
      userGoals: 'id, userId, status, kind',
      tieLabels: 'personId, userId',
      tieScores: 'personId, userId',
      dossiers: 'id, userId, personId',
      personIdentities: 'id, userId, personId',
      introRequests: 'id, userId',
      outbox: 'key, table, createdAt',
    });
    // phone numbers on people (texts are matched by number), and each person's texting history from the Mac's
    // Messages: counts, dates and the last few messages, kept in this browser only
    this.version(4).stores({
      people:
        'id, userId, nameNormalized, primaryEmail, linkedinSlug, currentOrganizationId, strength, lastInteractionAt, *emails, *phones',
      textThreads: 'id, userId, personId',
    });
    // plan 17 §G: what the student told the chat, kept in this browser in local mode (account mode keeps it on the
    // server)
    this.version(5).stores({
      memories: 'id, userId, personId, kind',
    });
    // deep research (docs/plan/20): each call's cost for the month's count and Settings, and the facts a brief wrote
    // found by the brief, so deleting the brief (or its 90 days running out) deletes them too
    this.version(6).stores({
      researchRuns: 'id, userId, personId, month, createdAt',
      facts: 'id, userId, personId, type, [sourceTable+sourceId]',
    });
    // plan 21: what the student said about two people, and the LinkedIn activity Orbit read to weigh each hop
    this.version(7).stores({
      pairNotes: 'id, userId, kind',
      engagement: 'id, userId, memberId',
    });
    // plan 24: the goals' "Anything else?" (freeText) is retired; what was written there moves into what the student
    // is going for (aim), after any aim already there
    this.version(8)
      .stores({})
      .upgrade((tx) =>
        tx
          .table('goals')
          .toCollection()
          .modify((g: Record<string, unknown>) => {
            const free = typeof g.freeText === 'string' ? g.freeText.trim() : '';
            const aim = typeof g.aim === 'string' ? g.aim.trim() : '';
            if (free) g.aim = aim ? `${aim}\n\n${free}` : free;
            delete g.freeText;
          }),
      );
  }
}

export const db = new OrbitDB();

export async function wipeDatabase(): Promise<void> {
  await db.delete();
  await db.open();
}
