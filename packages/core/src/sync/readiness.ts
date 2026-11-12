/**
 * Is Orbit ready yet? One answer for the app, the server and the "Orbit is ready" email, so all three say the same
 * thing (plan 40).
 *
 * The first import is a short list of steps, each waiting, working (with a count when there is one), done, or needing
 * the student. A step exists only for what the student connected: no LinkedIn, no LinkedIn steps.
 *
 *   LinkedIn connections · LinkedIn messages · Recent email (90 days) · Older email · Mapping your network
 *
 * Overall:
 * - `nothing`: nothing connected yet, so there is nothing to wait for;
 * - `syncing`: something is still coming in and nothing is usable yet;
 * - `usable`: the people and the recent mail are in (the student can start), older mail or the network map is still
 *   going;
 * - `ready`: every step is done;
 * - `problem`: a source needs the student (sign in again); the other steps still count.
 */

export type StepState = 'waiting' | 'working' | 'done' | 'problem';

export interface ReadyStep {
  key:
    | 'linkedin_people'
    | 'linkedin_messages'
    | 'email_recent'
    | 'email_older'
    | 'network'
    | 'texts'
    | 'instagram'
    | 'x';
  label: string;
  state: StepState;
  /** "1,240 connections so far", "3,100 of 9,800" */
  detail?: string;
  /** 0 to 1 when the step knows how far along it is */
  share?: number;
  /**
   * an optional source's step (plan 43 §3.10): shown in the list, never counted in the progress or the state, so
   * it never holds up "ready"
   */
  optional?: boolean;
}

export type ReadyState = 'nothing' | 'syncing' | 'usable' | 'ready' | 'problem';

export interface Readiness {
  state: ReadyState;
  steps: ReadyStep[];
  /** 0 to 1 over every step, for a bar or a percentage */
  progress: number;
  /** one line for a chip or a banner: "Reading your LinkedIn", "Orbit is ready" */
  headline: string;
}

/** What readiness is worked out from: the same facts whether the browser or the server asks. */
export interface ReadinessInput {
  google?: {
    status: string;
    /** the Gmail import's phase: recent (last 90 days), deep (older), complete */
    phase?: string | null;
    done?: number;
    total?: number | null;
  };
  linkedin?: {
    status: string;
    /** the first pass's stage: relations, chats, done; unknown from an older status */
    stage?: string | null;
    /** set once a full pass has finished */
    syncedAt?: string | null;
    /** the status says the first pass is still going (when the stage is not known) */
    importing?: boolean;
  };
  /** background jobs still queued for this account (scoring, matching, classifying) */
  pending: number;
  counts?: { people?: number; messages?: number; ties?: number };
  /**
   * Texts from the Mac's Messages (plan 43 §6), when the student switched them on: read in the browser, so the step is
   * done once an import has run and waits for one otherwise. It never holds up "ready".
   */
  texts?: { state: 'on' | 'off'; people?: number; importedAt?: string | null };
  /**
   * Instagram (plan 43 §4), when the student switched it on: done once its first days' reading is through, working
   * while it reads (`reading` says what), a problem when Instagram asked to sign in again. Never holds up "ready".
   */
  instagram?: { status: string; reading?: string };
  /** X (plan 43 §5), when switched on: done once connected. Never holds up "ready". */
  x?: { status: string };
}

const fmt = (n: number) => n.toLocaleString('en-US');
const BROKEN = new Set(['needs_reauth', 'error', 'revoked']);

export function readiness(i: ReadinessInput): Readiness {
  const steps: ReadyStep[] = [];
  const people = i.counts?.people ?? 0;

  const li = i.linkedin;
  if (li && li.status !== 'revoked' && li.status !== 'parked') {
    const broken = BROKEN.has(li.status);
    const finished = !!li.syncedAt || li.stage === 'done';
    const stage = finished ? 'done' : (li.stage ?? 'relations');
    steps.push({
      key: 'linkedin_people',
      label: 'LinkedIn connections',
      state: broken ? 'problem' : stage === 'relations' ? 'working' : 'done',
      detail: broken
        ? 'LinkedIn needs you to connect again'
        : people
          ? stage === 'relations'
            ? `${fmt(people)} people so far`
            : `${fmt(people)} people`
          : undefined,
    });
    steps.push({
      key: 'linkedin_messages',
      label: 'LinkedIn messages',
      state: broken ? 'problem' : finished ? 'done' : stage === 'chats' ? 'working' : 'waiting',
    });
  }

  const g = i.google;
  if (g && g.status !== 'revoked') {
    const broken = BROKEN.has(g.status);
    const phase = g.phase ?? 'recent';
    const recentDone = phase === 'deep' || phase === 'complete';
    const done = g.done ?? 0;
    const counted = phase === 'deep' && !!g.total && done < g.total;
    const messages = i.counts?.messages ?? 0;
    steps.push({
      key: 'email_recent',
      label: 'Recent email',
      state: broken ? 'problem' : recentDone ? 'done' : 'working',
      detail: broken
        ? 'Google needs you to sign in again'
        : recentDone
          ? 'The last 90 days'
          : messages
            ? `${fmt(messages)} messages so far`
            : 'The last 90 days',
    });
    steps.push({
      key: 'email_older',
      label: 'Older email',
      state: broken ? 'problem' : phase === 'complete' ? 'done' : phase === 'deep' ? 'working' : 'waiting',
      detail:
        phase === 'deep'
          ? counted
            ? `${fmt(done)} of ${fmt(g.total!)}`
            : done
              ? `${fmt(done)} so far`
              : undefined
          : undefined,
      share: counted ? done / g.total! : undefined,
    });
  }

  if (steps.length) {
    const sourcesDone = steps.every((s) => s.state === 'done');
    steps.push({
      key: 'network',
      label: 'Mapping your network',
      // the jobs that score and match what came in run while it comes in; the step is done once they have drained
      state:
        i.pending > 0
          ? sourcesDone || people > 0
            ? 'working'
            : 'waiting'
          : sourcesDone
            ? 'done'
            : 'waiting',
      detail:
        i.pending > 0
          ? `${fmt(i.pending)} ${i.pending === 1 ? 'task' : 'tasks'} left`
          : sourcesDone && i.counts?.ties
            ? `${fmt(i.counts.ties)} ties`
            : undefined,
    });
  }

  const weight = (s: ReadyStep) =>
    s.state === 'done' ? 1 : s.state === 'working' ? Math.max(0.15, Math.min(0.9, s.share ?? 0.35)) : 0;
  const progress = steps.length ? steps.reduce((a, s) => a + weight(s), 0) / steps.length : 0;

  const problem = steps.some((s) => s.state === 'problem');
  const all = steps.length > 0 && steps.every((s) => s.state === 'done');
  // usable: the people are in, and the recent mail when Google is connected
  const peopleIn = !li || steps.find((s) => s.key === 'linkedin_people')?.state === 'done';
  const recentIn = !g || steps.find((s) => s.key === 'email_recent')?.state === 'done';
  const state: ReadyState = !steps.length
    ? 'nothing'
    : problem
      ? 'problem'
      : all
        ? 'ready'
        : peopleIn && recentIn
          ? 'usable'
          : 'syncing';

  const working = steps.find((s) => s.state === 'working');
  const headline =
    state === 'nothing'
      ? 'Nothing connected yet'
      : state === 'ready'
        ? 'Orbit is ready'
        : state === 'problem'
          ? (steps.find((s) => s.state === 'problem')?.detail ?? 'Something needs you')
          : state === 'usable'
            ? 'Ready to use, still finishing'
            : working?.key.startsWith('linkedin')
              ? 'Reading your LinkedIn'
              : working?.key.startsWith('email')
                ? 'Reading your email'
                : 'Getting your network ready';
  // optional sources come last and are left out of everything above: texts never hold up "ready"
  const t = i.texts;
  if (t?.state === 'on')
    steps.push({
      key: 'texts',
      label: 'Texts',
      state: t.importedAt ? 'done' : 'waiting',
      detail: t.importedAt
        ? `${fmt(t.people ?? 0)} ${(t.people ?? 0) === 1 ? 'person' : 'people'}`
        : 'Update from your Mac when you like',
      optional: true,
    });
  const ig = i.instagram;
  if (ig)
    steps.push({
      key: 'instagram',
      label: 'Instagram',
      state: BROKEN.has(ig.status)
        ? 'problem'
        : ig.status === 'active' && !ig.reading
          ? 'done'
          : ig.status === 'active' || ig.status === 'connecting'
            ? 'working'
            : 'waiting',
      detail: BROKEN.has(ig.status)
        ? 'Sign in to Instagram again'
        : ig.status === 'active'
          ? (ig.reading ?? 'Up to date')
          : 'Not connected yet',
      optional: true,
    });
  const xs = i.x;
  if (xs)
    steps.push({
      key: 'x',
      label: 'X',
      state: BROKEN.has(xs.status) ? 'problem' : xs.status === 'active' ? 'done' : 'waiting',
      detail: BROKEN.has(xs.status)
        ? 'Sign in with X again'
        : xs.status === 'active'
          ? 'Connected'
          : 'Not connected yet',
      optional: true,
    });
  return { state, steps, progress: state === 'ready' ? 1 : progress, headline };
}

/** "62%": what a chip shows. */
export function progressLabel(r: Readiness): string {
  return `${Math.min(99, Math.max(1, Math.round(r.progress * 100)))}%`;
}
