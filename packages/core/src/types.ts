// Domain types for Orbit. Mirrors docs/orbit/03-data-model.md, trimmed to what the client-side v1 stores.
export type ID = string;

export type IntegrationProvider =
  | 'google'
  | 'linkedin_csv'
  /** the student's own LinkedIn account connected through Unipile, synced live */
  | 'linkedin_live'
  | 'granola'
  | 'fathom'
  | 'fireflies'
  /** Wispr Flow's Notetaker, read by signing in */
  | 'wispr'
  /** the student's Cal.com account: its event types become the booking link drafts offer */
  | 'calcom'
  | 'wispr_export'
  | 'tracker_import'
  /** the Mac's Messages database, imported and read in the browser */
  | 'imessage'
  | 'demo';
export type PersonSource =
  | 'gmail'
  | 'calendar'
  | 'linkedin_csv'
  | 'enrichment'
  | 'tracker_import'
  | 'manual'
  /** found on LinkedIn beyond the student's connections and saved to contact: not someone they know yet */
  | 'linkedin_search'
  | 'note'
  | 'recommendation'
  /** someone the student texts, named in their Contacts */
  | 'imessage'
  /**
   * the person's own LinkedIn profile read live (plan 17 E): the source of truth for their current position, below
   * only the student's own edit
   */
  | 'linkedin_profile'
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
  | 'same_current_company'
  /** both wrote on one thread (plan 16 §4.1) */
  | 'email_exchange'
  /** one wrote to the student with the other in To/Cc */
  | 'email_cc'
  /** LinkedIn mutual connection (Unipile connections_of) */
  | 'linkedin_mutual'
  /** an introducer Village returned */
  | 'village_path';
export type TouchpointKind =
  | 'email_in'
  | 'email_out'
  | 'email_cc'
  | 'meeting'
  | 'linkedin_in'
  | 'linkedin_out'
  /** an iMessage or SMS from them / to them, one per day each way (imported from the Mac's Messages) */
  | 'text_in'
  | 'text_out'
  | 'linkedin_connected'
  | 'linkedin_engaged'
  /** they commented on one of the student's LinkedIn posts (one per comment) */
  | 'linkedin_comment_in'
  /** the student commented on one of their LinkedIn posts (one per comment) */
  | 'linkedin_comment_out'
  /** they reacted to one of the student's LinkedIn posts (one per post; dated by the post, LinkedIn gives no time) */
  | 'linkedin_reaction_in'
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
  | 'fireflies'
  /** a meeting recorded by Wispr Flow's Notetaker */
  | 'wispr_notetaker'
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
  | 'confirm_note_match'
  /** "Did Lena introduce you to Sam?": a group email the introduction cues could not call (see possibleIntroduction) */
  | 'confirm_intro';
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
/**
 * `queued`: approved for a provider send, waiting out the undo window until `sendAt`.
 * `handed_off`: opened in the student's mail app or LinkedIn; not `sent` until the student confirms they sent it.
 */
export type OutboundStatus =
  | 'draft'
  | 'approved'
  | 'queued'
  | 'sending'
  | 'handed_off'
  | 'sent'
  | 'failed'
  | 'cancelled';
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
  | 'report_back'
  /** a first message to someone new (plan 16 §7.2) */
  | 'first_touch'
  /** a first message that names the mutual connection */
  | 'warm_first_touch'
  /** a third-person note the introducer can forward unchanged (≤ 90 words, double opt-in) */
  | 'forwardable_blurb'
  /** a genuine update to a dormant tie (score ≥ 30, no contact in 180 days); no ask unless the student wants one */
  | 'reengage';
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
  /** first-run hints the student closed; they never come back */
  dismissedHints?: string[];
  /** the morning debrief in the corner of the screen; on unless turned off */
  morningBrief?: boolean;
  /** the local day (YYYY-MM-DD) the debrief was last opened or closed, so it shows once a day */
  morningSeenOn?: string;
}

/** What a goal is for (plan 16 §2.1); it changes the register, the ask and the routing rules. */
export type GoalKind =
  | 'recruiting'
  | 'fundraising'
  | 'sales'
  | 'hiring'
  | 'advice'
  | 'cofounder'
  | 'community'
  | 'collaboration';

export const GOAL_KINDS: readonly GoalKind[] = [
  'recruiting',
  'fundraising',
  'sales',
  'hiring',
  'advice',
  'cofounder',
  'community',
  'collaboration',
];

/** A goal the student is working toward (orbit.goals, plan 16 §11.3). A student has 0–5 active goals. */
export interface Goal {
  id: ID;
  userId: ID;
  kind: GoalKind;
  title: string;
  description?: string;
  targets: { organizations: string[]; roles: string[]; geographies: string[]; people: string[] };
  /** sourcing filters: sector, stage, seniority, skills, keywords */
  criteria: Record<string, unknown>;
  /** "8 coffee chats with PMs by Dec 1" */
  successMetric?: string;
  priority: 1 | 2 | 3;
  status: 'active' | 'paused' | 'done';
  /** overrides the student's autonomy level for this goal (§8.4) */
  autonomyLevel?: 0 | 1 | 2;
  /** YYYY-MM-DD */
  dueAt?: string;
  source: 'user' | 'onboarding' | 'inferred';
  /** the student's words an inferred goal came from */
  evidence?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
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
  /** when the student last changed `status` (drives the applied, interviewing and offer updates) */
  statusChangedAt?: string;
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
  /** The student unchecked it when reviewing the parse: it is never used for matching or in messages. */
  excluded?: boolean;
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
  /** LinkedIn's own id for the company (from a profile's current position), for looking its page up again */
  linkedinCompanyId?: string;
  industry?: string;
  sizeBucket?: string;
  /** the company's logo, from its LinkedIn page; LinkedIn's image links expire, so it is fetched again when it does */
  logoUrl?: string;
}

export type PersonField =
  | 'displayName'
  | 'currentTitle'
  | 'currentOrganizationId'
  | 'headline'
  | 'location'
  | 'school';

export interface Person {
  id: ID;
  userId: ID;
  displayName: string;
  firstName: string;
  lastName: string;
  nameNormalized: string;
  primaryEmail?: string;
  /** the primary address as the student's source wrote it ("marcus.bell@gmail.com"); `primaryEmail` is the matching key */
  primaryEmailAsWritten?: string;
  emails: string[];
  /** phone numbers, as +15551234567 (from the student's Contacts when they import their texts) */
  phones?: string[];
  linkedinUrl?: string;
  linkedinSlug?: string;
  /** LinkedIn's member id, kept from a live (Unipile) sync so mutual-connection lookups can name this person */
  linkedinMemberId?: string;
  headline?: string;
  currentTitle?: string;
  currentOrganizationId?: ID;
  currentOrganizationRaw?: string;
  location?: string;
  photoUrl?: string;
  school?: string;
  isAlumni?: boolean;
  relationshipType: RelationshipType;
  /** tie score / 100 (0 when there is no tie at all) */
  strength: number;
  strengthBreakdown?: StrengthBreakdown;
  /** tie score 0–100 (plan 16 §3) */
  tieScore?: number;
  tieBand?: TieScoreSummary['band'];
  /** why the score is what it is, in plain sentences */
  tieExplanation?: string[];
  firstSeenAt?: string;
  lastInteractionAt?: string;
  interactionCount: number;
  sources: PersonSource[];
  linkedinConnectedOn?: string;
  isHuman: boolean;
  /** displayName is only a stand-in derived from the email address; the first real name replaces it */
  namePlaceholder?: boolean;
  /** which source last wrote each profile field, for source precedence (manual > enrichment > CSV > ... ) */
  fieldSources?: Partial<Record<PersonField, PersonSource>>;
  hiddenAt?: string;
  /** they asked not to be contacted (an `unsubscribe` reply, plan 16 §8.1): nothing is drafted or sent to them */
  doNotContact?: boolean;
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
  /** w·c for ties inferred with a confidence (graph/ties.ts); w alone for v1 edges */
  weight: number;
  /** c of the kind (§4.1); absent on v1 edges */
  confidence?: number;
  /** kinds behind the edge (one per kind today) */
  kinds?: EdgeType[];
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
  /** the 0–100 tie score behind `strength` (plan 16 §3; strength = score / 100) */
  tieScore?: TieScoreSummary;
}

/** What is kept of a tie score on the person (orbit.tie_scores in account mode). */
export interface TieScoreSummary {
  score: number;
  band: 'faint' | 'light' | 'warm' | 'strong' | 'close';
  explanation: string[];
  /** w_i · (f_i − baseline_i) per feature */
  contributions: Record<string, number>;
  features: Record<string, number>;
  modelVersion: string;
  /** the top mutual contacts behind the structural feature, kept so a single-person rescore can reuse them */
  mutuals?: { name: string; score: number }[];
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
  /** set when a message in the thread introduced the student to someone (see detectIntroduction) */
  introduction?: { introducerId: ID; introducedIds: ID[]; messageId: ID; at: string };
  /**
   * A message in the thread that may have introduced the student to someone, which the cues could not call: Orbit
   * asks ("Did Lena introduce you to Sam?"). `confirmed` recorded it as `introduction`; `dismissed` is the student's
   * no, remembered for the thread; `retired` means the question stopped being true (an introduction was recorded
   * from a later message, or the student already writes to the person).
   */
  possibleIntroduction?: {
    introducerId: ID;
    personIds: ID[];
    messageId: ID;
    at: string;
    status: 'open' | 'confirmed' | 'dismissed' | 'retired';
    decidedAt?: string;
  };
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
  /** the reply class (plan 16 §8.1) and its confidence, set by the server's classifier */
  replyClass?: string;
  replyConfidence?: number;
  extraction?: MessageExtraction;
  processedAt?: string;
}

export interface ProposedTime {
  startIso: string;
  endIso?: string;
  raw: string;
  /** IANA zone the sender stated ("2pm ET"); absent when the time was read in the student's own zone */
  timeZone?: string;
}

export interface MessageExtraction {
  proposedTimes: ProposedTime[];
  asksOfUser: string[];
  offers: string[];
  factsAboutSender: { type: FactType; text: string }[];
  sentiment: 'warm' | 'neutral' | 'cool';
  /** out-of-office return date (YYYY-MM-DD) when the auto-reply states one */
  returnDate?: string;
  /** a soft "not now" that says when to try again ("ping me in January"): first day to follow up (YYYY-MM-DD) */
  followUpAfter?: string;
  /** they declined a call but offered to answer questions over email: reply by email, never propose times */
  prefersEmail?: boolean;
  /** an intro or redirect that hands the student to someone else (named, cc'd): the next step is with them */
  handoff?: boolean;
  /** on a decline: "hard" is a no; "soft" is a not now, a wrong person, or a bare "best of luck" to a pending ask */
  decline?: 'hard' | 'soft';
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
  /** when Orbit put it on the student's Google Calendar and Google emailed the invite to the other person */
  inviteSentAt?: string;
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
  /** the goal this chat serves (plan 16 §2.1: every chat carries one in account mode) */
  goalId?: ID;
  outreachChannel?: Channel;
  firstOutreachAt?: string;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  bumpCount: number;
  /** the person's out-of-office return date (YYYY-MM-DD); bumps wait until the day after */
  outOfOfficeUntil?: string;
  /** an out-of-office reply pushed the next bump back: not before this time (return date plus two business days) */
  bumpNotBefore?: string;
  scheduledEventId?: ID;
  completedAt?: string;
  followedUpAt?: string;
  threadId?: ID;
  warmUp?: WarmUpPlan;
  /** who introduced or pointed the student to this person (for the opener and the report-back) */
  referrerPersonId?: ID;
  referrerName?: string;
  /** questions the student picked on the Prep tab for the next conversation */
  prepQuestions?: string[];
  /** when the referrer introduced the student to this person by email (the chat was opened from that intro) */
  introducedAt?: string;
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
  /**
   * What the note records about its people: `meeting`, a conversation with them (they met or talked: a meeting
   * touch, their chat completed, a thank-you next); `group_meeting`, a large recorded meeting (a light touch for
   * people the student already has a chat with, nothing more); `mention`, a note that only names them (what it says
   * about them is filed, no meeting). Absent on notes saved before it existed, which were all filed as meetings.
   */
  noteKind?: 'meeting' | 'group_meeting' | 'mention';
  extraction?: NoteExtraction;
  summary?: string;
  processedAt?: string;
  createdAt: string;
}

export interface NoteExtraction {
  summary: string;
  /**
   * `about` is the person the fact is about (a person id from the heuristic path, a name from the LLM);
   * `text` is a clause addressed to them ("you lead a small team on payments"); `evidence` is the sentence
   * it came from.
   */
  facts: { about: string; type: FactType; text: string; confidence: number; evidence?: string }[];
  actionItems: { owner: 'user' | 'counterpart'; text: string; dueHint?: string; about?: string }[];
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
  /** the raw sentence the fact was extracted from (the fact text itself is a cleaned clause) */
  evidence?: string;
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
  /** the goal this draft serves (plan 16 §2.1) */
  goalId?: ID;
  channel: Channel;
  kind: MessageKind;
  externalThreadId?: string;
  inReplyToMessageId?: string;
  toEmail?: string;
  /** blind copies: the introducer, moved to bcc on a reply-all to their introduction */
  bccEmails?: string[];
  toLinkedinUrl?: string;
  subject?: string;
  bodyDraft: string;
  bodyFinal?: string;
  bodyFinalHash?: string;
  status: OutboundStatus;
  /**
   * How a hand-off left Orbit (status `handed_off`): opened in the mail app, opened on LinkedIn, or copied for the
   * student to paste into Gmail in the browser. Either way it waits for the student's "I sent it".
   */
  handoffVia?: 'mailto' | 'linkedin_compose' | 'linkedin_connect' | 'copy';
  approvedAt?: string;
  queuedAt?: string;
  /** end of the undo window for a queued provider send; for an autopilot send, the time it is planned for */
  sendAt?: string;
  /** approved for autopilot: Orbit sends it itself at `sendAt`, spaced from the others, after checking it again */
  autopilot?: boolean;
  sentAt?: string;
  providerMessageId?: string;
  error?: string;
  generatedBy: 'template' | 'llm';
  claims?: DraftClaim[];
  needsInput?: DraftNeed[];
  opening?: string;
  /** the thread says to wait: send no earlier than this (the student's own note to them went out days ago) */
  holdUntil?: string;
  /** when the draft's words were last written: a draft that says "yesterday" is rewritten the next day */
  draftedAt?: string;
  createdAt: string;
}

/** A composed message (plan 16 §7.3): what the composer, LLM or template, hands to the validator and the send path. */
export interface ComposedMessage {
  id: ID;
  goalId: ID | null;
  personId: ID;
  kind: MessageKind;
  channel: 'gmail' | 'linkedin';
  /** gmail only */
  subject: string | null;
  body: string;
  ask: { kind: 'call' | 'question' | 'interest' | 'intro' | 'none'; text: string };
  /** at least one for first touches, each with the dossier or history item it came from */
  hooks: { text: string; sourceId: string }[];
  via?: { introducerId: ID; pathScore: number };
  sendWindow: { notBefore: string; tz: string };
  validator: { ok: boolean; issues: string[]; words: number; grade: number };
  /** e.g. 'compose-v2.0', or 'template-v2' for the fallback */
  promptVersion: string;
  /** A/B arm */
  variant: string | null;
}

/** What a draft is missing that only the student can supply (the needs-input prompt in the editor). */
export type DraftNeed =
  | 'connection'
  | 'update'
  | 'post'
  | 'news'
  | 'target'
  | 'answer'
  | 'role'
  | 'takeaway'
  | 'posting'
  /** the name of a mutual tie the connection line mentions without one ("my roommate") */
  | 'mutual'
  /** a reminder, not a line to write: the message says the resume is attached, so the student attaches it */
  | 'resume';

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
  /** why the system retired it (status `expired`): the trigger went away, the chat moved on, the time passed */
  expiredReason?: string;
  /** still true but did not make today's brief; kept (without a draft) for the next brief and listed under "more" */
  deferred?: boolean;
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

/** A research dossier on a person (orbit.dossiers, plan 16 §5). `content` is the synthesis, `sources` its citations. */
export interface Dossier {
  id: ID;
  userId: ID;
  personId: ID;
  goalId?: ID;
  status: 'pending' | 'ready' | 'partial' | 'needs_disambiguation' | 'failed';
  content?: Record<string, unknown>;
  sources: { id: string; url?: string; title?: string; [k: string]: unknown }[];
  candidates?: unknown[];
  costUsd: number;
  model?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
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
  /** how many of the samples it was learned from came from each place */
  sources?: Partial<Record<StyleSource, number>>;
  /** the student set some of it by hand: their choices win over anything learned later */
  custom?: boolean;
}

/** Where a writing sample came from: sent email, LinkedIn messages, messages sent from Orbit, or pasted in. */
export type StyleSource = 'email' | 'linkedin' | 'orbit' | 'pasted';

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
    | 'warmup_skip'
    | 'intro_confirm'
    | 'intro_reject';
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
