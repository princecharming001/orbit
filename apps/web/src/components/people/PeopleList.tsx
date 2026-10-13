import type { ChatStage, CoffeeChat, Person, Suggestion } from '@orbit/core';
import { ACTIVE_STAGES, CLOSED_STAGES, RELATIONSHIP_LABELS, STAGE_LABELS } from '@orbit/core';
import { Link, useNavigate } from 'react-router-dom';
import { lastTouch } from '../../engine/search';
import { Avatar, Chip, relDate, Select } from '../../ui';
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
export function PeopleList({
  people,
  chatFor,
  nextFor,
  move,
}: {
  people: Person[];
  chatFor: (personId: string) => CoffeeChat | undefined;
  nextFor: (chatId: string, personId: string) => Suggestion | undefined;
  move: (chat: CoffeeChat, to: ChatStage) => void;
}) {
  const nav = useNavigate();
  return (
    <>
      {/* phones get a list: one person per row, nothing cut mid-word, nothing off to the side */}
      <ul
        className="@5xl:hidden divide-y divide-line border border-line rounded-[var(--radius-card)]"
        data-testid="people-list"
      >
        {people.map((p) => {
          const c = chatFor(p.id);
          return (
            <li key={p.id}>
              <Link to={`/people/${p.id}`} className="flex items-start gap-3 p-3 hover:bg-canvas-2/60">
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
                  <span className="block text-[12.5px] text-ink-2">
                    {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' at ') || '—'}
                  </span>
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
      <div className="hidden @5xl:block border border-line rounded-[var(--radius-card)] overflow-x-auto">
        <table className="w-full text-[13.5px]" data-testid="people-table">
          <thead className="bg-canvas-2 text-ink-3 text-[12px] uppercase tracking-wide">
            <tr>
              {[
                'Name',
                'Title · Company',
                'How you know them',
                'Closeness',
                'Stage',
                'Last touch',
                'Next',
              ].map((h) => (
                <th key={h} className="text-left font-medium px-2.5 py-1.5 leading-tight">
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
                    if (!(e.target as HTMLElement).closest('a,button,select')) nav(`/people/${p.id}`);
                  }}
                >
                  <td className="px-2.5 h-12">
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
                  <td className="px-2.5 text-ink-2 min-w-[150px]">
                    {[p.currentTitle, p.currentOrganizationRaw].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-2.5 text-ink-2">{role(p) ?? '—'}</td>
                  <td className="px-2.5">
                    <StrengthDots v={p.strength} />
                  </td>
                  <td className="px-2.5">
                    {c ? (
                      <Select
                        value={c.stage}
                        onChange={(e) => move(c, e.target.value as ChatStage)}
                        className="h-7 w-[140px] text-[12px]"
                        aria-label={`Stage for ${p.displayName}`}
                        data-testid="list-stage"
                      >
                        {[...ACTIVE_STAGES, ...CLOSED_STAGES].map((s) => (
                          <option key={s} value={s}>
                            {STAGE_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    ) : p.hiddenAt ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <Link
                        to={`/people/${p.id}?draft=outreach`}
                        className="text-[12.5px] text-accent font-medium whitespace-nowrap hover:underline"
                        data-testid="list-start-chat"
                      >
                        Start a chat
                      </Link>
                    )}
                  </td>
                  <td className="px-2.5 text-ink-2 whitespace-nowrap">
                    <LastTouch person={p} chat={c} />
                  </td>
                  <td className="px-2.5">
                    {next ? <NextLink s={next} /> : <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
