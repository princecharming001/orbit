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
import type { TieBand } from '../scoring/tieScore';
import type { Dossier, Goal, GoalKind, MessageKind } from '../types';

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
  /** sources consulted: 'graph', 'linkedin_mutual', 'village' */
  sources: string[];
  unconfigured: string[];
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

/** POST /settings/autonomy */
export interface AutonomyRequest {
  level: 0 | 1 | 2;
  goalId?: string;
}
/** POST /settings/pause { until } (quiet_until, §9.3) */
export interface PauseRequest {
  until: string | null;
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
  '/settings/autonomy',
  '/settings/pause',
  '/cadence/due',
] as const;
export type ApiRoute = (typeof API_ROUTES)[number];
