/**
 * Plan 45 §4.3: one role, open beside the list (or in a drawer on a narrow screen). The header has Apply, where it
 * goes, Save and a menu. The way in comes first, since it is what Orbit is for: the people the student knows there,
 * alumni, and intros through friends, each with one button that writes the message right here (a referral ask, a
 * first message, an intro request), shown under the person. Then the fit as a ring with its four parts, the
 * requirements as a checklist, and what would raise it.
 */
import type { DismissReason, MatchStatus, RoleMatch, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bookmark, BookmarkCheck, Check, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import {
  applyWhere,
  BAND_WORDS,
  DISMISS_REASONS,
  partWords,
  postedWords,
  type RoleIntro,
  type RolePath,
} from '../../engine/roles';
import {
  askIntroForRole,
  askReferral,
  introsAt,
  type WayInResult,
  writeFirst,
} from '../../engine/rolesWayIn';
import { Avatar, Button, cx, Select, Spinner, useToast } from '../../ui';
import { RowMenu } from '../../ui/RowMenu';
import { Bars } from '../../ui/table';
import { CompanyLogo } from '../CompanyLogo';
import { MessagePane } from '../DraftMessage';
import { STATUS_WORDS } from './parts';
import { FitRing, factsOf } from './RoleCards';
import { companyHref } from './RolesTable';

const CLOSE_WORDS = ['', 'Light tie', 'Warm tie', 'Strong tie', 'Close tie'];

export function RolePanel({
  match,
  user,
  path,
  paths,
  intros: given,
  sources,
  heading,
  onSave,
  onStatus,
  onDismiss,
  onWayIn,
  wayInBusy,
}: {
  match: RoleMatch;
  user: User;
  path: RolePath;
  paths?: Map<string, RolePath>;
  /** the intros at this company when the page has read them; read here otherwise */
  intros?: RoleIntro[];
  /** what the profile was read from: the gaps say "resume" or "profile" */
  sources?: ('resume' | 'linkedin')[];
  /** show the title here (the pane); a drawer has it in its own header */
  heading?: boolean;
  onSave: () => void;
  onStatus: (s: MatchStatus) => void;
  onDismiss: (reason: DismissReason) => void;
  onWayIn: () => void;
  wayInBusy?: boolean;
}) {
  const j = match.job;
  const f = match.fit;
  const [intros, setIntros] = useState<RoleIntro[] | undefined>(given);
  useEffect(() => {
    if (given) {
      setIntros(given);
      return;
    }
    let live = true;
    setIntros(undefined);
    void introsAt(user.id, j.companyName).then((r) => live && setIntros(r));
    return () => {
      live = false;
    };
  }, [user.id, j.companyName, given]);
  const saved = match.status !== 'new' && match.status !== 'dismissed';
  const closed = !!j.closedAt || match.state === 'gone';
  const apply = applyWhere(j);
  const [askApplied, setAskApplied] = useState(false);
  useEffect(() => setAskApplied(false), [match.id]);
  const known = path.known[0];
  const posted = postedWords(j);
  return (
    <div className="text-[13.5px]" data-testid="role-panel">
      <header>
        <div className="flex items-center gap-3">
          <CompanyLogo name={j.companyName} domain={j.companyDomain} size={40} decorative />
          <div className="min-w-0">
            <Link
              to={companyHref(j.companyName, paths)}
              className="block truncate text-[14px] font-medium hover:underline"
              data-testid="role-panel-company"
            >
              {j.companyName}
            </Link>
            {posted && <p className="text-[12.5px] text-ink-3">Posted {posted.toLowerCase()}</p>}
          </div>
        </div>
        {heading && (
          <h2
            className="mt-3 text-[21px] font-medium leading-tight tracking-[-0.015em]"
            data-testid="role-panel-title"
          >
            {j.title}
          </h2>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {[...factsOf(match), j.team, j.term].filter(Boolean).map((x) => (
            <span
              key={x}
              className="inline-flex h-6 items-center rounded-full bg-canvas-2 px-2.5 text-[12px] text-ink-2"
            >
              {x}
            </span>
          ))}
        </div>
        {closed && (
          <p className="mt-3 text-[13px] text-bad" data-testid="role-panel-closed">
            No longer listed. The company took the posting down.
          </p>
        )}
        {!closed && known && (
          <p className="mt-4 text-[13px] font-medium text-accent" data-testid="role-panel-tip">
            Ask {known.name.split(' ')[0]} for a referral before you apply.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!closed && apply.href && (
            <a
              href={apply.href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => setAskApplied(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-ink px-4 text-[14px] font-medium text-white hover:bg-[#262626]"
              data-testid="role-panel-open-posting"
            >
              Apply <ExternalLink size={13} aria-hidden />
            </a>
          )}
          <Button onClick={onSave} aria-pressed={saved} data-testid="role-panel-save">
            {saved ? <BookmarkCheck size={15} className="text-accent" /> : <Bookmark size={15} />}
            {saved ? STATUS_WORDS[match.status] : 'Save'}
          </Button>
          {saved && (
            <Select
              value={match.status}
              onChange={(e) => onStatus(e.target.value as MatchStatus)}
              aria-label="Where it stands"
              className="h-9 text-[13px]"
              data-testid="role-panel-status"
            >
              {(['saved', 'applied', 'interviewing'] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_WORDS[s]}
                </option>
              ))}
            </Select>
          )}
          <RowMenu
            label="More for this role"
            align="left"
            items={DISMISS_REASONS.map((r) => ({
              label: r.label,
              onSelect: () => onDismiss(r.value),
              testId: `role-dismiss-${r.value}`,
            }))}
            testId="role-panel-dismiss"
          />
        </div>
        {!closed && apply.href && (
          <p className="mt-2 text-[12px] text-ink-3" data-testid="role-apply-where">
            Applies on {apply.words}
          </p>
        )}
        {askApplied && match.status !== 'applied' && match.status !== 'interviewing' && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] bg-canvas-2 px-3 py-2"
            data-testid="role-applied-ask"
          >
            <span className="mr-auto text-[13px]">Did you apply?</span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setAskApplied(false);
                onStatus('applied');
              }}
              data-testid="role-applied-yes"
            >
              Yes, I applied
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAskApplied(false)}>
              Not yet
            </Button>
          </div>
        )}
      </header>

      <Section title="Your way in" testId="role-panel-way-in">
        <WayIn
          match={match}
          user={user}
          path={path}
          intros={intros}
          onWayIn={onWayIn}
          wayInBusy={wayInBusy}
        />
      </Section>

      <Section title="How you fit" testId="role-panel-fit">
        {f ? (
          <FitBlock match={match} sources={sources} />
        ) : (
          <p className="text-[13px] text-ink-2" data-testid="role-panel-rough">
            Not read closely yet.{' '}
            {match.roughFit
              ? `${Math.round(match.roughFit.skills * 100)}% of the skills it names are on your profile${
                  match.roughFit.level ? ', at your level' : ''
                }.`
              : ''}
          </p>
        )}
      </Section>

      <Requirements match={match} />

      {(match.gaps ?? match.answers?.gaps ?? []).length > 0 && (
        <Section title="What would raise it" testId="role-panel-gaps">
          <ul className="space-y-1.5">
            {(match.gaps ?? match.answers?.gaps ?? []).map((g) => (
              <li key={g} className="flex gap-2 text-[13px] leading-relaxed text-ink-2">
                <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
                {g}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="mt-6 border-t border-line-2 pt-5" aria-label={title} data-testid={testId}>
      <h3 className="mb-3 text-[14px] font-medium">{title}</h3>
      {children}
    </section>
  );
}

/** The ring, the band and the four parts as short bars; each part's words on hover. */
function FitBlock({ match, sources }: { match: RoleMatch; sources?: ('resume' | 'linkedin')[] }) {
  const f = match.fit!;
  const parts = partWords(match, sources);
  return (
    <div>
      <div className="flex items-center gap-3">
        <FitRing match={match} size={52} />
        <div className="min-w-0">
          <p className="text-[14px] font-medium">{BAND_WORDS[f.band]}</p>
          {(match.reason ?? match.answers?.reason) && (
            <p className="text-[13px] text-ink-2" data-testid="role-panel-reason">
              {match.reason ?? match.answers?.reason}
            </p>
          )}
        </div>
      </div>
      {f.caps.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="role-panel-caps">
          {f.caps.map((c) => (
            <span
              key={c.kind}
              className="inline-flex h-6 items-center rounded-full bg-warn-soft px-2.5 text-[12px] text-warn"
              title={c.quote ? `"${c.quote}"` : undefined}
            >
              {c.label}
            </span>
          ))}
        </div>
      )}
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
        {parts.map((p) => (
          <li key={p.part} title={p.words} data-testid="role-panel-part" data-part={p.part}>
            <div className="flex items-baseline justify-between text-[12.5px]">
              <span className="font-medium">{p.name}</span>
              <span className="tabular-nums text-ink-3">
                {p.value === undefined ? 'Not asked' : `${Math.round(p.value * 100)}%`}
              </span>
            </div>
            <span className="mt-1.5 block h-[5px] overflow-hidden rounded-full bg-line-2" aria-hidden>
              {p.value !== undefined && (
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${Math.round(p.value * 100)}%` }}
                />
              )}
            </span>
            <span className="sr-only">{p.words}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SKILL_MARK = {
  work: { tone: 'have', words: 'From your work' },
  project: { tone: 'have', words: 'From a project' },
  listed: { tone: 'listed', words: 'Listed only' },
  none: { tone: 'missing', words: 'Not on your profile' },
} as const;

/** The skills the posting names, each met, listed only, or missing; a nice-to-have says so. */
function Requirements({ match }: { match: RoleMatch }) {
  const skills = match.answers?.skills ?? [];
  if (!skills.length) return null;
  const order = { work: 0, project: 0, listed: 1, none: 2 } as const;
  const sorted = [...skills].sort(
    (a, b) =>
      (order[a.answer as keyof typeof order] ?? 2) - (order[b.answer as keyof typeof order] ?? 2) ||
      (a.need === 'must' ? 0 : 1) - (b.need === 'must' ? 0 : 1),
  );
  return (
    <Section title="Requirements" testId="role-panel-reqs">
      <ul className="space-y-2">
        {sorted.map((s) => {
          const mark = SKILL_MARK[s.answer as keyof typeof SKILL_MARK] ?? SKILL_MARK.none;
          return (
            <li
              key={s.name}
              className="flex items-start gap-2.5"
              title={[s.posting && `Posting: "${s.posting}"`, s.you && `You: "${s.you}"`]
                .filter(Boolean)
                .join('\n')}
              data-testid="role-panel-req"
              data-have={mark.tone}
            >
              <span
                className={cx(
                  'mt-[1px] inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
                  mark.tone === 'have' && 'bg-accent text-white',
                  mark.tone === 'listed' && 'border-[1.5px] border-dashed border-warn',
                  mark.tone === 'missing' && 'border-[1.5px] border-line',
                )}
                aria-hidden
              >
                {mark.tone === 'have' && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('text-[13.5px]', mark.tone === 'missing' && 'text-ink-2')}>{s.name}</span>
                {s.need === 'nice' && <span className="ml-1.5 text-[12px] text-ink-3">Nice to have</span>}
              </span>
              <span className="shrink-0 text-[12px] text-ink-3">{mark.words}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

type Person = { id: string; name: string; photoUrl?: string; title?: string };

/**
 * The people in, best first: the ones the student knows (a referral ask), alumni (a first message), then intros
 * through a friend (an intro request). One button each, the message written and shown under them.
 */
function WayIn({
  match,
  user,
  path,
  intros,
  onWayIn,
  wayInBusy,
}: {
  match: RoleMatch;
  user: User;
  path: RolePath;
  intros?: RoleIntro[];
  onWayIn: () => void;
  wayInBusy?: boolean;
}) {
  const company = match.job.companyName;
  const rows: {
    key: string;
    person: Person;
    line: ReactNode;
    action: string;
    testId: string;
    buttonId: string;
    level?: number;
    run: () => Promise<WayInResult>;
  }[] = [
    ...path.known.slice(0, 3).map((p) => ({
      key: `k:${p.id}`,
      person: p,
      line: [p.title, CLOSE_WORDS[p.level]].filter(Boolean).join(' · '),
      action: 'Ask for a referral',
      testId: 'role-panel-known',
      buttonId: 'role-ask-referral',
      level: p.level,
      run: () => askReferral(user, match, p.id),
    })),
    ...path.alumni.slice(0, 2).map((p) => ({
      key: `a:${p.id}`,
      person: p,
      line: ['Alum', p.title].filter(Boolean).join(' · '),
      action: `Write to ${p.name.split(' ')[0]}`,
      testId: 'role-panel-alum',
      buttonId: 'role-write',
      run: () => writeFirst(user, match, p.id),
    })),
    ...(intros ?? []).slice(0, 3).map((i) => ({
      key: `i:${i.via.id}:${i.to.id}`,
      person: { id: i.to.id, name: i.to.name, photoUrl: i.to.photoUrl, title: i.to.title },
      line: (
        <>
          {i.to.title ? `${i.to.title} · ` : ''}via{' '}
          <Link to={`/people/${i.via.id}`} className="hover:underline">
            {i.via.name}
          </Link>
        </>
      ),
      action: `Ask ${i.via.name.split(' ')[0]} for an intro`,
      testId: 'role-panel-intro',
      buttonId: 'role-ask-intro',
      run: () => askIntroForRole(user, match, i),
    })),
  ].slice(0, 5);
  return (
    <div>
      {rows.length === 0 && intros === undefined && (
        <p className="flex items-center gap-2 text-[13px] text-ink-3" data-testid="role-panel-way-reading">
          <Spinner /> Looking for a way in
        </p>
      )}
      {rows.length === 0 && intros !== undefined && (
        <p className="text-[13px] text-ink-2" data-testid="role-panel-way-none">
          No one you know is at {company} yet.
        </p>
      )}
      <ul className="space-y-1">
        {rows.map(({ key, ...r }) => (
          <WayRow key={key} {...r} />
        ))}
      </ul>
      <Button
        variant={rows.length ? 'ghost' : 'secondary'}
        size="sm"
        className={rows.length ? 'mt-2 -ml-2' : 'mt-3'}
        onClick={onWayIn}
        loading={wayInBusy}
        data-testid="role-way-in"
      >
        {rows.length ? `More people at ${company}` : `Find people at ${company}`}
      </Button>
    </div>
  );
}

function WayRow({
  person: p,
  line,
  action,
  testId,
  buttonId,
  level,
  run,
}: {
  person: Person;
  line: ReactNode;
  action: string;
  testId: string;
  buttonId: string;
  level?: number;
  run: () => Promise<WayInResult>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [doneId, setDoneId] = useState<string>();
  const [note, setNote] = useState<string>();
  // the message as it is now: sent, discarded or edited from the box under the row
  const done = useLiveQuery(() => (doneId ? db.outbound.get(doneId) : undefined), [doneId]);
  const draftPerson = useLiveQuery(() => (done ? db.people.get(done.personId) : undefined), [done?.personId]);
  const go = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const r = await run();
      if (r.kind === 'draft') setDoneId(r.draft.id);
      else setNote(r.text);
    } catch {
      toast.push({ text: 'That did not work. Try again.', tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-testid={testId}>
      <div className="flex items-center gap-3 rounded-[10px] py-1.5">
        <Avatar name={p.name} src={p.photoUrl} id={p.id} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link to={`/people/${p.id}`} className="truncate font-medium hover:underline">
              {p.name}
            </Link>
            {level !== undefined && <Bars level={level} label="How close you are" />}
          </div>
          <p className="truncate text-[12.5px] text-ink-3">{line}</p>
        </div>
        {!doneId && (
          <Button size="sm" onClick={() => void go()} loading={busy} data-testid={buttonId}>
            {action}
          </Button>
        )}
      </div>
      {note && <p className="mb-2 ml-[46px] text-[12.5px] text-ink-2">{note}</p>}
      {done && done.status !== 'cancelled' && (
        <div className="mb-3 mt-1" data-testid="role-way-draft">
          <MessagePane o={done} person={draftPerson} />
        </div>
      )}
    </li>
  );
}
