/**
 * Plan 44, Roles for you: the shapes every part shares. The browser, orbit-api, orbit-worker and the tests import
 * these, so a change here is a change to all of them.
 *
 * A **role** is one open job from any source (`Job`). A student's **profile** (`RoleProfile`) is what Orbit read from
 * their resume and LinkedIn profile, as they corrected it. A **match** (`RoleMatch`) is one role for one student: its
 * free rank, then its score out of 10 with the answers and quotes it rests on.
 */

import type { TitleFamily } from '../search/titles';

// ---- roles ---------------------------------------------------------------------------------------------------------

export const JOB_SOURCES = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'workable',
  'recruitee',
  'simplify',
  'linkedin',
  'posting',
] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/** Services that host a company's whole board (`orbit_private.job_boards.service`). */
export const BOARD_SERVICES = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'workable',
  'recruitee',
] as const;
export type BoardService = (typeof BOARD_SERVICES)[number];

/** A role's level. `undefined` (null in SQL) is "the posting does not say". */
export const JOB_LEVELS = ['intern', 'entry', 'mid', 'senior', 'lead', 'exec'] as const;
export type JobLevel = (typeof JOB_LEVELS)[number];

export type Remote = 'remote' | 'hybrid' | 'on_site';
export type Employment = 'full_time' | 'part_time' | 'contract' | 'internship' | 'temporary';

export interface JobPay {
  min?: number;
  max?: number;
  currency?: string;
  per?: 'hour' | 'year' | 'month';
}

/**
 * One role as a reader returns it, before it is stored. Readers fill what their source says and nothing else; intake
 * (`_shared/roles/intake.ts`) adds level, family, places, term and remote where the reader left them out.
 */
export interface JobListing {
  source: JobSource;
  /** the source's own id for the role (Greenhouse job id, Workday external path, LinkedIn job id, ...) */
  externalId: string;
  companyName: string;
  companyDomain?: string;
  companyLinkedinId?: string;
  companyLogoUrl?: string;
  title: string;
  team?: string;
  /** places as the source writes them, one per entry ("San Francisco, CA", "Remote - US") */
  locations: string[];
  remote?: Remote;
  employment?: Employment;
  level?: JobLevel;
  term?: string;
  pay?: JobPay;
  sponsorship?: 'offers' | 'none';
  degrees?: string[];
  language?: string;
  /** the page a person reads */
  url: string;
  applyUrl?: string;
  postedAt?: string;
  /** the posting's text when the listing call gives it; otherwise read later with `JobText` */
  text?: string;
  /** anything else worth keeping (department, requisition id, Simplify category) */
  meta?: Record<string, unknown>;
}

/** A role as stored and shown. */
export interface Job {
  id: string;
  source: JobSource;
  externalId: string;
  companyKey: string;
  companyName: string;
  companyDomain?: string;
  companyLogoUrl?: string;
  title: string;
  team?: string;
  family?: TitleFamily;
  level?: JobLevel;
  employment?: Employment;
  places: string[];
  countries: string[];
  remote?: Remote;
  term?: string;
  pay?: JobPay;
  sponsorship?: 'offers' | 'none';
  degrees: string[];
  url: string;
  applyUrl?: string;
  postedAt?: string;
  firstSeenAt: string;
  closedAt?: string;
}

/** One requirement read from a posting (plan 44 §6.2). */
export interface JobRequirement {
  kind: 'skill' | 'experience' | 'education' | 'eligibility';
  /** `must`: the posting says required, minimum, must; `nice`: preferred, bonus, plus */
  need: 'must' | 'nice';
  /** short name ("Python", "2+ years in data analysis", "BS in Computer Science", "US work authorization") */
  name: string;
  /** the posting's own words, checked to be in its text */
  quote: string;
  /** experience: years asked for; education: the lowest degree asked */
  years?: number;
  degree?: 'high_school' | 'associate' | 'bachelor' | 'master' | 'phd' | 'mba' | 'jd' | 'md';
  /** eligibility: what is asked */
  eligibility?: 'citizenship' | 'clearance' | 'no_sponsorship' | 'work_authorization' | 'graduation_window';
  /** graduation_window: the graduation dates the posting asks for, YYYY-MM */
  gradFrom?: string;
  gradTo?: string;
}

// ---- the student ---------------------------------------------------------------------------------------------------

/** The student's level, from dates (plan 44 §3). */
export const PROFILE_LEVELS = ['student', 'new_grad', 'early', 'mid', 'senior'] as const;
export type ProfileLevel = (typeof PROFILE_LEVELS)[number];

export type DegreeKind = NonNullable<JobRequirement['degree']>;

export interface ProfileExperience {
  title: string;
  org?: string;
  start?: string;
  end?: string;
  /** full-time after school; internships, campus jobs and research assistantships are not */
  fullTime: boolean;
  family?: TitleFamily;
  /** what they did, in their own words; empty when the source gave only a title */
  text: string;
}

export interface ProfileSkill {
  name: string;
  /** written: on the resume or profile; read: plainly used in a line (with `line`); added: by the student here */
  from: 'written' | 'read' | 'added';
  line?: string;
}

/** A kind of role that fits, proposed from the profile and ticked by the student. */
export interface RoleKind {
  /** a short title a posting would use ("Software engineer", "Product analyst") */
  title: string;
  family?: TitleFamily;
  /** one line of why, resting on the student's own words */
  why?: string;
  /** the line it rests on, checked to be in the profile */
  line?: string;
  on: boolean;
}

export interface RoleWants {
  /** which levels to look at; empty: the ones that fit the profile's level */
  levels: JobLevel[];
  places: string[];
  notPlaces: string[];
  remote: boolean;
  /** only these companies, when set (from "roles at Stripe") */
  companies?: string[];
}

export interface RoleProfile {
  level: ProfileLevel;
  /** YYYY-MM */
  graduation?: string;
  degree?: DegreeKind;
  field?: string;
  school?: string;
  courses: string[];
  experience: ProfileExperience[];
  projects: { title?: string; text: string }[];
  skills: ProfileSkill[];
  kinds: RoleKind[];
  wants: RoleWants;
  /** asked, never guessed; undefined means not asked */
  eligibility: { needsSponsorship?: boolean; usCitizen?: boolean };
  sources: ('resume' | 'linkedin')[];
  /** months of full-time work after school */
  fullTimeMonths: number;
}

/** The lines the browser sends to be read into a profile (`/roles/profile` with `read`). */
export interface ProfileLines {
  /** the resume's facets, excluded lines left out */
  resume?: {
    experience: { title: string; org?: string; start?: string; end?: string; lines: string[] }[];
    education: { school: string; degree?: string; field?: string; end?: string; lines: string[] }[];
    projects: { title?: string; lines: string[] }[];
    skills: string[];
    courses: string[];
  };
  /** the student's own LinkedIn profile */
  linkedin?: {
    headline?: string;
    about?: string;
    positions: { title: string; org?: string; start?: string; end?: string; description?: string }[];
    schools: { school: string; degree?: string; field?: string; start?: string; end?: string }[];
    skills: string[];
    projects: { name: string; description?: string }[];
  };
}

// ---- the score -----------------------------------------------------------------------------------------------------

export type SkillAnswer = 'work' | 'project' | 'listed' | 'none';
export type ExperienceAnswer = 'same' | 'related' | 'projects' | 'none';
export type EducationAnswer = 'fits' | 'close' | 'no' | 'unsaid';
export type LevelAnswer = 'at' | 'below' | 'stretch' | 'far';

/** One answer with the lines it rests on: the student's and the posting's, each checked against its text. */
export interface Quoted<A> {
  answer: A;
  you?: string;
  posting?: string;
}

/** What the model answers about one student and one role (plan 44 §6.3). The formula turns it into the score. */
export interface FitAnswers {
  skills: (Quoted<SkillAnswer> & { name: string; need: 'must' | 'nice' })[];
  experience: Quoted<ExperienceAnswer>;
  education: Quoted<EducationAnswer>;
  level: Quoted<LevelAnswer>;
  /** facts that cap the score, each quoted from the posting */
  caps: FitCapFact[];
  /** the strongest reason, a few words ("Python and SQL from your Ramp internship") */
  reason: string;
  /** things the student could do, never invented ("Kubernetes is asked for and not on your resume") */
  gaps: string[];
}

export type FitCapKind =
  | 'degree'
  | 'years'
  | 'graduation'
  | 'sponsorship'
  | 'citizenship_no'
  | 'citizenship_ask'
  | 'place'
  | 'thin';

export interface FitCapFact {
  kind: FitCapKind;
  /** the posting's words */
  quote?: string;
  /** what the row says ("Asks for a PhD") */
  label: string;
}

export interface FitParts {
  skills?: number;
  experience?: number;
  education?: number;
  level?: number;
}

export interface Fit {
  /** 1 to 10 */
  score: number;
  /** before the caps */
  raw: number;
  /** each part 0 to 1; a part the posting says nothing about is left out */
  parts: FitParts;
  /** the weights used, after left-out parts were shared out */
  weights: FitParts;
  caps: FitCapFact[];
  band: FitBand;
}

export type FitBand = 'strong' | 'good' | 'stretch' | 'out';

// ---- matches -------------------------------------------------------------------------------------------------------

export type MatchState = 'to_read' | 'read' | 'failed' | 'gone';
export type MatchStatus = 'new' | 'saved' | 'dismissed' | 'applied' | 'interviewing';
export type DismissReason = 'kind' | 'level' | 'place' | 'company' | 'other';

export interface RoleMatch {
  id: string;
  job: Job;
  state: MatchState;
  rank: number;
  fit?: Fit;
  answers?: FitAnswers;
  reason?: string;
  gaps?: string[];
  status: MatchStatus;
  dismissReason?: DismissReason;
  readAt?: string;
  /**
   * set when the row is not read closely (the model is off, a limit is reached, it is still to be read when a search
   * stops): the row shows these free parts and "Not read closely yet", never a number. Such a row has no `fit` and
   * its state is `to_read` or `failed`.
   */
  roughFit?: { skills: number; level: boolean; place: boolean };
}

// ---- the API (all POST) --------------------------------------------------------------------------------------------

/** POST /roles/profile: read lines into a proposed profile, or save the one the student confirmed. */
export type RolesProfileRequest = { read: ProfileLines } | { save: RoleProfile } | { get: true };
export interface RolesProfileResponse {
  /** the profile the student confirmed (`save`, `get`); absent from `get` until they have confirmed one */
  profile?: RoleProfile;
  /** what Orbit read, before the student changed anything (`read`, and kept for `get`) */
  proposed?: RoleProfile;
  /** a line for the profile screen when it read little ("Your LinkedIn lists roles but not what you did in them") */
  note?: string;
}

/** POST /roles/search: filter, rank, list the roles to read; answers at once with any already scored. */
export interface RolesSearchRequest {
  /** a new search even when one for this profile is fresh */
  fresh?: boolean;
}
export interface RolesSearchResponse {
  searchId: string;
  matches: RoleMatch[];
  /** how many roles are listed for reading and how many are read */
  listed: number;
  read: number;
  done: boolean;
  /** what was searched ("1,240 company boards, 8,170 roles from SimplifyJobs, your LinkedIn search") */
  coverage: RolesCoverage;
  /** a line when the model is off or today's limit is reached */
  note?: string;
}

export interface RolesCoverage {
  boards: number;
  roles: number;
  linkedin: boolean;
  simplify: boolean;
}

/**
 * POST /roles/more: read the next few closely. In production the answer comes at once and the reading carries on
 * behind it: each answer holds every row read so far for the search, `done: false` until none is left to read. When
 * the search is over without everything read (the model is off, a limit is reached), `done` is true and the rows not
 * read closely come too, each with `roughFit` and no `fit`. A search that a newer one replaced answers 404
 * `search_replaced`: ask /roles/search once more and follow the search it gives.
 */
export interface RolesMoreRequest {
  searchId: string;
}
export type RolesMoreResponse = RolesSearchResponse;

/** POST /roles/list: what is already scored, and Saved. Free. */
export interface RolesListRequest {
  view?: 'matches' | 'saved';
  /** with `matches`: also the latest search's roles not read closely yet, each with `roughFit` and no `fit` */
  rest?: boolean;
}
export interface RolesListResponse {
  matches: RoleMatch[];
  searchId?: string;
  coverage?: RolesCoverage;
  profileAt?: string;
}

/** POST /roles/score: one posting, by link or by its text, scored now. */
export interface RolesScoreRequest {
  url?: string;
  text?: string;
  title?: string;
  company?: string;
}
export interface RolesScoreResponse {
  match?: RoleMatch;
  /**
   * why it could not be scored ("Orbit cannot read this site: paste the posting's text"). With no profile yet it
   * names the profile ("Read your resume or LinkedIn profile first ..."), and the posting card links to Roles.
   */
  problem?: string;
}

/** POST /roles/act: a status for one match answers `match`; `watch` answers `watching`, the companies watched now. */
export type RolesActRequest =
  | { matchId: string; status: MatchStatus; dismissReason?: DismissReason }
  | { watch: { companyName: string; on: boolean } };
export interface RolesActResponse {
  match?: RoleMatch;
  watching?: string[];
}
