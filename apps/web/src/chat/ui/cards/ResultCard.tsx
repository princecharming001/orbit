/**
 * One glass card per result kind. Each card reuses the app's own pieces where they exist (DraftEditor and the
 * approval flow for drafts, SuggestionCard for a brief, Avatar, STAGE_LABELS) and falls back to the envelope's
 * summary when the data is not what it expects. "Open in app" is a router Link to the envelope's href.
 */
import type { Person } from '@orbit/core';
import { STAGE_LABELS } from '@orbit/core';
import { ArrowUpRight, Check, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DraftEditor, OutboxStatus } from '../../../components/DraftEditor';
import { SuggestionCard } from '../../../components/SuggestionCard';
import { Avatar, Button, Chip, cx, relDate } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { Markdown } from '../Markdown';
import type { ToolBlock } from '../threadStore';
import {
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
  readSuggestions,
} from './shapes';

export interface CardActions {
  approve: (toolUseId: string, edited?: { body: string; subject?: string }) => Promise<string | undefined>;
  cancel: (toolUseId: string) => Promise<void>;
}

/** The label of the page an href opens, for the "Open in app" link. */
export function hrefLabel(href: string): string {
  const path = href.split('?')[0]!.split('#')[0]!;
  if (path.startsWith('/people/')) return 'Open profile';
  if (path.startsWith('/companies/')) return 'Open company';
  if (path.startsWith('/inbox')) return 'Open in Drafts';
  if (path.startsWith('/pipeline')) return 'Open pipeline';
  if (path.startsWith('/map')) return 'Open on map';
  if (path.startsWith('/today')) return 'Open Today';
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
      return <Markdown text={env.summary} className="my-2" />;
    case 'person': {
      const r = readPerson(d);
      if (!r) return <Summary env={env} />;
      const { person, chat, facts } = r;
      return (
        <GlassCard kind="person">
          <div className="flex items-start gap-3">
            <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={44} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[15px]">{person.displayName}</span>
                <Chip tone="neutral">{closeness(person.strength)}</Chip>
                {chat && <Chip tone="accent">{STAGE_LABELS[chat.stage]}</Chip>}
              </div>
              <div className="text-[13px] text-ink-2 truncate">
                {[person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ')}
              </div>
              {person.lastInteractionAt && (
                <div className="text-[12.5px] text-ink-3 mt-0.5">
                  Last contact {relDate(person.lastInteractionAt)}
                </div>
              )}
              {facts.length > 0 && (
                <ul className="mt-2 text-[13px] text-ink-2 space-y-0.5 list-disc pl-4">
                  {facts.slice(0, 3).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
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
    case 'draft':
      return <DraftCard block={block} env={env} actions={actions} />;
    case 'drafts': {
      const drafts = readDrafts(d);
      if (!drafts.length) return <Summary env={env} />;
      return (
        <GlassCard kind="drafts">
          <CardHead title={env.summary} href={env.href} />
          <ul className="divide-y divide-line-2">
            {drafts.map(({ draft, person }) => (
              <li key={draft.id} className="py-2 flex items-start gap-3 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">
                      {person?.displayName ?? draft.toEmail ?? 'Someone'}
                    </span>
                    <Chip
                      tone={draft.status === 'draft' ? 'accent' : draft.status === 'sent' ? 'good' : 'warn'}
                    >
                      {draft.status === 'handed_off'
                        ? 'Waiting for I sent it'
                        : draft.status === 'draft'
                          ? 'Draft'
                          : draft.status}
                    </Chip>
                  </div>
                  <div className="text-[13px] text-ink-2 line-clamp-2 mt-0.5">
                    {draft.bodyFinal ?? draft.bodyDraft}
                  </div>
                </div>
                <Link
                  to={`/inbox?draft=${draft.id}`}
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
          <CardHead title="Pipeline" href={env.href ?? '/pipeline'} />
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
            {items.map(({ chat, person, nextStep }) => (
              <PersonRow
                key={person.id}
                person={person}
                sub={nextStep ? `Next: ${nextStep}` : undefined}
                aside={chat ? <Chip tone="accent">{STAGE_LABELS[chat.stage]}</Chip> : undefined}
              />
            ))}
          </div>
        </GlassCard>
      );
    }
    case 'routes': {
      const { to, routes, people } = readRoutes(d);
      if (!routes.length) return <Summary env={env} />;
      const name = (id: string) => (id === 'user' ? 'You' : (people[id]?.firstName ?? 'someone'));
      return (
        <GlassCard kind="routes">
          <CardHead title={to ? `Routes to ${to.displayName}` : 'Routes'} href={env.href} />
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
                    {['You', ...r.hops.map((h) => name(h.toId))].join(' → ')}
                    <span className="ml-2 text-[12px] font-normal text-ink-3">
                      {r.band === 'strong' ? 'strong' : r.band === 'possible' ? 'possible' : 'long shot'}
                    </span>
                  </div>
                  <div className="text-[12.5px] text-ink-3">{r.hops.map((h) => h.text).join('. ')}</div>
                </div>
              </li>
            ))}
          </ol>
        </GlassCard>
      );
    }
    case 'brief':
    case 'suggestion': {
      const suggestions = readSuggestions(d);
      if (!suggestions.length) return <Summary env={env} />;
      return (
        <div className="my-2 space-y-2" data-testid={`result-${env.kind}`}>
          {suggestions.map((s) => (
            <SuggestionCard key={s.id} s={s} compact />
          ))}
          {env.href && (
            <div className="flex justify-end">
              <OpenInApp href={env.href} />
            </div>
          )}
        </div>
      );
    }
    case 'note': {
      const { note, person, facts, summary } = readNote(d);
      return (
        <GlassCard kind="note">
          <CardHead title={person ? `Note on ${person.displayName}` : 'Note saved'} href={env.href} />
          {(summary || note?.rawText) && (
            <p className="text-[13.5px] text-ink-2 line-clamp-4 whitespace-pre-line">
              {summary ?? note?.rawText}
            </p>
          )}
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
      const { name, industry, people, target } = readCompany(d);
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
              {people.map((p) => (
                <PersonRow key={p.id} person={p} />
              ))}
            </div>
          ) : (
            <p className="text-[13.5px] text-ink-2">{env.summary}</p>
          )}
        </GlassCard>
      );
    }
    case 'settings': {
      const changes = readSettings(d);
      if (!changes.length) return <Summary env={env} />;
      return (
        <GlassCard kind="settings">
          <CardHead title="Settings changed" href={env.href} />
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
      const { source, counts } = readImport(d);
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

/** What an approval produced, in place of the card that asked. A sent draft draws the Inbox's own status block. */
function Outcome({ env, block, actions }: { env: ResultEnvelope; block: ToolBlock; actions: CardActions }) {
  const r = env.kind === 'draft' ? readDraft(env.data) : undefined;
  if (r && r.draft.status !== 'draft')
    return (
      <div className="my-2" data-testid="result-outcome">
        <OutboxStatus draft={r.draft} />
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
  const [busy, setBusy] = useState(false);
  if (!r) return <Summary env={env} />;
  if (block.status === 'approved' && block.outcome)
    return <Outcome env={block.outcome} block={block} actions={actions} />;
  const { draft, person } = r;
  return (
    <GlassCard kind="draft">
      <CardHead
        title={person ? `To ${person.displayName}` : 'Draft'}
        href={env.href}
        aside={<Chip tone="accent">{draft.channel === 'linkedin' ? 'LinkedIn' : 'Email'}</Chip>}
      />
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const text = c.text ?? env.summary;
  if (block.status === 'approved' && block.outcome)
    return <Outcome env={block.outcome} block={block} actions={actions} />;
  const decided = block.status === 'cancelled' || block.status === 'approved';
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
      {c.draft && !decided && (
        <div className="mt-3">
          <DraftEditor
            draft={c.draft}
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
          {!c.draft && (
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
