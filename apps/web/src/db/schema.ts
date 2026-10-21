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
    | 'calcom'
    | 'wispr_export'
    | 'tracker_import'
    | 'demo';
  externalAccountId?: string;
  /** live LinkedIn: the token Orbit's server gave this browser for the account; account calls carry it */
  accessToken?: string;
  /** an app connected by signing in (Cal.com, Fathom): `accessToken` expires and is renewed with this */
  oauth?: { refreshToken?: string; expiresAt?: string };
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
  }
}

export const db = new OrbitDB();

export async function wipeDatabase(): Promise<void> {
  await db.delete();
  await db.open();
}
