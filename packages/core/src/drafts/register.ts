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
  /** what the student's line named: "post", "article", "talk" ("talk about your post", never a dangling "it") */
  piece?: string;
  /** `q` is the question the student's own line raised ("how much of that an intern actually sees") */
  reacted?: boolean;
  /** the same question asked directly, for one question by email to someone senior ("What do you look for ...?") */
  direct?: string;
  /** the role note the question is built on, to cite */
  factId?: string;
  factText?: string;
  /** `q` follows up on the role note the opener states ("how much of that work a summer analyst actually sees") */
  roleLine?: boolean;
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
 * question about what to know "before recruiting starts" would show they have not done the homework. A banker is
 * asked for their judgment ("how you'd approach the rest of this cycle"), never whether their group "still brings on
 * summer analysts" or about off-cycle and diversity programs: seats are a recruiting-office question, and nothing on
 * record says the student qualifies for a diversity program.
 *
 * `major`: the student's field, for the one question it raises with someone senior ("for candidates coming from
 * computer science rather than math or statistics, what gap do you see most often").
 */
export function questionsFor(
  p: QuestionInput,
  sector: Sector,
  opts: { late?: boolean; applied?: boolean; major?: string } = {},
): Question[] {
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
  const major = opts.major?.trim().toLowerCase();
  // a field a recruiting process does not expect ("computer science" in consulting, "economics" in quant)
  const cs = !!major && /\b(computer science|cs|software|computer engineering)\b/.test(major);
  switch (kind) {
    case 'bank':
      // the application is in: the question is about the group they would join, never about the cycle or what to
      // know "before recruiting starts"
      if (opts.applied)
        return senior
          ? [
              q(
                `what separates the summer analysts who do well${TG ? ` in ${TG}` : org ? ` at ${org}` : ''}`,
                'what separates the summer analysts who do well',
              ),
              q(
                `what you'd want an incoming summer analyst to understand about ${TG ?? 'the group'}`,
                `what an incoming summer analyst should know`,
              ),
            ]
          : [
              q(
                `what the first year looks like${TG ? ` in ${TG}` : org ? ` at ${org}` : ''} and what you wish you'd known going in`,
                'what the first year looks like',
              ),
            ];
      if (opts.late)
        return senior
          ? [
              q("how you'd approach recruiting from here if you were in my position", 'recruiting from here'),
              q(
                `what separates the analysts who do well${TG ? ` in ${TG}` : org ? ` at ${org}` : ''}`,
                'what separates the analysts who do well',
              ),
            ]
          : [
              q(
                `how you chose ${G ?? org ?? 'banking'} and what you wish you'd known going in`,
                `how you chose ${G ?? org ?? 'banking'}`,
              ),
              q(
                "what you'd focus on at this point in the cycle if you were recruiting now",
                'recruiting at this point in the cycle',
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
              `how you chose ${G ?? org ?? 'banking'} and what you wish you'd known going in`,
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
              'how you made the move into private equity and what surprised you about the work',
              'how you got into private equity',
            ),
            q(
              "how you'd prepare for buy-side recruiting if you were a student now",
              'preparing for buy-side recruiting',
            ),
          ];
    case 'trading': {
      const trader = /\btrad/i.test(p.title ?? '');
      // a head of a desk or a partner answers one question by email, and it is one only they can answer: never
      // "what separates the interns who get return offers" from a student who has no internship there
      if (exec)
        return [
          cs
            ? q(
                'for candidates coming from computer science rather than math or statistics, what gap you see most often',
                'where computer science candidates fall short',
                'For candidates coming from computer science rather than math or statistics, what gap do you see most often?',
              )
            : q(
                'what separates the candidates who do well in your interviews',
                'what separates the strongest candidates',
                'What separates the candidates who do well in your interviews?',
              ),
        ];
      return senior
        ? [
            q(
              `what separates the new hires who do well on your ${trader ? 'desk' : 'team'}`,
              'what separates the new hires who do well',
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
              : q(
                  `what a typical research problem looks like in your first year${org ? ` at ${org}` : ''}`,
                  'what research looks like in the first year',
                ),
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
      // a student whose major is not business has the question every interviewer will ask them
      const fromField =
        major && !/\b(business|economics|finance|management|commerce)\b/.test(major)
          ? q(
              `how someone coming from ${lowerField(opts.major!)} should prepare for case interviews`,
              `coming to consulting from ${lowerField(opts.major!)}`,
            )
          : undefined;
      // a partner does not staff first-year business analysts (they are generalists): a partner is asked for
      // judgment; an engagement manager or a principal, who runs the case team, what separates the first-years on
      // it; a consultant or business analyst about their own choices
      if (exec)
        return [
          q('what separates the business analysts who do well early on', 'what makes new analysts stand out'),
          q(
            "what you'd tell a student deciding whether consulting is the right first job",
            'whether consulting is the right first job',
          ),
          ...(fromField ? [fromField] : []),
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
          ...(fromField ? [fromField] : []),
        ];
      return [
        office
          ? q(`how you picked ${office} and what the first year there is like`, `how you picked ${office}`)
          : practice
            ? q(
                `how you ended up in ${practice} and what surprised you about the work`,
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
        ...(fromField ? [fromField] : []),
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
      // a VP or a head of engineering is far from the intern class: the small, grantable ask is a pointer to the
      // right person on their team; a manager or a staff engineer is asked what they look for on their team
      if (exec || /\b(vice president|vp|head of|director)\b/i.test(p.title ?? ''))
        return [
          q(
            "whether there's someone on your team, maybe a recent intern or new grad, you'd suggest I talk to",
            'who on your team I should talk to',
            "Is there someone on your team, maybe a recent intern or new grad, you'd suggest I talk to?",
          ),
        ];
      if (senior)
        return [
          q(
            'what you look for in the interns and new grads on your team',
            'what you look for in interns',
            'What do you look for in the interns on your team?',
          ),
          q(
            'what the interns who do well on your team do differently in their first few weeks',
            'what the interns who do well do differently',
            'What do the interns who do well on your team do differently in their first few weeks?',
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

/** "Computer Science" as a field in a sentence: "computer science", keeping acronyms. */
function lowerField(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}
