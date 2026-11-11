import type { ChatStage, CoffeeChat, Person, Suggestion } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, RELATIONSHIP_LABELS, STAGE_LABELS } from '@orbit/core';
import { Send } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { lastTouch } from '../../engine/search';
import { Avatar, Button, Chip, PickCircle, relDate, Select } from '../../ui';
import { LogoText } from '../CompanyLogo';
import { NextLink } from './PipelineBoard';
import { StrengthDots, wentQuiet } from './shared';

/** The same answer the person page shows under "How you know them". */
const role = (p: Person) =>
  p.relationshipType === 'unknown' ? undefined : RELATIONSHIP_LABELS[p.relationshipType];

/** The newest message either way in a chat, and whose it was; else the last time they dealt with each other at all. */
function LastTouch({ person, chat }: { person: Person; chat?: CoffeeChat }) {
  const sent = chat?.lastOutboundAt;
  const reply = chat?.lastInboundAt;
  if (!sent && !reply) return <>{relDate(lastTouch(person))}</>;
  const theirs = !!reply && (!sent || reply > sent);
  return (
    <>
      {theirs ? `Reply ${relDate(reply)}` : `Sent ${relDate(sent)}`}
      {chat && wentQuiet(chat) && <span className="text-warn"> · quiet</span>}
    </>
  );
}

/**
 * Everyone in the student's orbit, with or without a chat: who they are, how close, and where the chat stands. A
 * chat's stage changes right in the row; someone without a chat has a Start a chat link that opens the first message
 * on their page. Phones get one person per row instead of the table.
 */
export interface Selection {
  selected: Set<string>;
  /** everyone the filter shows (not only this page of rows), for Select all */
  all: string[];
  onChange: (next: Set<string>) => void;
}

/** The sticky bar while people are selected: how many, write to them, clear. */
export function SelectionBar({
  count,
  onWrite,
  onClear,
}: {
  count: number;
  onWrite: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-20 mt-4 flex justify-center pointer-events-none">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-canvas/95 backdrop-blur pl-4 pr-1.5 py-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.1)]"
        data-testid="people-selection-bar"
      >
        <span className="text-[13.5px] font-medium tabular" data-testid="people-selected-count">
          {count} selected
        </span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="primary" onClick={onWrite} data-testid="people-write-selected">
          <Send size={13} aria-hidden /> Write to them
        </Button>
      </div>
    </div>
  );
}

function Check({
  on,
  onToggle,
  label,
  mixed,
  testId,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  mixed?: boolean;
  testId?: string;
}) {
  return (
    <PickCircle
      checked={on}
      mixed={mixed}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      label={label}
      size={18}
      className="pointer-coarse:!h-[22px] pointer-coarse:!w-[22px]"
      testId={testId}
    />
  );
}

export function PeopleList({
  people,
  chatFor,
  nextFor,
  move,
  selection,
}: {
  people: Person[];
  chatFor: (personId: string) => CoffeeChat | undefined;
  nextFor: (chatId: string, personId: string) => Suggestion | undefined;
  move: (chat: CoffeeChat, to: ChatStage) => void;
  /** Select mode (plan 38): a box on every row and one for everyone the filter shows */
  selection?: Selection;
}) {
  const nav = useNavigate();
  const toggle = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };
  const allOn =
    !!selection && selection.all.length > 0 && selection.all.every((id) => selection.selected.has(id));
  const someOn = !!selection && !allOn && selection.selected.size > 0;
  return (
    <>
      {/* phones get a list: one person per row, nothing cut mid-word, nothing off to the side */}
      <ul
        className="@4xl:hidden divide-y divide-line border border-line rounded-[var(--radius-card)]"
        data-testid="people-list"
      >
        {people.map((p) => {
          const c = chatFor(p.id);
          return (
            <li key={p.id} className={selection ? 'flex items-start gap-1 pl-3' : undefined}>
              {selection && (
                <span className="pt-4">
                  <Check
                    on={selection.selected.has(p.id)}
                    onToggle={() => toggle(p.id)}
                    label={`Select ${p.displayName}`}
                  />
                </span>
              )}
              <Link
                to={`/people/${p.id}`}
                className="flex flex-1 min-w-0 items-start gap-3 p-3 hover:bg-canvas-2/60"
                onClick={(e) => {
                  if (selection) {
                    e.preventDefault();
                    toggle(p.id);
                  }
                }}
              >
                <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium">{p.displayName}</span>
                    {p.isAlumni && (
                      <Chip tone="accent" className="h-5">
                        Alum
                      </Chip>
                    )}
                  </span>
                  {p.currentTitle || p.currentOrganizationRaw ? (
                    <LogoText person={p} className="text-[12.5px] text-ink-2" wrap>
                      {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ')}
                    </LogoText>
                  ) : (
                    p.headline && (
                      // no title read yet: their LinkedIn headline says what they do
                      <span className="text-[12.5px] text-ink-2 line-clamp-1" title={p.headline}>
                        {p.headline}
                      </span>
                    )
                  )}
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
                    <span className="inline-flex items-center gap-1">
                      Closeness <StrengthDots v={p.strength} />
                    </span>
                    {role(p) && <span>{role(p)}</span>}
                    {c && <Chip className="h-5">{STAGE_LABELS[c.stage]}</Chip>}
                    {c && wentQuiet(c) && <span className="text-warn">quiet</span>}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hidden @4xl:block border border-line rounded-[var(--radius-card)] overflow-x-auto">
        <table className="w-full text-[13.5px]" data-testid="people-table">
          <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
            <tr>
              {selection && (
                <th className="w-8 pl-3 pr-1 py-1.5">
                  <Check
                    on={allOn}
                    mixed={someOn}
                    onToggle={() => selection.onChange(allOn ? new Set() : new Set(selection.all))}
                    label={allOn ? 'Select nobody' : `Select all ${selection.all.length}`}
                    testId="people-select-all"
                  />
                </th>
              )}
              {[
                'Name',
                'Title · Company',
                'How you know them',
                'Closeness',
                'Stage',
                'Last touch',
                'Next',
              ].map((h) => (
                <th key={h} className="text-left font-medium px-2 py-1.5 leading-tight">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {people.map((p) => {
              const c = chatFor(p.id);
              const next = c ? nextFor(c.id, p.id) : undefined;
              return (
                // the whole row opens the person, like it looks; the name stays the link for keyboard and screen readers
                <tr
                  key={p.id}
                  className="hover:bg-canvas-2/60 cursor-pointer"
                  data-testid="people-row"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button,select,input')) return;
                    if (selection) toggle(p.id);
                    else nav(`/people/${p.id}`);
                  }}
                  data-selected={selection?.selected.has(p.id) || undefined}
                >
                  {selection && (
                    <td className="w-8 pl-3 pr-1">
                      <Check
                        on={selection.selected.has(p.id)}
                        onToggle={() => toggle(p.id)}
                        label={`Select ${p.displayName}`}
                        testId="people-row-select"
                      />
                    </td>
                  )}
                  <td className="px-2 h-12">
                    <Link
                      to={`/people/${p.id}`}
                      className="inline-flex items-center gap-2 font-medium hover:underline whitespace-nowrap"
                    >
                      <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={26} />
                      <span data-testid="person-name">{p.displayName}</span>
                      {p.isAlumni && (
                        <Chip tone="accent" className="h-5">
                          Alum
                        </Chip>
                      )}
                    </Link>
                  </td>
                  <td className="px-2 text-ink-2 min-w-[150px]">
                    {p.currentTitle || p.currentOrganizationRaw ? (
                      <LogoText person={p} wrap>
                        <span className="block leading-snug">
                          {p.currentTitle ?? p.currentOrganizationRaw}
                        </span>
                        {p.currentTitle && p.currentOrganizationRaw && (
                          <span className="block text-[12px] text-ink-3 leading-snug">
                            {p.currentOrganizationRaw}
                          </span>
                        )}
                      </LogoText>
                    ) : p.headline ? (
                      // no title read yet: their LinkedIn headline says what they do
                      <span
                        className="block max-w-[340px] text-[12.5px] leading-snug text-ink-3 line-clamp-2"
                        title={p.headline}
                        data-testid="people-row-headline"
                      >
                        {p.headline}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 text-ink-2">{role(p) ?? ''}</td>
                  <td className="px-2">
                    <StrengthDots v={p.strength} />
                  </td>
                  <td className="px-2">
                    {c ? (
                      <Select
                        value={c.stage}
                        onChange={(e) => move(c, e.target.value as ChatStage)}
                        className="h-7 w-[148px] text-[12px]"
                        aria-label={`Stage for ${p.displayName}`}
                        data-testid="list-stage"
                      >
                        {[...ACTIVE_STAGES, ...CLOSED_STAGES].map((s) => (
                          <option key={s} value={s}>
                            {STAGE_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    ) : p.hiddenAt ? null : (
                      <Link
                        to={`/people/${p.id}?draft=outreach`}
                        className="text-[12.5px] text-accent font-medium whitespace-nowrap hover:underline"
                        data-testid="list-start-chat"
                      >
                        Start a chat
                      </Link>
                    )}
                  </td>
                  <td className="px-2 text-ink-2 min-w-[96px] leading-snug">
                    <LastTouch person={p} chat={c} />
                  </td>
                  <td className="px-2">{next ? <NextLink s={next} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
