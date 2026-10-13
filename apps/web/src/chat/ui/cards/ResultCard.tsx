/**
 * One glass card per result kind. Each card reuses the app's own pieces where they exist (DraftEditor and the
 * approval flow for drafts, SuggestionCard for a brief, Avatar, STAGE_LABELS) and falls back to the envelope's
 * summary when the data is not what it expects. "Open in app" is a router Link to the envelope's href.
 */
import type { OutboundMessage, Person, Suggestion } from '@orbit/core';
import { STAGE_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, Check, Copy, Download, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { copyText } from '../../../components/approve';
import { DraftEditor, OutboxStatus } from '../../../components/DraftEditor';
import { SuggestionCard } from '../../../components/SuggestionCard';
import { db } from '../../../db/schema';
import { Avatar, Button, Chip, cx, relDate } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { Markdown } from '../Markdown';
import type { ToolBlock } from '../threadStore';
import { Choices } from './Choices';
import { SetupCard } from './Setup';
import {
  readBriefExtras,
  readChoices,
  readCompany,
  readConfirm,
  readDraft,
  readDrafts,
  readError,
  readFacts,
  readImport,
  readNote,
  readPeople,
  readPerson,
  readPipeline,
  readPrep,
  readRoutes,
  readSettings,
  readSetup,
  readSuggestions,
  readText,
  readWarmIntros,
  type WarmIntro,
} from './shapes';

export interface CardActions {
  approve: (toolUseId: string, edited?: { body: string; subject?: string }) => Promise<string | undefined>;
  cancel: (toolUseId: string) => Promise<void>;
  /** sends text as the student's next message (a tapped choice) */
  send: (text: string) => Promise<void> | void;
}

/** The label of the page an href opens, for the "Open in app" link. */
export function hrefLabel(href: string): string {
  const path = href.split('?')[0]!.split('#')[0]!;
  if (path.startsWith('/people/')) return 'Open profile';
  if (path.startsWith('/companies/')) return 'Open company';
  if (path.startsWith('/inbox')) return 'Open Drafts';
  if (path.startsWith('/map')) return 'Open on map';
  if (path.startsWith('/settings')) return 'Open Settings';
  if (path.startsWith('/people')) return 'Open People';
  if (path.startsWith('/discover')) return 'Open Discover';
  return 'Open in app';
}

export function OpenInApp({ href, className }: { href?: string; className?: string }) {
  if (!href) return null;
  return (
    <Link
      to={href}
      className={cx(
        'inline-flex items-center gap-1 h-8 px-2.5 -ml-1 rounded-lg text-[13px] font-medium text-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        className,
      )}
      data-testid="open-in-app"
    >
      {hrefLabel(href)} <ArrowUpRight size={14} aria-hidden />
    </Link>
  );
}

export function GlassCard({
  children,
  kind,
  className,
  tone,
}: {
  children: ReactNode;
  kind: string;
  className?: string;
  tone?: 'bad' | 'warn';
}) {
  return (
    <div
      className={cx(
        'glass glass-strong rounded-[18px] p-4 my-2 min-w-0 max-w-full break-words text-[14px]',
        tone === 'bad' && 'border-bad/30',
        tone === 'warn' && 'border-warn/30',
        className,
      )}
      data-testid={`result-${kind}`}
    >
      {children}
    </div>
  );
}

function CardHead({ title, href, aside }: { title: ReactNode; href?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <div className="font-semibold text-[14px] min-w-0 truncate">{title}</div>
      {aside}
      <OpenInApp href={href} className="ml-auto shrink-0" />
    </div>
  );
}

/** Village's warm intro paths: who introduces, how warm in a word, and the hops. */
function WarmIntros({ intros, divided }: { intros: WarmIntro[]; divided?: boolean }) {
  if (!intros.length) return null;
  return (
    <div className={cx(divided && 'mt-3 pt-3 border-t border-line-2')} data-testid="warm-intros">
      <div className="text-[12px] font-medium text-ink-3 mb-1.5">Warm intros</div>
      <ul className="space-y-2 text-[13.5px]">
        {intros.map((w) => (
          <li key={`${w.introducer}:${w.hops.join('>')}`} data-testid="warm-intro">
            <div className="flex items-center gap-2 flex-wrap">
              {w.introducerId ? (
                <Link to={`/people/${w.introducerId}`} className="font-medium hover:underline">
                  {w.introducer}
                </Link>
              ) : (
                <span className="font-medium">{w.introducer}</span>
              )}
              <Chip tone={w.warmthWord === 'warm' ? 'good' : w.warmthWord === 'good' ? 'accent' : 'neutral'}>
                {w.warmthWord}
              </Chip>
            </div>
            {w.hops.length > 1 && <div className="text-[12.5px] text-ink-2">{w.hops.join(' → ')}</div>}
            {w.note && <div className="text-[12.5px] text-ink-3">{w.note}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonRow({
  person,
  sub,
  href,
  aside,
}: {
  person: Person;
  sub?: string;
  href?: string;
  aside?: ReactNode;
}) {
  const role = sub ?? [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ');
  return (
    <div className="flex items-center gap-3 min-w-0 py-1.5">
      <Link to={href ?? `/people/${person.id}`} className="shrink-0">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={32} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={href ?? `/people/${person.id}`} className="font-medium hover:underline block truncate">
          {person.displayName}
        </Link>
        {role && <div className="text-[12.5px] text-ink-3 truncate">{role}</div>}
      </div>
      {aside}
    </div>
  );
}

function closeness(strength: number): string {
  return strength >= 0.6 ? 'Close' : strength >= 0.3 ? 'Warm' : 'Weak tie';
}

export function ResultCard({ block, actions }: { block: ToolBlock; actions: CardActions }) {
  const env = block.envelope;
  if (!env) return null;
  return <Envelope env={env} block={block} actions={actions} />;
}

function Envelope({ env, block, actions }: { env: ResultEnvelope; block: ToolBlock; actions: CardActions }) {
  const d = env.data;
  switch (env.kind) {
    case 'text':
      return <TextResult env={env} />;
    case 'person': {
      const r = readPerson(d);
      if (!r) return <Summary env={env} />;
      const { person, chat, facts, lastTouch, stageLabel, questions } = r;
      const stage = chat ? STAGE_LABELS[chat.stage] : stageLabel;
      return (
        <GlassCard kind="person">
          <div className="flex items-start gap-3">
            <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={44} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[15px]">{person.displayName}</span>
                <Chip tone="neutral">{closeness(person.strength)}</Chip>
                {stage && <Chip tone="accent">{stage}</Chip>}
              </div>
              <div className="text-[13px] text-ink-2 truncate">
                {[person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ')}
              </div>
              {(person.lastInteractionAt || lastTouch) && (
                <div className="text-[12.5px] text-ink-3 mt-0.5">
                  Last contact {person.lastInteractionAt ? relDate(person.lastInteractionAt) : lastTouch}
                </div>
              )}
              {facts.length > 0 && (
                <ul className="mt-2 text-[13px] text-ink-2 space-y-0.5 list-disc pl-4">
                  {facts.slice(0, 3).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              {questions.length > 0 && (
                <>
                  <div className="mt-3 text-[12px] font-medium text-ink-3 uppercase tracking-wide">
                    Questions to ask
                  </div>
                  <ol className="mt-1 text-[13.5px] list-decimal pl-5 space-y-1" data-testid="person-prep">
                    {questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <OpenInApp href={env.href ?? `/people/${person.id}`} />
          </div>
        </GlassCard>
      );
    }
    case 'people': {
      const people = readPeople(d);
      if (!people.length) return <Summary env={env} />;
      return (
        <GlassCard kind="people">
          <CardHead title={env.summary} href={env.href} />
          <div className="divide-y divide-line-2">
            {people.map(({ person, why }) => (
              <PersonRow key={person.id} person={person} sub={why} />
            ))}
          </div>
        </GlassCard>
      );
    }
    case 'choices':
      return <Choices options={readChoices(d)} actions={actions} />;
    case 'setup': {
      const { what, status } = readSetup(d);
      return what ? <SetupCard what={what} status={status} /> : <Summary env={env} />;
    }
    case 'draft':
      return <DraftCard block={block} env={env} actions={actions} />;
    case 'drafts': {
      const drafts = readDrafts(d);
      if (!drafts.length) return <Summary env={env} />;
      return (
        <GlassCard kind="drafts">
          <CardHead title={env.summary} href={env.href} />
          <ul className="divide-y divide-line-2">
            {drafts.slice(0, 8).map((r) => (
              <li key={r.id} className="py-2 flex items-start gap-3 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{r.personName ?? 'Someone'}</span>
                    {r.kindLabel && <span className="text-[12.5px] text-ink-3">{r.kindLabel}</span>}
                    {r.status && (
                      <Chip tone={r.status === 'draft' ? 'accent' : r.status === 'sent' ? 'good' : 'warn'}>
                        {DRAFT_STATUS[r.status] ?? r.status}
                      </Chip>
                    )}
                  </div>
                  {r.text && <div className="text-[13px] text-ink-2 line-clamp-2 mt-0.5">{r.text}</div>}
                </div>
                <Link
                  to={`/inbox?draft=${r.id}`}
                  className="shrink-0 text-[13px] text-accent font-medium hover:underline"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </GlassCard>
      );
    }
    case 'pipeline': {
      const { items, counts } = readPipeline(d);
      if (!items.length && !Object.keys(counts).length) return <Summary env={env} />;
      return (
        <GlassCard kind="pipeline">
          <CardHead
            title={items.length === 1 ? env.summary : 'Pipeline'}
            href={env.href ?? '/people?view=board'}
          />
          {Object.keys(counts).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {Object.entries(counts).map(([stage, n]) => (
                <Chip key={stage} tone="neutral">
                  <span className="tabular">{n}</span>{' '}
                  {(STAGE_LABELS as Record<string, string>)[stage] ?? stage}
                </Chip>
              ))}
            </div>
          )}
          <div className="divide-y divide-line-2">
            {items.slice(0, 12).map(({ person, stage, stageLabel, nextStep }) => (
              <PersonRow
                key={person.id}
                person={person}
                sub={nextStep ? `Next: ${nextStep}` : undefined}
                aside={
                  stage || stageLabel ? (
                    <Chip tone="accent">
                      {stageLabel ?? (STAGE_LABELS as Record<string, string>)[stage!] ?? stage}
                    </Chip>
                  ) : undefined
                }
              />
            ))}
          </div>
          {items.length > 12 && (
            <p className="mt-1 text-[12.5px] text-ink-3">And {items.length - 12} more on the People board.</p>
          )}
        </GlassCard>
      );
    }
    case 'routes': {
      const { to, routes, stories, warmIntros } = readRoutes(d);
      // warm intros alone are a result too (Village found paths where Orbit's own graph has none)
      if (!routes.length && !stories.length && !warmIntros.length) {
        const people = readPeople(d);
        if (!people.length) return <Summary env={env} />;
        return (
          <GlassCard kind="routes">
            <CardHead title={env.summary} href={env.href} />
            <div className="divide-y divide-line-2">
              {people.map(({ person }) => (
                <PersonRow key={person.id} person={person} />
              ))}
            </div>
          </GlassCard>
        );
      }
      return (
        <GlassCard kind="routes">
          <CardHead title={to ? `Routes to ${to.displayName}` : env.summary} href={env.href} />
          {routes.length > 0 && (
            <ol className="space-y-2">
              {routes.map((r, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className="mt-1 shrink-0 w-14 h-1.5 rounded-full bg-line-2 overflow-hidden"
                    role="meter"
                    aria-valuenow={Math.round(r.score * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Route strength"
                  >
                    <span
                      className="block h-full bg-accent rounded-full"
                      style={{ width: `${Math.max(8, Math.round(r.score * 100))}%` }}
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium">
                      {['You', ...r.names].join(' → ')}
                      <span className="ml-2 text-[12px] font-normal text-ink-3">
                        {r.bandLabel ??
                          (r.band === 'strong' ? 'strong' : r.band === 'possible' ? 'possible' : 'long shot')}
                      </span>
                    </div>
                    {r.text.length > 0 && <div className="text-[12.5px] text-ink-3">{r.text.join('. ')}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {stories.length > 0 && (
            <ul className="text-[13.5px] space-y-1.5">
              {stories.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
          {routes.length === 0 && stories.length === 0 && (
            <p className="text-[13.5px] text-ink-2">{env.summary}</p>
          )}
          <WarmIntros intros={warmIntros} divided={routes.length > 0 || stories.length > 0} />
        </GlassCard>
      );
    }
    case 'brief':
    case 'suggestion':
      return <SuggestionsCard env={env} />;
    case 'note': {
      const { note, person, facts, summary, notes, candidates } = readNote(d);
      if (notes.length)
        return (
          <GlassCard kind="note">
            <CardHead title={env.summary} href={env.href} />
            <ul className="divide-y divide-line-2 text-[13.5px]">
              {notes.slice(0, 6).map((n, i) => (
                <li key={i} className="py-1.5">
                  <div className="text-[12.5px] text-ink-3">
                    {[n.when, n.people.join(', ')].filter(Boolean).join(' · ')}
                  </div>
                  {n.summary && <div className="line-clamp-2">{n.summary}</div>}
                </li>
              ))}
            </ul>
          </GlassCard>
        );
      if (candidates.length)
        return (
          <GlassCard kind="note">
            <CardHead title={env.summary} href={env.href} />
            <div className="divide-y divide-line-2">
              {candidates.map((p) => (
                <PersonRow key={p.id} person={p} />
              ))}
            </div>
          </GlassCard>
        );
      return (
        <GlassCard kind="note">
          <CardHead title={person ? `Note on ${person.displayName}` : 'Note saved'} href={env.href} />
          <p className="text-[13.5px] text-ink-2 line-clamp-4 whitespace-pre-line">
            {summary ?? note?.rawText ?? env.summary}
          </p>
          {facts.length > 0 && (
            <ul className="mt-2 text-[13px] space-y-1">
              {facts.map((f) => (
                <li key={f} className="flex gap-2">
                  <Check size={14} className="text-good mt-0.5 shrink-0" aria-hidden /> <span>{f}</span>
                </li>
              ))}
            </ul>
          )}
        </GlassCard>
      );
    }
    case 'facts': {
      const { person, facts } = readFacts(d);
      if (!facts.length) return <Summary env={env} />;
      return (
        <GlassCard kind="facts">
          <CardHead
            title={person ? `What you know about ${person.firstName}` : 'What you know'}
            href={env.href}
          />
          <ul className="text-[13.5px] space-y-1.5">
            {facts.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                {f.type && (
                  <Chip tone="neutral" className="capitalize">
                    {f.type.replace(/_/g, ' ')}
                  </Chip>
                )}
                <span className="min-w-0">{f.text}</span>
              </li>
            ))}
          </ul>
        </GlassCard>
      );
    }
    case 'company': {
      const { name, industry, people, former, target } = readCompany(d);
      if (!name) return <Summary env={env} />;
      return (
        <GlassCard kind="company">
          <CardHead
            title={name}
            href={env.href}
            aside={
              <>
                {industry && <Chip tone="neutral">{industry}</Chip>}
                {target && <Chip tone="accent">Target</Chip>}
              </>
            }
          />
          {people.length > 0 ? (
            <div className="divide-y divide-line-2">
              {people.slice(0, 8).map((p) => (
                <PersonRow key={p.id} person={p} />
              ))}
            </div>
          ) : (
            <p className="text-[13.5px] text-ink-2">{env.summary}</p>
          )}
          {former.length > 0 && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              Used to work there: {former.map((p) => p.displayName).join(', ')}
            </p>
          )}
          {people.length > 0 && <p className="mt-2 text-[12.5px] text-ink-3">{env.summary}</p>}
          <WarmIntros intros={readWarmIntros(d)} divided />
        </GlassCard>
      );
    }
    case 'settings': {
      const changes = readSettings(d);
      if (!changes.length) return <Summary env={env} />;
      return (
        <GlassCard kind="settings">
          <CardHead title={env.summary} href={env.href} />
          <dl className="text-[13.5px] space-y-1">
            {changes.map((c) => (
              <div key={c.label} className="flex items-baseline gap-2 flex-wrap">
                <dt className="text-ink-3">{c.label}</dt>
                <dd className="font-medium">
                  {c.from !== undefined && <span className="text-ink-3 line-through mr-1.5">{c.from}</span>}
                  {c.to}
                </dd>
              </div>
            ))}
          </dl>
        </GlassCard>
      );
    }
    case 'import': {
      const { source, counts, lines } = readImport(d);
      return (
        <GlassCard kind="import">
          <CardHead title={source ? `Imported from ${source}` : 'Imported'} href={env.href} />
          {counts.length ? (
            <div className="flex flex-wrap gap-4">
              {counts.map((c) => (
                <div key={c.label} className="min-w-0">
                  <div className="text-[20px] font-semibold tabular leading-tight">{c.value}</div>
                  <div className="text-[12px] text-ink-3 capitalize">{c.label}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13.5px] text-ink-2">{env.summary}</p>
          )}
          {lines.length > 0 && (
            <ul className="mt-2 text-[13px] text-ink-2 list-disc pl-4 space-y-0.5">
              {lines.slice(0, 8).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {counts.length > 0 && <p className="mt-2 text-[12.5px] text-ink-3">{env.summary}</p>}
        </GlassCard>
      );
    }
    case 'prep': {
      const { person, when, summary, questions, facts } = readPrep(d);
      if (!person && !summary && !questions.length) return <Summary env={env} />;
      return (
        <GlassCard kind="prep">
          <CardHead
            title={person ? `Prep for ${person.displayName}` : 'Prep'}
            href={env.href}
            aside={
              when ? (
                <Chip tone="good">
                  {new Date(when).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </Chip>
              ) : undefined
            }
          />
          {summary && <p className="text-[13.5px] text-ink-2">{summary}</p>}
          {facts.length > 0 && (
            <ul className="mt-2 text-[13px] text-ink-2 list-disc pl-4 space-y-0.5">
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {questions.length > 0 && (
            <>
              <div className="mt-3 text-[12px] font-medium text-ink-3 uppercase tracking-wide">
                Questions to ask
              </div>
              <ol className="mt-1 text-[13.5px] list-decimal pl-5 space-y-1">
                {questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ol>
            </>
          )}
        </GlassCard>
      );
    }
    case 'needs_confirmation':
      return <ConfirmCard block={block} env={env} actions={actions} />;
    case 'error':
      return (
        <GlassCard kind="error" tone="bad">
          <div className="flex items-start gap-2 text-[13.5px]">
            <TriangleAlert size={16} className="text-bad shrink-0 mt-0.5" aria-hidden />
            <span>{readError(d) ?? env.summary}</span>
          </div>
        </GlassCard>
      );
    default:
      return <Summary env={env} />;
  }
}

/** The envelope's own words, when the data is not something the UI can draw. */
function Summary({ env }: { env: ResultEnvelope }) {
  return (
    <GlassCard kind={env.kind}>
      <div className="flex items-start gap-3">
        <p className="text-[13.5px] flex-1 min-w-0">{env.summary}</p>
        <OpenInApp href={env.href} className="shrink-0" />
      </div>
    </GlassCard>
  );
}

const DRAFT_STATUS: Record<string, string> = {
  draft: 'Draft',
  queued: 'Sending soon',
  sending: 'Sending',
  sent: 'Sent',
  handed_off: 'Waiting for I sent it',
  failed: 'Not sent',
  cancelled: 'Discarded',
};

/** The draft as stored now, so a card shows what happened to it since (edited, handed off, sent). */
function useLiveDraft(draftId: string | undefined, given?: OutboundMessage): OutboundMessage | undefined {
  const live = useLiveQuery(
    async () => (draftId ? ((await db.outbound.get(draftId)) ?? null) : null),
    [draftId],
  );
  return live ?? given;
}

const OPEN_DRAFT = new Set(['draft', 'failed', 'cancelled']);

/** The day's cards: the existing SuggestionCard for each open one, read live from the database. */
function SuggestionsCard({ env }: { env: ResultEnvelope }) {
  const { suggestions, ids, summary } = readSuggestions(env.data);
  const live = useLiveQuery(
    async () => (ids.length ? (await db.suggestions.bulkGet(ids)).filter((x): x is Suggestion => !!x) : []),
    [ids.join(',')],
  );
  const open = [...suggestions, ...(live ?? [])].filter(
    (x) => env.kind === 'brief' || x.status === 'pending' || x.status === 'snoozed',
  );
  if (!open.length) return <Summary env={env} />;
  const shown = open.filter((x) => x.status === 'pending').slice(0, env.kind === 'brief' ? 3 : 1);
  if (!shown.length) return <Summary env={env} />;
  const rest = open.filter((x) => x.status === 'pending').length - shown.length;
  return (
    <div className="my-2 space-y-2" data-testid={`result-${env.kind}`}>
      {env.kind === 'brief' && (summary ?? env.summary) && (
        <p className="text-[14px] text-ink-2">{summary ?? env.summary}</p>
      )}
      {shown.map((x) => (
        <SuggestionCard key={x.id} s={x} compact />
      ))}
      {env.kind === 'brief' && <BriefExtras env={env} />}
      <div className="flex items-center justify-between gap-2">
        {rest > 0 ? (
          <Link
            to="/inbox"
            className="text-[12.5px] text-accent font-medium hover:underline"
            data-testid="brief-more"
          >
            {rest} more in Drafts
          </Link>
        ) : (
          <span />
        )}
        {/* the "more" link already opens Drafts */}
        {!(rest > 0 && env.href === '/inbox') && <OpenInApp href={env.href} />}
      </div>
    </div>
  );
}

/** Under the brief's cards: the next chat coming up, and how many chats wait on a reply. */
function BriefExtras({ env }: { env: ResultEnvelope }) {
  const { nextUp, waiting } = readBriefExtras(env.data);
  if (!nextUp && !waiting) return null;
  return (
    <div className="text-[13px] text-ink-2 space-y-0.5" data-testid="brief-extras">
      {nextUp && (
        <p data-testid="brief-coming-up">
          <span className="font-medium">Coming up:</span> {nextUp.person ?? nextUp.title ?? 'A chat'},{' '}
          {new Date(nextUp.startAt).toLocaleString('en-US', {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </p>
      )}
      {waiting > 0 && (
        <p data-testid="brief-waiting">
          {waiting === 1 ? '1 chat is' : `${waiting} chats are`} waiting on a reply.
        </p>
      )}
    </div>
  );
}

/** A plain answer, with the words to copy or the file to save when the result carries one. */
function TextResult({ env }: { env: ResultEnvelope }) {
  const { quote, file } = readText(env.data);
  const [copied, setCopied] = useState(false);
  if (!quote && !file && !env.href) return <Markdown text={env.summary} className="my-2" />;
  return (
    <GlassCard kind="text">
      <div className="flex items-start gap-3">
        <Markdown text={env.summary} className="flex-1 min-w-0 text-[13.5px]" />
        <OpenInApp href={env.href} className="shrink-0" />
      </div>
      {quote && (
        <div className="mt-2">
          <blockquote className="whitespace-pre-line rounded-xl bg-canvas/70 px-3 py-2 text-[13.5px]">
            {quote}
          </blockquote>
          <Button
            size="sm"
            className="mt-2"
            onClick={async () => setCopied(await copyText(quote))}
            data-testid="text-copy"
          >
            <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy text'}
          </Button>
        </div>
      )}
      {file && (
        <Button
          size="sm"
          className="mt-2"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([file.json], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
          data-testid="text-download"
        >
          <Download size={14} aria-hidden /> Save {file.name}
        </Button>
      )}
    </GlassCard>
  );
}

/** What an approval produced, in place of the card that asked. A sent draft draws the Inbox's own status block. */
function Outcome({ env, block, actions }: { env: ResultEnvelope; block: ToolBlock; actions: CardActions }) {
  const r = env.kind === 'draft' ? readDraft(env.data) : undefined;
  const draft = useLiveDraft(r?.draftId, r?.draft);
  if (draft && !OPEN_DRAFT.has(draft.status))
    return (
      <div className="my-2" data-testid="result-outcome">
        <p className="text-[13.5px] mb-1">{env.summary}</p>
        <OutboxStatus draft={draft} />
        {env.href && (
          <div className="mt-1 flex justify-end">
            <OpenInApp href={env.href} />
          </div>
        )}
      </div>
    );
  return (
    <div data-testid="result-outcome">
      <Envelope env={env} block={{ ...block, status: 'done', outcome: undefined }} actions={actions} />
    </div>
  );
}

/** The draft card: the existing editor and approval flow; Approve goes through the engine. */
function DraftCard({ block, env, actions }: { block: ToolBlock; env: ResultEnvelope; actions: CardActions }) {
  const r = readDraft(env.data);
  const draft = useLiveDraft(r?.draftId, r?.draft);
  const person = useLiveQuery(
    async () => (r?.person || !draft ? null : ((await db.people.get(draft.personId)) ?? null)),
    [draft?.personId, !!r?.person],
  );
  const [busy, setBusy] = useState(false);
  if (!r) return <Summary env={env} />;
  if (block.status === 'approved' && block.outcome)
    return <Outcome env={block.outcome} block={block} actions={actions} />;
  if (!draft) return <Summary env={env} />;
  const name = r.person?.displayName ?? person?.displayName ?? r.personName;
  if (!OPEN_DRAFT.has(draft.status))
    return (
      <GlassCard kind="draft">
        <CardHead title={name ? `To ${name}` : 'Draft'} href={env.href} />
        <p className="text-[13.5px] mb-2">{env.summary}</p>
        <OutboxStatus draft={draft} />
      </GlassCard>
    );
  return (
    <GlassCard kind="draft">
      <CardHead
        title={name ? `To ${name}` : 'Draft'}
        href={env.href}
        aside={<Chip tone="accent">{draft.channel === 'linkedin' ? 'LinkedIn' : 'Email'}</Chip>}
      />
      {draft.needsInput?.length ? (
        <p className="text-[13px] text-warn mb-2" data-testid="draft-needs-input">
          {env.summary}
        </p>
      ) : null}
      <DraftEditor
        draft={draft}
        busy={busy}
        onApprove={async (body, subject) => {
          setBusy(true);
          try {
            return await actions.approve(block.toolUseId, { body, subject });
          } finally {
            setBusy(false);
          }
        }}
      />
    </GlassCard>
  );
}

/** A risky action waits here: nothing runs until Approve. A blocked one says why and keeps Approve off. */
function ConfirmCard({
  block,
  env,
  actions,
}: {
  block: ToolBlock;
  env: ResultEnvelope;
  actions: CardActions;
}) {
  const c = readConfirm(env.data);
  const draft = useLiveDraft(c.draftId, c.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const text = c.text ?? env.summary;
  if (block.status === 'approved' && block.outcome)
    return <Outcome env={block.outcome} block={block} actions={actions} />;
  const decided = block.status === 'cancelled' || block.status === 'approved';
  const editable = !!draft && OPEN_DRAFT.has(draft.status);
  const approve = async (edited?: { body: string; subject?: string }) => {
    setBusy(true);
    setError(undefined);
    try {
      const e = await actions.approve(block.toolUseId, edited);
      if (e) setError(e);
      return e;
    } finally {
      setBusy(false);
    }
  };
  return (
    <GlassCard kind="needs_confirmation" tone={c.blockedReason ? 'warn' : undefined}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 w-6 h-6 rounded-full bg-accent-soft text-accent inline-flex items-center justify-center">
          <Check size={13} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-ink-3 uppercase tracking-wide">
            Needs your approval
          </div>
          <p className="text-[14px] font-medium mt-0.5" data-testid="confirm-text">
            {text}
          </p>
          {env.continues && (
            <p className="text-[12.5px] text-ink-3 mt-0.5">Orbit continues with the next step after this.</p>
          )}
          {c.blockedReason && (
            <p
              className="mt-1.5 text-[13px] text-warn flex items-start gap-1.5"
              data-testid="confirm-blocked"
            >
              <TriangleAlert size={14} className="shrink-0 mt-0.5" aria-hidden /> {c.blockedReason}
            </p>
          )}
        </div>
      </div>
      {editable && !decided && (
        <div className="mt-3">
          <DraftEditor
            draft={draft}
            busy={busy || !!c.blockedReason}
            approveLabel="Approve & send"
            onApprove={(body, subject) => approve({ body, subject })}
          />
        </div>
      )}
      {decided ? (
        <p className="mt-3 text-[13px] text-ink-3" data-testid="confirm-decided">
          {block.status === 'cancelled' ? 'Cancelled. Nothing was changed.' : 'Approved.'}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!editable && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !!c.blockedReason}
              title={c.blockedReason}
              onClick={() => approve()}
              data-testid="confirm-approve"
            >
              Approve
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => actions.cancel(block.toolUseId)}
            data-testid="confirm-cancel"
          >
            Cancel
          </Button>
          {error && <span className="text-[13px] text-bad">{error}</span>}
        </div>
      )}
    </GlassCard>
  );
}
