/**
 * The other lists of people a chat answer can show, in the network search card's look (people.tsx): people found
 * outside the network (find_people, on the web or LinkedIn) with their email and how sure Orbit is of it, and
 * people the student already has (search_people and the like).
 */
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
  title,
  actions,
}: {
  env: ResultEnvelope;
  block: ToolBlock;
  items: ListRow[];
  title?: string;
  actions: CardActions;
}) {
  const picked = usePickSet();
  const fold = useRowFold(items);
  const withEmail = items.filter((it) => it.person?.email);
  const verified = withEmail.filter((it) => it.person?.emailConfidence === 'verified').length;
  // what the search left out or assumed, said once under the title
  const quiet = env.summary.replace(/^.*?[.?!](\s|$)/, '').trim();
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
  const emails = withEmail.length
    ? `${plural(withEmail.length, 'email', 'emails')}${verified ? `, ${verified} verified` : ''}`
    : undefined;
  return (
    <PeopleShell
      testId="result-list"
      title={plural(items.length, 'person', 'people')}
      sub={
        <>
          {[title, emails].filter(Boolean).join(' · ')}
          {quiet && <span className="mt-0.5 block text-ink-3/90">{quiet}</span>}
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
      <ul className="px-1.5 pb-1.5">
        {fold.shown.map(({ person, why, stage }) => (
          <li key={person.id} className="list-none">
            <PersonLine
              name={person.displayName}
              avatar={{ id: person.id, src: person.photoUrl }}
              linkedinUrl={person.linkedinUrl}
              tag={stage && <NameTag>{stage}</NameTag>}
              line={
                <Role
                  text={
                    why ?? [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ')
                  }
                />
              }
              to={`/people/${person.id}`}
              goLabel="Open"
              linkLabel={`Open ${person.displayName}`}
              pick={
                canPick
                  ? {
                      picking: picked.size > 0,
                      picked: picked.has(person.id),
                      onPick: (on) => picked.set(person.id, on),
                    }
                  : undefined
              }
              testId="known-person"
            />
          </li>
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
