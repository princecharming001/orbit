/**
 * The next steps each card offers, worked out from the result alone, so the card and the chat agree on them: the card
 * draws them as chips, and the no-key router reads them when the student answers "do it", "yes" or "the second one"
 * right after a card (agent/routerThread.ts). Each step's message is a sentence the router turns into a tool call.
 */
import { MEDIUM_TIE } from '@orbit/core';
import type { ResultEnvelope } from '../../types';
import {
  addTarget,
  afterStage,
  askForIntro,
  introTo,
  prepFor,
  showDrafts,
  warmUpFirst,
  writeNow,
  writeTo,
  writeToEach,
} from './next';
import type { NextStep } from './parts';
import type { RouteView, WarmIntro } from './shapes';
import {
  readCompany,
  readImport,
  readList,
  readNote,
  readPeople,
  readPeopleQuery,
  readPerson,
  readPipeline,
  readRoutes,
  readSkipped,
  readText,
  unpack,
} from './shapes';

/** The intro chain a route or a warm intro is: "Maya Chen > Daniel Okafor", for matching one with the other. */
export const chainKey = (names: string[]) =>
  names
    .filter((n) => n.toLowerCase() !== 'you')
    .map((n) => n.toLowerCase())
    .join('>');

/** A routes card's rows: the routes strongest first, each with the warm intro along the same chain, then the rest. */
export function routeRows(d: unknown) {
  const { routes, warmIntros } = readRoutes(d);
  return rowsFrom(routes, warmIntros);
}

/** The same rows from routes already read (the card for several people reads each person's once). */
export function rowsFrom(routes: RouteView[], warmIntros: WarmIntro[]) {
  const sorted = [...routes].sort((a, b) => b.score - a.score);
  const warmByChain = new Map(warmIntros.map((w) => [chainKey(w.hops), w]));
  const merged = new Set<(typeof warmIntros)[number]>();
  const rows = sorted.map((r) => {
    const w = warmByChain.get(chainKey(r.names));
    if (w) merged.add(w);
    return { r, w };
  });
  return { sorted, rows, rest: warmIntros.filter((w) => !merged.has(w)) };
}

/** The steps a result offers, at most three, in the order the card shows them. */
export function cardSteps(toolName: string, env: ResultEnvelope): NextStep[] {
  return stepsOf(toolName, env).slice(0, 3);
}

function stepsOf(toolName: string, env: ResultEnvelope): NextStep[] {
  const d = env.data;
  switch (env.kind) {
    case 'person': {
      const r = readPerson(d);
      if (!r) return [];
      // just hidden: the one thing to offer is taking it back
      if (r.person.hiddenAt || /^Hid\b/.test(env.summary))
        return [{ label: 'Show again', message: `Unhide ${r.person.displayName}` }];
      const { person, chat, questions } = r;
      const steps: NextStep[] = [];
      if (!r.nextMessage?.wait) steps.push(writeTo(person.displayName, r.nextMessage?.kind));
      if ((chat?.stage === 'scheduled' || chat?.stage === 'scheduling') && !questions.length)
        steps.push(prepFor(person.displayName));
      if (!chat && person.strength < MEDIUM_TIE) steps.push(introTo(person.displayName));
      return steps;
    }
    case 'people': {
      const people = readPeople(d);
      const { query } = readPeopleQuery(d);
      const target = readRoutes(d).to;
      if (!people.length) return [];
      const names = people.map((p) => p.person.displayName);
      // mutual connections: ask the closest one for the intro
      if (target && people[0]) return [askForIntro(people[0].person.displayName, target.displayName)];
      // a list (not a name search that needs a pick): one draft each
      if (!query || people.length === 1) {
        const each = people.length === 1 ? writeTo(names[0]!) : writeToEach(names);
        return each ? [each] : [];
      }
      return [];
    }
    case 'drafts': {
      const warmUp = readSkipped(d).find((s) => /linkedin only/i.test(s.why));
      return warmUp ? [writeTo(warmUp.name)] : [];
    }
    case 'pipeline': {
      const { items } = readPipeline(d);
      const quiet = items.filter((i) => i.quiet);
      if (items.length === 1) {
        const one = items[0]!;
        const step = one.quiet
          ? writeTo(one.person.displayName, 'bump')
          : afterStage(one.person.displayName, one.stage);
        return step ? [step] : [];
      }
      if (quiet.length) {
        const each = writeToEach(
          quiet.map((q) => q.person.displayName),
          'bump',
        );
        if (!each) return [];
        return [
          quiet.length === items.length || quiet.length === 1
            ? each
            : {
                label: quiet.length <= 5 ? `Follow up with the ${quiet.length} quiet ones` : each.label,
                message: each.message,
              },
        ];
      }
      return [];
    }
    case 'routes': {
      const { to, routes, stories, warmIntros } = readRoutes(d);
      if (!routes.length && !stories.length && !warmIntros.length) return [];
      const { sorted, rest } = routeRows(d);
      const best = sorted[0];
      if (!to) return [];
      if (best && best.names.length > 1) return [askForIntro(best.names[0]!, to.displayName)];
      // a Village introducer only when they are someone in Orbit, so the request has someone to go to
      if (!best && rest[0]?.introducerId && rest[0].hops.length > 2)
        return [askForIntro(rest[0].introducer, to.displayName)];
      return [writeTo(to.displayName)];
    }
    case 'note': {
      const n = readNote(d);
      if (n.notes.length || n.candidates.length) return [];
      if (n.person && n.thankYouDraftId)
        return [
          { label: 'Review the thank-you', message: `Open the thank-you draft to ${n.person.displayName}` },
        ];
      if (n.person) return [writeTo(n.person.displayName)];
      return [];
    }
    case 'company': {
      const { name, people, target } = readCompany(d);
      if (!name) return [];
      const steps: NextStep[] = [];
      if (people[0]) steps.push(writeTo(people[0].displayName));
      if (people.length >= 2) {
        const each = writeToEach(people.map((p) => p.displayName));
        if (each) steps.push(each);
      }
      if (!target) steps.push(addTarget(name));
      return steps;
    }
    case 'import':
      return /linkedin/i.test(readImport(d).source ?? '')
        ? [{ label: 'Who should I meet', message: 'Who should I meet?' }]
        : [];
    case 'list': {
      const { title, items } = readList(d);
      if (!items.length) return [];
      const heading = title ?? firstSentence(env.summary);
      const steps: NextStep[] = [];
      if (toolName === 'find_people')
        steps.push({ label: 'Add them to People', message: 'Add them all to People' });
      const researched = heading.match(/^Research on (.+)$/)?.[1];
      if (researched) steps.push(writeTo(researched));
      if (toolName === 'list_due') steps.push(showDrafts);
      return steps;
    }
    case 'text': {
      // mutual connections need LinkedIn live: Orbit's own routes still answer the question
      const mutual = unpack(d) as { target?: { name?: string }; reason?: string } | undefined;
      if (toolName === 'get_mutual_connections' && mutual?.target?.name)
        return [introTo(mutual.target.name), { label: 'Connect LinkedIn', message: 'Connect my LinkedIn' }];
      const { warmUpFor, wait } = readText(d);
      if (warmUpFor) return [warmUpFirst(warmUpFor.displayName), writeNow(warmUpFor.displayName)];
      if (wait)
        return [
          {
            ...writeTo(
              wait.person.displayName,
              wait.reason === 'too_soon' || wait.reason === 'away' ? 'bump' : 'nurture',
            ),
            label: 'Write anyway',
          },
        ];
      return [];
    }
    default:
      return [];
  }
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.?!](?=\s|$)/);
  return (m ? m[0] : s).replace(/\.$/, '');
}
