import type { Sector } from '../types';
import {
  article,
  chosenGroup,
  functionLabel,
  groupNoun,
  roleNoun,
  shortOrg,
  titleFunction,
} from './phrasing';
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
  /** the topic of a post or talk the student named */
  about?: string;
  /** `q` is the question the student's own line raised ("how much of that an intern actually sees") */
  reacted?: boolean;
  /** the same question asked directly, for one question by email to someone senior ("What do you look for ...?") */
  direct?: string;
  /** the role note the question is built on, to cite */
  factId?: string;
  factText?: string;
}

export interface QuestionInput {
  title?: string;
  org?: string;
  group?: string;
  industry?: string;
}

function q(qText: string, short?: string, direct?: string): Question {
  return { q: qText, short: short ?? qText, ...(direct ? { direct } : {}) };
}

/**
 * `late`: the student is writing to a bank after its summer analyst cycle has mostly run (see `cycleTiming`), so a
 * question about what to know "before recruiting starts" would show they have not done the homework; the questions
 * are about the late paths instead (seats still open, off-cycle and diversity programs, full-time).
 */
export function questionsFor(p: QuestionInput, sector: Sector, opts: { late?: boolean } = {}): Question[] {
  const kind: FirmKind = firmKindOf(p, sector);
  const senior = isSeniorTitle(p.title);
  const exec = seniorityOf(p.title) === 'exec';
  const org = shortOrg(p.org?.trim() || undefined);
  const group = p.group?.trim() || undefined;
  const G = group ? chosenGroup(group) : undefined;
  // "about the Healthcare group", never "about Healthcare" (which reads as the industry)
  const TG = group ? `the ${groupNoun(group, sector)}` : undefined;
  const role = roleNoun(p.title);
  const theirFn = functionLabel(titleFunction(p.title));
  switch (kind) {
    case 'bank':
      if (opts.late)
        return senior
          ? [
              q(
                `whether ${TG ?? 'your group'} still brings on summer analysts this late, through off-cycle or diversity programs`,
                'late paths into banking',
              ),
              q(
                "what you'd tell a student who missed the main summer analyst cycle",
                'recruiting after the main cycle',
              ),
            ]
          : [
              q(
                `how you chose ${G ?? org ?? 'banking'} and what the work is like day to day`,
                `how you chose ${G ?? org ?? 'banking'}`,
              ),
              q(
                "how you'd approach it if you were recruiting off-cycle now, after the main summer analyst cycle",
                'recruiting off-cycle',
              ),
            ];
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
            q('how recruiting went for you and what helped most', 'how recruiting went for you'),
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
      if (exec)
        return [
          q(
            `what separates the interns who get return offers${org ? ` at ${org}` : ''}`,
            'what separates the interns who get return offers',
            `What separates the interns who get return offers${org ? ` at ${org}` : ''}?`,
          ),
        ];
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
      // a partner is asked what they look for; an engagement manager or a principal, who runs the case team, what
      // separates the first-years on it; a consultant or business analyst about their own choices
      if (exec)
        return [
          q(
            `what you look for in the first-years you staff${practice ? ` in ${practice}` : ''}`,
            'what you look for in first-years',
          ),
          q(
            `what you'd tell a student choosing which office and practice to aim for${org ? ` at ${org}` : ''}`,
            'choosing an office and practice',
          ),
        ];
      if (senior)
        return [
          q(
            'what separates the first-year consultants who do well on your case teams',
            'what makes new consultants stand out',
          ),
          q(
            `how case prep translates to the first months on a team${org ? ` at ${org}` : ''}`,
            'how case prep translates to the job',
          ),
        ];
      return [
        office
          ? q(`how you picked ${office} and what the first year there is like`, `how you picked ${office}`)
          : practice
            ? q(
                `how you ended up in ${practice} and what the work is like`,
                `how you ended up in ${practice}`,
              )
            : q(
                `how you chose ${org ?? 'consulting'} and how staffing worked in your first year`,
                `how you chose ${org ?? 'consulting'}`,
              ),
        q(
          `how you prepared for case interviews${org ? ` at ${org}` : ''} and what you'd do the same way again`,
          'how you prepared for case interviews',
        ),
      ];
    }
    case 'startup':
      if (exec)
        return [
          q(
            `what you look for in early hires${org ? ` at ${org}` : ''}`,
            'what you look for in early hires',
            `What do you look for in early hires${org ? ` at ${org}` : ''}?`,
          ),
          q(
            `what you'd tell a student weighing a startup${org ? ` like ${org}` : ''} against a bigger company`,
            'joining a startup early',
            `What would you tell a student weighing a startup${org ? ` like ${org}` : ''} against a bigger company?`,
          ),
        ];
      return [
        q(
          `how you ended up at ${org ?? 'a startup'} so early, and what that stage has been like`,
          `joining ${org ?? 'a startup'} early`,
        ),
        q("what you'd focus on if you were recruiting again"),
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
            exec
              ? 'What do you look for in interns and new grads?'
              : 'What do you look for in the interns on your team?',
          ),
          q(
            `what separates the interns who get return offers${org ? ` at ${org}` : ''}`,
            'what separates the interns who get return offers',
            `What separates the interns who get return offers${org ? ` at ${org}` : ''}?`,
          ),
        ];
      const where = group ? `on ${chosenGroup(group)}` : org ? `at ${org}` : '';
      return [
        role
          ? q(
              `how you ended up as ${article(role)} ${role}${where ? ` ${where}` : ''}`,
              `how you ended up ${where || 'where you are'}`,
            )
          : q(`how you ended up ${where || 'where you are'}`),
        q(`what your first few months${org ? ` at ${org}` : ''} were like`),
        q("what you'd focus on if you were recruiting again"),
      ];
    }
    default:
      return [
        q(
          `how you got into ${theirFn ?? 'your field'} and what helped most early on`,
          `how you got into ${theirFn ?? 'your field'}`,
        ),
        senior
          ? q(`what you look for in people starting out${org ? ` at ${org}` : ''}`)
          : q(`what the path${org ? ` to ${org}` : ''} looked like`),
      ];
  }
}
