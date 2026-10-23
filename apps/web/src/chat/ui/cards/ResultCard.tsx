/**
 * One card per result kind, built from the same parts (parts.tsx): one header line, compact rows, lists that fold
 * after five, at most one status line, and a row of next steps where there is an obvious one. Cards reuse the app's
 * own pieces where they exist (DraftEditor in its compact form and the approval flow for drafts, SuggestionCard
 * inside the brief, Avatar, STAGE_LABELS) and fall back to the envelope's summary when the data is not what they
 * expect.
 */
import type { OutboundMessage, Person, Suggestion } from '@orbit/core';
import { CHANNEL_LABELS, MEDIUM_TIE, MESSAGE_KIND_LABELS, STAGE_LABELS, STRONG_TIE } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, Check, Copy, Download, TriangleAlert } from 'lucide-react';
import { Fragment as Frag, type ReactNode, useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { copyText } from '../../../components/approve';
import { CompanyLogo, LogoText } from '../../../components/CompanyLogo';
import { DraftEditor, OutboxStatus } from '../../../components/DraftEditor';
import { KIND_LABEL, SuggestionCard } from '../../../components/SuggestionCard';
import { db } from '../../../db/schema';
import { Avatar, Button, Chip, cx, LinkedInMark, relDate } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import { Markdown } from '../Markdown';
import type { ToolBlock } from '../threadStore';
import { Choices } from './Choices';
import { addPicked, askForIntro, type Picked, routesToEach, writeTo, writeToEach } from './next';
import {
  CardHead,
  DraftOwnersContext,
  GlassCard,
  type NextStep,
  NextSteps,
  OpenInApp,
  PersonRow,
  PickBox,
  Section,
  SelectionBar,
  useFold,
} from './parts';
import { SetupCard } from './Setup';
import {
  type PersonView,
  type RouteView,
  readBriefExtras,
  readChoices,
  readCompany,
  readConfirm,
  readDraft,
  readDrafts,
  readError,
  readFacts,
  readImport,
  readList,
  readNote,
  readPeople,
  readPeopleQuery,
  readPerson,
  readPipeline,
  readPrep,
  readRoutes,
  readRoutesMany,
  readSettings,
  readSetup,
  readSkipped,
  readSuggestions,
  readText,
  readWarmIntros,
  type WarmIntro,
} from './shapes';
import { cardSteps, rowsFrom } from './steps';

export { GlassCard, hrefLabel, OpenInApp } from './parts';

export interface CardActions {
  approve: (toolUseId: string, edited?: { body: string; subject?: string }) => Promise<string | undefined>;
  cancel: (toolUseId: string) => Promise<void>;
  /** sends text as the student's next message (a tapped choice or next step) */
  send: (text: string) => Promise<void> | void;
}

/** The draft a block shows in an editor (a draft card, or a send waiting for approval), for DraftOwnersContext. */
export function editingDraftId(block: ToolBlock): string | undefined {
  const env = block.envelope;
  if (!env || block.outcome) return undefined;
  if (env.kind === 'draft') return readDraft(env.data)?.draftId;
  if (env.kind === 'needs_confirmation' && block.status === 'pending') return readConfirm(env.data).draftId;
  return undefined;
}

/** "3 people match "Dan". Check which one ..." -> "3 people match "Dan"": a summary's first sentence, as a title. */
function firstSentence(s: string): string {
  const m = s.match(/^.*?[.?!](?=\s|$)/);
  return (m ? m[0] : s).replace(/\.$/, '');
}

function closeness(strength: number): string {
  return strength >= STRONG_TIE ? 'Close' : strength >= MEDIUM_TIE ? 'Warm' : 'Weak tie';
}

const stageText = (stage?: string, label?: string) =>
  label ?? (stage ? ((STAGE_LABELS as Record<string, string>)[stage] ?? stage) : undefined);

export function ResultCard({ block, actions }: { block: ToolBlock; actions: CardActions }) {
  const env = block.envelope;
  if (!env) return null;
  return <Envelope env={env} block={block} actions={actions} />;
}

function Envelope({ env, block, actions }: { env: ResultEnvelope; block: ToolBlock; actions: CardActions }) {
  const d = env.data;
  switch (env.kind) {
    case 'text':
      return <TextResult env={env} actions={actions} />;
    case 'person': {
      const r = readPerson(d);
      return r ? <PersonCard env={env} r={r} actions={actions} /> : <Summary env={env} />;
    }
    case 'people':
      return <PeopleCard env={env} actions={actions} />;
    case 'choices':
      return <Choices options={readChoices(d)} actions={actions} />;
    case 'setup': {
      const { what, status } = readSetup(d);
      return what ? <SetupCard what={what} status={status} /> : <Summary env={env} />;
    }
    case 'draft':
      return <DraftCard block={block} env={env} actions={actions} />;
    case 'drafts':
      return <DraftsCard env={env} actions={actions} />;
    case 'pipeline':
      return <PipelineCard env={env} actions={actions} />;
    case 'routes':
      return <RoutesCard env={env} actions={actions} />;
    case 'routes_many':
      return <RoutesManyCard env={env} actions={actions} />;
    case 'brief':
      return <BriefCard env={env} />;
    case 'suggestion':
      return <OneSuggestion env={env} />;
    case 'note':
      return <NoteCard env={env} actions={actions} />;
    case 'facts':
      return <FactsCard env={env} />;
    case 'company':
      return <CompanyCard env={env} actions={actions} />;
    case 'settings':
      return <SettingsCard env={env} />;
    case 'import':
      return <ImportCard env={env} actions={actions} />;
    case 'prep':
      return <PrepCard env={env} />;
    case 'list':
      return <ListCard env={env} block={block} actions={actions} />;
    case 'needs_confirmation':
      return <ConfirmCard block={block} env={env} actions={actions} />;
    case 'error':
      return (
        <GlassCard kind="error" tone="bad">
          <div className="flex items-start gap-2">
            <TriangleAlert size={15} className="text-bad shrink-0 mt-0.5" aria-hidden />
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
      <div className="flex items-start gap-2">
        <p className="flex-1 min-w-0">{env.summary}</p>
        <OpenInApp href={env.href} className="shrink-0 -mr-1.5 -my-1" />
      </div>
    </GlassCard>
  );
}

// ---------- person ----------

function PersonCard({ env, r, actions }: { env: ResultEnvelope; r: PersonView; actions: CardActions }) {
  const { person, chat, facts, lastTouch, stageLabel, questions, summary, timeline, connections, notes } = r;
  const stage = chat ? STAGE_LABELS[chat.stage] : stageLabel;
  const last = person.lastInteractionAt ? relDate(person.lastInteractionAt) : lastTouch;
  const role = person.currentTitle ?? person.headline ?? person.currentOrganizationRaw;
  const factFold = useFold(facts, 3);
  const timeFold = useFold(timeline, 3);
  const whoFold = useFold(connections, 4);
  const noteFold = useFold(notes, 2);
  const steps = cardSteps('get_person', env);
  return (
    <GlassCard kind="person">
      <CardHead
        lead={<Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={36} />}
        title={person.displayName}
        chip={<Chip tone={stage ? 'accent' : 'neutral'}>{stage ?? closeness(person.strength)}</Chip>}
        sub={
          <LogoText person={person} size={13}>
            {[role, r.nextMeeting ? `meeting ${r.nextMeeting}` : last ? `last contact ${last}` : undefined]
              .filter(Boolean)
              .join(' · ')}
          </LogoText>
        }
        href={env.href ?? `/people/${person.id}`}
        className="mb-1"
      />
      {facts.length > 0 ? (
        <>
          <ul className="mt-1.5 text-[13px] text-ink-2 space-y-0.5 list-disc pl-4 marker:text-ink-3">
            {factFold.shown.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {factFold.more}
        </>
      ) : (
        summary && <p className="mt-1.5 text-[13px] text-ink-2 line-clamp-2">{summary}</p>
      )}
      {questions.length > 0 && (
        <Section title="Questions to ask">
          <ol
            className="text-[13px] list-decimal pl-5 space-y-0.5 marker:text-ink-3"
            data-testid="person-prep"
          >
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </Section>
      )}
      {timeline.length > 0 && (
        <Section title="Recent">
          <ul className="space-y-0.5 text-[13px]" data-testid="person-timeline">
            {timeFold.shown.map((t, i) => (
              <li key={i} className="flex gap-2 min-w-0">
                <span className="text-ink-3 shrink-0 tabular w-[6.5rem] truncate">{t.when}</span>
                <span className="min-w-0 truncate text-ink-2" title={t.text}>
                  {t.text}
                </span>
              </li>
            ))}
          </ul>
          {timeFold.more}
        </Section>
      )}
      {connections.length > 0 && (
        <Section title={`Who ${person.firstName} knows`}>
          <div data-testid="person-connections">
            {whoFold.shown.map((c) => (
              <PersonRow key={c.person.id} person={c.person} sub={c.how} dense />
            ))}
          </div>
          {whoFold.more}
        </Section>
      )}
      {notes.length > 0 && (
        <Section title="Notes">
          <ul className="space-y-1 text-[13px]">
            {noteFold.shown.map((n, i) => (
              <li key={i}>
                {n.when && <span className="text-ink-3">{n.when} · </span>}
                <span className="text-ink-2 line-clamp-2 inline">{n.summary}</span>
              </li>
            ))}
          </ul>
          {noteFold.more}
        </Section>
      )}
      <NextSteps steps={steps} send={actions.send} />
    </GlassCard>
  );
}

// ---------- people ----------

function PeopleCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const people = readPeople(env.data);
  const { query } = readPeopleQuery(env.data);
  const target = readRoutes(env.data).to;
  const fold = useFold(people);
  const picked = usePicked();
  if (!people.length) return <Summary env={env} />;
  // rows with a reason under the name keep two lines; a list of names and roles reads on one
  const dense = !!target || !people.some((p) => p.why);
  const steps = cardSteps('search_people', env);
  // more than one person: each row can be picked, and the picked ones get routes or a draft together
  const pickable = people.length > 1;
  const names = people.filter((p) => picked.has(p.person.id)).map((p) => p.person.displayName);
  const pickedSteps = [routesToEach(names), writeToEach(names)].filter((s): s is NextStep => !!s);
  return (
    <GlassCard kind="people">
      <CardHead
        title={
          query && people.length > 1
            ? `Which "${query}"?`
            : firstSentence(env.summary).replace(/, including .*$/, '')
        }
        href={env.href}
      />
      <div className={dense ? undefined : 'divide-y divide-line-2'}>
        {fold.shown.map(({ person, why, stage }) => (
          <div key={person.id} className="flex items-center gap-2.5 min-w-0">
            {pickable && (
              <PickBox
                checked={picked.has(person.id)}
                onChange={(on) => picked.set(person.id, on)}
                label={person.displayName}
              />
            )}
            <div className="min-w-0 flex-1">
              <PersonRow
                person={person}
                sub={why}
                dense={dense}
                aside={stage ? <Chip tone="neutral">{stage}</Chip> : undefined}
              />
            </div>
          </div>
        ))}
      </div>
      {fold.more}
      {pickable && (
        <SelectionBar
          count={names.length}
          total={fold.shown.length}
          onAll={() => picked.setAll(fold.shown.map((p) => p.person.id))}
          onClear={picked.clear}
          steps={pickedSteps}
          send={actions.send}
        />
      )}
      {!names.length && <NextSteps steps={steps} send={actions.send} />}
    </GlassCard>
  );
}

/** Which rows of a card are picked: a set the checkboxes and the bar share. */
function usePicked() {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  return {
    has: (id: string) => ids.has(id),
    set: (id: string, on: boolean) =>
      setIds((cur) => {
        const next = new Set(cur);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    setAll: (all: string[]) => setIds(new Set(all)),
    clear: () => setIds(new Set()),
  };
}

// ---------- drafts ----------

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

function DraftsCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const drafts = readDrafts(env.data);
  const skipped = readSkipped(env.data);
  const fold = useFold(drafts);
  if (!drafts.length && !skipped.length) return <Summary env={env} />;
  // create_drafts: a title that counts what it wrote; list_drafts: its own summary
  const made = skipped.length > 0 || /^Drafted /.test(env.summary);
  const title = made
    ? drafts.length
      ? `Drafted ${drafts.length === 1 ? 'a message' : `${drafts.length} messages`}`
      : 'No drafts written'
    : firstSentence(env.summary);
  const steps = cardSteps('create_drafts', env);
  return (
    <GlassCard kind="drafts">
      <CardHead title={title} href={env.href} />
      <ul className="divide-y divide-line-2 -mx-1.5">
        {fold.shown.map((r) => (
          <li key={r.id}>
            <Link
              to={`/inbox?draft=${r.id}`}
              className="flex items-baseline gap-2 min-w-0 px-1.5 py-1.5 rounded-[8px] hover:bg-canvas-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              data-testid="drafts-row"
            >
              <span className="font-medium shrink-0 max-w-[45%] truncate">{r.personName ?? 'Someone'}</span>
              {r.kindLabel && <span className="text-[12.5px] text-ink-3 shrink-0">{r.kindLabel}</span>}
              <span className="text-[12.5px] text-ink-3 truncate min-w-0 flex-1">{r.text}</span>
              {r.status && r.status !== 'draft' && (
                <Chip tone={r.status === 'sent' ? 'good' : 'warn'} className="self-center">
                  {DRAFT_STATUS[r.status] ?? r.status}
                </Chip>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {fold.more}
      {skipped.length > 0 && (
        <p className="mt-1.5 text-[12.5px] text-ink-3" data-testid="drafts-skipped">
          Skipped {skipped.map((s) => `${s.name} (${s.why})`).join(', ')}.
        </p>
      )}
      <NextSteps steps={steps} send={actions.send} />
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
        <OutboxStatus draft={draft} compact />
      </div>
    );
  return (
    <div data-testid="result-outcome">
      <Envelope env={env} block={{ ...block, status: 'done', outcome: undefined }} actions={actions} />
    </div>
  );
}

/** The header of a draft: who, the kind of message, and how it goes. */
function DraftHead({
  draft,
  name,
  person,
  href,
  aside,
}: {
  draft: OutboundMessage;
  name?: string;
  person?: Person | null;
  href?: string;
  aside?: ReactNode;
}) {
  return (
    <CardHead
      lead={name ? <Avatar name={name} src={person?.photoUrl} id={draft.personId} size={24} /> : undefined}
      title={name ? `To ${name}` : 'Draft'}
      chip={
        <>
          <Chip tone="accent">{MESSAGE_KIND_LABELS[draft.kind]}</Chip>
          <span className="hidden sm:inline text-[12.5px] text-ink-3 shrink-0">
            {CHANNEL_LABELS[draft.channel]}
          </span>
        </>
      }
      href={href ?? `/people/${draft.personId}`}
      aside={aside}
      className="mb-2"
    />
  );
}

/** The draft card: the compact editor and the approval flow; Approve goes through the engine. */
function DraftCard({ block, env, actions }: { block: ToolBlock; env: ResultEnvelope; actions: CardActions }) {
  const r = readDraft(env.data);
  const draft = useLiveDraft(r?.draftId, r?.draft);
  const owners = useContext(DraftOwnersContext);
  const person = useLiveQuery(
    async () => (draft ? ((await db.people.get(draft.personId)) ?? null) : null),
    [draft?.personId],
  );
  const [busy, setBusy] = useState(false);
  if (!r) return <Summary env={env} />;
  if (block.status === 'approved' && block.outcome)
    return <Outcome env={block.outcome} block={block} actions={actions} />;
  if (!draft) return <Summary env={env} />;
  const name = r.person?.displayName ?? person?.displayName ?? r.personName;
  const href = `/people/${draft.personId}`;
  // a later card in the thread holds this draft's editor: this one folds to its header
  const owner = owners.get(draft.id);
  if (owner && owner !== block.toolUseId)
    return (
      <GlassCard kind="draft" className="py-2">
        <DraftHead
          draft={draft}
          name={name}
          person={person}
          aside={<span className="text-[12px] text-ink-3 shrink-0">Continued below</span>}
        />
      </GlassCard>
    );
  if (!OPEN_DRAFT.has(draft.status))
    return (
      <GlassCard kind="draft">
        <DraftHead draft={draft} name={name} person={person} href={href} />
        <OutboxStatus draft={draft} compact />
      </GlassCard>
    );
  return (
    <GlassCard kind="draft">
      <DraftHead draft={draft} name={name} person={person} href={href} />
      <DraftEditor
        draft={draft}
        busy={busy}
        compact
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

// ---------- pipeline ----------

function PipelineCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const { items, counts } = readPipeline(env.data);
  const fold = useFold(items);
  if (!items.length && !Object.keys(counts).length) return <Summary env={env} />;
  const steps = cardSteps('list_pipeline', env);
  // the stage counts are of every chat: they belong on the whole pipeline, not on a stage or the quiet ones
  const whole = !/ in | went quiet/.test(env.summary.replace(/ in your pipeline/, ''));
  const stageCounts = whole ? Object.entries(counts).sort((a, b) => b[1] - a[1]) : [];
  return (
    <GlassCard kind="pipeline">
      <CardHead
        title={stageCounts.length ? 'Your chats' : firstSentence(env.summary)}
        href={env.href ?? '/people?view=board'}
      />
      {stageCounts.length > 0 && (
        <p className="text-[12.5px] text-ink-3 line-clamp-2 mb-0.5" data-testid="pipeline-counts">
          {stageCounts.map(([stage, n], i) => (
            <span key={stage}>
              {i > 0 && ' · '}
              <span className="tabular text-ink-2 font-medium">{n}</span> {stageText(stage)?.toLowerCase()}
            </span>
          ))}
        </p>
      )}
      <div className="divide-y divide-line-2">
        {fold.shown.map(({ person, stage, stageLabel, nextStep, quiet: q, youWroteOn }) => (
          <PersonRow
            key={person.id}
            person={person}
            sub={
              nextStep ? `Next: ${nextStep}` : q && youWroteOn ? `No reply since ${youWroteOn}` : undefined
            }
            aside={
              stage || stageLabel ? (
                <Chip tone={q ? 'warn' : 'neutral'}>{stageText(stage, stageLabel)}</Chip>
              ) : undefined
            }
          />
        ))}
      </div>
      {fold.more}
      <NextSteps steps={steps} send={actions.send} />
    </GlassCard>
  );
}

// ---------- routes ----------

/** The intro chain a route or a warm intro is: "Maya Chen > Daniel Okafor", for matching one with the other. */
const chainKey = (names: string[]) =>
  names
    .filter((n) => n.toLowerCase() !== 'you')
    .map((n) => n.toLowerCase())
    .join('>');

function RouteMeter({ score }: { score: number }) {
  return (
    <span
      className="mt-[7px] shrink-0 w-8 h-1 rounded-full bg-line-2 overflow-hidden"
      role="meter"
      aria-valuenow={Math.round(score * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Route strength"
    >
      <span
        className="block h-full bg-accent rounded-full"
        style={{ width: `${Math.max(10, Math.round(score * 100))}%` }}
      />
    </span>
  );
}

function RoutesCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const { to, routes, stories, warmIntros } = readRoutes(env.data);
  const candidates = readPeople(env.data);
  const sorted = [...routes].sort((a, b) => b.score - a.score);
  // a warm intro along the same chain as a route is the same way in: its warmth joins that route's row
  const warmByChain = new Map(warmIntros.map((w) => [chainKey(w.hops), w]));
  const merged = new Set<WarmIntro>();
  const rows = sorted.map((r) => {
    const w = warmByChain.get(chainKey(r.names));
    if (w) merged.add(w);
    return { r, w };
  });
  const rest = warmIntros.filter((w) => !merged.has(w));
  const routeFold = useFold(rows, 3);
  const storyFold = useFold(stories);
  const peopleFold = useFold(candidates);
  // warm intros alone are a result too (Village found paths where Orbit's own graph has none)
  if (!routes.length && !stories.length && !warmIntros.length) {
    if (!candidates.length) return <Summary env={env} />;
    return (
      <GlassCard kind="routes">
        <CardHead title={firstSentence(env.summary)} href={env.href} />
        <div className="divide-y divide-line-2">
          {peopleFold.shown.map(({ person }) => (
            <PersonRow key={person.id} person={person} />
          ))}
        </div>
        {peopleFold.more}
      </GlassCard>
    );
  }
  const steps = cardSteps('find_routes', env);
  return (
    <GlassCard kind="routes">
      <CardHead
        lead={to ? <Avatar name={to.displayName} src={to.photoUrl} id={to.id} size={24} /> : undefined}
        title={to ? `Routes to ${to.displayName}` : firstSentence(env.summary)}
        href={env.href}
      />
      {routes.length > 0 && (
        <>
          <ol className="space-y-1.5 mt-1">
            {routeFold.shown.map(({ r, w }, i) => (
              <RouteRow key={i} r={r} warm={w} />
            ))}
          </ol>
          {routeFold.more}
        </>
      )}
      {stories.length > 0 && (
        <>
          <ul className="space-y-1 mt-1 text-[13px] text-ink-2">
            {storyFold.shown.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {storyFold.more}
        </>
      )}
      {routes.length === 0 && stories.length === 0 && <p className="text-ink-2">{env.summary}</p>}
      <WarmIntros intros={rest} divided={routes.length > 0 || stories.length > 0} />
      <NextSteps steps={steps} send={actions.send} />
    </GlassCard>
  );
}

function RouteRow({ r, warm }: { r: RouteView; warm?: WarmIntro }) {
  const band =
    r.bandLabel ?? (r.band === 'strong' ? 'strong' : r.band === 'possible' ? 'possible' : 'long shot');
  const why = [warm?.note, ...r.text].filter(Boolean).join('. ');
  return (
    <li className="flex items-start gap-2.5 min-w-0" data-testid={warm ? 'warm-intro' : 'route'}>
      <RouteMeter score={r.score} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium truncate">
            You
            {r.hops.map((h, k) => (
              <span key={`${h.id ?? h.name}-${k}`}>
                {' → '}
                <HopName hop={k === 0 && warm?.introducerId ? { ...h, id: warm.introducerId } : h} />
              </span>
            ))}
          </span>
          {warm ? (
            <Chip tone={warm.warmthWord === 'warm' ? 'good' : 'neutral'}>{warm.warmthWord}</Chip>
          ) : (
            <span className="text-[12px] text-ink-3 shrink-0 lowercase">{band}</span>
          )}
        </div>
        {why && (
          <div className="text-[12.5px] text-ink-3 line-clamp-1" title={why}>
            {why}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Routes to several people at once (the people picked on a list): one block per person with the best way in, the
 * number of other routes, and the step to take, so nobody has to be asked about one at a time.
 */
function RoutesManyCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const entries = readRoutesMany(env.data);
  if (!entries.length) return <Summary env={env} />;
  return (
    <GlassCard kind="routes_many">
      <CardHead title={`Routes to ${entries.length} people`} href={env.href} />
      <ol className="divide-y divide-line-2" data-testid="routes-many">
        {entries.map(({ to, routes, warmIntros }) => {
          const { rows, rest } = rowsFrom(routes, warmIntros);
          const best = rows[0];
          const intro = best && best.r.names.length > 1 ? best.r.names[0] : undefined;
          const steps = [
            intro && to ? askForIntro(intro, to.displayName) : undefined,
            to ? writeTo(to.displayName) : undefined,
          ].filter((s): s is NextStep => !!s);
          return (
            <li key={to!.id} className="py-2 first:pt-0 last:pb-0" data-testid="routes-many-person">
              <div className="flex items-center gap-2 min-w-0">
                <Avatar name={to!.displayName} src={to!.photoUrl} id={to!.id} size={22} />
                <Link to={`/people/${to!.id}`} className="font-medium hover:underline truncate">
                  {to!.displayName}
                </Link>
                {to!.linkedinUrl && <LinkedInMark url={to!.linkedinUrl} name={to!.displayName} />}
                {to!.currentOrganizationRaw && (
                  <span className="text-[12.5px] text-ink-3 truncate">· {to!.currentOrganizationRaw}</span>
                )}
              </div>
              {best ? (
                <ol className="mt-1">
                  <RouteRow r={best.r} warm={best.w} />
                </ol>
              ) : rest[0] ? (
                <ul className="mt-1">
                  <WarmIntroRow w={rest[0]} />
                </ul>
              ) : (
                <p className="mt-1 text-[12.5px] text-ink-3">
                  No route through people you know yet. A short, specific note of your own is the way in.
                </p>
              )}
              {rows.length + rest.length > 1 && (
                <p className="text-[12px] text-ink-3 mt-0.5">
                  {rows.length + rest.length - 1} more {rows.length + rest.length - 1 === 1 ? 'way' : 'ways'}{' '}
                  in on the map
                </p>
              )}
              <NextSteps steps={steps} send={actions.send} />
            </li>
          );
        })}
      </ol>
    </GlassCard>
  );
}

/** A name on a route: it opens their LinkedIn profile when Orbit has it, else their page in Orbit. */
function HopName({ hop }: { hop: { id?: string; name: string; linkedinUrl?: string } }) {
  if (hop.linkedinUrl)
    return (
      <a
        href={hop.linkedinUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="hover:underline"
        title={`${hop.name} on LinkedIn`}
        data-testid="route-hop-linkedin"
      >
        {hop.name}
      </a>
    );
  if (hop.id)
    return (
      <Link to={`/people/${hop.id}`} className="hover:underline" data-testid="route-hop-person">
        {hop.name}
      </Link>
    );
  return <>{hop.name}</>;
}

/** One warm intro path from Village: who introduces, how warm in a word, and the hops. */
function WarmIntroRow({ w }: { w: WarmIntro }) {
  return (
    <li className="min-w-0" data-testid="warm-intro">
      <div className="flex items-center gap-1.5 min-w-0">
        {w.introducerId ? (
          <Link to={`/people/${w.introducerId}`} className="font-medium hover:underline truncate">
            {w.introducer}
          </Link>
        ) : (
          <span className="font-medium truncate">{w.introducer}</span>
        )}
        <Chip tone={w.warmthWord === 'warm' ? 'good' : w.warmthWord === 'good' ? 'accent' : 'neutral'}>
          {w.warmthWord}
        </Chip>
      </div>
      <div className="text-[12.5px] text-ink-3 line-clamp-1">
        {w.hops.length > 1 ? w.hops.join(' → ') : null}
        {w.hops.length > 1 && w.note ? '. ' : ''}
        {w.note}
      </div>
    </li>
  );
}

/**
 * Village's warm intro paths, folded after three. `after` rows (a company's routes through someone the student knows
 * that no warm intro covers) follow under the same title, so two lists never name the same way in twice.
 */
function WarmIntros({
  intros,
  divided,
  after = [],
  title = 'Warm intros',
}: {
  intros: WarmIntro[];
  divided?: boolean;
  after?: { key: string; node: ReactNode }[];
  title?: string;
}) {
  const rows = [
    ...intros.map((w) => ({ key: `${w.introducer}:${w.hops.join('>')}`, node: <WarmIntroRow w={w} /> })),
    ...after,
  ];
  const fold = useFold(rows, 3);
  if (!rows.length) return null;
  return (
    <div className={cx(divided ? 'mt-2.5 pt-2 border-t border-line-2' : 'mt-1')} data-testid="warm-intros">
      <div className="text-[11.5px] font-medium text-ink-3 mb-1">{title}</div>
      <ul className="space-y-1.5">
        {fold.shown.map((r) => (
          <Frag key={r.key}>{r.node}</Frag>
        ))}
      </ul>
      {fold.more}
    </div>
  );
}

// ---------- brief ----------

/** A brief row's button: what opening the card does. */
function openLabel(s: Suggestion): string {
  if (s.outboundMessageId) return 'Review';
  if (s.kind === 'prep_brief') return 'Prep';
  if (s.kind.startsWith('confirm_')) return 'Answer';
  return 'Open';
}

function BriefRow({ s, open, onToggle }: { s: Suggestion; open: boolean; onToggle: () => void }) {
  const person = useLiveQuery(() => (s.personId ? db.people.get(s.personId) : undefined), [s.personId]);
  const meta = KIND_LABEL[s.kind];
  return (
    <li data-testid={`suggestion-${s.kind}`} className="min-w-0">
      <div className="flex items-center gap-2.5 py-1.5 min-w-0">
        {person ? (
          <Link to={`/people/${person.id}`} className="shrink-0" tabIndex={-1} aria-hidden>
            <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={28} />
          </Link>
        ) : (
          <span className="w-7 h-7 rounded-full bg-accent-soft shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5 min-w-0">
            {person && (
              <Link to={`/people/${person.id}`} className="font-medium hover:underline truncate">
                {person.displayName}
              </Link>
            )}
            {meta && <Chip tone={meta.tone}>{meta.label}</Chip>}
          </div>
          <div className="text-[12.5px] text-ink-3 truncate mt-0.5" title={s.reasonText}>
            {s.reasonText}
          </div>
        </div>
        <Button
          size="sm"
          variant={open ? 'ghost' : 'secondary'}
          className="!h-7 !px-2.5 !text-[12.5px]"
          aria-expanded={open}
          onClick={onToggle}
          data-testid="brief-open"
        >
          {open ? 'Close' : openLabel(s)}
        </Button>
      </div>
      {open && (
        <div className="pb-2">
          <SuggestionCard s={s} defaultOpen />
        </div>
      )}
    </li>
  );
}

/** The day's cards as one compact list, read live from the database; a row opens the full card in place. */
function BriefCard({ env }: { env: ResultEnvelope }) {
  const { suggestions, ids, summary } = readSuggestions(env.data);
  const live = useLiveQuery(
    async () => (ids.length ? (await db.suggestions.bulkGet(ids)).filter((x): x is Suggestion => !!x) : []),
    [ids.join(',')],
  );
  const [openId, setOpenId] = useState<string>();
  const pending = [...suggestions, ...(live ?? [])].filter((x) => x.status === 'pending');
  const shown = pending.slice(0, 3);
  if (!shown.length) return <Summary env={env} />;
  const rest = pending.length - shown.length;
  const { nextUp, waiting, week } = readBriefExtras(env.data);
  return (
    <GlassCard kind="brief">
      <CardHead
        title={
          <span data-testid="brief-title">
            {firstSentence(summary ?? env.summary).replace(/, most urgent first$/, '')}
          </span>
        }
        aside={
          rest > 0 ? (
            <Link
              to="/inbox"
              className="inline-flex items-center gap-0.5 h-7 px-2 -mr-1.5 rounded-full text-[12.5px] font-medium text-ink-3 hover:text-ink hover:bg-canvas-2 shrink-0"
              data-testid="brief-more"
            >
              {rest} more in Drafts
              <ArrowUpRight size={13} aria-hidden />
            </Link>
          ) : (
            <OpenInApp href={env.href} className="shrink-0 -mr-1.5" />
          )
        }
      />
      <ul className="divide-y divide-line-2">
        {shown.map((x) => (
          <BriefRow
            key={x.id}
            s={x}
            open={openId === x.id}
            onToggle={() => setOpenId((v) => (v === x.id ? undefined : x.id))}
          />
        ))}
      </ul>
      {(nextUp || waiting > 0 || week) && (
        <p className="mt-1.5 text-[12.5px] text-ink-3" data-testid="brief-extras">
          {nextUp && (
            <span data-testid="brief-coming-up">
              Coming up: <span className="text-ink-2">{nextUp.person ?? nextUp.title ?? 'A chat'}</span>,{' '}
              {new Date(nextUp.startAt).toLocaleString('en-US', {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          )}
          {waiting > 0 && (
            <span data-testid="brief-waiting">
              {nextUp && ' · '}
              {waiting === 1 ? '1 chat' : `${waiting} chats`} waiting on a reply
            </span>
          )}
          {week && (
            <span data-testid="brief-week">
              {(nextUp || waiting > 0) && ' · '}
              {week.sent} of {week.target} first messages this week
              {week.replyRate !== undefined && `, ${week.replyRate}% replied`}
            </span>
          )}
        </p>
      )}
    </GlassCard>
  );
}

/** One card of the day, as the app draws it. */
function OneSuggestion({ env }: { env: ResultEnvelope }) {
  const { suggestions, ids } = readSuggestions(env.data);
  const live = useLiveQuery(
    async () => (ids.length ? (await db.suggestions.bulkGet(ids)).filter((x): x is Suggestion => !!x) : []),
    [ids.join(',')],
  );
  const open = [...suggestions, ...(live ?? [])].filter((x) => x.status === 'pending');
  if (!open[0]) return <Summary env={env} />;
  return (
    <div className="my-2" data-testid="result-suggestion">
      <SuggestionCard s={open[0]} compact />
    </div>
  );
}

// ---------- notes and facts ----------

function NoteCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const n = readNote(env.data);
  const listFold = useFold(n.notes, 3);
  const candFold = useFold(n.candidates);
  const factFold = useFold(n.facts, 4);
  if (n.notes.length)
    return (
      <GlassCard kind="note">
        <CardHead title={firstSentence(env.summary)} href={env.href} hrefText="Notes" />
        <ul className="divide-y divide-line-2">
          {listFold.shown.map((x, i) => (
            <li key={i} className="py-1.5 min-w-0">
              <div className="text-[12px] text-ink-3 truncate">
                {[x.when, x.people.join(', ')].filter(Boolean).join(' · ')}
              </div>
              {x.summary && <div className="text-[13px] line-clamp-2">{x.summary}</div>}
            </li>
          ))}
        </ul>
        {listFold.more}
      </GlassCard>
    );
  if (n.candidates.length)
    return (
      <GlassCard kind="note">
        <CardHead title="Who was this with?" sub={env.summary} href={env.href} />
        <div className="divide-y divide-line-2">
          {candFold.shown.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
        </div>
        {candFold.more}
      </GlassCard>
    );
  const steps = cardSteps('add_note', env);
  return (
    <GlassCard kind="note">
      <CardHead
        lead={
          n.person ? (
            <Avatar name={n.person.displayName} src={n.person.photoUrl} id={n.person.id} size={24} />
          ) : undefined
        }
        title={n.person ? `Note on ${n.person.displayName}` : 'Note saved'}
        chip={n.when ? <span className="text-[12.5px] text-ink-3 shrink-0">{n.when}</span> : undefined}
        href={env.href}
      />
      {n.unmatched && (
        <p className="text-[12.5px] text-warn mb-1">Saved, but Orbit is not sure who this was with.</p>
      )}
      <p className="text-[13px] text-ink-2 line-clamp-3 whitespace-pre-line">
        {n.summary ?? n.note?.rawText ?? env.summary}
      </p>
      {n.facts.length > 0 && (
        <>
          <ul className="mt-1.5 text-[13px] space-y-0.5">
            {factFold.shown.map((f) => (
              <li key={f} className="flex gap-1.5">
                <Check size={13} className="text-good mt-[3px] shrink-0" aria-hidden /> <span>{f}</span>
              </li>
            ))}
          </ul>
          {factFold.more}
        </>
      )}
      {n.promises.length > 0 && (
        <p className="mt-1.5 text-[12.5px] text-ink-3">You promised: {n.promises.join('; ')}</p>
      )}
      <NextSteps steps={steps} send={actions.send} />
    </GlassCard>
  );
}

function FactsCard({ env }: { env: ResultEnvelope }) {
  const { person, facts } = readFacts(env.data);
  const fold = useFold(facts);
  if (!facts.length) return <Summary env={env} />;
  return (
    <GlassCard kind="facts">
      <CardHead
        title={person ? `What you know about ${person.firstName}` : 'What you know'}
        href={env.href}
      />
      <ul className="space-y-1">
        {fold.shown.map((f, i) => (
          <li key={i} className="flex items-start gap-2 min-w-0">
            {f.type && (
              <Chip tone="neutral" className="capitalize mt-px">
                {f.type.replace(/_/g, ' ')}
              </Chip>
            )}
            <span className="min-w-0 text-[13px]">{f.text}</span>
          </li>
        ))}
      </ul>
      {fold.more}
    </GlassCard>
  );
}

// ---------- company ----------

function CompanyCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const { name, industry, people, former, saved, target, via } = readCompany(env.data);
  const warm = readWarmIntros(env.data);
  const fold = useFold(people);
  if (!name) return <Summary env={env} />;
  // a route through someone the student knows and a warm intro along the same chain are one way in, said once: the
  // warm intro (it has the warmth and why) stays, and only the routes it does not cover are listed after it
  const viaRows = via
    .filter((v) => {
      const key = chainKey([v.through, v.target.displayName]);
      return !warm.some((x) => chainKey(x.hops).startsWith(key));
    })
    .map((v) => ({
      key: `via:${v.target.id}`,
      node: (
        <li className="min-w-0 truncate" data-testid="company-via">
          <Link to={`/people/${v.target.id}`} className="font-medium hover:underline">
            {v.target.displayName}
          </Link>
          <span className="text-ink-3"> via {v.through}</span>
        </li>
      ),
    }));
  const counts = [
    people.length ? `${people.length} you know there` : saved.length ? 'nobody you know there yet' : '',
    saved.length ? `${saved.length} saved to contact` : '',
    former.length ? `${former.length} used to be` : '',
    via.length ? `${via.length} through someone you know` : '',
  ].filter(Boolean);
  const steps = cardSteps('find_routes', env);
  return (
    <GlassCard kind="company">
      <CardHead
        lead={<CompanyLogo name={name} size={24} decorative />}
        title={name}
        chip={
          target ? (
            <Chip tone="accent">Target</Chip>
          ) : industry ? (
            <Chip tone="neutral">{industry}</Chip>
          ) : undefined
        }
        sub={counts.join(' · ') || undefined}
        href={env.href}
      />
      {people.length > 0 ? (
        <>
          <div>
            {fold.shown.map((p) => (
              <PersonRow key={p.id} person={p} sub={p.currentTitle} dense />
            ))}
          </div>
          {fold.more}
        </>
      ) : saved.length === 0 ? (
        <p className="text-ink-2">{env.summary}</p>
      ) : null}
      {saved.length > 0 && (
        <div
          className={people.length ? 'mt-2 pt-2 border-t border-line-2' : undefined}
          data-testid="company-saved"
        >
          <div className="text-[12px] text-ink-3 mb-0.5">
            Saved to contact · not someone you know yet, so routes go through others
          </div>
          {saved.map((p) => (
            <PersonRow key={p.id} person={p} sub={p.currentTitle} dense />
          ))}
        </div>
      )}
      {former.length > 0 && (
        <p className="mt-1.5 text-[12.5px] text-ink-3 line-clamp-2">
          Used to work there: {former.map((p) => p.displayName).join(', ')}
        </p>
      )}
      <WarmIntros
        intros={warm}
        after={viaRows}
        title={viaRows.length ? 'Warmer ways in' : 'Warm intros'}
        divided
      />
      <NextSteps steps={steps} send={actions.send} />
    </GlassCard>
  );
}

// ---------- settings, import, prep, list ----------

function SettingsCard({ env }: { env: ResultEnvelope }) {
  const changes = readSettings(env.data);
  const fold = useFold(changes, 8);
  if (!changes.length) return <Summary env={env} />;
  return (
    <GlassCard kind="settings">
      <CardHead title={firstSentence(env.summary)} href={env.href} />
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-[13px]">
        {fold.shown.map((c) => (
          <div key={c.label} className="flex items-baseline gap-2 min-w-0">
            <dt className="text-ink-3 shrink-0">{c.label}</dt>
            <dd className="font-medium min-w-0 truncate" title={c.to}>
              {c.from !== undefined && <span className="text-ink-3 line-through mr-1.5">{c.from}</span>}
              {c.to}
            </dd>
          </div>
        ))}
      </dl>
      {fold.more}
    </GlassCard>
  );
}

function ImportCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const { source, counts, lines } = readImport(env.data);
  const fold = useFold(lines);
  const steps = cardSteps('import_linkedin', env);
  return (
    <GlassCard kind="import">
      <CardHead
        title={source ? `Imported from ${source}` : 'Imported'}
        sub={counts.length ? firstSentence(env.summary) : undefined}
        href={env.href}
      />
      {counts.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {counts.map((c) => (
            <div key={c.label} className="flex items-baseline gap-1.5 min-w-0">
              <span className="text-[16px] font-semibold tabular leading-tight">{c.value}</span>
              <span className="text-[12.5px] text-ink-3">{c.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-ink-2">{env.summary}</p>
      )}
      {lines.length > 0 && (
        <>
          <ul className="mt-1.5 text-[13px] text-ink-2 list-disc pl-4 space-y-0.5 marker:text-ink-3">
            {fold.shown.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {fold.more}
        </>
      )}
      <NextSteps steps={steps} send={actions.send} />
    </GlassCard>
  );
}

function PrepCard({ env }: { env: ResultEnvelope }) {
  const { person, when, summary, questions, facts } = readPrep(env.data);
  if (!person && !summary && !questions.length) return <Summary env={env} />;
  return (
    <GlassCard kind="prep">
      <CardHead
        lead={person ? <Avatar name={person.displayName} id={person.id} size={24} /> : undefined}
        title={person ? `Prep for ${person.displayName}` : 'Prep'}
        chip={
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
        href={env.href}
      />
      {summary && <p className="text-[13px] text-ink-2">{summary}</p>}
      {facts.length > 0 && (
        <ul className="mt-1.5 text-[13px] text-ink-2 list-disc pl-4 space-y-0.5 marker:text-ink-3">
          {facts.slice(0, 4).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {questions.length > 0 && (
        <Section title="Questions to ask">
          <ol className="text-[13px] list-decimal pl-5 space-y-0.5 marker:text-ink-3">
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </Section>
      )}
    </GlassCard>
  );
}

function ListCard({ env, block, actions }: { env: ResultEnvelope; block: ToolBlock; actions: CardActions }) {
  const { title, items } = readList(env.data);
  const fold = useFold(items, 6);
  const picked = usePicked();
  if (!items.length) return <Summary env={env} />;
  const heading = title ?? firstSentence(env.summary);
  const steps = cardSteps(block.toolName, env);
  // rows that stand for people found in a search can be picked: added to People, with routes or a draft to each
  const pickable = items.filter((it) => !!it.id);
  const chosen = pickable.filter((it) => picked.has(it.id!));
  const rows: Picked[] = chosen.map((it) => ({ name: it.text, rec: it.known ? undefined : it.id }));
  const pickedSteps = [addPicked(rows, 'routes'), addPicked(rows), addPicked(rows, 'drafts')].filter(
    (s): s is NextStep => !!s,
  );
  return (
    <GlassCard kind="list">
      <CardHead title={heading} href={env.href} />
      <ul className="divide-y divide-line-2" data-testid="list-rows">
        {fold.shown.map((it, i) => (
          <li
            key={i}
            className={cx('flex min-w-0 gap-2.5', it.avatar ? 'items-center py-1.5' : 'items-start py-1')}
          >
            {it.id && (
              <PickBox
                checked={picked.has(it.id)}
                onChange={(on) => picked.set(it.id!, on)}
                label={it.text}
              />
            )}
            {it.avatar ? (
              <Avatar name={it.avatar.name} src={it.avatar.src} id={`${it.avatar.name}-${i}`} size={28} />
            ) : (
              it.chip && (
                <Chip tone="neutral" className="mt-px">
                  {it.chip}
                </Chip>
              )
            )}
            <div className="min-w-0 flex-1 text-[13px] leading-snug">
              <div className="flex min-w-0 items-center gap-1.5">
                {it.href ? (
                  <Link to={it.href} className="truncate font-medium hover:underline">
                    {it.text}
                  </Link>
                ) : (
                  <span className={cx(it.avatar ? 'truncate font-medium' : 'min-w-0')}>{it.text}</span>
                )}
                {it.links.map((l) =>
                  /linkedin\.com/i.test(l.url) ? (
                    // a LinkedIn profile: its small blue mark beside the name, not a word in the line
                    <LinkedInMark key={l.url} url={l.url} name={it.text} testId="list-linkedin" />
                  ) : (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-ink-3 hover:text-ink"
                    >
                      {l.label}
                      <ArrowUpRight size={11} />
                    </a>
                  ),
                )}
              </div>
              {it.sub && <div className="line-clamp-1 text-[12.5px] text-ink-3">{it.sub}</div>}
            </div>
            {it.avatar && it.chip && <span className="label-mono shrink-0 !text-[10px]">{it.chip}</span>}
          </li>
        ))}
      </ul>
      {fold.more}
      {pickable.length > 1 && (
        <SelectionBar
          count={chosen.length}
          total={fold.shown.filter((it) => !!it.id).length}
          onAll={() => picked.setAll(fold.shown.filter((it) => !!it.id).map((it) => it.id!))}
          onClear={picked.clear}
          steps={pickedSteps}
          send={actions.send}
        />
      )}
      {!chosen.length && <NextSteps steps={steps} send={actions.send} />}
    </GlassCard>
  );
}

// ---------- text ----------

/** A plain answer, with the words to copy or the file to save when the result carries one. */
function TextResult({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const { quote, file, warmUpFor, wait } = readText(env.data);
  const [copied, setCopied] = useState(false);
  // create_draft asks first: these say it to the student, in place of the sentence written for the model
  if (warmUpFor)
    return (
      <GlassCard kind="text">
        <CardHead
          lead={<Avatar name={warmUpFor.displayName} id={warmUpFor.id} size={24} />}
          title={warmUpFor.displayName}
          chip={<Chip tone="neutral">LinkedIn only</Chip>}
          href={env.href}
        />
        <p className="text-[13px] text-ink-2">
          You have not talked yet. Cold notes get far more replies once your name is familiar, so Orbit
          suggests a short warm-up first: a few LinkedIn steps over a few days, then the message.
        </p>
        <NextSteps steps={cardSteps('create_draft', env)} send={actions.send} />
      </GlassCard>
    );
  if (wait)
    return (
      <GlassCard kind="text">
        <CardHead
          lead={<Avatar name={wait.person.displayName} id={wait.person.id} size={24} />}
          title={wait.person.displayName}
          chip={wait.until ? <Chip tone="neutral">From {wait.until}</Chip> : undefined}
          href={env.href}
        />
        <p className="text-[13px] text-ink-2">
          {env.summary.replace(/\s*Pass a kind to write anyway\.?$/, '')}
        </p>
        <NextSteps steps={cardSteps('create_draft', env)} send={actions.send} />
      </GlassCard>
    );
  if (!quote && !file && !env.href) return <Markdown text={env.summary} className="my-2" />;
  return (
    <GlassCard kind="text">
      <div className="flex items-start gap-2">
        <Markdown text={env.summary} className="flex-1 min-w-0 text-[13.5px]" />
        <OpenInApp href={env.href} className="shrink-0 -mr-1.5 -my-0.5" />
      </div>
      {quote && (
        <div className="mt-1.5">
          <blockquote className="whitespace-pre-line rounded-[10px] bg-canvas-2 px-3 py-2 text-[13px]">
            {quote}
          </blockquote>
          <Button
            size="sm"
            className="mt-1.5"
            onClick={async () => setCopied(await copyText(quote))}
            data-testid="text-copy"
          >
            <Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy text'}
          </Button>
        </div>
      )}
      {file && (
        <Button
          size="sm"
          className="mt-1.5"
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
          <Download size={13} aria-hidden /> Save {file.name}
        </Button>
      )}
    </GlassCard>
  );
}

// ---------- approval ----------

/**
 * The approval sentence as a title and a line: "Send the thank-you to Lena Novak" over "opened in your mail app ...".
 * The first line of the message is left out: the message itself is right below.
 */
function splitIntent(text: string): { title: string; how?: string } {
  const at = text.indexOf(': ');
  if (at < 0) return { title: text };
  const how = text
    .slice(at + 2)
    .replace(/\.?\s*It starts: ".*$/s, '')
    .trim();
  return { title: text.slice(0, at), how: how ? how.charAt(0).toUpperCase() + how.slice(1) : undefined };
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
  const owners = useContext(DraftOwnersContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const text = c.text ?? env.summary;
  if (block.status === 'approved' && block.outcome)
    return <Outcome env={block.outcome} block={block} actions={actions} />;
  const decided = block.status === 'cancelled' || block.status === 'approved';
  const owner = draft ? owners.get(draft.id) : undefined;
  const editable = !!draft && OPEN_DRAFT.has(draft.status) && (!owner || owner === block.toolUseId);
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
  const cancel = (
    <Button
      size="sm"
      variant={editable ? 'ghost' : 'secondary'}
      disabled={busy}
      onClick={() => actions.cancel(block.toolUseId)}
      data-testid="confirm-cancel"
    >
      Cancel
    </Button>
  );
  const { title, how } = editable ? splitIntent(text) : { title: text, how: undefined };
  return (
    <GlassCard kind="needs_confirmation" tone={c.blockedReason ? 'warn' : undefined}>
      <div className="flex items-start gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={c.blockedReason ? 'warn' : 'accent'}>Needs your approval</Chip>
            {env.continues && <span className="text-[12px] text-ink-3">then Orbit carries on</span>}
          </div>
          <p
            className={cx('mt-1 font-medium', editable ? 'line-clamp-1' : 'line-clamp-3')}
            title={text}
            data-testid="confirm-text"
          >
            {title}
          </p>
          {how && (
            <p className="text-[12.5px] text-ink-3 line-clamp-1" title={how}>
              {how}
            </p>
          )}
          {c.blockedReason && (
            <p
              className="mt-1 text-[12.5px] text-warn flex items-start gap-1.5"
              data-testid="confirm-blocked"
            >
              <TriangleAlert size={13} className="shrink-0 mt-0.5" aria-hidden /> {c.blockedReason}
            </p>
          )}
        </div>
      </div>
      {editable && !decided && (
        <div className="mt-2">
          <DraftEditor
            draft={draft}
            compact
            busy={busy || !!c.blockedReason}
            approveLabel="Approve & send"
            onApprove={(body, subject) => approve({ body, subject })}
            extraActions={cancel}
          />
        </div>
      )}
      {decided ? (
        <p className="mt-1.5 text-[12.5px] text-ink-3" data-testid="confirm-decided">
          {block.status === 'cancelled' ? 'Cancelled. Nothing was changed.' : 'Approved.'}
        </p>
      ) : (
        (!editable || error) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
            {!editable && cancel}
            {error && <span className="text-[12.5px] text-bad">{error}</span>}
          </div>
        )
      )}
    </GlassCard>
  );
}
