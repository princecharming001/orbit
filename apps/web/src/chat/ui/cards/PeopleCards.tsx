/**
 * The other lists of people a chat answer can show, in the network search card's look (people.tsx): people found
 * outside the network (find_people, on the web or LinkedIn) with their email and how sure Orbit is of it, and
 * people the student already has (search_people and the like).
 */
import type { Person } from '@orbit/core';
import { Link } from 'react-router-dom';
import { PersonCompanyLogo } from '../../../components/CompanyLogo';
import { Avatar, cx } from '../../../ui';
import type { ResultEnvelope } from '../../types';
import type { ToolBlock } from '../threadStore';
import { addPicked, type Picked, routesToEach, writeToEach } from './next';
import { type NextStep, OpenInApp } from './parts';
import {
  BatchTag,
  Dot,
  EmailLine,
  NameTag,
  PeopleFooter,
  PeopleShell,
  PersonLine,
  splitBatch,
  usePickSet,
  useRowFold,
} from './people';
import { type ListRow, readPeople, readPeopleQuery } from './shapes';
import { cardSteps } from './steps';

type CardActions = { send: (text: string) => Promise<void> | void };

/** "3 people match "Dan". Check which one ..." -> "3 people match "Dan"". */
export function firstSentence(s: string): string {
  const m = s.match(/^.*?[.?!](?=\s|$)/);
  return (m ? m[0] : s).replace(/\.$/, '');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every row of a list card is a person found in a search: draw it as people, not as a plain list. */
export const isPeopleList = (items: ListRow[]) => items.length > 0 && items.every((it) => !!it.person);

/** The role line: words, with a YC batch as its own tag. */
function Role({ text }: { text?: string }) {
  const { text: words, batch } = splitBatch(text);
  return (
    <>
      {batch && <BatchTag batch={batch} />}
      {words && <span className="truncate">{words}</span>}
    </>
  );
}

/** People found outside the network: who, how warm, their email and how sure, and why they fit. */
export function FoundPeopleCard({
  env,
  block,
  items,
  actions,
}: {
  env: ResultEnvelope;
  block: ToolBlock;
  items: ListRow[];
  /** the tool's own title ("People for advice"): no longer shown, the card says "outside your network" */
  title?: string;
  actions: CardActions;
}) {
  const picked = usePickSet();
  const fold = useRowFold(items);
  const pickable = items.filter((it) => !!it.id);
  const canPick = pickable.length > 1;
  const chosen = pickable.filter((it) => picked.has(it.id!));
  // someone found in a search goes by name alone; the id finds them for add_sourced
  const rows: Picked[] = chosen.map((it) =>
    it.known ? { name: it.person!.name } : { name: it.person!.name, rec: it.id },
  );
  const pickedSteps = [addPicked(rows, 'routes'), addPicked(rows), addPicked(rows, 'drafts')].filter(
    (s): s is NextStep => !!s,
  );
  return (
    <PeopleShell
      testId="result-list"
      // one line that tells this card from the network's own: who they are, nothing more
      title={
        <>
          {plural(items.length, 'person', 'people')}
          <span className="font-normal text-ink-3">: outside your network</span>
        </>
      }
      aside={<OpenInApp href={env.href} className="shrink-0 -mr-1.5" />}
    >
      <ul className="px-1.5 pb-1.5" data-testid="list-rows">
        {fold.shown.map((it, i) => {
          const p = it.person!;
          const close = (p.tier ?? 9) <= 2 || !!it.known;
          const to = it.known ? `/map?reach=${encodeURIComponent(it.known)}` : undefined;
          const out = to ? undefined : (p.url ?? p.linkedinUrl);
          const outLabel = p.url ? 'Open page' : 'LinkedIn';
          return (
            <li key={it.id ?? i} className="list-none">
              <PersonLine
                name={p.name}
                avatar={{ id: it.id ?? `${p.name}-${i}`, src: p.photo }}
                linkedinUrl={p.linkedinUrl}
                tag={it.chip && <NameTag tone={close ? 'good' : 'quiet'}>{it.chip}</NameTag>}
                line={<Role text={p.role} />}
                extra={
                  p.email ? (
                    <>
                      <EmailLine email={p.email} sureness={p.emailConfidence} />
                      {p.why && (
                        <span className="hidden min-w-0 items-center @md:inline-flex">
                          <Dot />
                          <span className="truncate">{p.why}</span>
                        </span>
                      )}
                    </>
                  ) : (
                    p.why && <span className="truncate">{p.why}</span>
                  )
                }
                to={to}
                href={out}
                goLabel={to ? 'Warm path' : out ? outLabel : undefined}
                linkLabel={
                  to
                    ? `Warm path to ${p.name}`
                    : p.url
                      ? `The page ${p.name} was found on`
                      : `${p.name} on LinkedIn`
                }
                pick={
                  canPick && it.id
                    ? {
                        picking: picked.size > 0,
                        picked: picked.has(it.id),
                        onPick: (on) => picked.set(it.id!, on),
                      }
                    : undefined
                }
                testId="found-person"
                data={{ sureness: p.email ? (p.emailConfidence ?? 'page') : undefined }}
              />
            </li>
          );
        })}
      </ul>
      <PeopleFooter
        fold={fold}
        total={items.length}
        picked={chosen.length}
        onClear={picked.clear}
        pickedSteps={pickedSteps}
        steps={cardSteps(block.toolName, env)}
        send={actions.send}
      />
    </PeopleShell>
  );
}

/** People the student already has: each row opens their page; picked ones get routes or a draft together. */
export function KnownPeopleCard({ env, actions }: { env: ResultEnvelope; actions: CardActions }) {
  const people = readPeople(env.data);
  const { query, nameQuery } = readPeopleQuery(env.data);
  const picked = usePickSet();
  const fold = useRowFold(people);
  const canPick = people.length > 1;
  const names = people.filter((p) => picked.has(p.person.id)).map((p) => p.person.displayName);
  const pickedSteps = [routesToEach(names), writeToEach(names)].filter((s): s is NextStep => !!s);
  const title =
    query && nameQuery && people.length > 1
      ? `Which "${query}"?`
      : firstSentence(env.summary).replace(/, including .*$/, '');
  return (
    <PeopleShell
      testId="result-people"
      title={title}
      aside={<OpenInApp href={env.href} className="shrink-0 -mr-1.5" />}
    >
      {/* two columns of cards (one on a narrow chat): who, where, how close, and one thing to do */}
      <ul className="grid grid-cols-1 @md:grid-cols-2 border-t border-line-2" data-testid="known-people-grid">
        {fold.shown.map(({ person, why, stage }) => (
          <PersonTile
            key={person.id}
            person={person}
            line={why}
            tag={stage}
            pick={
              canPick
                ? {
                    picking: picked.size > 0,
                    picked: picked.has(person.id),
                    onPick: (on) => picked.set(person.id, on),
                  }
                : undefined
            }
            onWrite={() => void actions.send(`Write to ${person.displayName}`)}
          />
        ))}
      </ul>
      <PeopleFooter
        fold={fold}
        total={people.length}
        picked={names.length}
        onClear={picked.clear}
        pickedSteps={pickedSteps}
        steps={cardSteps('search_people', env)}
        send={actions.send}
      />
    </PeopleShell>
  );
}

/** How close the student is to someone, 0 to 100: the tie score, else the strength. */
export function closenessOf(p: Pick<Person, 'tieScore' | 'strength'>): number {
  return Math.round(p.tieScore ?? (p.strength ?? 0) * 100);
}

/** The word on the tile's corner: the stage, an alum, or how close. */
function tileTag(p: Person, stage?: string): { text: string; tone: 'good' | 'warn' | 'accent' | 'quiet' } {
  if (stage) return { text: stage, tone: 'accent' };
  const c = closenessOf(p);
  if (c >= 60) return { text: 'Strong', tone: 'good' };
  if (p.isAlumni) return { text: 'Alum', tone: 'accent' };
  if (c >= 35) return { text: 'Possible', tone: 'warn' };
  return { text: c > 0 ? 'Met once' : 'New', tone: 'quiet' };
}

const TONE = {
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent',
  quiet: 'bg-canvas-2 text-ink-2',
} as const;

/** Signal bars and the number: how close the student is (four bars, filled by quarters). */
export function ClosenessSignal({ value }: { value: number }) {
  const lit = value >= 75 ? 4 : value >= 50 ? 3 : value >= 25 ? 2 : value > 0 ? 1 : 0;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2"
      title={`Closeness ${value} of 100`}
      data-testid="closeness-signal"
    >
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[5, 8, 11, 14].map((h, i) => (
          <span
            key={h}
            className={cx('w-[3px] rounded-[1px]', i < lit ? 'bg-accent' : 'bg-line')}
            style={{ height: h }}
          />
        ))}
      </span>
      <span className="tabular font-medium text-ink">{value}</span>
      <span className="text-ink-3">closeness</span>
    </span>
  );
}

export function PersonTile({
  person,
  line,
  tag,
  pick,
  onWrite,
  href,
}: {
  person: Person;
  line?: string;
  tag?: string;
  /** where the tile opens; their page unless given (the company card opens the Map at the warmest way in) */
  href?: string;
  pick?: { picking: boolean; picked: boolean; onPick: (on: boolean) => void };
  onWrite: () => void;
}) {
  const t = tileTag(person, tag);
  const first = person.firstName || person.displayName.split(' ')[0];
  return (
    <li
      className="group/tile relative list-none border-b border-line-2 p-4 @md:[&:nth-child(odd)]:border-r"
      data-testid="known-person"
    >
      <Link
        to={href ?? `/people/${person.id}`}
        className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={`Open ${person.displayName}`}
      />
      <div className="flex items-start justify-between gap-2">
        <Avatar name={person.displayName} src={person.photoUrl} id={person.id} size={40} />
        <span className="flex items-center gap-2">
          {pick && (
            <input
              type="checkbox"
              className={cx(
                'relative z-10 h-4 w-4 accent-[var(--color-accent)] cursor-pointer transition-opacity',
                pick.picking ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100 focus:opacity-100',
              )}
              checked={pick.picked}
              onChange={(e) => pick.onPick(e.target.checked)}
              aria-label={`Pick ${person.displayName}`}
              data-testid="pick-person"
            />
          )}
          <span className={cx('rounded-full px-2.5 py-0.5 text-[12px] font-medium', TONE[t.tone])}>
            {t.text}
          </span>
        </span>
      </div>
      <div className="mt-3 text-[14.5px] font-medium leading-snug truncate">{person.displayName}</div>
      <div className="text-[13px] text-ink-3 truncate">{line ?? person.currentTitle ?? ''}</div>
      {person.currentOrganizationRaw && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-ink-2 min-w-0">
          <PersonCompanyLogo person={person} size={15} />
          <span className="truncate">{person.currentOrganizationRaw}</span>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <ClosenessSignal value={closenessOf(person)} />
        <button
          type="button"
          className="relative z-10 h-8 px-3 rounded-[6px] border border-line bg-canvas text-[13px] font-medium hover:bg-canvas-2"
          onClick={onWrite}
          data-testid="known-person-write"
        >
          Write to {first}
        </button>
      </div>
    </li>
  );
}
