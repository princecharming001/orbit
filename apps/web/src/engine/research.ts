/**
 * Research dossiers (plan 16 §5) from the browser's side: ask orbit-api for one, read it, answer "which person did
 * you mean", and turn the stored synthesis into what the card and the chat show, with numbered source links. Account
 * mode only: the research runs on the server.
 */
import type { Dossier, User } from '@orbit/core';
import { db } from '../db/schema';
import {
  type ApiFailure,
  callApi,
  isAccountMode,
  isServerUser,
  NO_SERVER,
  SIGN_IN_FIRST,
} from '../integrations/orbitApi';
import { writeFromServer } from './serverSync';

export interface Claim {
  text: string;
  /** 1-based numbers of the sources it came from */
  sources: number[];
  date?: string;
  /**
   * what the support check said (deep research): 'full' when the cited page says it, 'partial' when it says only part
   * of it (shown, never used in a draft or a fact), 'unchecked' when the check could not run; absent on older briefs
   */
  support?: 'full' | 'partial' | 'unchecked';
}

export interface DossierView {
  status: Dossier['status'];
  who?: string;
  now?: Claim;
  recently: Claim[];
  inCommon: Claim[];
  history?: { firstContact?: string; lastContact?: string; summary?: string };
  openers: Claim[];
  careful: string[];
  /** the same, with their sources (deep research cites every line) */
  carefulClaims: Claim[];
  /** what is happening at their company (Go deeper) */
  company: Claim[];
  /** Go deeper ran: 'person' (more about them) or 'company' (their company's news and hiring) */
  deeper?: string;
  confidence?: string;
  /** the full picture (dossier v1.1): empty on a dossier written before it */
  career: (Claim & { role: string; org: string; start?: string; end?: string })[];
  education: (Claim & { school: string; degree?: string; years?: string })[];
  profiles: { kind: string; url: string }[];
  highlights: (Claim & { kind: string; title: string; url?: string; summary?: string })[];
  topics: string[];
  sources: { n: number; url?: string; title?: string; demo?: boolean }[];
  /** for needs_disambiguation: the people it might be */
  candidates: { index: number; label: string; url?: string }[];
  updatedAt: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** a field under its snake_case or camelCase name (the synthesis is stored as the model wrote it) */
const field = (o: Obj | undefined, snake: string): unknown => {
  if (!o) return undefined;
  if (snake in o) return o[snake];
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return o[camel];
};

/** The synthesis as the card shows it: every claim with the numbers of its sources. */
export function dossierView(d: Dossier): DossierView {
  const sources = (d.sources ?? []).map((s, i) => ({
    n: i + 1,
    // a web address only: a source is a link on the page, never anything it could run
    url: str(s.url) && /^https?:\/\//i.test(str(s.url)!) ? str(s.url) : undefined,
    title: str(s.title),
    id: s.id,
    demo: s.demo === true,
  }));
  const numberOf = new Map(sources.map((s) => [s.id, s.n]));
  const refs = (o: Obj | undefined) =>
    arr(field(o, 'source_ids'))
      .map((id) => numberOf.get(String(id)))
      .filter((n): n is number => typeof n === 'number');
  const claim = (v: unknown, textKey = 'text'): Claim | undefined => {
    const o = obj(v);
    if (!o) return str(v) ? { text: str(v)!, sources: [] } : undefined;
    const text = str(o[textKey]);
    const support =
      o.support === 'full' || o.support === 'partial' || o.support === 'unchecked' ? o.support : undefined;
    return text ? { text, sources: refs(o), date: str(o.date), ...(support ? { support } : {}) } : undefined;
  };
  const c = obj(d.content) ?? {};
  const now = obj(field(c, 'now'));
  const nowText = now
    ? [
        str(now.role),
        str(now.org) ? `at ${str(now.org)}` : undefined,
        str(now.since) ? `since ${str(now.since)}` : undefined,
      ]
        .filter(Boolean)
        .join(' ')
    : undefined;
  const history = obj(field(c, 'history'));
  return {
    status: d.status,
    who: str(field(c, 'who')),
    now: nowText ? (claim({ ...now, text: nowText }) ?? { text: nowText, sources: refs(now) }) : undefined,
    recently: arr(field(c, 'recently'))
      .map((x) => claim(x))
      .filter((x): x is Claim => !!x)
      .slice(0, 3),
    inCommon: arr(field(c, 'in_common'))
      .map((x) => claim(x))
      .filter((x): x is Claim => !!x),
    history: history
      ? {
          firstContact: str(field(history, 'first_contact')),
          lastContact: str(field(history, 'last_contact')),
          summary: str(history.summary),
        }
      : undefined,
    openers: arr(field(c, 'openers'))
      .map((x) => claim(x))
      .filter((x): x is Claim => !!x)
      .slice(0, 3),
    careful: arr(field(c, 'careful'))
      .map((x) => claim(x)?.text)
      .filter((x): x is string => !!x),
    carefulClaims: arr(field(c, 'careful'))
      .map((x) => claim(x))
      .filter((x): x is Claim => !!x),
    company: arr(field(c, 'company'))
      .map((x) => claim(x))
      .filter((x): x is Claim => !!x),
    deeper: str(field(c, 'deeper')),
    confidence: str(field(c, 'confidence')),
    career: arr(field(c, 'career'))
      .map((x) => {
        const o = obj(x);
        const role = str(o?.role);
        const org = str(o?.org);
        if (!o || (!role && !org)) return undefined;
        const text = [role, org && `at ${org}`].filter(Boolean).join(' ');
        return {
          text,
          sources: refs(o),
          role: role ?? '',
          org: org ?? '',
          start: str(o.start),
          end: str(o.end),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    education: arr(field(c, 'education'))
      .map((x) => {
        const o = obj(x);
        const school = str(o?.school);
        if (!o || !school) return undefined;
        return { text: school, sources: refs(o), school, degree: str(o.degree), years: str(o.years) };
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    profiles: arr(field(c, 'profiles'))
      .map((x) => {
        const o = obj(x);
        const url = str(o?.url);
        return url && /^https?:\/\//i.test(url) ? { kind: str(o?.kind) ?? 'other', url } : undefined;
      })
      .filter((x): x is { kind: string; url: string } => !!x),
    highlights: arr(field(c, 'highlights'))
      .map((x) => {
        const o = obj(x);
        const title = str(o?.title);
        if (!o || !title) return undefined;
        const url = str(o.url);
        return {
          text: title,
          title,
          sources: refs(o),
          date: str(o.date),
          kind: str(o.kind) ?? 'other',
          url: url && /^https?:\/\//i.test(url) ? url : undefined,
          summary: str(o.summary),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    topics: arr(field(c, 'topics'))
      .map(str)
      .filter((x): x is string => !!x),
    sources: sources.map(({ n, url, title, demo }) => ({ n, url, title, demo })),
    candidates: arr(d.candidates).map((x, index) => {
      const o = obj(x) ?? {};
      const label =
        [str(o.name), str(o.title), str(o.org) ?? str(o.company), str(o.location)]
          .filter(Boolean)
          .join(', ') ||
        str(x) ||
        `Person ${index + 1}`;
      return { index, label, url: str(o.url) ?? str(o.linkedinUrl) };
    }),
    updatedAt: d.updatedAt,
  };
}

export type ResearchResult =
  | { ok: true; status: 'queued' | Dossier['status']; dossier: Dossier | null }
  | { ok: false; message: string; reason?: ApiFailure['reason'] };

function notHere(): ResearchResult {
  return { ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER, reason: 'signed_out' };
}

async function keep(userId: string, d: Dossier | null | undefined): Promise<void> {
  if (d) await writeFromServer('dossiers', [d as unknown as Record<string, unknown>], userId);
}

/** The newest dossier this browser holds for a person. */
export async function localDossier(personId: string): Promise<Dossier | undefined> {
  const rows = await db.dossiers.where('personId').equals(personId).toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Read the person's dossier from the server (and keep a copy). */
export async function getDossier(user: Pick<User, 'id'>, personId: string): Promise<ResearchResult> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/research/get', { personId });
  if (!r.ok) {
    const local = await localDossier(personId);
    if (local && r.reason === 'network') return { ok: true, status: local.status, dossier: local };
    return { ok: false, message: r.message, reason: r.reason };
  }
  await keep(user.id, r.value.dossier);
  return { ok: true, status: r.value.dossier?.status ?? 'queued', dossier: r.value.dossier };
}

/** Ask for research on a person: a fresh dossier comes back at once, otherwise it is queued. */
export async function researchPerson(
  user: Pick<User, 'id'>,
  personId: string,
  opts: { refresh?: boolean; goalId?: string } = {},
): Promise<ResearchResult> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/research/person', { personId, refresh: opts.refresh, goalId: opts.goalId });
  if (!r.ok) return { ok: false, message: r.message, reason: r.reason };
  await keep(user.id, r.value.dossier);
  return { ok: true, status: r.value.status, dossier: r.value.dossier };
}

/** Answer "which of these did you mean" and research that one. */
export async function chooseCandidate(
  user: Pick<User, 'id'>,
  personId: string,
  candidateIndex: number,
): Promise<ResearchResult> {
  if (!isServerUser(user.id)) return notHere();
  const r = await callApi('/research/choose', { personId, candidateIndex });
  if (!r.ok) return { ok: false, message: r.message, reason: r.reason };
  await keep(user.id, r.value.dossier);
  return { ok: true, status: r.value.status, dossier: r.value.dossier };
}
