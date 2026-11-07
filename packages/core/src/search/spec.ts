/**
 * The query network search runs (plan 32 §4.1, revision 2 in §18): what the chat model compiles a sentence into.
 * The zod schema lives with the chat tool (web, zod 4); these are the types and the defaults every consumer shares.
 *
 * Booleans: OR inside an array, AND across blocks, `anyOf` for OR between position blocks.
 */
import type { RelationshipType } from '../types';
import type { CompanyKind, Stage } from './companies';
import type { SearchSeniority, TitleFamily } from './titles';

export type Need = 'must' | 'nice';
export type When = 'current' | 'past' | 'ever';
export type WarmthBand = 'light' | 'warm' | 'strong' | 'close';

export interface RoleSpec {
  titles?: string[];
  families?: TitleFamily[];
  seniority?: SearchSeniority[];
  seniorityAtLeast?: SearchSeniority;
  founder?: boolean;
}

export interface CompanySpec {
  names?: string[];
  /** include subsidiaries of a named parent (default true; the card shows the chip) */
  withSubsidiaries?: boolean;
  kinds?: CompanyKind[];
  yc?: { batches?: string[]; any?: boolean };
  stages?: Stage[];
  sizeMin?: number;
  sizeMax?: number;
  industries?: string[];
}

export interface PositionSpec {
  id?: string;
  role?: RoleSpec;
  company?: CompanySpec;
  when?: When;
  startedWithinYears?: number;
  endedWithinYears?: number;
  need?: Need;
  negate?: boolean;
}

export type Degree = 'undergrad' | 'masters' | 'mba' | 'phd' | 'high_school';

export interface SchoolSpec {
  names: string[];
  fields?: string[];
  degree?: Degree[];
  gradFrom?: number;
  gradTo?: number;
  need?: Need;
  negate?: boolean;
}

export interface PlaceSpec {
  names: string[];
  need?: Need;
  negate?: boolean;
}

export interface KeywordSpec {
  terms: string[];
  need?: Need;
  negate?: boolean;
}

export type Channel = 'email' | 'meeting' | 'text' | 'linkedin';

export interface TouchSpec {
  channel: Channel;
  direction?: 'in' | 'out' | 'any';
  withinDays?: number;
  beforeDays?: number;
  negate?: boolean;
}

export interface RelationshipSpec {
  warmthAtLeast?: WarmthBand;
  types?: RelationshipType[];
  everTalked?: boolean;
  talkedWithinDays?: number;
  quietForDays?: number;
  touched?: TouchSpec[];
  connectedWithinDays?: number;
  hasChat?: boolean;
  tags?: string[];
  mutualWith?: string;
  throughFriend?: string;
  alumOfMySchool?: boolean;
}

export interface CriterionSpec {
  text: string;
  need?: Need;
}

export interface QuerySpec {
  ask: string;
  scope?: 'mine' | 'mine_and_friends';
  positions?: PositionSpec[];
  anyOf?: string[][];
  schools?: SchoolSpec[];
  places?: PlaceSpec[];
  keywords?: KeywordSpec;
  relationship?: RelationshipSpec;
  like?: string;
  exclude?: { personIds?: string[] };
  criteria?: CriterionSpec[];
  unsupported?: string[];
  count?: boolean;
  sort?: 'match' | 'warmth' | 'recent' | 'name';
  refine?: { resultSetId: string; mode: 'narrow' | 'widen' | 'replace'; onlyThese?: boolean };
  limit?: number;
  /** what lint changed, said on the card */
  lint?: string[];
}

export const WARMTH_RANK: Record<WarmthBand | 'faint', number> = {
  faint: 0,
  light: 1,
  warm: 2,
  strong: 3,
  close: 4,
};

/** Whether a spec asks anything at all (an empty spec is refused and the model asks one question). */
export function specIsEmpty(s: QuerySpec): boolean {
  const rel = s.relationship ?? {};
  return (
    !s.positions?.length &&
    !s.schools?.length &&
    !s.places?.length &&
    !s.keywords?.terms.length &&
    !s.criteria?.length &&
    !s.like &&
    !Object.values(rel).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0))
  );
}
