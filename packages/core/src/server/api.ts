/**
 * The orbit-api contract (plan 16 §11.3, §19 P3–P6): every request and response body the account-mode client and
 * the Edge Function exchange. Both sides import these types, so a change here is a change to both.
 *
 * All routes are POST with a JSON body and `Authorization: Bearer <Orbit access token>`, except the Google sign-in
 * redirects. Errors are `{ error: { code, message } }` with an HTTP status; a missing provider key answers 503 with
 * header `x-orbit-connector: unconfigured` and body `{ error: { code: 'unconfigured', missing: string[] } }`.
 */

import type { ReplyClass } from '../email/replyClass';
import type { WarmPath } from '../graph/route';
import type { OwnWords } from '../ownWords';
import type { TieBand } from '../scoring/tieScore';
import type { Dossier, Goal, GoalKind, MessageKind, StyleCard } from '../types';

export type ApiChannel = 'gmail' | 'linkedin';

// ---- integrations (P3) ---------------------------------------------------------------------------------------------

/** POST /google/sync */
export interface GoogleSyncRequest {
  mode: 'backfill' | 'incremental';
}
/** POST /linkedin/connect/start → open `url` (Unipile hosted auth); the webhook finishes the connection */
export interface LinkedinConnectStartResponse {
  url: string;
}
/** POST /linkedin/status */
export interface LinkedinStatusResponse {
  status: 'not_connected' | 'connecting' | 'active' | 'needs_reauth' | 'error';
  accountId: string | null;
  lastSyncedAt: string | null;
  relations: number;
}
/** POST /linkedin/sync, POST /google/sync, POST /research/person (queued work) */
export interface QueuedResponse {
  queued: boolean;
  /** why nothing was queued, e.g. 'already_running' or 'not_connected' */
  reason?: string;
}

// ---- goals and scores (P5) -----------------------------------------------------------------------------------------

/** POST /goals/list */
export interface GoalsListResponse {
  goals: Goal[];
}
/** POST /goals/upsert: `id` absent creates; at most 5 active goals (409 `too_many_goals`) */
export interface GoalUpsertRequest {
  goal: Partial<Goal> & { kind: GoalKind; title: string };
}
export interface GoalUpsertResponse {
  goal: Goal;
}
/** POST /goals/archive */
export interface IdRequest {
  id: string;
}

/** One turn of the chat, as the post-turn passes (memory, goal inference) read it. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}
/** POST /goals/infer: at most 6 turns, 8,000 characters in all. Proposes goals (§1.6); nothing is saved. */
export interface GoalsInferRequest {
  turns: ChatTurn[];
}
export interface ProposedGoal {
  kind: GoalKind;
  /** at most 60 characters */
  title: string;
  targets: Goal['targets'];
  criteria: { sector?: string; stage?: string; seniority?: string[]; skills?: string[]; keywords?: string[] };
  successMetric: string | null;
  /** YYYY-MM-DD */
  dueAt: string | null;
  /** the active goal this refines, when it is one */
  isUpdateOf: string | null;
  /** the student's own words it came from (always a substring of what they wrote) */
  quote: string;
}
export interface GoalsInferResponse {
  goals: ProposedGoal[];
  /** Claude is not configured on the server: nothing was inferred */
  unconfigured?: true;
}

/** POST /scores/explain */
export interface ScoreExplainRequest {
  personId: string;
}
export interface ScoreExplainResponse {
  personId: string;
  score: number;
  band: TieBand;
  explanation: string[];
  contributions: Record<string, number>;
  modelVersion: string;
  computedAt: string;
  /** set when the student's own label overrides the model (§3.5) */
  labelled?: 1 | 2 | 3 | 4 | 5;
}
/** POST /scores/label */
export interface ScoreLabelRequest {
  personId: string;
  closeness: 1 | 2 | 3 | 4 | 5;
}

// ---- research and sourcing (P4) ------------------------------------------------------------------------------------

/** POST /research/person: queues `enrich.dossier` unless a fresh dossier exists (then returns it) */
export interface ResearchPersonRequest {
  personId: string;
  goalId?: string;
  refresh?: boolean;
}
export interface ResearchPersonResponse {
  status: 'queued' | Dossier['status'];
  dossier: Dossier | null;
}
/** POST /research/get */
export interface ResearchGetRequest {
  personId: string;
}
export interface ResearchGetResponse {
  dossier: Dossier | null;
}
/** POST /research/choose: answers a needs_disambiguation dossier and re-queues it */
export interface ResearchChooseRequest {
  personId: string;
  candidateIndex: number;
}

export interface SourcedCandidate {
  id: string;
  name: string;
  title?: string;
  org?: string;
  location?: string;
  linkedinUrl?: string;
  source: 'unipile' | 'apollo' | 'exa' | 'semantic_scholar';
  rank: number;
  fit: number;
  reach: number;
  responsiveness: number;
  reasons: string[];
  /** already in the student's network */
  knownPersonId?: string;
}
/** POST /source/search */
export interface SourceSearchRequest {
  goalId?: string;
  purpose: GoalKind;
  query?: string;
  filters?: {
    organizations?: string[];
    titles?: string[];
    locations?: string[];
    schools?: string[];
    seniority?: string[];
    keywords?: string[];
  };
  limit?: number;
}
export interface SourceSearchResponse {
  batchId: string;
  results: SourcedCandidate[];
  /** providers skipped because their key is not set */
  unconfigured: string[];
  /** filters dropped to get results (§6.7) */
  relaxed: string[];
}
/** POST /source/add */
export interface SourceAddRequest {
  recommendationIds: string[];
}
export interface SourceAddResponse {
  people: { id: string; displayName: string; chatId: string }[];
}

// ---- warm paths (P4) -----------------------------------------------------------------------------------------------

export type PathTarget =
  | { personId: string }
  | { linkedinUrl: string; name?: string; company?: string }
  | { company: string; domain?: string };

/** POST /paths/find. Node ids are orbit.people ids; the student is 'user'. */
export interface PathsFindRequest {
  target: PathTarget;
  goalId?: string;
}
export interface PathsFindResponse {
  paths: (WarmPath & { id: string; names: Record<string, string> })[];
  fallback?: 'cold';
  direct?: { personId: string; score: number; band: string; text: string };
  /** sources consulted: 'graph', 'linkedin_mutual', 'village', 'friends' (plan 29: a hop through a friend's people) */
  sources: string[];
  unconfigured: string[];
  /**
   * Plan 21: how the hops into a person target were weighed. 'queued': the LinkedIn evidence is being read in the
   * background (hop words may change on the next find; the order only then); 'checked': read within the last 30 days.
   * Absent when there is nothing to read (no LinkedIn, no mutuals with member ids).
   */
  hopEvidence?: 'queued' | 'checked';
}
/** POST /intros/ask: drafts the intro request and the forwardable blurb (never sends) */
export interface IntroAskRequest {
  introducerPersonId: string;
  targetPersonId: string;
  goalId?: string;
  pathScore: number;
  path: WarmPath;
}
export interface IntroAskResponse {
  introRequestId: string;
  draftIds: string[];
}

/**
 * What the path looked like when the intro was asked for (plan 21 §8), stored on orbit.intro_requests.hop_features:
 * P and every hop's p, evidence kind and band, for the fit over outcomes.
 */
export interface IntroHopFeatures {
  p: number;
  hops: { fromId: string; toId: string; p: number; kind: string; band?: string }[];
}

/**
 * The student's corrections on a hop (plan 21 §3.5), both people theirs:
 *   POST /pairs/block    "they don't really know each other": the pair is never a hop until unblocked
 *   POST /pairs/unblock
 *   POST /pairs/close    "they're close": a student_says_close tie (and any block lifted)
 *   POST /pairs/unclose  the tie removed
 */
export interface PairCorrectionRequest {
  aPersonId: string;
  bPersonId: string;
}
export interface PairCorrectionResponse {
  /** the pair, a < b */
  aPersonId: string;
  bPersonId: string;
  blocked: boolean;
  close: boolean;
}

// ---- drafts, replies, calendar (P5) --------------------------------------------------------------------------------

export interface ServerDraft {
  id: string;
  personId: string;
  chatId: string | null;
  goalId: string | null;
  channel: ApiChannel;
  kind: MessageKind;
  subject: string | null;
  body: string;
  status: 'draft' | 'approved' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'discarded' | 'cancelled';
  sendAt: string | null;
  sentAt: string | null;
  validator: { ok: boolean; issues: string[]; words: number; grade: number } | null;
  generatedBy: 'llm' | 'template';
  hooks: { text: string; sourceId: string }[];
  /** text the student must supply before it can be sent ([ASK USER: …], §8.6) */
  needsInput: string[];
  createdAt: string;
  updatedAt: string;
}
/** POST /drafts/compose */
export interface DraftComposeRequest {
  personId: string;
  kind: MessageKind;
  goalId?: string;
  channel: ApiChannel;
  /** reply drafts point at the inbound message */
  replyToMessageId?: string;
}
export interface DraftResponse {
  draft: ServerDraft;
}
/** POST /drafts/approve: `sendAt` absent = next send window (§7.3); LinkedIn needs `confirm: true` from a tap */
export interface DraftApproveRequest {
  draftId: string;
  sendAt?: string;
  confirm?: boolean;
}
/** POST /drafts/cancel, POST /drafts/discard */
export interface DraftIdRequest {
  draftId: string;
}

export interface ReplyItem {
  messageId: string;
  threadId: string;
  personId: string | null;
  personName: string;
  channel: ApiChannel;
  replyClass: ReplyClass;
  confidence: number;
  receivedAt: string;
  snippet: string;
  draftId: string | null;
}
/** POST /replies/list: inbound replies to the student's outreach, newest first, last 30 days */
export interface RepliesListResponse {
  replies: ReplyItem[];
}
/** POST /replies/draft */
export interface ReplyDraftRequest {
  messageId: string;
}

export interface Slot {
  start: string;
  end: string;
  /** "Tue Oct 21, 10:00–10:30 ET" in the recipient's zone when known */
  label: string;
}
/** POST /calendar/slots */
export interface SlotsRequest {
  personId?: string;
  tz?: string;
  count?: number;
}
export interface SlotsResponse {
  slots: Slot[];
  tz: string;
}
/** POST /calendar/book: creates the event after the student approved; asks for calendar.events the first time */
export interface BookRequest {
  draftId: string;
  slotStart: string;
}
export interface BookResponse {
  eventId?: string;
  needsConsent?: { url: string };
}

// ---- memory, autonomy, cadence (P5) --------------------------------------------------------------------------------

export type MemoryKind = 'preference' | 'constraint' | 'goal_detail' | 'outcome' | 'person_fact' | 'note';
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  personId: string | null;
  importance: number;
  createdAt: string;
  lastSeenAt: string;
}
/** POST /memory/search */
export interface MemorySearchRequest {
  query: string;
  personId?: string;
  limit?: number;
}
export interface MemorySearchResponse {
  memories: (MemoryItem & { score: number })[];
}
/** POST /memory/add */
export interface MemoryAddRequest {
  text: string;
  kind: MemoryKind;
  personId?: string;
}
export interface MemoryAddResponse {
  memory: MemoryItem;
  /** true when an existing memory matched (cosine ≥ 0.92) and was refreshed instead */
  deduped: boolean;
}
/** POST /memory/list */
export interface MemoryListResponse {
  memories: MemoryItem[];
}
/** POST /memory/forget { id } */

/** POST /memory/extract: at most 6 turns, 8,000 characters in all; memories found are added (source 'chat'). */
export interface MemoryExtractRequest {
  turns: ChatTurn[];
}
export interface MemoryExtractResponse {
  /** what was found, as stored (a refreshed memory when it matched one already kept) */
  memories: MemoryItem[];
  /** how many of them are new */
  added: number;
  /** Claude is not configured on the server: nothing was extracted */
  unconfigured?: true;
}

/** POST /settings/autonomy */
export interface AutonomyRequest {
  level: 0 | 1 | 2;
  goalId?: string;
}
/** POST /settings/pause { until } (quiet_until, §9.3) */
export interface PauseRequest {
  until: string | null;
}
/**
 * POST /settings/profile: what the server's drafting and sending read from the student's settings. A field left out
 * is kept; null (or an empty string) removes the address or the link. The address is at most 500 characters, the
 * link is https, the time zone an IANA zone.
 */
export interface ProfileSettingsRequest {
  postalAddress?: string | null;
  schedulingLink?: string | null;
  timezone?: string;
  /** setup was finished then (users.onboarding.completed_at), so signing in on another device skips it */
  onboardingCompletedAt?: string;
  /** who the student is, for the server's drafts and research (users.school, degree, majors, grad_year,
   * current_city); null or empty clears */
  school?: string | null;
  degree?: string | null;
  majors?: string[];
  graduationYear?: number | null;
  currentCity?: string | null;
  /**
   * the student's own words about their goals (plan 24: aim, success, story, proudOf, wantToMeet, networkingHard,
   * neverDo, currentJob), kept in users.settings.about for the server's drafts; the whole set replaces the stored
   * one, and null clears it
   */
  about?: OwnWords | null;
  /** read the tone of replies for closeness (plan 27): false turns it off (users.settings.read_reply_tone) */
  readReplyTone?: boolean;
}
export interface ProfileSettingsResponse {
  postalAddress: string | null;
  schedulingLink: string | null;
  timezone: string;
  school?: string | null;
  degree?: string | null;
  majors?: string[];
  graduationYear?: number | null;
  currentCity?: string | null;
  about?: OwnWords | null;
}

export interface DueItem {
  kind: 'bump' | 'went_quiet' | 'thank_you' | 'stage_timer' | 'nurture' | 'send_due';
  personId: string | null;
  chatId: string | null;
  draftId: string | null;
  reason: string;
  dueAt: string;
}
/** POST /cadence/due */
export interface DueResponse {
  items: DueItem[];
}

// ---- friends (plan 29 Part A) --------------------------------------------------------------------------------------

/** What one side of a friendship shares with the other: everyone, only people at some companies, or nothing yet. */
export type FriendShareMode = 'all' | 'companies' | 'none';

/** How well the owner knows a shared person, in a word: 1 knows, 2 knows well, 3 close (plan 29 A1). */
export type FriendCloseness = 1 | 2 | 3;

/**
 * One of a friend's shared people as the viewer may see them: name, title, company, public LinkedIn slug, school and
 * a closeness word. Never an email address, a phone number, a note, a score or anything derived from Gmail or
 * Calendar (plan 29 A2.2).
 */
export interface FriendShare {
  /** the owner's person id (the projection row); the viewer never has a row for it unless they save the person */
  personId: string;
  displayName: string;
  title: string | null;
  company: string | null;
  companyDomain: string | null;
  linkedinSlug: string | null;
  school: string | null;
  /** the person went to the owner's school */
  isAlumni: boolean;
  closeness: FriendCloseness;
}

/** A friend as the Friends tab lists them, with the counts the row shows. */
export interface Friend {
  friendshipId: string;
  userId: string;
  name: string;
  school: string | null;
  gradYear: number | null;
  avatarUrl: string | null;
  /** how many people the friend shares with the viewer */
  shares: number;
  /** how many of those are at the viewer's target companies */
  atTargets: number;
  /** per target company, how many of the friend's people are there */
  knowsAt: { company: string; count: number }[];
  /** what the viewer shares back */
  myMode: FriendShareMode;
  myCompanyDomains: string[];
  since: string;
}

/** An invite or request waiting on someone: sent by the viewer (out) or sent to them (in). */
export interface FriendInvite {
  id: string;
  direction: 'in' | 'out';
  /** the other side: an email when they are not on Orbit yet, a name when they are */
  email: string | null;
  name: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';
  createdAt: string;
}

/** POST /friends/invite { email? }: an email invite, or a link to copy when no email is given */
export interface FriendsInviteRequest {
  email?: string;
}
export interface FriendsInviteResponse {
  code: string;
  link: string;
  /** 'requested' when the invitee is already on Orbit (they see a request), 'sent' when the link went by email */
  status: 'sent' | 'requested' | 'link';
  invite: FriendInvite;
}
/** POST /friends/accept { code | friendshipId, mode }: accepting shares back in the chosen mode */
export interface FriendsAcceptRequest {
  code?: string;
  friendshipId?: string;
  mode: FriendShareMode;
  companyDomains?: string[];
}
export interface FriendsAcceptResponse {
  friend: Friend;
}
/** POST /friends/decline { code | friendshipId } */
export interface FriendsDeclineRequest {
  code?: string;
  friendshipId?: string;
}
/** POST /friends/end { friendshipId }: visibility ends both ways at once */
export interface FriendsEndRequest {
  friendshipId: string;
}
/** GET /friends */
export interface FriendsListResponse {
  friends: Friend[];
  pending: FriendInvite[];
}
/** POST /friends/settings { friendshipId?, mode, companyDomains }: for one friend, or for all when no id */
export interface FriendsSettingsRequest {
  friendshipId?: string;
  mode: FriendShareMode;
  companyDomains?: string[];
}
export interface FriendsSettingsResponse {
  mode: FriendShareMode;
  companyDomains: string[];
  /** how many of the viewer's people the projection now holds */
  shares: number;
}
/** GET /friends/preview: the viewer's own projection, exactly as a friend sees it */
export interface FriendPreviewResponse {
  mode: FriendShareMode;
  companyDomains: string[];
  shares: FriendShare[];
  total: number;
}
/** GET /friends/shares/:friendUserId?company=: a friend's projection, paged */
export interface FriendSharesResponse {
  friendUserId: string;
  shares: FriendShare[];
  total: number;
  nextCursor: string | null;
}

/** An intro asked of a friend (plan 29 A4): the friend forwards or declines; the target is never written to directly. */
export interface FriendIntroAsk {
  id: string;
  friendshipId: string;
  askerUserId: string;
  askerName: string;
  friendUserId: string;
  friendName: string;
  /** the friend's person id (their projection row) */
  targetPersonId: string;
  targetName: string;
  targetCompany: string | null;
  /** the asker's own row for the same human, when they have one */
  askerPersonId: string | null;
  /** the forwardable blurb, in the asker's words */
  note: string;
  status: 'asked' | 'forwarded' | 'declined' | 'expired';
  createdAt: string;
  answeredAt: string | null;
  /** the friend's forward draft, once they answered */
  forwardedDraftId: string | null;
}
/** POST /friends/asks { friendUserId, targetPersonId, note } */
export interface FriendAskRequest {
  friendUserId: string;
  targetPersonId: string;
  note: string;
}
export interface FriendAskResponse {
  ask: FriendIntroAsk;
}
/** GET /friends/asks: the asks the viewer made and the asks friends made of them */
export interface FriendAsksResponse {
  asked: FriendIntroAsk[];
  received: FriendIntroAsk[];
}
/** POST /friends/asks/:id/respond { action, body? }: forward makes the forward draft on the friend's side */
export interface FriendAskRespondRequest {
  action: 'forward' | 'decline';
  body?: string;
}
export interface FriendAskRespondResponse {
  ask: FriendIntroAsk;
  /** the forward draft, approved like any draft; null on a decline */
  draft: ServerDraft | null;
}

// ---- autopilot and voice (plan 29 Part B) --------------------------------------------------------------------------

/**
 * The three modes Settings offers (plan 29 B1): off writes only, assist sends what was tapped, autopilot plans too.
 * core/safety/rules.ts carries the same union for the send rules; index.ts re-exports this one by name so the two
 * never collide at the package root.
 */
export type AutopilotMode = 'off' | 'assist' | 'autopilot';

/** POST /autopilot/mode { mode, goalId? }: for the account, or for one goal */
export interface AutopilotModeRequest {
  mode: AutopilotMode;
  goalId?: string;
}
export interface AutopilotModeResponse {
  mode: AutopilotMode;
  goalId: string | null;
}

/** A rung of the trust ladder (plan 23 §4.9, plan 29 B2.2): how many unchanged approvals unlock a kind of send. */
export interface AutopilotRung {
  kind: 'bump' | 'thank_you' | 'schedule' | 'first_touch';
  needed: number;
  unchanged: number;
  unlocked: boolean;
}

/** One message autopilot touched: queued for tomorrow, held, sent today, or waiting on the student. */
export interface AutopilotItem {
  draftId: string;
  personId: string | null;
  personName: string;
  company: string | null;
  kind: MessageKind;
  replyClass?: ReplyClass;
  subject: string | null;
  /** when it goes or went, in the recipient's morning */
  sendAt: string | null;
  sentAt: string | null;
  status: 'queued' | 'held' | 'sent' | 'needs_you' | 'cancelled';
  /** why it was held or not sent: the rule, in a sentence */
  reason?: string;
  /** a reply that asked something only the student knows */
  question?: string;
  /** the rung that let it go on its own */
  autoRung?: AutopilotRung['kind'];
}

/** GET /autopilot/status */
export interface AutopilotStatus {
  mode: AutopilotMode;
  pausedUntil: string | null;
  pausedGoals: { goalId: string; title: string; until: string | null; reason: string }[];
  /** tomorrow's batch: the first messages that go in the morning unless held */
  queued: AutopilotItem[];
  held: AutopilotItem[];
  sentToday: AutopilotItem[];
  /** replies that asked a question only the student can answer */
  needsYou: AutopilotItem[];
  rungs: AutopilotRung[];
  caps: {
    autoPerDay: number;
    firstTouchPerWeek: number;
    firstTouchPerDay: number;
    usedToday: number;
    firstTouchesThisWeek: number;
  };
  /** when the evening review opens for tomorrow's batch */
  reviewUntil: string | null;
}
/** POST /autopilot/hold { draftId }: the batch goes without this one */
export interface AutopilotHoldRequest {
  draftId: string;
}
export interface AutopilotHoldResponse {
  item: AutopilotItem;
}
/** POST /autopilot/pause { until, goalId? }: null lifts the pause; no goal pauses everything */
export interface AutopilotPauseRequest {
  until: string | null;
  goalId?: string;
}
export interface AutopilotPauseResponse {
  pausedUntil: string | null;
  goalId: string | null;
  /** queued sends that were cancelled by the pause */
  cancelled: number;
}

/** POST /replies/answer { draftId, answer }: the student's one line fills the question and the reply drafts itself */
export interface ReplyAnswerRequest {
  draftId: string;
  answer: string;
}
export interface ReplyAnswerResponse {
  draft: ServerDraft;
}

/** One thing Orbit learned from the student's edits (plan 29 B2.4), kept or forgotten in Settings → Voice. */
export interface VoiceNote {
  id: string;
  /** one line in the student's words: "You cut 'Thanks either way' every time" */
  text: string;
  /** the draft_edits rows behind it */
  evidence: string[];
  createdAt: string;
  keptAt: string | null;
  /** a forgotten note is never re-learned */
  forgottenAt: string | null;
}
/** GET /voice */
export interface VoiceResponse {
  card: StyleCard | null;
  /** the card as sentences: "You greet with Hi, sign off Thanks, write short, use contractions" */
  cardProse: string[];
  notes: VoiceNote[];
  /** 0 to 3, how much recent drafts sounded like the student; null before the first judge run */
  soundsLikeYou: number | null;
  relearnedAt: string | null;
}
/** POST /voice/notes { id, action } */
export interface VoiceNoteRequest {
  id: string;
  action: 'keep' | 'forget';
}
export interface VoiceNoteResponse {
  note: VoiceNote;
}
/** POST /voice/relearn: rebuilds the card from sent mail; the job runs in the background */
export interface VoiceRelearnResponse {
  queued: boolean;
}

/** Every route path, for both sides' tables and tests. */
export const API_ROUTES = [
  '/auth/session',
  '/auth/refresh',
  '/auth/logout',
  '/auth/me',
  '/sync/status',
  '/sync/pull',
  '/sync/push',
  '/account/export',
  '/account/delete',
  '/google/sync',
  '/linkedin/connect/start',
  '/linkedin/status',
  '/linkedin/sync',
  '/goals/list',
  '/goals/upsert',
  '/goals/archive',
  '/goals/infer',
  '/scores/explain',
  '/scores/label',
  '/research/person',
  '/research/get',
  '/research/choose',
  '/source/search',
  '/source/add',
  '/paths/find',
  '/intros/ask',
  '/drafts/compose',
  '/drafts/approve',
  '/drafts/cancel',
  '/drafts/discard',
  '/replies/list',
  '/replies/draft',
  '/calendar/slots',
  '/calendar/book',
  '/memory/search',
  '/memory/add',
  '/memory/list',
  '/memory/forget',
  '/memory/extract',
  '/settings/autonomy',
  '/settings/pause',
  '/settings/profile',
  '/cadence/due',
  // plan 29 Part A: friends
  '/friends/invite',
  '/friends/accept',
  '/friends/decline',
  '/friends/end',
  '/friends',
  '/friends/settings',
  '/friends/preview',
  '/friends/shares/:friendUserId',
  '/friends/asks',
  '/friends/asks/:id/respond',
  // plan 29 Part B: autopilot and voice
  '/autopilot/mode',
  '/autopilot/status',
  '/autopilot/hold',
  '/autopilot/pause',
  '/replies/answer',
  '/voice',
  '/voice/notes',
  '/voice/relearn',
] as const;
export type ApiRoute = (typeof API_ROUTES)[number];
