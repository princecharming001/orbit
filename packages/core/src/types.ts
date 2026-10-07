// Domain types for Orbit. Mirrors docs/orbit/03-data-model.md, trimmed to what the client-side v1 stores.
export type ID = string;

export type IntegrationProvider =
  | 'google'
  | 'linkedin_csv'
  | 'granola'
  | 'fathom'
  | 'wispr_export'
  | 'tracker_import'
  | 'demo';
export type PersonSource =
  | 'gmail'
  | 'calendar'
  | 'linkedin_csv'
  | 'enrichment'
  | 'tracker_import'
  | 'manual'
  | 'note'
  | 'recommendation'
  | 'demo';
export type RelationshipType =
  | 'unknown'
  | 'recruiter'
  | 'alumni'
  | 'peer'
  | 'mentor'
  | 'professor'
  | 'family_friend'
  | 'colleague'
  | 'other';
export type AffiliationKind = 'employment' | 'education';
export type EdgeType =
  | 'co_tenure'
  | 'same_school_cohort'
  | 'email_cothread'
  | 'meeting_coattendee'
  | 'introduced_by'
  | 'same_current_company';
export type TouchpointKind =
  | 'email_in'
  | 'email_out'
  | 'email_cc'
  | 'meeting'
  | 'linkedin_in'
  | 'linkedin_out'
  | 'linkedin_connected'
  | 'linkedin_engaged'
  | 'note'
  | 'manual_log'
  | 'intro_observed';
export type ChatStage =
  | 'identified'
  | 'warming'
  | 'outreach_sent'
  | 'replied'
  | 'scheduling'
  | 'scheduled'
  | 'completed'
  | 'followed_up'
  | 'nurturing'
  | 'declined'
  | 'no_response'
  | 'archived';
export type ChatSource = 'recommendation' | 'manual' | 'detected' | 'tracker_import' | 'reach';
export type Actor = 'system' | 'user';
export type NoteSource =
  | 'granola_api'
  | 'granola_email'
  | 'fathom'
  | 'wispr_capture'
  | 'wispr_export'
  | 'manual'
  | 'email_ingest'
  | 'upload'
  | 'tracker_import';
export type FactType =
  | 'role_detail'
  | 'background'
  | 'advice'
  | 'personal'
  | 'offer'
  | 'hook'
  | 'preference'
  | 'ask_made'
  | 'contact_info'
  | 'connection';
export type SuggestionKind =
  | 'new_outreach'
  | 'warm_up_engage'
  | 'report_back'
  | 'follow_up_bump'
  | 'schedule_propose'
  | 'schedule_confirm'
  | 'prep_brief'
  | 'thank_you'
  | 'action_item_reminder'
  | 'nurture_checkin'
  | 'reconnect'
  | 'congratulate'
  | 'ask_referral'
  | 'intro_request'
  | 'confirm_stage'
  | 'confirm_merge'
  | 'confirm_note_match';
export type SuggestionStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'snoozed'
  | 'dismissed'
  | 'sent'
  | 'expired'
  | 'done';
export type Channel = 'gmail' | 'linkedin' | 'clipboard';
export type OutboundStatus = 'draft' | 'approved' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
export type MessageKind =
  | 'outreach'
  | 'bump'
  | 'schedule'
  | 'thank_you'
  | 'nurture'
  | 'congratulate'
  | 'referral_ask'
  | 'intro_request'
  | 'reply'
  | 'report_back';
export type Sector = 'finance' | 'consulting' | 'tech' | 'general';
export type Seniority = 'junior' | 'mid' | 'senior' | 'exec';
export type EmailCategory =
  | 'networking'
  | 'recruiting_process'
  | 'personal'
  | 'transactional'
  | 'newsletter'
  | 'automated'
  | 'other';
export type ReplySignal =
  | 'reply_positive'
  | 'reply_neutral'
  | 'reply_decline'
  | 'scheduling_proposal'
  | 'scheduling_confirmation'
  | 'reschedule'
  | 'thank_you'
  | 'referral_offer'
  | 'intro_offer'
  | 'question'
  | 'out_of_office'
  | 'other';
export type EmailDirection = 'inbound' | 'outbound';

export interface User {
  id: ID;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
  school: string;
  schoolDomain?: string;
  graduationYear?: number;
  degree?: string;
  majors: string[];
  homeCity?: string;
  currentCity?: string;
  timezone: string;
  linkedinUrl?: string;
  onboardingStep: number; // 1..10, 11 = done
  onboardingCompletedAt?: string;
  createdAt: string;
}

export interface UserSettings {
  userId: ID;
  briefTimeLocal: string; // "07:00"
  briefChannels: ('email' | 'in_app')[];
  quietDays: number[];
  weeklyOutreachTarget: number;
  dailySendCapGmail: number;
  dailySendCapLinkedin: number;
  perPersonCooldownHours: number;
  maxBumps: number;
  tonePreset: 'warm' | 'direct' | 'formal';
  schedulingLink?: string;
  warmUpEnabled: boolean;
  warmUpDays: number; // days of warm-up before cold LinkedIn outreach
  anthropicApiKey?: string;
  googleClientId?: string;
}

export interface RecruitingGoals {
  userId: ID;
  cycleLabel: string;
  targetRoles: string[];
  targetFunctions: string[];
  targetIndustries: string[];
  targetLocations: string[];
  freeText?: string;
  ambition: 1 | 2 | 3;
}

export interface TargetCompany {
  id: ID;
  userId: ID;
  organizationId?: ID;
  nameRaw: string;
  priority: 1 | 2 | 3;
  status: 'researching' | 'applied' | 'interviewing' | 'offer' | 'closed';
  deadline?: string;
  notes?: string;
}

export interface ResumeFacet {
  id: ID;
  resumeId: ID;
  kind: 'experience' | 'education' | 'project' | 'skill_group' | 'interest' | 'summary';
  title?: string;
  organizationName?: string;
  startDate?: string;
  endDate?: string;
  text: string;
  keywords: string[];
  confirmed: boolean;
}

export interface Resume {
  id: ID;
  userId: ID;
  filename: string;
  text: string;
  parsedAt?: string;
  parseSource?: 'heuristic' | 'llm';
  isCurrent: boolean;
  createdAt: string;
}

export interface Organization {
  id: ID;
  name: string;
  nameNormalized: string;
  domains: string[];
  linkedinSlug?: string;
  industry?: string;
  sizeBucket?: string;
  logoUrl?: string;
}

export interface Person {
  id: ID;
  userId: ID;
  displayName: string;
  firstName: string;
  lastName: string;
  nameNormalized: string;
  primaryEmail?: string;
  emails: string[];
  linkedinUrl?: string;
  linkedinSlug?: string;
  headline?: string;
  currentTitle?: string;
  currentOrganizationId?: ID;
  currentOrganizationRaw?: string;
  location?: string;
  photoUrl?: string;
  school?: string;
  isAlumni?: boolean;
  relationshipType: RelationshipType;
  strength: number;
  strengthBreakdown?: StrengthBreakdown;
  firstSeenAt?: string;
  lastInteractionAt?: string;
  interactionCount: number;
  sources: PersonSource[];
  linkedinConnectedOn?: string;
  isHuman: boolean;
  hiddenAt?: string;
  summary?: string;
  summaryUpdatedAt?: string;
  talkingPoints?: string[];
  tags: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Affiliation {
  id: ID;
  userId: ID;
  personId: ID;
  kind: AffiliationKind;
  organizationId?: ID;
  nameRaw: string;
  title?: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  isCurrent: boolean;
  source: PersonSource;
}

export interface Edge {
  id: ID;
  userId: ID;
  personAId: ID;
  personBId: ID;
  type: EdgeType;
  weight: number;
  evidence: Record<string, unknown> & { text?: string };
}

export interface Touchpoint {
  id: ID;
  userId: ID;
  personId: ID;
  kind: TouchpointKind;
  occurredAt: string;
  refTable: string;
  refId: ID;
  summary?: string;
  weight: number;
}

export interface StrengthBreakdown {
  raw: number;
  recency: number;
  counts: Partial<Record<TouchpointKind, number>>;
  /** latest touch of any kind, CC and LinkedIn connection included */
  lastInteractionAt?: string;
  /** latest email, meeting, logged chat or LinkedIn message: what the student would call talking */
  lastConversationAt?: string;
}

export interface EmailThread {
  id: ID;
  userId: ID;
  externalThreadId: string;
  subject?: string;
  snippet?: string;
  firstMessageAt?: string;
  lastMessageAt?: string;
  messageCount: number;
  participantEmails: string[];
  participantPersonIds: ID[];
  category?: EmailCategory;
  categoryConfidence?: number;
  isNetworking: boolean;
  chatId?: ID;
  classifiedAt?: string;
  classifiedBy?: 'heuristic' | 'llm';
}

export interface EmailMessage {
  id: ID;
  userId: ID;
  threadId: ID;
  externalMessageId: string;
  direction: EmailDirection;
  fromEmail: string;
  fromName?: string;
  toEmails: string[];
  ccEmails: string[];
  fromPersonId?: ID;
  sentAt: string;
  subject?: string;
  bodyText: string; // quotes stripped
  headers: Record<string, string>;
  isAutomated: boolean;
  signal?: ReplySignal;
  signalConfidence?: number;
  extraction?: MessageExtraction;
  processedAt?: string;
}

export interface ProposedTime {
  startIso: string;
  endIso?: string;
  raw: string;
}

export interface MessageExtraction {
  proposedTimes: ProposedTime[];
  asksOfUser: string[];
  offers: string[];
  factsAboutSender: { type: FactType; text: string }[];
  sentiment: 'warm' | 'neutral' | 'cool';
}

export interface CalendarEvent {
  id: ID;
  userId: ID;
  externalEventId: string;
  title?: string;
  description?: string;
  startAt: string;
  endAt: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees: { email: string; displayName?: string; responseStatus?: string; self?: boolean }[];
  attendeePersonIds: ID[];
  conferenceUrl?: string;
  isCoffeeChat?: boolean;
  coffeeChatConfidence?: number;
  chatId?: ID;
}

export interface CoffeeChat {
  id: ID;
  userId: ID;
  personId: ID;
  organizationId?: ID;
  stage: ChatStage;
  stageEnteredAt: string;
  source: ChatSource;
  goalTags: string[];
  outreachChannel?: Channel;
  firstOutreachAt?: string;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  bumpCount: number;
  scheduledEventId?: ID;
  completedAt?: string;
  followedUpAt?: string;
  threadId?: ID;
  warmUp?: WarmUpPlan;
  /** who introduced or pointed the student to this person (for the opener and the report-back) */
  referrerPersonId?: ID;
  referrerName?: string;
  priority: 1 | 2 | 3;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageEvent {
  id: ID;
  userId: ID;
  chatId: ID;
  fromStage?: ChatStage;
  toStage: ChatStage;
  status: 'applied' | 'proposed' | 'confirmed' | 'rejected';
  actor: Actor;
  reason: string;
  evidenceRefTable?: string;
  evidenceRefId?: ID;
  confidence?: number;
  createdAt: string;
  decidedAt?: string;
}

export interface WarmUpAction {
  id: ID;
  kind: 'view_profile' | 'react_post' | 'comment_post' | 'follow';
  label: string;
  url: string;
  dueAt: string;
  doneAt?: string;
  skippedAt?: string;
  note?: string; // what the student engaged with (post topic / their comment), used as the warm-up hook in outreach
}

export interface WarmUpPlan {
  startedAt: string;
  readyAt: string; // earliest date outreach is suggested
  actions: WarmUpAction[];
}

export interface MeetingNote {
  id: ID;
  userId: ID;
  source: NoteSource;
  externalId?: string;
  title?: string;
  occurredAt: string;
  rawText: string;
  rawSummary?: string;
  attendees: { name?: string; email?: string }[];
  personIds: ID[];
  chatId?: ID;
  calendarEventId?: ID;
  matchStatus: 'auto' | 'confirmed' | 'unmatched' | 'rejected';
  matchConfidence?: number;
  extraction?: NoteExtraction;
  summary?: string;
  processedAt?: string;
  createdAt: string;
}

export interface NoteExtraction {
  summary: string;
  facts: { about: string; type: FactType; text: string; confidence: number }[];
  actionItems: { owner: 'user' | 'counterpart'; text: string; dueHint?: string }[];
  offers: string[];
  hooks: string[];
  warmth: 'warm' | 'neutral' | 'cool';
  suggestedNextStep: string;
}

export interface PersonFact {
  id: ID;
  userId: ID;
  personId: ID;
  type: FactType;
  text: string;
  sourceTable: string;
  sourceId: ID;
  occurredAt?: string;
  confidence: number;
  deletedAt?: string;
  createdAt: string;
}

export interface ActionItem {
  id: ID;
  userId: ID;
  personId?: ID;
  chatId?: ID;
  text: string;
  dueAt?: string;
  status: 'open' | 'done' | 'dismissed';
  sourceTable?: string;
  sourceId?: ID;
  createdAt: string;
}

export interface OutboundMessage {
  id: ID;
  userId: ID;
  personId: ID;
  chatId?: ID;
  suggestionId?: ID;
  channel: Channel;
  kind: MessageKind;
  externalThreadId?: string;
  inReplyToMessageId?: string;
  toEmail?: string;
  toLinkedinUrl?: string;
  subject?: string;
  bodyDraft: string;
  bodyFinal?: string;
  bodyFinalHash?: string;
  status: OutboundStatus;
  approvedAt?: string;
  queuedAt?: string;
  sentAt?: string;
  providerMessageId?: string;
  error?: string;
  generatedBy: 'template' | 'llm';
  claims?: DraftClaim[];
  needsInput?: ('connection' | 'update' | 'post')[];
  opening?: string;
  createdAt: string;
}

export interface DraftClaim {
  text: string;
  factId?: string;
  kind: 'about_person' | 'about_user' | 'shared' | 'logistics';
}

export interface Suggestion {
  id: ID;
  userId: ID;
  kind: SuggestionKind;
  personId?: ID;
  chatId?: ID;
  outboundMessageId?: ID;
  briefId?: ID;
  priorityScore: number;
  reasonText: string;
  signals: Record<string, unknown>;
  payload: Record<string, unknown>;
  status: SuggestionStatus;
  dedupeKey: string;
  snoozedUntil?: string;
  carriedOver: number;
  expiresAt: string;
  decidedAt?: string;
  createdAt: string;
}

export interface Brief {
  id: ID;
  userId: ID;
  kind: 'welcome' | 'daily' | 'recap';
  briefDate: string; // YYYY-MM-DD
  generatedAt: string;
  openedAt?: string;
  suggestionIds: ID[];
  summaryText: string;
  stats: Record<string, number>;
}

export interface Recommendation {
  id: ID;
  userId: ID;
  personId: ID;
  score: number;
  fitScore: number;
  reachScore: number;
  responsePrior: number;
  reasons: { code: string; text: string }[];
  bestPath?: ReachPath;
  status: 'new' | 'saved' | 'dismissed' | 'converted' | 'expired';
  dismissedReason?: string;
  batchDate: string;
}

export interface ReachHop {
  fromId: ID; // 'user' for the student
  toId: ID;
  weight: number;
  type: EdgeType | 'strength' | 'alumni' | 'former';
  text: string;
}

export interface ReachPath {
  hops: ReachHop[];
  score: number;
  band: 'strong' | 'possible' | 'long_shot';
}

export interface StyleCard {
  greetingPatterns: string[];
  signoffs: string[];
  formality: number;
  avgSentenceWords: number;
  avgMessageWords: number;
  contractions: boolean;
  exclamationsPerMessage: number;
  emoji: boolean;
  characteristicPhrases: string[];
  avoid: string[];
  notes: string;
  builtFromCount: number;
  version: number;
}

export interface FeedbackEvent {
  id: ID;
  userId: ID;
  kind:
    | 'approve'
    | 'edit'
    | 'dismiss'
    | 'snooze'
    | 'expire'
    | 'stage_confirm'
    | 'stage_correct'
    | 'merge_accept'
    | 'merge_reject'
    | 'fact_delete'
    | 'recommendation_dismiss'
    | 'warmup_done'
    | 'warmup_skip';
  suggestionId?: ID;
  outboundMessageId?: ID;
  refTable?: string;
  refId?: ID;
  reason?: string;
  editDistance?: number;
  createdAt: string;
}

export interface Notification {
  id: ID;
  userId: ID;
  kind:
    | 'brief'
    | 'reply_received'
    | 'chat_tomorrow'
    | 'action_item_due'
    | 'integration_problem'
    | 'weekly_recap'
    | 'system';
  title: string;
  body?: string;
  link?: string;
  readAt?: string;
  createdAt: string;
}

export interface AuditEntry {
  id: ID;
  userId: ID;
  actor: Actor;
  action: string;
  objectTable?: string;
  objectId?: ID;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MergeSuggestion {
  id: ID;
  userId: ID;
  personAId: ID;
  personBId: ID;
  score: number;
  features: Record<string, number>;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  createdAt: string;
}
