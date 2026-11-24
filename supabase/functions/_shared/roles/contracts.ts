/**
 * Plan 44: the seams between the parts of Roles on the server. The source side (boards.ts, readers/*, intake.ts,
 * discover.ts, tick.ts) implements these; the search side (profile.ts, candidates.ts, score.ts, the /roles routes)
 * calls them. Tests use fakes of the same shapes.
 */

import type { Job, JobListing, JobRequirement } from '../../../../packages/core/src/roles/types.ts';
import type { Db } from '../db.ts';

export interface RoleNet {
  fetch: typeof fetch;
  now: () => Date;
}

/** The student's own LinkedIn, through Unipile (the account must be theirs and active). */
export interface LinkedinJobAccess {
  base: string;
  apiKey: string;
  accountId: string;
}

/** A LinkedIn job search: one call per role kind, newest first. */
export interface LinkedinJobQuery {
  keywords: string;
  /** LinkedIn's EXPERIENCE LEVEL filter */
  seniority?: ('intern' | 'entry' | 'associate' | 'mid_senior' | 'director' | 'executive')[];
  jobType?: ('full_time' | 'part_time' | 'contract' | 'temporary' | 'internship')[];
  presence?: ('on_site' | 'hybrid' | 'remote')[];
  /** days since posting */
  datePosted?: number;
  limit?: number;
}

/**
 * What `text` rejects with when the posting could not be read just now (its source is busy or unreachable): the
 * role is left to be read later, never scored on its title alone as if it had no text.
 */
export class TextLater extends Error {
  constructor(reason = 'later') {
    super(reason);
    this.name = 'TextLater';
  }
}

/** What the search side needs from the source side. */
export interface RoleSources {
  /** Store listings (intake: level, family, places, term, dedupe) and return the stored roles, in order. */
  keep(db: Db, listings: JobListing[], o?: { boardId?: string }): Promise<Job[]>;
  /**
   * The posting's text for a stored role, read from its source when not kept yet (or when older than 7 days), cleaned
   * and capped at 8,000 characters, and stored with its hash. Undefined when the source cannot give it (a page
   * Orbit cannot read, a role that is gone). Rejects with `TextLater` when it could not be read just now.
   */
  text(db: Db, net: RoleNet, jobId: string, linkedin?: LinkedinJobAccess): Promise<string | undefined>;
  /** One LinkedIn job search through the student's own account. Results are listings, not yet kept. */
  linkedinSearch(net: RoleNet, access: LinkedinJobAccess, q: LinkedinJobQuery): Promise<JobListing[]>;
  /** A posting by its link: a board, Workday, LinkedIn or any page with a JobPosting block. */
  readUrl(net: RoleNet, url: string, linkedin?: LinkedinJobAccess): Promise<JobListing | { problem: string }>;
}

/** What the source side stores for the search side: the requirements read once per text (plan 44 §6.2). */
export interface StoredRequirements {
  hash: string;
  requirements: JobRequirement[];
}
