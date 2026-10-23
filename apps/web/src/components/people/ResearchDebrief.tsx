import type { Dossier, Person } from '@orbit/core';
import { companyLogoUrl } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, ExternalLink, Globe, RefreshCw, Search, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db } from '../../db/schema';
import {
  type Allowance,
  allowanceLine,
  briefStale,
  deleteBrief,
  RESEARCH_FOOTER,
  readAllowance,
  researchBlocker,
  startResearch,
} from '../../engine/deepResearch';
import { type Claim, type DossierView, dossierView, getDossier, researchPerson } from '../../engine/research';
import { isServerUser } from '../../integrations/orbitApi';
import { useSession } from '../../state/session';
import { Button, Chip, cx, relDate, Spinner, useToast } from '../../ui';
import { CompanyLogo } from '../CompanyLogo';
import { DossierCard } from './DossierCard';

type Source = DossierView['sources'][number];

const KIND_LABEL: Record<string, string> = {
  post: 'Post',
  article: 'Article',
  talk: 'Talk',
  podcast: 'Podcast',
  project: 'Project',
  paper: 'Paper',
  news: 'News',
  award: 'Award',
  other: 'Mention',
};

const PROFILE_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  x: 'X',
  github: 'GitHub',
  website: 'Website',
  scholar: 'Scholar',
  other: 'Profile',
};

function host(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** A site's own icon, small, for a source or a profile link; a globe when it has none. */
function SiteIcon({ url, size = 14 }: { url?: string; size?: number }) {
  const h = host(url);
  const [failed, setFailed] = useState(false);
  if (!h || failed) return <Globe size={size} className="text-ink-3 shrink-0" aria-hidden />;
  return (
    <img
      src={companyLogoUrl(h)}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-[3px]"
      onError={() => setFailed(true)}
    />
  );
}

/** "[2]" after a claim: the page it came from, opened in a new tab (a sample source in the demo goes nowhere). */
function Refs({ ns, sources }: { ns: number[]; sources: Source[] }) {
  return (
    <>
      {ns.map((n) => {
        const s = sources.find((x) => x.n === n);
        return s?.url && !s.demo ? (
          <a
            key={n}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-0.5 align-super text-[10px] text-ink-3 hover:text-ink"
            title={s.title ?? s.url}
            data-testid="debrief-ref"
          >
            [{n}]
          </a>
        ) : (
          <span key={n} className="ml-0.5 align-super text-[10px] text-ink-3" title={s?.title}>
            [{n}]
          </span>
        );
      })}
    </>
  );
}

function Block({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="py-4 border-t border-line-2 first:border-t-0 first:pt-0" data-testid={testId}>
      <h3 className="text-[11.5px] uppercase tracking-wide text-ink-3 mb-2">{title}</h3>
      {children}
    </section>
  );
}

const span = (start?: string, end?: string) =>
  start || end ? `${start ?? '?'} – ${end ?? 'now'}` : undefined;

/**
 * Everything Orbit found about someone, laid out to skim: who they are, their pages, their career with each
 * company's logo, school, the things they made or said (posts, talks, papers, news) with links, what you have in
 * common, good openers, their company's news (Go deeper), what to be careful about, and every source.
 *
 * Research starts only here: the Deep research button (and Go deeper on the finished brief). With LinkedIn connected
 * through Orbit the brief comes from orbit-research; the sample student gets sample briefs; account mode keeps the
 * server's own queue (DossierCard).
 */
export function ResearchDebrief({ person, userId }: { person: Person; userId: string }) {
  const stored = useLiveQuery(
    async () =>
      (await db.dossiers.where('personId').equals(person.id).toArray()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )[0] ?? null,
    [person.id],
  );
  const server = isServerUser(userId);
  if (!server) return <DeepResearch person={person} stored={stored ?? null} />;
  return <ServerDebrief person={person} userId={userId} stored={stored ?? null} />;
}

/** Account mode: the server researches through its queue; the card asks for it and waits. */
function ServerDebrief({
  person,
  userId,
  stored,
}: {
  person: Person;
  userId: string;
  stored: Dossier | null;
}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ready = stored && (stored.status === 'ready' || stored.status === 'partial');
  // anything but a finished brief (none yet, being researched, which one did you mean) is the research card's job
  if (!ready) return <DossierCard person={person} userId={userId} />;
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await researchPerson({ id: userId }, person.id, { refresh: true });
      if (r.ok && (r.status === 'queued' || r.status === 'pending'))
        for (let i = 0; i < 36 && alive.current; i++) {
          await new Promise((res) => setTimeout(res, 5000));
          const g = await getDossier({ id: userId }, person.id);
          if (!g.ok || (g.dossier && g.dossier.status !== 'pending')) break;
        }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return <Debrief d={stored as Dossier} person={person} onRefresh={refresh} busy={busy} />;
}

/**
 * Deep research on the live site and in the demo: the Deep research button when there is no brief, the brief with Go
 * deeper when there is. The month's count shows next to the buttons; dollars stay in Settings.
 */
function DeepResearch({ person, stored }: { person: Person; stored: Dossier | null }) {
  const { user } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<'quick' | 'deeper' | undefined>();
  const [error, setError] = useState<string>();
  const [blocker, setBlocker] = useState<string | null>();
  const [left, setLeft] = useState<Allowance>();
  const [stale, setStale] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // what the card may offer: never a research call, only whether one is possible and how many are left
  useEffect(() => {
    if (!user) return;
    void researchBlocker(user, person).then((b) => alive.current && setBlocker(b ?? null));
    void readAllowance(user)
      .then((a) => alive.current && setLeft(a))
      .catch(() => undefined);
  }, [user?.id, person.id, person.doNotContact, stored?.updatedAt]);
  useEffect(() => {
    if (stored) void briefStale(person, stored).then((s) => alive.current && setStale(s));
  }, [stored?.updatedAt, person.headline, person.currentOrganizationRaw]);
  if (!user || blocker === undefined) return null;
  const first = person.firstName || 'them';
  const run = async (kind: 'quick' | 'deeper', candidateIndex?: number) => {
    setBusy(kind);
    setError(undefined);
    try {
      const r = await startResearch(user, person.id, { kind, candidateIndex });
      if (!alive.current) return;
      if (!r.ok) setError(r.message);
      setLeft(await readAllowance(user));
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };
  const ready = stored && (stored.status === 'ready' || stored.status === 'partial');
  if (ready)
    return (
      <Debrief
        d={stored}
        person={person}
        busy={busy === 'quick'}
        onRefresh={stale ? () => void run('quick') : undefined}
        stale={stale}
        deeper={
          !blocker && !(stored.content as { deeper?: unknown } | undefined)?.deeper
            ? { run: () => void run('deeper'), busy: busy === 'deeper' }
            : undefined
        }
        allowance={left}
        error={error}
        onDelete={async () => {
          await deleteBrief(stored.id);
          toast.push({ text: `Deleted the brief on ${first}, and the facts it added.` });
        }}
      />
    );
  const choosing = stored?.status === 'needs_disambiguation';
  const v = choosing ? dossierView(stored) : undefined;
  return (
    <div
      className="rounded-[var(--radius-card)] border border-line bg-canvas p-5"
      data-testid="research-card"
    >
      <div className="flex items-center gap-2">
        <Search size={15} className="text-ink-3" aria-hidden />
        <h2 className="text-[15px] font-medium">Deep research</h2>
      </div>
      {busy ? (
        <p
          className="mt-2 flex items-center gap-2 text-[13px] text-ink-3"
          role="status"
          data-testid="research-pending"
        >
          <Spinner /> Researching {first}. This takes about a minute.
        </p>
      ) : choosing && v ? (
        <div className="mt-2" data-testid="research-choices">
          <p className="text-[13px] text-ink-2">
            More than one person matches {person.displayName}. Which one is yours?
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {v.candidates.map((c) => (
              <Button
                key={c.index}
                size="sm"
                variant="secondary"
                className="justify-start whitespace-normal text-left h-auto py-1.5"
                onClick={() => void run('quick', c.index)}
                data-testid="research-choice"
              >
                {c.label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-[13px] text-ink-3 leading-relaxed">
            Orbit looks {first} up on LinkedIn and the public web: what they work on now, what they said or
            made lately, what you have in common, and a few openers, every line with its source.
          </p>
          {blocker ? (
            <p className="mt-3 text-[13px] text-ink-2" data-testid="research-blocked">
              {blocker}{' '}
              {/connect your linkedin/i.test(blocker) && (
                <Link to="/settings/integrations" className="text-accent hover:underline">
                  Open Settings
                </Link>
              )}
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void run('quick')}
                disabled={!!busy || left?.left === 0}
                data-testid="research-start"
              >
                Deep research
              </Button>
              {left && (
                <span className="text-[12px] text-ink-3" data-testid="research-allowance">
                  {allowanceLine(left)}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="mt-2 text-[12.5px] text-bad" role="alert" data-testid="research-error">
          {error}
        </p>
      )}
      <p className="mt-3 text-[11.5px] text-ink-3">{RESEARCH_FOOTER}</p>
    </div>
  );
}

function Debrief({
  d,
  person,
  onRefresh,
  busy,
  stale,
  deeper,
  allowance,
  error,
  onDelete,
}: {
  d: Dossier;
  person: Person;
  onRefresh?: () => void;
  busy: boolean;
  /** their LinkedIn changed since the brief (a new job or headline): the one time Refresh is offered */
  stale?: boolean;
  /** Go deeper, when it has not run yet */
  deeper?: { run: () => void; busy: boolean };
  allowance?: Allowance;
  error?: string;
  onDelete?: () => void;
}) {
  const toast = useToast();
  const v = dossierView(d);
  const first = person.firstName || 'them';
  const sources = v.sources;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.push({ text: 'Copied.', tone: 'good' });
    } catch {
      toast.push({ text: 'Select the line and copy it.' });
    }
  };
  // what they did recently that is not already a highlight
  const titles = new Set(v.highlights.map((h) => h.title.toLowerCase()));
  const recently = v.recently.filter((r) => !titles.has(r.text.toLowerCase()));
  const side = v.inCommon.length > 0 || v.openers.length > 0 || v.carefulClaims.length > 0;
  return (
    <div
      className="rounded-[var(--radius-card)] border border-line bg-canvas p-5"
      data-testid="research-debrief"
    >
      {/* who they are, in a line, with the pages that are theirs */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-medium tracking-[-0.01em]">Who {first} is</h2>
          {v.who && <p className="text-[14px] text-ink-2 mt-1 leading-relaxed">{v.who}</p>}
          {v.now && (
            <p className="text-[13px] text-ink-3 mt-1.5 flex items-center gap-1.5">
              <CompanyLogo
                name={person.currentOrganizationRaw}
                orgId={person.currentOrganizationId}
                size={14}
                decorative
              />
              <span>
                Now {v.now.text}
                <Refs ns={v.now.sources} sources={sources} />
              </span>
            </p>
          )}
        </div>
        {onRefresh && (
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={busy} data-testid="debrief-refresh">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Refresh
          </Button>
        )}
      </div>
      {stale && (
        <p className="mt-2 text-[12.5px] text-warn" data-testid="research-stale">
          {first}'s LinkedIn shows a new job or headline since this brief. Refresh to research them again.
        </p>
      )}
      {(v.topics.length > 0 || v.profiles.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="debrief-topics">
          {v.profiles.map((p) => (
            <a
              key={p.url}
              href={p.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line text-[12.5px] hover:bg-canvas-2"
              data-testid="debrief-profile"
            >
              <SiteIcon url={p.url} size={13} />
              {PROFILE_LABEL[p.kind] ?? host(p.url)}
            </a>
          ))}
          {v.topics.map((t) => (
            <Chip key={t} className="h-7 px-2.5 text-[12.5px]">
              {t}
            </Chip>
          ))}
        </div>
      )}

      <div className={cx('mt-5 grid gap-x-8', side && '@3xl:grid-cols-[minmax(0,1fr)_minmax(0,280px)]')}>
        <div className="min-w-0">
          {v.career.length > 0 && (
            <Block title="Career" testId="debrief-career">
              <ol className="space-y-2.5">
                {v.career.map((c, i) => (
                  <li key={`${c.org}-${i}`} className="flex items-start gap-2.5">
                    <CompanyLogo name={c.org} size={20} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] text-ink">
                        {c.role || c.org}
                        <Refs ns={c.sources} sources={sources} />
                      </div>
                      {span(c.start, c.end) && (
                        <div className="text-[12px] text-ink-3 tabular">{span(c.start, c.end)}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </Block>
          )}
          {v.education.length > 0 && (
            <Block title="Education" testId="debrief-education">
              <ul className="space-y-2">
                {v.education.map((e, i) => (
                  <li key={`${e.school}-${i}`} className="flex items-start gap-2.5">
                    <CompanyLogo name={e.school} size={20} decorative className="mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-[13.5px]">
                        {e.school}
                        <Refs ns={e.sources} sources={sources} />
                      </div>
                      {(e.degree || e.years) && (
                        <div className="text-[12px] text-ink-3">
                          {[e.degree, e.years].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Block>
          )}
          {v.highlights.length > 0 && (
            <Block title="What they've made and said" testId="debrief-highlights">
              <div className="grid @xl:grid-cols-2 gap-2.5">
                {v.highlights.map((h, i) => {
                  const href = h.url ?? sources.find((s) => s.n === h.sources[0])?.url;
                  const demo = sources.find((s) => s.n === h.sources[0])?.demo;
                  const inner = (
                    <>
                      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                        <SiteIcon url={href} size={13} />
                        <span className="truncate">{host(href) ?? 'source'}</span>
                        <span>·</span>
                        <span>{KIND_LABEL[h.kind] ?? 'Mention'}</span>
                        {h.date && <span className="ml-auto tabular shrink-0">{h.date}</span>}
                      </div>
                      <div className="text-[13.5px] font-medium mt-1 leading-snug line-clamp-2">
                        {h.title}
                      </div>
                      {h.summary && <p className="text-[12.5px] text-ink-2 mt-1 line-clamp-2">{h.summary}</p>}
                    </>
                  );
                  return href && !demo ? (
                    <a
                      key={i}
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block rounded-[12px] border border-line p-3 hover:bg-canvas-2 transition-colors"
                      data-testid="debrief-highlight"
                    >
                      {inner}
                    </a>
                  ) : (
                    <div
                      key={i}
                      className="rounded-[12px] border border-line p-3"
                      data-testid="debrief-highlight"
                    >
                      {inner}
                    </div>
                  );
                })}
              </div>
            </Block>
          )}
          {recently.length > 0 && (
            <Block title="Recently" testId="debrief-recently">
              <ul className="space-y-1.5 text-[13.5px] text-ink-2">
                {recently.map((r, i) => (
                  <li key={i}>
                    <ClaimLine claim={r} sources={sources} />
                  </li>
                ))}
              </ul>
            </Block>
          )}
          {v.company.length > 0 && (
            <Block title={`At ${person.currentOrganizationRaw ?? 'their company'}`} testId="debrief-company">
              <ul className="space-y-1.5 text-[13.5px] text-ink-2">
                {v.company.map((c, i) => (
                  <li key={i}>
                    <ClaimLine claim={c} sources={sources} />
                  </li>
                ))}
              </ul>
            </Block>
          )}
        </div>
        {side ? (
          <div className="min-w-0">
            {v.inCommon.length > 0 && (
              <Block title="In common with you" testId="debrief-common">
                <ul className="space-y-1.5 text-[13.5px]">
                  {v.inCommon.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-good shrink-0" />
                      <span>
                        <ClaimLine claim={c} sources={sources} />
                      </span>
                    </li>
                  ))}
                </ul>
              </Block>
            )}
            {v.openers.length > 0 && (
              <Block title="Good openers" testId="debrief-openers">
                <ul className="space-y-2">
                  {v.openers.map((o, i) => (
                    <li key={i} className="group flex items-start gap-2 text-[13.5px] text-ink-2">
                      <span className="flex-1">
                        “{o.text}”
                        <Refs ns={o.sources} sources={sources} />
                      </span>
                      <button
                        className="shrink-0 p-1 rounded text-ink-3 hover:text-ink opacity-100 @3xl:opacity-0 @3xl:group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => void copy(o.text)}
                        aria-label="Copy this opener"
                        title="Copy"
                      >
                        <Copy size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </Block>
            )}
            {v.carefulClaims.length > 0 && (
              <Block title="Be careful" testId="debrief-careful">
                <ul className="space-y-1.5 text-[13px] text-warn">
                  {v.carefulClaims.map((c, i) => (
                    <li key={i}>
                      {c.text}
                      <Refs ns={c.sources} sources={sources} />
                    </li>
                  ))}
                </ul>
              </Block>
            )}
          </div>
        ) : null}
      </div>

      {sources.length > 0 && (
        <details className="mt-4 pt-3 border-t border-line-2 text-[12.5px]" data-testid="debrief-sources">
          <summary className="cursor-pointer text-ink-3 hover:text-ink w-fit">
            {sources.length} source{sources.length === 1 ? '' : 's'}
            {v.confidence ? ` · ${v.confidence} confidence` : ''} · updated {relDate(v.updatedAt)}
          </summary>
          <ol className="mt-2 space-y-1.5">
            {sources.map((s) => (
              <li key={s.n} className="flex items-center gap-2 min-w-0">
                <span className="text-ink-3 tabular w-5 shrink-0">{s.n}.</span>
                <SiteIcon url={s.url} size={13} />
                {s.url && !s.demo ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate hover:underline"
                    title={s.url}
                  >
                    {s.title ?? host(s.url)}
                  </a>
                ) : (
                  <span className="truncate">{s.title ?? host(s.url) ?? 'Source'}</span>
                )}
                {s.url && !s.demo && <ExternalLink size={11} className="text-ink-3 shrink-0" />}
                <span className="text-ink-3 truncate shrink-0 max-w-[40%]">{host(s.url)}</span>
              </li>
            ))}
          </ol>
          {sources.some((s) => s.demo) && (
            <p className="text-[12px] text-ink-3 mt-2">
              Sample sources: this is a made-up person, so nothing links out.
            </p>
          )}
        </details>
      )}
      {(deeper || error) && (
        <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="research-deeper-row">
          {deeper && (
            <Button
              size="sm"
              onClick={deeper.run}
              disabled={deeper.busy || busy}
              data-testid="research-deeper"
            >
              {deeper.busy ? <Spinner /> : null} {deeper.busy ? 'Going deeper' : 'Go deeper'}
            </Button>
          )}
          {deeper && !deeper.busy && (
            <span className="text-[12px] text-ink-3">
              {(d.research?.strongPages ?? 1) > 0
                ? `More about ${first}, and what is happening at their company.`
                : `Their company's recent news and hiring.`}
            </span>
          )}
          {deeper?.busy && (
            <span className="text-[12px] text-ink-3" role="status" data-testid="research-deeper-pending">
              Looking further. This takes about a minute.
            </span>
          )}
          {error && (
            <span className="text-[12.5px] text-bad" role="alert" data-testid="research-error">
              {error}
            </span>
          )}
        </div>
      )}
      <div className="mt-4 pt-3 border-t border-line-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
        <span data-testid="research-footer">{RESEARCH_FOOTER}</span>
        {allowance && <span data-testid="research-allowance">{allowanceLine(allowance)}</span>}
        {onDelete && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 hover:text-bad"
            onClick={onDelete}
            data-testid="research-delete"
          >
            <Trash2 size={12} aria-hidden /> Delete brief
          </button>
        )}
      </div>
    </div>
  );
}

function ClaimLine({ claim, sources }: { claim: Claim; sources: Source[] }) {
  return (
    <>
      {claim.date ? <span className="text-ink-3">{claim.date} · </span> : null}
      {claim.text}
      <Refs ns={claim.sources} sources={sources} />
      <Partly claim={claim} />
    </>
  );
}

/** A claim its source only partly says: shown, marked, never used in a draft or a fact. */
function Partly({ claim }: { claim: Pick<Claim, 'support'> }) {
  if (claim.support !== 'partial') return null;
  return (
    <span
      className="ml-1 text-[11px] text-ink-3"
      title="Its source says only part of this, so Orbit does not use it in drafts or facts."
      data-testid="claim-partly"
    >
      (partly supported)
    </span>
  );
}
