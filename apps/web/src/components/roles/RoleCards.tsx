/**
 * Plan 45 §4.2: the roles as a list of cards, the way job sites show them. Each card: the company's logo and name,
 * when it was posted, the title, a short line of facts, the fit as a ring, and the way in (who the student knows
 * there, or who could introduce them) as the one line in the accent color. Save and a three-dot menu sit on the
 * card; the arrows (or j and k) move through the list, Enter opens, S saves, X says not for me.
 */
import type { DismissReason, JobPay, RoleMatch } from '@orbit/core';
import { Bookmark, BookmarkCheck, ExternalLink } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import {
  BAND_WORDS,
  DISMISS_REASONS,
  introsOf,
  LEVEL_WORDS,
  pathOf,
  type RoleIntro,
  type RolePath,
  type WayIn,
  wayInOf,
  whereWords,
} from '../../engine/roles';
import { Avatar, cx } from '../../ui';
import { RowMenu } from '../../ui/RowMenu';
import { CompanyLogo } from '../CompanyLogo';

/** The fit out of 100 as a ring, in its band's tone; a dashed ring with no number when not read closely. */
export function FitRing({
  match,
  size = 40,
  stretch,
}: {
  match: Pick<RoleMatch, 'fit'>;
  size?: number;
  stretch?: boolean;
}) {
  const f = match.fit;
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  if (!f)
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center text-[11px] text-ink-3"
        style={{ width: size, height: size }}
        title="Not read closely yet. Ranked by the level, the place and the skills it names."
        role="img"
        aria-label="Not read closely yet"
        data-testid="role-fit-rough"
      >
        <svg width={size} height={size} className="absolute inset-0" aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--color-line)"
            strokeWidth={2}
            strokeDasharray="3 3"
          />
        </svg>
        <span aria-hidden>?</span>
      </span>
    );
  const tone =
    f.score >= 65 ? 'var(--color-accent)' : f.score >= 50 ? 'var(--color-warn)' : 'var(--color-ink-3)';
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={`${f.score} out of 100, ${(BAND_WORDS[f.band] ?? '').toLowerCase()}${stretch ? ', a stretch' : ''}. Fit on paper: how well what you wrote matches what the posting asks, not a chance of an offer.`}
      role="img"
      aria-label={`Fit ${f.score} out of 100, ${BAND_WORDS[f.band]}`}
      data-testid="role-fit"
      data-score={f.score}
    >
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-2)" strokeWidth={3} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={`${(c * f.score) / 100} ${c}`}
        />
      </svg>
      <span
        className="relative font-semibold tabular-nums leading-none"
        style={{ fontSize: Math.round(size * (f.score >= 100 ? 0.3 : 0.36)) }}
      >
        {f.score}
      </span>
    </span>
  );
}

/** "$45/hr", "$120k to $150k". */
export function payWords(pay?: JobPay): string {
  if (!pay || (pay.min === undefined && pay.max === undefined)) return '';
  const cur = !pay.currency || pay.currency === 'USD' ? '$' : `${pay.currency} `;
  const n = (v: number) =>
    pay.per === 'hour'
      ? `${cur}${Math.round(v)}`
      : v >= 1000
        ? `${cur}${Math.round(v / 1000)}k`
        : `${cur}${v}`;
  const per = pay.per === 'hour' ? '/hr' : pay.per === 'month' ? '/mo' : '';
  if (pay.min !== undefined && pay.max !== undefined && pay.max !== pay.min)
    return `${n(pay.min)} to ${n(pay.max)}${per}`;
  return `${n((pay.min ?? pay.max)!)}${per}`;
}

/** "2d", "3w", "Today": when it was posted, short enough for the card's corner. */
export function agoWords(iso?: string, now = new Date()): string {
  const at = Date.parse(iso ?? '');
  if (!at) return '';
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days < 7) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

const LEVEL_ONE: Partial<Record<string, string>> = { intern: 'Internship' };

/** The facts under the title: place, how remote, level, pay. */
export function factsOf(m: RoleMatch): string[] {
  const j = m.job;
  const where = whereWords(j);
  return [
    where.place,
    j.remote === 'hybrid' && where.place !== 'Hybrid' ? 'Hybrid' : '',
    j.level ? (LEVEL_ONE[j.level] ?? LEVEL_WORDS[j.level]) : '',
    payWords(j.pay),
  ].filter(Boolean);
}

/** Faces, overlapping a little. */
function Faces({ people }: { people: { id: string; name: string; photoUrl?: string }[] }) {
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {people.slice(0, 3).map((p) => (
        <span key={p.id} className="rounded-full ring-2 ring-canvas">
          <Avatar name={p.name} src={p.photoUrl} id={p.id} size={20} />
        </span>
      ))}
    </span>
  );
}

const first = (name: string) => name.split(' ')[0] ?? name;

/** The way in, in a few words with faces; nothing when there is none yet. */
export function WayInLine({ path, intros }: { path: RolePath; intros?: RoleIntro[] }) {
  const way: WayIn = wayInOf(path, intros);
  if (way === 'none') return null;
  let faces: { id: string; name: string; photoUrl?: string }[];
  let words: string;
  let kind: string;
  if (path.known.length) {
    faces = [...path.known, ...path.alumni];
    const more = path.known.length - 1;
    words = more
      ? `${first(path.known[0]!.name)} and ${more} more you know`
      : `You know ${path.known[0]!.name}`;
    kind = 'known';
  } else if (path.alumni.length) {
    faces = path.alumni;
    words =
      path.alumni.length === 1
        ? `${path.alumni[0]!.name}, an alum, works there`
        : `${path.alumni.length} alumni work there`;
    kind = 'alumni';
  } else {
    const best = intros![0]!;
    faces = intros!.map((i) => i.via);
    words = `Intro via ${first(best.via.name)}`;
    kind = 'intro';
  }
  return (
    <span
      className="flex min-w-0 items-center gap-2 text-[12.5px] font-medium text-accent"
      data-testid="role-path"
      data-kind={kind}
      data-way={way}
    >
      <Faces people={faces} />
      <span className="truncate">{words}</span>
    </span>
  );
}

export function RoleCard({
  match: m,
  path,
  intros,
  active,
  stretch,
  busy,
  onOpen,
  onSave,
  onDismiss,
}: {
  match: RoleMatch;
  path: RolePath;
  intros?: RoleIntro[];
  active?: boolean;
  stretch?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onSave: () => void;
  onDismiss: (r: DismissReason) => void;
}) {
  const j = m.job;
  const saved = m.status !== 'new';
  const capped = m.fit?.caps[0]?.label;
  const way = wayInOf(path, intros);
  return (
    <li
      className={cx(
        'group relative flex cursor-pointer gap-3 border-l-2 px-4 py-3.5 transition-colors',
        active ? 'border-l-ink bg-canvas-2' : 'border-l-transparent hover:bg-canvas-2/60',
      )}
      onClick={onOpen}
      data-testid="role-row"
      data-id={m.id}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
    >
      <span className="mt-0.5 shrink-0">
        <CompanyLogo name={j.companyName} domain={j.companyDomain} size={36} decorative />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <span className="truncate" data-testid="role-company">
            {j.companyName}
          </span>
          {agoWords(j.postedAt ?? j.firstSeenAt) && (
            <span className="shrink-0 text-ink-3" data-testid="role-posted">
              · {agoWords(j.postedAt ?? j.firstSeenAt)}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="mt-0.5 block max-w-full truncate text-left text-[14.5px] font-medium leading-snug text-ink focus-visible:underline focus-visible:outline-none"
          title={j.title}
          data-testid="role-title"
        >
          {j.title}
        </button>
        <span className="mt-1 block truncate text-[12.5px] text-ink-3" data-testid="role-facts">
          {factsOf(m).join(' · ')}
        </span>
        {(!!j.closedAt || m.state === 'gone') && (
          <span className="mt-1 block text-[12px] text-bad" data-testid="role-closed">
            No longer listed
          </span>
        )}
        {m.status === 'applied' || m.status === 'interviewing' ? (
          <span className="mt-1 block text-[12px] font-medium text-ink-2" data-testid="role-status">
            {m.status === 'applied' ? 'Applied' : 'Interviewing'}
          </span>
        ) : null}
        {(capped || stretch) && (
          <span className="mt-1 block truncate text-[12px] text-warn" data-testid="role-why">
            {capped ?? 'A stretch'}
          </span>
        )}
        {way !== 'none' && (
          <span className="mt-2 flex items-center">
            <WayInLine path={path} intros={intros} />
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-start gap-1">
        <span
          className={cx(
            'mt-1 flex items-center transition-opacity',
            active || saved
              ? 'opacity-100'
              : 'opacity-100 @[44rem]:opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSave();
            }}
            disabled={busy}
            aria-pressed={saved}
            aria-label={saved ? `Saved ${j.title}` : `Save ${j.title}`}
            title={saved ? 'Saved' : 'Save'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-ink-3 hover:bg-canvas hover:text-ink"
            data-testid="role-save"
          >
            {saved ? <BookmarkCheck size={16} className="text-accent" /> : <Bookmark size={16} />}
          </button>
          <RowMenu
            label={`More for ${j.title}`}
            items={[
              ...DISMISS_REASONS.map((r) => ({
                label: r.label,
                onSelect: () => onDismiss(r.value),
                testId: `role-card-dismiss-${r.value}`,
              })),
              ...(j.url
                ? [
                    {
                      label: 'Open posting',
                      icon: <ExternalLink size={13} className="text-ink-3" aria-hidden />,
                      onSelect: () => window.open(j.url, '_blank', 'noopener,noreferrer'),
                    },
                  ]
                : []),
            ]}
            testId="role-card-menu"
          />
        </span>
        <FitRing match={m} stretch={stretch} />
      </span>
    </li>
  );
}

/** The cards, with the keyboard: arrows or j and k move, Enter opens, S saves, X says not for me (other reason). */
export function RoleCards({
  rows,
  paths,
  intros,
  active,
  stretch,
  busy,
  onActive,
  onOpen,
  onSave,
  onDismiss,
}: {
  rows: RoleMatch[];
  paths?: Map<string, RolePath>;
  intros?: Map<string, RoleIntro[]>;
  active?: string;
  stretch?: Set<string>;
  busy?: string;
  onActive: (id: string) => void;
  onOpen: (m: RoleMatch) => void;
  onSave: (m: RoleMatch) => void;
  onDismiss: (m: RoleMatch, r: DismissReason) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const at = Math.max(
    0,
    rows.findIndex((r) => r.id === active),
  );
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest('[role="menu"]') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = rows[at];
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (step) {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, (active ? at : -1) + step))];
      if (next) onActive(next.id);
      return;
    }
    if (!cur) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(cur);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      onSave(cur);
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      onDismiss(cur, 'other');
    }
  };
  return (
    <ul
      ref={list}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the list takes the keyboard (arrows, Enter, S, X)
      tabIndex={0}
      aria-label="Roles"
      onKeyDown={onKey}
      className="divide-y divide-line-2 focus-visible:outline-none"
      data-testid="roles-list"
    >
      {rows.map((m) => (
        <RoleCard
          key={m.id}
          match={m}
          path={pathOf(paths, m.job.companyName)}
          intros={introsOf(intros, m.job.companyName)}
          active={m.id === active}
          stretch={stretch?.has(m.id)}
          busy={busy === m.id}
          onOpen={() => onOpen(m)}
          onSave={() => onSave(m)}
          onDismiss={(r) => onDismiss(m, r)}
        />
      ))}
    </ul>
  );
}

export function RoleCardsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-line-2" data-testid="roles-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders with no identity
        <li key={i} className="flex gap-3 px-4 py-4">
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-[8px] bg-canvas-2" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-24 animate-pulse rounded bg-canvas-2" />
            <span className="block h-3.5 w-56 animate-pulse rounded bg-canvas-2" />
            <span className="block h-3 w-40 animate-pulse rounded bg-canvas-2" />
          </span>
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-canvas-2" />
        </li>
      ))}
    </ul>
  );
}
