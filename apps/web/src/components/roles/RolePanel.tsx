/**
 * Plan 44 §2.4: one role, opened beside the table. The score and its four parts, each a bar with its own words; the
 * lines it rests on, from the posting and from the student; what would raise it (never invented); the way in (people
 * the student knows there, alumni, who could introduce them); and the actions: Find a way in, Draft a note, Open
 * posting, Save, Not for me with a reason.
 */
import type { DismissReason, MatchStatus, RoleMatch } from '@orbit/core';
import { Bookmark, BookmarkCheck, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { type CompanyPerson, reachCompany } from '../../engine/graph';
import { BAND_WORDS, partWords, postedWords, quotesOf, type RolePath, whereWords } from '../../engine/roles';
import { Avatar, Button, cx, Select } from '../../ui';
import { Bars } from '../../ui/table';
import { CompanyLogo } from '../CompanyLogo';
import { DismissMenu, FitBar, PartBar, STATUS_WORDS } from './parts';
import { companyHref } from './RolesTable';

export function RolePanel({
  match,
  userId,
  path,
  paths,
  sources,
  onSave,
  onStatus,
  onDismiss,
  onWayIn,
  wayInBusy,
  onDraft,
}: {
  match: RoleMatch;
  userId: string;
  path: RolePath;
  paths?: Map<string, RolePath>;
  /** what the profile was read from: the gaps say "resume" or "profile" */
  sources?: ('resume' | 'linkedin')[];
  onSave: () => void;
  onStatus: (s: MatchStatus) => void;
  onDismiss: (reason: DismissReason) => void;
  onWayIn: () => void;
  wayInBusy?: boolean;
  onDraft: (personId: string) => void;
}) {
  const j = match.job;
  const f = match.fit;
  const parts = partWords(match, sources);
  const quotes = quotesOf(match);
  const where = whereWords(j);
  const [menu, setMenu] = useState(false);
  // who could introduce them: the routes the company page shows, read once the panel opens
  const [intro, setIntro] = useState<CompanyPerson[]>();
  useEffect(() => {
    let live = true;
    setIntro(undefined);
    reachCompany(userId, j.companyName)
      .then(
        (r) => live && setIntro(r.people.filter((c) => c.route.kind === 'warm' && c.route.via).slice(0, 3)),
      )
      .catch(() => live && setIntro([]));
    return () => {
      live = false;
    };
  }, [userId, j.companyName]);
  const saved = match.status === 'saved' || match.status === 'applied' || match.status === 'interviewing';
  const first = path.known[0];
  const closed = !!j.closedAt || match.state === 'gone';
  return (
    <div className="space-y-6 text-[13.5px]" data-testid="role-panel">
      <div>
        <Link
          to={companyHref(j.companyName, paths)}
          className="inline-flex items-center gap-2 text-[13px] text-ink-2 hover:underline"
          data-testid="role-panel-company"
        >
          <CompanyLogo name={j.companyName} domain={j.companyDomain} size={18} decorative />
          {j.companyName}
        </Link>
        {/* the role's title is the panel's own heading */}
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          {[j.team, where.all, where.term, postedWords(j) ? `Posted ${postedWords(j).toLowerCase()}` : '']
            .filter(Boolean)
            .join(' · ')}
        </p>
        {closed && (
          <p className="mt-2 text-[12.5px] text-bad" data-testid="role-panel-closed">
            No longer listed. The company took the posting down.
          </p>
        )}
      </div>

      <section aria-label="Fit" data-testid="role-panel-fit">
        {f ? (
          <>
            <div className="flex items-baseline gap-3">
              <span className="text-[28px] font-normal tracking-[-0.02em] tabular-nums leading-none">
                {f.score}
                <span className="text-[16px] text-ink-3">/10</span>
              </span>
              <span className="text-[13.5px] text-ink-2">{BAND_WORDS[f.band]}</span>
              <FitBar score={f.score} className="ml-auto w-24" />
            </div>
            {f.caps.length > 0 && (
              <ul className="mt-2 space-y-0.5" data-testid="role-panel-caps">
                {f.caps.map((c) => (
                  <li key={c.kind} className="text-[12.5px] text-bad">
                    {c.label}
                    {c.quote ? <span className="text-ink-3">: "{c.quote}"</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <ul className="mt-4 space-y-3">
              {parts.map((p) => (
                <li key={p.part} data-testid="role-panel-part" data-part={p.part}>
                  <div className="flex items-center gap-3">
                    <span className="w-[84px] shrink-0 font-medium">{p.name}</span>
                    <PartBar value={p.value} />
                    <span className="w-8 shrink-0 text-right text-[12px] tabular-nums text-ink-3">
                      {p.value === undefined ? '' : `${Math.round(p.value * 100)}%`}
                    </span>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                    {p.value === undefined
                      ? `Left out: ${p.words.charAt(0).toLowerCase()}${p.words.slice(1)}`
                      : p.words}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
              Fit on paper: how well what you wrote matches what the posting asks for. It is not a chance of
              an offer.
            </p>
          </>
        ) : (
          <div data-testid="role-panel-rough">
            <p className="font-medium">Not read closely yet</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              Orbit could not read this role against your profile just now, so it has no score. From what can
              be read without that:{' '}
              {match.roughFit
                ? `${Math.round(match.roughFit.skills * 100)}% of the skills it names are on your profile, ${
                    match.roughFit.level ? 'it is at your level' : 'it may not be at your level'
                  }, and ${match.roughFit.place ? 'it is in a place you picked' : 'it is outside the places you picked'}.`
                : 'nothing yet.'}
            </p>
          </div>
        )}
      </section>

      {(quotes.posting.length > 0 || quotes.you.length > 0) && (
        <section className="grid gap-4 @[30rem]:grid-cols-2" aria-label="What the score rests on">
          <Quotes title="From the posting" lines={quotes.posting} testId="role-panel-from-posting" />
          <Quotes title="From you" lines={quotes.you} testId="role-panel-from-you" />
        </section>
      )}

      {(match.gaps ?? match.answers?.gaps ?? []).length > 0 && (
        <section aria-label="What would raise it" data-testid="role-panel-gaps">
          <h4 className="mb-1.5 font-medium">What would raise it</h4>
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">
            {(match.gaps ?? match.answers?.gaps ?? []).map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Your way in" data-testid="role-panel-way-in">
        <h4 className="mb-2 font-medium">Your way in</h4>
        {path.known.length === 0 && path.alumni.length === 0 && intro !== undefined && intro.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">
            No one you know is at {j.companyName} yet. Find a way in searches for people there.
          </p>
        ) : null}
        <ul className="space-y-2">
          {path.known.slice(0, 4).map((p) => (
            <li key={p.id} className="flex items-center gap-2.5" data-testid="role-panel-known">
              <Avatar name={p.name} src={p.photoUrl} id={p.id} size={26} />
              <span className="min-w-0 flex-1">
                <Link to={`/people/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                {p.title && <span className="block truncate text-[12px] text-ink-3">{p.title}</span>}
              </span>
              <Bars level={p.level} label="How close you are" />
            </li>
          ))}
          {path.alumni.slice(0, 3).map((p) => (
            <li key={p.id} className="flex items-center gap-2.5" data-testid="role-panel-alum">
              <Avatar name={p.name} src={p.photoUrl} id={p.id} size={26} />
              <span className="min-w-0 flex-1">
                <Link to={`/people/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
                <span className="block truncate text-[12px] text-ink-3">
                  Alum{p.title ? `, ${p.title}` : ''}
                </span>
              </span>
            </li>
          ))}
          {(intro ?? []).map((c) => (
            <li key={c.person.id} className="flex items-center gap-2.5" data-testid="role-panel-intro">
              <Avatar name={c.person.displayName} src={c.person.photoUrl} id={c.person.id} size={26} />
              <span className="min-w-0 flex-1">
                <Link to={`/people/${c.person.id}`} className="font-medium hover:underline">
                  {c.person.displayName}
                </Link>
                <span className="block truncate text-[12px] text-ink-3">
                  {c.route.via ? (
                    <>
                      <Link to={`/people/${c.route.via.id}`} className="hover:underline">
                        {c.route.via.name}
                      </Link>{' '}
                      could introduce you
                    </>
                  ) : (
                    c.route.line
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap items-center gap-2 border-t border-line pt-4" aria-label="Actions">
        <Button variant="primary" onClick={onWayIn} loading={wayInBusy} data-testid="role-way-in">
          Find a way in
        </Button>
        {first && (
          <Button onClick={() => onDraft(first.id)} data-testid="role-draft-note">
            Draft a note to {first.name.split(' ')[0]}
          </Button>
        )}
        {j.url && (
          <a
            href={j.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center gap-1.5 rounded-[6px] border border-line bg-canvas px-4 text-[14px] font-medium hover:bg-canvas-2"
            data-testid="role-panel-open-posting"
          >
            Open posting <ExternalLink size={13} aria-hidden />
          </a>
        )}
        <Button variant="ghost" onClick={onSave} aria-pressed={saved} data-testid="role-panel-save">
          {saved ? <BookmarkCheck size={15} className="text-accent" /> : <Bookmark size={15} />}
          {saved ? 'Saved' : 'Save'}
        </Button>
        <span className="relative">
          <Button
            variant="ghost"
            onClick={() => setMenu((m) => !m)}
            aria-haspopup="menu"
            aria-expanded={menu}
            data-testid="role-panel-dismiss"
          >
            Not for me
          </Button>
          {menu && (
            <DismissMenu
              className="absolute bottom-full left-0 mb-1"
              onClose={() => setMenu(false)}
              onPick={(r) => {
                setMenu(false);
                onDismiss(r);
              }}
            />
          )}
        </span>
        {saved && (
          <Select
            value={match.status}
            onChange={(e) => onStatus(e.target.value as MatchStatus)}
            aria-label="Where it stands"
            className={cx('h-9 text-[13px]')}
            data-testid="role-panel-status"
          >
            {(['saved', 'applied', 'interviewing'] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_WORDS[s]}
              </option>
            ))}
          </Select>
        )}
      </section>
    </div>
  );
}

function Quotes({ title, lines, testId }: { title: string; lines: string[]; testId: string }) {
  if (!lines.length) return null;
  return (
    <div data-testid={testId}>
      <h4 className="mb-1.5 font-medium">{title}</h4>
      <ul className="space-y-1.5">
        {lines.map((l) => (
          <li key={l} className="border-l-2 border-line pl-2.5 text-[12.5px] leading-relaxed text-ink-2">
            "{l}"
          </li>
        ))}
      </ul>
    </div>
  );
}
