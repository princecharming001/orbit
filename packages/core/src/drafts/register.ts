import type { Sector } from '../types';
import { article, chosenGroup, functionLabel, groupNoun, roleNoun, titleFunction } from './phrasing';
import { type FirmKind, firmKindOf, isSeniorTitle, seniorityOf } from './sector';

/**
 * What a first message asks about, by the kind of firm and how senior the recipient is. A question from one sector's
 * bank never goes to another ("how juniors get staffed" is a consulting question; a quant partner has no "office"),
 * and a senior person is never asked about their first year or what a new hire's first months look like: they are
 * asked what they look for, which is the question only they can answer.
 *
 * `q` follows "tell me", "hear" or "curious"; `short` follows "talk about" in a LinkedIn note.
 */
export interface Question {
  q: string;
  short: string;
  /** the topic of a post or talk the student named, for "curious about ..." */
  about?: string;
}

export interface QuestionInput {
  title?: string;
  org?: string;
  group?: string;
  industry?: string;
}

function q(qText: string, short?: string): Question {
  return { q: qText, short: short ?? qText };
}

export function questionsFor(p: QuestionInput, sector: Sector): Question[] {
  const kind: FirmKind = firmKindOf(p, sector);
  const senior = isSeniorTitle(p.title);
  const exec = seniorityOf(p.title) === 'exec';
  const org = p.org?.trim() || undefined;
  const group = p.group?.trim() || undefined;
  const G = group ? chosenGroup(group) : undefined;
  // "about the Healthcare group", never "about Healthcare" (which reads as the industry)
  const TG = group ? `the ${groupNoun(group, sector)}` : undefined;
  const role = roleNoun(p.title);
  const theirFn = functionLabel(titleFunction(p.title));
  switch (kind) {
    case 'bank':
      return senior
        ? [
            q(
              `what separates the summer analysts who do well${TG ? ` in ${TG}` : ''}`,
              'what separates the summer analysts who do well',
            ),
            q(
              `what you'd want a student to understand about ${TG ?? 'banking'} before recruiting starts`,
              `what students should know about ${TG ?? 'banking'}`,
            ),
            q("how you'd approach recruiting if you were a student now"),
          ]
        : [
            q(
              `how you chose ${G ?? org ?? 'banking'} and what the work is like day to day`,
              `how you chose ${G ?? org ?? 'banking'}`,
            ),
            q("how recruiting went for you and what you'd do differently", 'how recruiting went for you'),
            G
              ? q(`what made you pick ${G} over the other groups`, `why you picked ${G}`)
              : q(
                  `what made you pick ${org ?? 'your bank'} over the other banks`,
                  `why you picked ${org ?? 'banking'}`,
                ),
          ];
    case 'pe':
      return senior
        ? [
            q('what you look for in the analysts you hire'),
            q(
              "what you'd tell a student who wants to end up in private equity",
              'getting into private equity',
            ),
          ]
        : [
            q(
              'how you made the move into private equity and what the work is like',
              'how you got into private equity',
            ),
            q(
              "how you'd prepare for buy-side recruiting if you were a student now",
              'preparing for buy-side recruiting',
            ),
          ];
    case 'trading': {
      const trader = /\btrad/i.test(p.title ?? '');
      return senior
        ? [
            q(
              `what separates the interns who get return offers${org ? ` at ${org}` : ''}`,
              'what separates the interns who get return offers',
            ),
            q(
              "what you'd tell a student deciding between trading and research",
              'choosing between trading and research',
            ),
          ]
        : [
            q(
              `how you prepared for the interviews${org ? ` at ${org}` : ''} and what your first months were like`,
              `how you prepared for the interviews${org ? ` at ${org}` : ''}`,
            ),
            trader
              ? q('how you decided between trading and research')
              : q(`what research looks like day to day${org ? ` at ${org}` : ''}`),
          ];
    }
    case 'vc':
      return senior
        ? [
            q(
              "what you'd tell a student who wants to end up in venture",
              'how a student should think about venture',
            ),
            q(
              'whether you would recommend operating first to someone who wants to end up in venture',
              'whether to operate first before venture',
            ),
          ]
        : [
            q(
              `how you got into venture and what your week${org ? ` at ${org}` : ''} actually looks like`,
              'how you got into venture',
            ),
            q(
              "how you'd prepare for venture recruiting if you were a student now",
              'preparing for venture recruiting',
            ),
          ];
    case 'consulting': {
      const office = group && /\boffice$/i.test(group) ? chosenGroup(group) : undefined;
      const practice = group && !office ? chosenGroup(group) : undefined;
      if (senior)
        return [
          q(
            'what separates the first-year consultants who do well on your teams',
            'what makes new consultants stand out',
          ),
          q(
            `what you'd focus on as a student recruiting for ${org ?? 'consulting'} now`,
            `recruiting for ${org ?? 'consulting'}`,
          ),
        ];
      return [
        q(
          `how you decided on ${org ?? 'consulting'} and how staffing works in the first year`,
          `how you decided on ${org ?? 'consulting'}`,
        ),
        office
          ? q(`how you picked ${office} and what the first year there is like`, `how you picked ${office}`)
          : practice
            ? q(
                `how you ended up in ${practice} and what the work is like`,
                `how you ended up in ${practice}`,
              )
            : q(`what the first year at ${org ?? 'the firm'} is really like`),
      ];
    }
    case 'startup':
      if (exec)
        return [
          q(`what you look for in early hires${org ? ` at ${org}` : ''}`),
          q(
            `what you'd tell a student weighing a startup${org ? ` like ${org}` : ''} against a bigger company`,
            'joining a startup early',
          ),
        ];
      return [
        q(
          `how you ended up at ${org ?? 'a startup'} so early, and what that stage has been like`,
          `joining ${org ?? 'a startup'} early`,
        ),
        q(`what you'd focus on if you were recruiting for ${theirFn ?? 'your role'} again`),
      ];
    case 'big_tech':
    case 'tech': {
      if (senior)
        return [
          q(
            exec
              ? 'what you look for in interns and new grads'
              : 'what you look for in the interns and new grads on your team',
            'what you look for in interns',
          ),
          q(
            `what separates the interns who get return offers${org ? ` at ${org}` : ''}`,
            'what separates the interns who get return offers',
          ),
        ];
      const where = group ? `on ${chosenGroup(group)}` : org ? `at ${org}` : '';
      return [
        role
          ? q(
              `how you ended up as ${article(role)} ${role}${where ? ` ${where}` : ''}, and what you'd do differently`,
              `how you ended up ${where || 'where you are'}`,
            )
          : q(`how you ended up ${where || 'where you are'}, and what you'd do differently`),
        q(`what your first few months${org ? ` at ${org}` : ''} were like`),
        q(`what you'd focus on if you were recruiting for ${theirFn ?? 'your role'} again`),
      ];
    }
    default:
      return [
        q(
          `how you got into ${theirFn ?? 'your field'} and what you'd do differently starting now`,
          `how you got into ${theirFn ?? 'your field'}`,
        ),
        senior
          ? q(`what you look for in people starting out${org ? ` at ${org}` : ''}`)
          : q(`what the path${org ? ` to ${org}` : ''} looked like`),
      ];
  }
}
