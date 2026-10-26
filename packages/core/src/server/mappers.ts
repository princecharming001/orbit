import type {
  Affiliation,
  CalendarEvent,
  ChatStage,
  CoffeeChat,
  Dossier,
  Edge,
  EdgeType,
  EmailMessage,
  EmailThread,
  Goal,
  MeetingNote,
  MergeSuggestion,
  Organization,
  OutboundMessage,
  OutboundStatus,
  Person,
  PersonFact,
  PersonSource,
  Recommendation,
  StageEvent,
  TieScoreSummary,
  User,
} from '../types';

/**
 * Rows of the `orbit` schema (plan 16 §11.3), snake_case as Postgres returns them, and the mappings to and from the
 * core camelCase types (§11.4). `/sync/pull` sends rows already mapped, so Dexie stores them unchanged; the functions
 * write the other way. Dependency-free: timestamps are ISO strings, `date` columns YYYY-MM-DD, `jsonb` plain values;
 * `bigint` and `numeric` are strings, as postgres.js returns them.
 */

type Uuid = string;
type Ts = string;
type Json = unknown;

export namespace Row {
  export interface Users {
    id: Uuid;
    google_sub: string;
    email: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    avatar_url: string | null;
    school: string | null;
    school_domain: string | null;
    grad_year: number | null;
    degree: string | null;
    majors: string[];
    current_title: string | null;
    current_org: string | null;
    current_city: string | null;
    timezone: string;
    autonomy_level: 0 | 1 | 2;
    settings: Record<string, Json>;
    onboarding: Record<string, Json>;
    created_at: Ts;
    updated_at: Ts;
    last_seen_at: Ts | null;
    deleted_at: Ts | null;
  }
  export interface Sessions {
    id: Uuid;
    user_id: Uuid;
    refresh_hash: string;
    user_agent: string | null;
    created_at: Ts;
    last_used_at: Ts | null;
    expires_at: Ts;
    revoked_at: Ts | null;
  }
  export interface OauthStates {
    state: string;
    code_verifier: string;
    redirect_to: string;
    user_id: Uuid | null;
    scopes: string[];
    created_at: Ts;
    expires_at: Ts;
  }
  export interface LoginCodes {
    code_hash: string;
    user_id: Uuid;
    expires_at: Ts;
    used_at: Ts | null;
  }
  export interface IntegrationAccounts {
    id: Uuid;
    user_id: Uuid;
    provider: 'google' | 'linkedin' | 'village';
    external_account_id: string | null;
    email: string | null;
    scopes: string[];
    status: 'active' | 'needs_reauth' | 'revoked' | 'error' | 'connecting';
    token_secret_id: Uuid | null;
    sync_state: Record<string, Json>;
    watch_expires_at: Ts | null;
    last_synced_at: Ts | null;
    last_error: string | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Organizations {
    id: Uuid;
    user_id: Uuid;
    name: string;
    name_norm: string;
    domains: string[];
    linkedin_slug: string | null;
    industry: string | null;
    size_bucket: string | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface People {
    id: Uuid;
    user_id: Uuid;
    is_self: boolean;
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    name_norm: string;
    primary_email: string | null;
    headline: string | null;
    title: string | null;
    org_id: Uuid | null;
    org_raw: string | null;
    location: string | null;
    timezone: string | null;
    school: string | null;
    is_alumni: boolean;
    photo_url: string | null;
    linkedin_url: string | null;
    linkedin_slug: string | null;
    linkedin_member_id: string | null;
    relationship_type: string | null;
    sources: string[];
    first_seen_at: Ts | null;
    last_interaction_at: Ts | null;
    strength: number;
    summary: string | null;
    tags: string[];
    notes: string | null;
    do_not_contact: boolean;
    hidden_at: Ts | null;
    merged_into: Uuid | null;
    created_at: Ts;
    updated_at: Ts;
    deleted_at: Ts | null;
  }
  export interface PersonIdentities {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid;
    kind: 'email' | 'linkedin_member' | 'linkedin_slug' | 'phone' | 'unipile_attendee';
    value_norm: string;
    value_raw: string | null;
    source: string;
    confidence: number;
    created_at: Ts;
  }
  export interface Affiliations {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid;
    org_id: Uuid | null;
    org_raw: string | null;
    kind: 'employment' | 'education';
    title: string | null;
    degree: string | null;
    field: string | null;
    start_date: string | null;
    end_date: string | null;
    is_current: boolean;
    source: string;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface MergeSuggestions {
    id: Uuid;
    user_id: Uuid;
    person_a: Uuid;
    person_b: Uuid;
    score: number;
    features: Record<string, number>;
    status: 'open' | 'merged' | 'rejected';
    created_at: Ts;
    decided_at: Ts | null;
    updated_at: Ts;
  }
  export interface DoNotMerge {
    user_id: Uuid;
    person_a: Uuid;
    person_b: Uuid;
    created_at: Ts;
  }
  export interface Goals {
    id: Uuid;
    user_id: Uuid;
    kind: Goal['kind'];
    title: string;
    description: string | null;
    targets: Goal['targets'];
    criteria: Record<string, Json>;
    success_metric: string | null;
    priority: 1 | 2 | 3;
    status: Goal['status'];
    autonomy_level: 0 | 1 | 2 | null;
    due_at: string | null;
    source: Goal['source'];
    evidence: string | null;
    created_at: Ts;
    updated_at: Ts;
    deleted_at: Ts | null;
  }
  export interface Threads {
    id: Uuid;
    user_id: Uuid;
    provider: 'gmail' | 'linkedin';
    external_id: string;
    subject: string | null;
    participant_person_ids: Uuid[];
    participant_count: number;
    first_at: Ts | null;
    last_at: Ts | null;
    message_count: number;
    last_direction: 'in' | 'out' | null;
    category: string | null;
    is_networking: boolean;
    chat_id: Uuid | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Messages {
    id: Uuid;
    user_id: Uuid;
    thread_id: Uuid;
    provider: 'gmail' | 'linkedin';
    external_id: string;
    rfc_message_id: string | null;
    in_reply_to: string | null;
    direction: 'in' | 'out';
    from_person_id: Uuid | null;
    from_addr: string | null;
    to_addrs: string[];
    cc_addrs: string[];
    to_person_ids: Uuid[];
    cc_person_ids: Uuid[];
    sent_at: Ts;
    subject: string | null;
    snippet: string | null;
    body_text: string | null;
    is_automated: boolean;
    list_unsubscribe: boolean;
    reply_class: string | null;
    reply_confidence: number | null;
    extraction: Json | null;
    /** vector(384), as pgvector's text form or an array; never sent to the browser */
    embedding: string | number[] | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface CalendarEvents {
    id: Uuid;
    user_id: Uuid;
    external_id: string;
    title: string | null;
    description: string | null;
    start_at: Ts;
    end_at: Ts | null;
    status: string | null;
    organizer_email: string | null;
    attendees: { email: string; displayName?: string; responseStatus?: string; self?: boolean }[];
    attendee_person_ids: Uuid[];
    attendee_count: number;
    conference_url: string | null;
    is_one_on_one: boolean;
    chat_id: Uuid | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Ties {
    id: Uuid;
    user_id: Uuid;
    a_person_id: Uuid;
    b_person_id: Uuid;
    kind: EdgeType;
    weight: number;
    confidence: number;
    evidence: Record<string, Json>;
    first_seen_at: Ts;
    last_seen_at: Ts;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface TieScores {
    user_id: Uuid;
    person_id: Uuid;
    score: number;
    band: string;
    features: Record<string, number>;
    contributions: Record<string, number>;
    explanation: string[];
    model_version: string;
    computed_at: Ts;
    updated_at: Ts;
  }
  export interface TieLabels {
    user_id: Uuid;
    person_id: Uuid;
    closeness: 1 | 2 | 3 | 4 | 5;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Chats {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid;
    goal_id: Uuid | null;
    org_id: Uuid | null;
    stage: ChatStage;
    stage_entered_at: Ts;
    /** the remaining CoffeeChat fields, camelCase */
    data: Record<string, Json>;
    archived_at: Ts | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface StageEvents {
    id: Uuid;
    user_id: Uuid;
    chat_id: Uuid;
    from_stage: ChatStage | null;
    to_stage: ChatStage;
    status: StageEvent['status'];
    actor: string;
    reason: string | null;
    evidence: { table?: string; id?: string; [k: string]: Json } | null;
    confidence: number | null;
    created_at: Ts;
    decided_at: Ts | null;
    updated_at: Ts;
  }
  export interface Drafts {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid;
    chat_id: Uuid | null;
    goal_id: Uuid | null;
    channel: 'gmail' | 'linkedin';
    kind: string;
    subject: string | null;
    body: string;
    ask: Json | null;
    hooks: Json[];
    via: Json | null;
    thread_external_id: string | null;
    in_reply_to: string | null;
    status: 'draft' | 'approved' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'discarded' | 'cancelled';
    autonomy_level: number;
    send_at: Ts | null;
    sent_at: Ts | null;
    provider_message_id: string | null;
    error: string | null;
    cancel_reason: string | null;
    validator: Json | null;
    generated_by: string;
    prompt_version: string | null;
    variant: string | null;
    replied_at: Ts | null;
    reply_class: string | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Notes {
    id: Uuid;
    user_id: Uuid;
    person_ids: Uuid[];
    chat_id: Uuid | null;
    source: string;
    title: string | null;
    occurred_at: Ts;
    raw_text: string;
    extraction: Json | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Facts {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid;
    type: string;
    text: string;
    source_table: string | null;
    source_id: Uuid | null;
    occurred_at: Ts | null;
    confidence: number;
    deleted_at: Ts | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Dossiers {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid;
    goal_id: Uuid | null;
    status: Dossier['status'];
    content: Record<string, Json> | null;
    sources: Dossier['sources'];
    candidates: Json[] | null;
    /** numeric(8,4) */
    cost_usd: string;
    model: string | null;
    error: string | null;
    created_at: Ts;
    updated_at: Ts;
    expires_at: Ts;
  }
  export interface ResearchCache {
    user_id: Uuid;
    key: string;
    provider: string;
    response: Json;
    created_at: Ts;
    expires_at: Ts;
  }
  export interface Recommendations {
    id: Uuid;
    user_id: Uuid;
    goal_id: Uuid | null;
    person_id: Uuid | null;
    candidate: Record<string, Json>;
    source: string;
    external_id: string | null;
    rank: number;
    fit: number | null;
    reach: number | null;
    responsiveness: number | null;
    reasons: string[];
    status: 'new' | 'added' | 'dismissed';
    batch_id: Uuid;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface IntroRequests {
    id: Uuid;
    user_id: Uuid;
    target_person_id: Uuid | null;
    introducer_person_id: Uuid | null;
    goal_id: Uuid | null;
    path: Json;
    path_score: number;
    rank: number;
    status: 'asked' | 'agreed' | 'declined' | 'intro_made' | 'meeting' | 'no_response';
    asked_at: Ts;
    outcome_at: Ts | null;
    created_at: Ts;
    updated_at: Ts;
  }
  export interface Memories {
    id: Uuid;
    user_id: Uuid;
    person_id: Uuid | null;
    kind: 'preference' | 'constraint' | 'goal_detail' | 'outcome' | 'person_fact' | 'note';
    text: string;
    embedding: string | number[] | null;
    importance: number;
    source: string;
    quote: string | null;
    created_at: Ts;
    last_seen_at: Ts;
    updated_at: Ts;
    deleted_at: Ts | null;
  }
  export interface UsageLedger {
    /** bigint identity */
    id: string;
    user_id: Uuid | null;
    provider: string;
    operation: string;
    /** numeric */
    units: string;
    /** numeric(10,5) */
    cost_usd: string;
    created_at: Ts;
  }
  export interface JobRuns {
    id: string;
    queue: string;
    msg_id: string | null;
    user_id: Uuid | null;
    kind: string;
    dedupe_key: string | null;
    status: 'running' | 'ok' | 'error' | 'skipped';
    attempt: number;
    error: string | null;
    duration_ms: number | null;
    started_at: Ts;
    finished_at: Ts | null;
  }
  export interface DeadLetters {
    id: string;
    queue: string;
    msg_id: string | null;
    message: Json;
    error: string | null;
    created_at: Ts;
  }
  export interface AuditLog {
    id: string;
    user_id: Uuid | null;
    actor: 'user' | 'agent' | 'system';
    action: string;
    target_table: string | null;
    target_id: string | null;
    details: Record<string, Json>;
    created_at: Ts;
  }
  export interface WebhookEvents {
    provider: string;
    event_id: string;
    received_at: Ts;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

const u = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
/** Only the keys whose value is defined, so a mapped object compares equal to one built without them. */
function compact<T extends object>(o: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// users

export function userFromRow(r: Row.Users): User {
  const step = r.onboarding.step;
  return compact({
    id: r.id,
    email: r.email,
    fullName: r.full_name ?? '',
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    avatarUrl: u(r.avatar_url),
    school: r.school ?? '',
    schoolDomain: u(r.school_domain),
    graduationYear: u(r.grad_year),
    degree: u(r.degree),
    majors: r.majors,
    currentCity: u(r.current_city),
    timezone: r.timezone,
    onboardingStep: typeof step === 'number' ? step : 11,
    onboardingCompletedAt:
      typeof r.onboarding.completedAt === 'string' ? r.onboarding.completedAt : undefined,
    createdAt: r.created_at,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// organizations, people, identities, affiliations

export function organizationFromRow(r: Row.Organizations): Organization {
  return compact({
    id: r.id,
    name: r.name,
    nameNormalized: r.name_norm,
    domains: r.domains,
    linkedinSlug: u(r.linkedin_slug),
    industry: u(r.industry),
    sizeBucket: u(r.size_bucket),
  });
}

export function organizationToRow(o: Organization, userId: Uuid, at: Ts): Row.Organizations {
  return {
    id: o.id,
    user_id: userId,
    name: o.name,
    name_norm: o.nameNormalized,
    domains: o.domains,
    linkedin_slug: n(o.linkedinSlug),
    industry: n(o.industry),
    size_bucket: n(o.sizeBucket),
    created_at: at,
    updated_at: at,
  };
}

export function tieScoreFromRow(r: Row.TieScores): TieScoreSummary {
  return {
    score: r.score,
    band: r.band as TieScoreSummary['band'],
    explanation: r.explanation,
    contributions: r.contributions,
    features: r.features,
    modelVersion: r.model_version,
  };
}

export function tieScoreToRow(t: TieScoreSummary, userId: Uuid, personId: Uuid, at: Ts): Row.TieScores {
  return {
    user_id: userId,
    person_id: personId,
    score: t.score,
    band: t.band,
    features: t.features,
    contributions: t.contributions,
    explanation: t.explanation,
    model_version: t.modelVersion,
    computed_at: at,
    updated_at: at,
  };
}

/**
 * `orbit.people` (+ its identities and tie score) → `Person`. `emails` come from the email identities (the primary
 * address first); `strength`, `strengthBreakdown` and the tie fields from `tie_scores` when given.
 */
export function personFromRow(
  r: Row.People,
  extra: { identities?: Row.PersonIdentities[]; tieScore?: Row.TieScores; interactionCount?: number } = {},
): Person {
  const emails = [
    ...new Set(
      [
        r.primary_email,
        ...(extra.identities ?? []).filter((i) => i.kind === 'email').map((i) => i.value_norm),
      ].filter((e): e is string => !!e),
    ),
  ];
  const tie = extra.tieScore ? tieScoreFromRow(extra.tieScore) : undefined;
  return compact({
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    nameNormalized: r.name_norm,
    primaryEmail: u(r.primary_email),
    emails,
    linkedinUrl: u(r.linkedin_url),
    linkedinSlug: u(r.linkedin_slug),
    linkedinMemberId: u(r.linkedin_member_id),
    headline: u(r.headline),
    currentTitle: u(r.title),
    currentOrganizationId: u(r.org_id),
    currentOrganizationRaw: u(r.org_raw),
    location: u(r.location),
    photoUrl: u(r.photo_url),
    school: u(r.school),
    isAlumni: r.is_alumni,
    relationshipType: (r.relationship_type ?? 'unknown') as Person['relationshipType'],
    strength: tie ? tie.score / 100 : r.strength,
    strengthBreakdown: tie ? { raw: 0, recency: 0, counts: {}, tieScore: tie } : undefined,
    tieScore: tie?.score,
    tieBand: tie?.band,
    tieExplanation: tie?.explanation,
    firstSeenAt: u(r.first_seen_at),
    lastInteractionAt: u(r.last_interaction_at),
    interactionCount: extra.interactionCount ?? 0,
    sources: r.sources as PersonSource[],
    isHuman: true,
    hiddenAt: u(r.hidden_at),
    doNotContact: r.do_not_contact || undefined,
    summary: u(r.summary),
    tags: r.tags,
    notes: u(r.notes),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export function personToRow(p: Person, extra: { isSelf?: boolean; timezone?: string } = {}): Row.People {
  return {
    id: p.id,
    user_id: p.userId,
    is_self: extra.isSelf ?? false,
    display_name: p.displayName,
    first_name: p.firstName || null,
    last_name: p.lastName || null,
    name_norm: p.nameNormalized,
    primary_email: n(p.primaryEmail),
    headline: n(p.headline),
    title: n(p.currentTitle),
    org_id: n(p.currentOrganizationId),
    org_raw: n(p.currentOrganizationRaw),
    location: n(p.location),
    timezone: n(extra.timezone),
    school: n(p.school),
    is_alumni: !!p.isAlumni,
    photo_url: n(p.photoUrl),
    linkedin_url: n(p.linkedinUrl),
    linkedin_slug: n(p.linkedinSlug),
    linkedin_member_id: n(p.linkedinMemberId),
    relationship_type: p.relationshipType,
    sources: p.sources,
    first_seen_at: n(p.firstSeenAt),
    last_interaction_at: n(p.lastInteractionAt),
    strength: p.strength,
    summary: n(p.summary),
    tags: p.tags,
    notes: n(p.notes),
    do_not_contact: !!p.doNotContact,
    hidden_at: n(p.hiddenAt),
    merged_into: null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    deleted_at: null,
  };
}

export function affiliationFromRow(r: Row.Affiliations): Affiliation {
  return compact({
    id: r.id,
    userId: r.user_id,
    personId: r.person_id,
    kind: r.kind,
    organizationId: u(r.org_id),
    nameRaw: r.org_raw ?? '',
    title: u(r.title),
    degree: u(r.degree),
    field: u(r.field),
    startDate: u(r.start_date),
    endDate: u(r.end_date),
    isCurrent: r.is_current,
    source: r.source as PersonSource,
  });
}

export function affiliationToRow(a: Affiliation, at: Ts): Row.Affiliations {
  return {
    id: a.id,
    user_id: a.userId,
    person_id: a.personId,
    org_id: n(a.organizationId),
    org_raw: a.nameRaw || null,
    kind: a.kind,
    title: n(a.title),
    degree: n(a.degree),
    field: n(a.field),
    start_date: n(a.startDate),
    end_date: n(a.endDate),
    is_current: a.isCurrent,
    source: a.source,
    created_at: at,
    updated_at: at,
  };
}

const MERGE_STATUS: Record<Row.MergeSuggestions['status'], MergeSuggestion['status']> = {
  open: 'pending',
  merged: 'accepted',
  rejected: 'rejected',
};

export function mergeSuggestionFromRow(r: Row.MergeSuggestions): MergeSuggestion {
  return {
    id: r.id,
    userId: r.user_id,
    personAId: r.person_a,
    personBId: r.person_b,
    score: r.score,
    features: r.features,
    status: MERGE_STATUS[r.status],
    createdAt: r.created_at,
  };
}

export function mergeSuggestionToRow(m: MergeSuggestion, at: Ts): Row.MergeSuggestions {
  const status = m.status === 'accepted' ? 'merged' : m.status === 'rejected' ? 'rejected' : 'open';
  return {
    id: m.id,
    user_id: m.userId,
    person_a: m.personAId,
    person_b: m.personBId,
    score: m.score,
    features: m.features,
    status,
    created_at: m.createdAt,
    decided_at: status === 'open' ? null : at,
    updated_at: at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// goals

export function goalFromRow(r: Row.Goals): Goal {
  return compact({
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    title: r.title,
    description: u(r.description),
    targets: r.targets,
    criteria: r.criteria,
    successMetric: u(r.success_metric),
    priority: r.priority,
    status: r.status,
    autonomyLevel: u(r.autonomy_level),
    dueAt: u(r.due_at),
    source: r.source,
    evidence: u(r.evidence),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: u(r.deleted_at),
  });
}

export function goalToRow(g: Goal): Row.Goals {
  return {
    id: g.id,
    user_id: g.userId,
    kind: g.kind,
    title: g.title,
    description: n(g.description),
    targets: g.targets,
    criteria: g.criteria,
    success_metric: n(g.successMetric),
    priority: g.priority,
    status: g.status,
    autonomy_level: n(g.autonomyLevel),
    due_at: n(g.dueAt),
    source: g.source,
    evidence: n(g.evidence),
    created_at: g.createdAt,
    updated_at: g.updatedAt,
    deleted_at: n(g.deletedAt),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// threads, messages, calendar events

export function threadFromRow(r: Row.Threads, extra: { participantEmails?: string[] } = {}): EmailThread {
  return compact({
    id: r.id,
    userId: r.user_id,
    externalThreadId: r.external_id,
    channel: r.provider === 'linkedin' ? ('linkedin' as const) : undefined,
    subject: u(r.subject),
    firstMessageAt: u(r.first_at),
    lastMessageAt: u(r.last_at),
    messageCount: r.message_count,
    participantEmails: extra.participantEmails ?? [],
    participantPersonIds: r.participant_person_ids,
    category: u(r.category) as EmailThread['category'],
    isNetworking: r.is_networking,
    chatId: u(r.chat_id),
  });
}

export function threadToRow(
  t: EmailThread,
  extra: { provider?: Row.Threads['provider']; lastDirection?: 'in' | 'out'; at: Ts },
): Row.Threads {
  return {
    id: t.id,
    user_id: t.userId,
    provider: extra.provider ?? 'gmail',
    external_id: t.externalThreadId,
    subject: n(t.subject),
    participant_person_ids: t.participantPersonIds,
    participant_count: Math.max(t.participantPersonIds.length, t.participantEmails.length),
    first_at: n(t.firstMessageAt),
    last_at: n(t.lastMessageAt),
    message_count: t.messageCount,
    last_direction: n(extra.lastDirection),
    category: n(t.category),
    is_networking: t.isNetworking,
    chat_id: n(t.chatId),
    created_at: extra.at,
    updated_at: extra.at,
  };
}

export function messageFromRow(r: Row.Messages): EmailMessage {
  return compact({
    id: r.id,
    userId: r.user_id,
    threadId: r.thread_id,
    externalMessageId: r.external_id,
    channel: r.provider === 'linkedin' ? ('linkedin' as const) : undefined,
    direction: r.direction === 'in' ? ('inbound' as const) : ('outbound' as const),
    fromEmail: r.from_addr ?? '',
    toEmails: r.to_addrs,
    ccEmails: r.cc_addrs,
    fromPersonId: u(r.from_person_id),
    sentAt: r.sent_at,
    subject: u(r.subject),
    // bodies are kept for networking threads only; elsewhere the snippet is what there is
    bodyText: r.body_text ?? r.snippet ?? '',
    headers: compact({
      'message-id': u(r.rfc_message_id),
      'in-reply-to': u(r.in_reply_to),
      'list-unsubscribe': r.list_unsubscribe ? 'yes' : undefined,
    }) as Record<string, string>,
    isAutomated: r.is_automated,
    replyClass: u(r.reply_class),
    replyConfidence: u(r.reply_confidence),
    extraction: u(r.extraction) as EmailMessage['extraction'],
  });
}

export function messageToRow(
  m: EmailMessage,
  extra: {
    provider?: Row.Messages['provider'];
    toPersonIds?: Uuid[];
    ccPersonIds?: Uuid[];
    snippet?: string;
    at: Ts;
  },
): Row.Messages {
  return {
    id: m.id,
    user_id: m.userId,
    thread_id: m.threadId,
    provider: extra.provider ?? 'gmail',
    external_id: m.externalMessageId,
    rfc_message_id: n(m.headers['message-id']),
    in_reply_to: n(m.headers['in-reply-to']),
    direction: m.direction === 'inbound' ? 'in' : 'out',
    from_person_id: n(m.fromPersonId),
    from_addr: m.fromEmail || null,
    to_addrs: m.toEmails,
    cc_addrs: m.ccEmails,
    to_person_ids: extra.toPersonIds ?? [],
    cc_person_ids: extra.ccPersonIds ?? [],
    sent_at: m.sentAt,
    subject: n(m.subject),
    snippet: n(extra.snippet),
    body_text: m.bodyText || null,
    is_automated: m.isAutomated,
    list_unsubscribe: !!m.headers['list-unsubscribe'],
    reply_class: n(m.replyClass),
    reply_confidence: n(m.replyConfidence),
    extraction: n(m.extraction),
    embedding: null,
    created_at: extra.at,
    updated_at: extra.at,
  };
}

const EVENT_STATUS = new Set(['confirmed', 'tentative', 'cancelled']);

export function calendarEventFromRow(r: Row.CalendarEvents): CalendarEvent {
  return compact({
    id: r.id,
    userId: r.user_id,
    externalEventId: r.external_id,
    title: u(r.title),
    description: u(r.description),
    startAt: r.start_at,
    endAt: r.end_at ?? r.start_at,
    status: (EVENT_STATUS.has(r.status ?? '') ? r.status : 'confirmed') as CalendarEvent['status'],
    attendees: r.attendees,
    attendeePersonIds: r.attendee_person_ids,
    conferenceUrl: u(r.conference_url),
    chatId: u(r.chat_id),
  });
}

export function calendarEventToRow(
  e: CalendarEvent,
  extra: { organizerEmail?: string; at: Ts },
): Row.CalendarEvents {
  return {
    id: e.id,
    user_id: e.userId,
    external_id: e.externalEventId,
    title: n(e.title),
    description: n(e.description),
    start_at: e.startAt,
    end_at: e.endAt,
    status: e.status,
    organizer_email: n(extra.organizerEmail),
    attendees: e.attendees,
    attendee_person_ids: e.attendeePersonIds,
    attendee_count: e.attendees.length,
    conference_url: n(e.conferenceUrl),
    is_one_on_one: e.attendees.length === 2,
    chat_id: n(e.chatId),
    created_at: extra.at,
    updated_at: extra.at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// ties

/** `orbit.ties` → `Edge`: `type` is the kind, `weight` is w·c (§11.4), with the confidence and kind kept. */
export function edgeFromTieRow(r: Row.Ties): Edge {
  return {
    id: r.id,
    userId: r.user_id,
    personAId: r.a_person_id,
    personBId: r.b_person_id,
    type: r.kind,
    weight: r.weight * r.confidence,
    confidence: r.confidence,
    kinds: [r.kind],
    evidence: {
      ...(r.evidence as Record<string, unknown>),
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    },
  };
}

/** `Edge` → `orbit.ties`: w is weight / c (a v1 edge without a confidence keeps its weight as w with c = 1). */
export function tieRowFromEdge(e: Edge, at: Ts): Row.Ties {
  const c = e.confidence ?? 1;
  const { firstSeenAt, lastSeenAt, ...evidence } = e.evidence as Record<string, unknown>;
  const [a, b] = e.personAId < e.personBId ? [e.personAId, e.personBId] : [e.personBId, e.personAId];
  return {
    id: e.id,
    user_id: e.userId,
    a_person_id: a,
    b_person_id: b,
    kind: e.type,
    weight: c > 0 ? Math.min(1, e.weight / c) : 0,
    confidence: c,
    evidence: evidence as Record<string, Json>,
    first_seen_at: typeof firstSeenAt === 'string' ? firstSeenAt : at,
    last_seen_at: typeof lastSeenAt === 'string' ? lastSeenAt : at,
    created_at: at,
    updated_at: at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// chats, stage events

const CHAT_COLUMNS = new Set([
  'id',
  'userId',
  'personId',
  'goalId',
  'organizationId',
  'stage',
  'stageEnteredAt',
  'archivedAt',
  'createdAt',
  'updatedAt',
]);

/** `orbit.chats` → `CoffeeChat`: the columns, with `data` (the remaining CoffeeChat fields) spread in. */
export function chatFromRow(r: Row.Chats): CoffeeChat {
  const data = r.data as Partial<CoffeeChat>;
  return compact({
    goalTags: [],
    source: 'manual' as const,
    bumpCount: 0,
    priority: 2 as const,
    ...data,
    id: r.id,
    userId: r.user_id,
    personId: r.person_id,
    goalId: u(r.goal_id),
    organizationId: u(r.org_id),
    stage: r.stage,
    stageEnteredAt: r.stage_entered_at,
    archivedAt: u(r.archived_at),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export function chatToRow(c: CoffeeChat): Row.Chats {
  const data: Record<string, Json> = {};
  for (const [k, v] of Object.entries(c)) if (!CHAT_COLUMNS.has(k) && v !== undefined) data[k] = v;
  return {
    id: c.id,
    user_id: c.userId,
    person_id: c.personId,
    goal_id: n(c.goalId),
    org_id: n(c.organizationId),
    stage: c.stage,
    stage_entered_at: c.stageEnteredAt,
    data,
    archived_at: n(c.archivedAt),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function stageEventFromRow(r: Row.StageEvents): StageEvent {
  return compact({
    id: r.id,
    userId: r.user_id,
    chatId: r.chat_id,
    fromStage: u(r.from_stage),
    toStage: r.to_stage,
    status: r.status,
    actor: r.actor === 'user' ? ('user' as const) : ('system' as const),
    reason: r.reason ?? '',
    evidenceRefTable: typeof r.evidence?.table === 'string' ? r.evidence.table : undefined,
    evidenceRefId: typeof r.evidence?.id === 'string' ? r.evidence.id : undefined,
    confidence: u(r.confidence),
    createdAt: r.created_at,
    decidedAt: u(r.decided_at),
  });
}

export function stageEventToRow(e: StageEvent, at: Ts): Row.StageEvents {
  return {
    id: e.id,
    user_id: e.userId,
    chat_id: e.chatId,
    from_stage: n(e.fromStage),
    to_stage: e.toStage,
    status: e.status,
    actor: e.actor,
    reason: e.reason || null,
    evidence:
      e.evidenceRefTable || e.evidenceRefId
        ? (compact({ table: e.evidenceRefTable, id: e.evidenceRefId }) as Row.StageEvents['evidence'])
        : null,
    confidence: n(e.confidence),
    created_at: e.createdAt,
    decided_at: n(e.decidedAt),
    updated_at: at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// drafts

const DRAFT_STATUS_IN: Record<Row.Drafts['status'], OutboundStatus> = {
  draft: 'draft',
  approved: 'approved',
  scheduled: 'queued',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  discarded: 'cancelled',
  cancelled: 'cancelled',
};
const DRAFT_STATUS_OUT: Record<OutboundStatus, Row.Drafts['status']> = {
  draft: 'draft',
  approved: 'approved',
  queued: 'scheduled',
  sending: 'sending',
  // a hand-off waits for the student's "I sent it": still a draft on the server
  handed_off: 'draft',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** `orbit.drafts` → `OutboundMessage` (§11.4). `scheduled` is the browser's `queued`; `discarded` is `cancelled`. */
export function outboundFromDraftRow(r: Row.Drafts): OutboundMessage {
  return compact({
    id: r.id,
    userId: r.user_id,
    personId: r.person_id,
    chatId: u(r.chat_id),
    goalId: u(r.goal_id),
    channel: r.channel,
    kind: r.kind as OutboundMessage['kind'],
    externalThreadId: u(r.thread_external_id),
    inReplyToMessageId: u(r.in_reply_to),
    subject: u(r.subject),
    bodyDraft: r.body,
    status: DRAFT_STATUS_IN[r.status],
    sendAt: u(r.send_at),
    sentAt: u(r.sent_at),
    providerMessageId: u(r.provider_message_id),
    error: u(r.error) ?? u(r.cancel_reason),
    generatedBy: r.generated_by === 'template' ? ('template' as const) : ('llm' as const),
    createdAt: r.created_at,
  });
}

export function draftRowFromOutbound(
  o: OutboundMessage,
  extra: Partial<
    Pick<Row.Drafts, 'ask' | 'hooks' | 'via' | 'validator' | 'prompt_version' | 'variant' | 'autonomy_level'>
  > & {
    at: Ts;
  },
): Row.Drafts {
  return {
    id: o.id,
    user_id: o.userId,
    person_id: o.personId,
    chat_id: n(o.chatId),
    goal_id: n(o.goalId),
    channel: o.channel === 'linkedin' ? 'linkedin' : 'gmail',
    kind: o.kind,
    subject: n(o.subject),
    body: o.bodyFinal ?? o.bodyDraft,
    ask: extra.ask ?? null,
    hooks: extra.hooks ?? [],
    via: extra.via ?? null,
    thread_external_id: n(o.externalThreadId),
    in_reply_to: n(o.inReplyToMessageId),
    status: DRAFT_STATUS_OUT[o.status],
    autonomy_level: extra.autonomy_level ?? 0,
    send_at: n(o.sendAt),
    sent_at: n(o.sentAt),
    provider_message_id: n(o.providerMessageId),
    error: n(o.error),
    cancel_reason: null,
    validator: extra.validator ?? null,
    generated_by: o.generatedBy,
    prompt_version: extra.prompt_version ?? null,
    variant: extra.variant ?? null,
    replied_at: null,
    reply_class: null,
    created_at: o.createdAt,
    updated_at: extra.at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// notes, facts, dossiers, recommendations

export function noteFromRow(r: Row.Notes): MeetingNote {
  return compact({
    id: r.id,
    userId: r.user_id,
    source: r.source as MeetingNote['source'],
    title: u(r.title),
    occurredAt: r.occurred_at,
    rawText: r.raw_text,
    attendees: [],
    personIds: r.person_ids,
    chatId: u(r.chat_id),
    matchStatus: r.person_ids.length ? ('confirmed' as const) : ('unmatched' as const),
    extraction: u(r.extraction) as MeetingNote['extraction'],
    createdAt: r.created_at,
  });
}

export function noteToRow(m: MeetingNote, at: Ts): Row.Notes {
  return {
    id: m.id,
    user_id: m.userId,
    person_ids: m.personIds,
    chat_id: n(m.chatId),
    source: m.source,
    title: n(m.title),
    occurred_at: m.occurredAt,
    raw_text: m.rawText,
    extraction: n(m.extraction),
    created_at: m.createdAt,
    updated_at: at,
  };
}

export function factFromRow(r: Row.Facts): PersonFact {
  return compact({
    id: r.id,
    userId: r.user_id,
    personId: r.person_id,
    type: r.type as PersonFact['type'],
    text: r.text,
    sourceTable: r.source_table ?? '',
    sourceId: r.source_id ?? '',
    occurredAt: u(r.occurred_at),
    confidence: r.confidence,
    deletedAt: u(r.deleted_at),
    createdAt: r.created_at,
  });
}

export function factToRow(f: PersonFact, at: Ts): Row.Facts {
  return {
    id: f.id,
    user_id: f.userId,
    person_id: f.personId,
    type: f.type,
    text: f.text,
    source_table: f.sourceTable || null,
    source_id: f.sourceId || null,
    occurred_at: n(f.occurredAt),
    confidence: f.confidence,
    deleted_at: n(f.deletedAt),
    created_at: f.createdAt,
    updated_at: at,
  };
}

export function dossierFromRow(r: Row.Dossiers): Dossier {
  return compact({
    id: r.id,
    userId: r.user_id,
    personId: r.person_id,
    goalId: u(r.goal_id),
    status: r.status,
    content: u(r.content) as Dossier['content'],
    sources: r.sources,
    candidates: u(r.candidates),
    costUsd: Number(r.cost_usd),
    model: u(r.model),
    error: u(r.error),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  });
}

export function dossierToRow(d: Dossier): Row.Dossiers {
  return {
    id: d.id,
    user_id: d.userId,
    person_id: d.personId,
    goal_id: n(d.goalId),
    status: d.status,
    content: (d.content as Record<string, Json> | undefined) ?? null,
    sources: d.sources,
    candidates: n(d.candidates),
    cost_usd: d.costUsd.toFixed(4),
    model: n(d.model),
    error: n(d.error),
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    expires_at: d.expiresAt,
  };
}

const REC_STATUS_IN: Record<Row.Recommendations['status'], Recommendation['status']> = {
  new: 'new',
  added: 'converted',
  dismissed: 'dismissed',
};

/** `orbit.recommendations` → `Recommendation` (rows without a person yet are candidates, not recommendations). */
export function recommendationFromRow(r: Row.Recommendations): Recommendation | undefined {
  if (!r.person_id) return undefined;
  return {
    id: r.id,
    userId: r.user_id,
    personId: r.person_id,
    score: r.rank,
    fitScore: r.fit ?? 0,
    reachScore: r.reach ?? 0,
    responsePrior: r.responsiveness ?? 0,
    reasons: r.reasons.map((text) => ({ code: 'reason', text })),
    status: REC_STATUS_IN[r.status],
    batchDate: r.created_at.slice(0, 10),
  };
}

export function recommendationToRow(
  rec: Recommendation,
  extra: { batchId: Uuid; source: string; goalId?: Uuid; candidate?: Record<string, Json>; at: Ts },
): Row.Recommendations {
  const status = rec.status === 'converted' ? 'added' : rec.status === 'dismissed' ? 'dismissed' : 'new';
  return {
    id: rec.id,
    user_id: rec.userId,
    goal_id: n(extra.goalId),
    person_id: rec.personId,
    candidate: extra.candidate ?? {},
    source: extra.source,
    external_id: null,
    rank: rec.score,
    fit: rec.fitScore,
    reach: rec.reachScore,
    responsiveness: rec.responsePrior,
    reasons: rec.reasons.map((r) => r.text),
    status,
    batch_id: extra.batchId,
    created_at: extra.at,
    updated_at: extra.at,
  };
}
