import type {
  ActionItem,
  Affiliation,
  AuditEntry,
  Brief,
  CalendarEvent,
  CoffeeChat,
  Edge,
  EmailMessage,
  EmailThread,
  FeedbackEvent,
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

export interface IntegrationAccount {
  id: string;
  userId: string;
  provider: 'google' | 'linkedin_csv' | 'granola' | 'fathom' | 'wispr_export' | 'tracker_import' | 'demo';
  externalAccountId?: string;
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
}

export interface KV {
  key: string;
  value: unknown;
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
  }
}

export const db = new OrbitDB();

export async function wipeDatabase(): Promise<void> {
  await db.delete();
  await db.open();
}
