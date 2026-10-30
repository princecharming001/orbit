/**
 * Reply-likelihood rubric for one generated draft. Grounded in cold-outreach research (Boomerang's 40M-email study:
 * 50 to 125 words and a grade-3-to-5 reading level reply best; Gong/Lavender: one clear ask, a specific reason
 * "why you", a personalised first line, short plain subjects of 2 to 6 words; LinkedIn caps connection notes at 300
 * characters and free accounts at 200) plus Orbit's own playbook (docs/plan/15, plan 24 own words and never rules).
 * Every item is a pass, a fail with a reason, or not applicable; nothing here throws.
 */
import { asksIn, fleschKincaidGrade, validateComposed } from '../../drafts/compose';
import { neverDoChecks } from '../../drafts/neverDo';
import { contextText, type DraftOutput, wordsIn } from '../../drafts/templates';
import { placeholderIn, type ValidationIssue, validateDraft } from '../../drafts/validate';
import { type Built, FIRST_TOUCH, type ScenarioId } from './harness';

export type RubricId =
  | 'blocking'
  | 'placeholder'
  | 'responsive'
  | 'no_invention'
  | 'goal_fit'
  | 'never_do'
  | 'grammar'
  | 'li_note'
  | 'why_you'
  | 'opener'
  | 'own_words'
  | 'clean_voice'
  | 'length'
  | 'one_ask'
  | 'concrete_ask'
  | 'subject'
  | 'filler'
  | 'greeting'
  | 'signoff'
  | 'no_repeat'
  | 'grade'
  | 'dashes'
  | 'compose_v2';

/** How much a miss hurts the chance of a reply (used to rank failures and pick the worst drafts). */
export const WEIGHT: Record<RubricId, number> = {
  blocking: 6,
  placeholder: 6,
  responsive: 5,
  no_invention: 5,
  goal_fit: 4,
  never_do: 4,
  grammar: 3,
  li_note: 3,
  why_you: 3,
  opener: 3,
  own_words: 2,
  clean_voice: 2,
  length: 2,
  one_ask: 2,
  concrete_ask: 2,
  subject: 2,
  filler: 2,
  greeting: 2,
  signoff: 2,
  no_repeat: 2,
  grade: 1,
  dashes: 1,
  compose_v2: 0,
};

export const RUBRIC_IDS = Object.keys(WEIGHT) as RubricId[];

export interface Check {
  pass: boolean | null; // null = not applicable
  detail?: string;
}
export type Grade = Record<RubricId, Check>;

export interface Graded extends Built {
  draft: DraftOutput;
  grade: Grade;
  issues: ValidationIssue[];
  score: number; // weighted misses
}

const NA: Check = { pass: null };
const ok = (pass: boolean, detail?: string): Check => ({ pass, detail: pass ? undefined : detail });

const FILLER = [
  'hope this finds you well',
  'hope you are doing well',
  "hope you're doing well",
  'hope you are well',
  'pick your brain',
  'reach out',
  'reaching out',
  'touch base',
  'circle back',
  'i know you are busy',
  "i know you're busy",
  'sorry to bother',
  'any advice',
  'would mean the world',
  'i would be grateful',
  "i'd be grateful",
  'amazing',
  'incredible',
  'inspiring',
  'passionate',
  'huge fan',
  'dream company',
  'honored',
  'humbly',
  'quick question',
  'just wanted',
  'just surfacing',
  "thought i'd introduce myself",
  'came across your profile',
  'leverage',
  'synergy',
];

const GENERIC_OPENERS = [
  /^i came across your profile/i,
  /^my name is/i,
  /^i hope/i,
  /^i am writing/i,
  /^i wanted to (introduce|reach)/i,
  // only who-I-am, nothing about them
  /^(?![^.]*\byou)i'?m (a|an) [^.]*?(student|junior|senior|sophomore|first-year|freshman)[^.]*\.$/i,
];

const STOP = new Set(
  `the a an and or but if so to of in on at for from with by about into over under after before than then that this
  these those it its is are was were be been being have has had do does did i me my mine we our you your they them
  their he she his her not no yes very really just also like as up out more most some any all can could would should
  will shall may might must get got make made want wants wanted which who whom what when where why how there here
  because while until since role roles position internship intern job team company work working love really lol tbh
  kid stuff thing things somewhere ideally honestly kind story long started`.split(/\s+/),
);

/** Distinct content words (5+ letters) of a text, for "did the draft use their own words". */
function contentWords(t: string | undefined): string[] {
  return [
    ...new Set(
      (t ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\s'-]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 5 && !STOP.has(w)),
    ),
  ];
}

function bodyLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function sentences(body: string): string[] {
  const lines = bodyLines(body);
  const inner = lines.slice(1, Math.max(1, lines.length - 2)).join(' ');
  return inner
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/** Word ranges per scenario (body words, without greeting and sign-off). */
const RANGE: Record<ScenarioId, [number, number]> = {
  outreach_email: [50, 125],
  outreach_linkedin: [30, 125],
  bump: [15, 60],
  schedule: [15, 80],
  thank_you: [30, 110],
  nurture: [25, 100],
  congratulate: [15, 70],
  referral_ask: [35, 120],
  intro_request: [40, 130],
  reply_question: [15, 110],
  reply_question_llm: [15, 110],
  reply_interested: [15, 80],
  reply_referral: [15, 80],
  reply_not_now: [10, 60],
};

const ASK_ONE: ReadonlySet<ScenarioId> = new Set([
  'outreach_email',
  'outreach_linkedin',
  'bump',
  'schedule',
  'referral_ask',
  'intro_request',
  'reply_interested',
]);

export function grade(b: Built, d: DraftOutput): Graded {
  const { ctx, persona: p, scenario: s, recipient: r } = b;
  const body = d.body;
  const lower = body.toLowerCase();
  const all = `${d.subject ?? ''}\n${body}\n${d.bodyShort ?? ''}`;
  const g = {} as Grade;
  const context = contextText(ctx);
  const issues = validateDraft(d, {
    kind: d.kind,
    facts: ctx.facts,
    allowedUrls: ctx.user.schedulingLink ? [ctx.user.schedulingLink] : [],
    recipientFirstName: ctx.person.firstName,
    recipientFullName: ctx.person.fullName,
    channel: ctx.channel,
    context,
    asks: ctx.thread?.asksOfUser,
    neverDo: ctx.user.neverDo,
    hadConversation: !!ctx.chat?.completedAt,
    recentOpenings: ctx.recentOpenings,
  });
  const blocking = issues.filter((i) => i.blocking);
  g.blocking = ok(!blocking.length, blocking.map((i) => `${i.code}: ${i.detail}`).join('; '));
  const gap = [d.subject ?? '', body, d.bodyShort ?? ''].map(placeholderIn).find(Boolean);
  const braces = all.match(/\{[^}]*\}|\bTODO\b|\bXX+\b|\bundefined\b|\bnull\b|\bNaN\b/);
  g.placeholder = ok(!gap && !braces, gap ?? braces?.[0]);

  // responsive: a reply answers what they said, and never sends "no reply needed" to someone who just wrote
  const justWrote = !!ctx.thread?.lastInboundAt;
  const brushOff = /no reply needed|just wanted to stay in touch|see how things are going/i.test(body);
  if (s === 'schedule' || s === 'reply_interested')
    g.responsive = ok(
      /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(body) || /calendly|cal\.com/i.test(body),
      'they asked for times; no day or time offered',
    );
  else if (s === 'reply_question' || s === 'reply_question_llm') {
    const miss: string[] = [];
    if (!/\b(20\d\d|graduat|class of|'\d\d|spring|may|december)\b/i.test(body)) miss.push('graduation');
    if (
      !/\b(role|intern|position|analyst|engineer|product|design|data|research|consult|invest|venture|co-?founder|rais)/i.test(
        body,
      )
    )
      miss.push('roles');
    if (/happy to walk you through all of it when we talk/i.test(body)) miss.push('dodges both questions');
    g.responsive = ok(!miss.length, `does not answer: ${miss.join(', ')}`);
  } else if (s === 'reply_referral')
    g.responsive = ok(
      /\bTom\b/.test(body) && !brushOff,
      "ignores the hand-off to Tom (cc'd) or brushes them off",
    );
  else if (s === 'reply_not_now')
    g.responsive = ok(
      /january|new year|after the holidays/i.test(body) && !brushOff,
      'ignores "ping me in January"',
    );
  else if (justWrote) g.responsive = ok(!brushOff, 'says no reply needed right after they wrote');
  else g.responsive = NA;

  // no invention: the validator's grounding plus facts about the student that the inputs contradict
  const inv = issues
    .filter((i) => i.code === 'unsupported_detail' || i.code === 'ungrounded_claim')
    .map((i) => i.detail);
  const yr = (all.match(
    /\b(?:i'?m|i am|is) an? (?:\w+ )?(first-year|freshman|sophomore|junior|senior)\b(?! (?:software|product|data|associate|analyst|engineer|director|manager|designer|consultant|researcher|vice))/i,
  ) ??
    all.match(/\b(first-year|freshman|sophomore|junior|senior) (?:here|studying)\b/i) ??
    (d.subject ?? '').match(/^[^,]* (first-year|freshman|sophomore|junior|senior),/i))?.[1]?.toLowerCase();
  const want = p.year.label.toLowerCase();
  if (yr && !['mba', 'phd'].includes(want) && yr !== want && !(yr === 'freshman' && want === 'first-year'))
    inv.push(`calls a${want === 'associate' ? ' two-year (associate) student' : ` ${want}`} a "${yr}"`);
  if (/\b(fellow alum|alum too|also went to)\b/i.test(all) && !ctx.person.isAlumni)
    inv.push('claims a shared school');
  g.no_invention = ok(!inv.length, inv.join('; '));

  // goal fit: says what the student is actually after
  const gf: string[] = [];
  const recruitingWords = /\brecruiting for\b|\binternships?\b|\bfull-time roles\b|\bthis cycle\b/i;
  if (['fundraising', 'cofounder'].includes(p.goal.id) && recruitingWords.test(all))
    gf.push(`a ${p.goal.id} goal written as job recruiting`);
  if (
    p.goal.id !== 'ib' &&
    /\b(your bank|other banks|banking|investment banking)\b/i.test(all) &&
    !/bank/i.test(ctx.person.org ?? '')
  )
    gf.push('banking talk for a non-banking goal');
  if (
    p.goal.id === 'cofounder' &&
    !/co-?founder|build(ing)? (a|my) (company|startup)/i.test(all) &&
    FIRST_TOUCH.has(s)
  )
    gf.push('never says they are looking for a co-founder');
  if (/full-time/i.test(p.goal.cycleLabel) && /\bintern hiring\b|\binternships?\b/i.test(all))
    gf.push('a full-time goal written as internships');
  if (p.year.label === 'MBA' && /\b(internships?)\b/.test(all) && /full-time/.test(p.goal.cycleLabel))
    gf.push('MBA full-time goal written as internship');
  g.goal_fit =
    FIRST_TOUCH.has(s) || ['bump', 'intro_request', 'referral_ask'].includes(s)
      ? ok(!gf.length, gf.join('; '))
      : NA;

  // never rules: our own reading of the rule, and whether the app can check it at all
  if (!p.never.text) g.never_do = NA;
  else {
    const broke = p.never.breaks(all, { school: p.school.name, firstName: p.name.first });
    const appChecks = neverDoChecks(p.never.text).length;
    g.never_do = ok(
      !broke,
      `breaks "${p.never.text}"${appChecks ? '' : ' (the app has no check for this rule)'}`,
    );
  }

  // grammar: splices that read as machine-written
  const gr: string[] = [];
  // the student's own typing is judged by clean_voice, not here
  const typed = [p.words.story, p.words.aim, p.words.proudOf, ctx.update, ctx.answer]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const G: [RegExp, string][] = [
    [/\b(about|hear about|to) (she|he|they) (works|is|runs|leads)\b/i, 'pronoun spliced after a preposition'],
    [
      /\b(point|advice|idea) that (lead|be|make|show|ask|send|use|focus|start|keep|always|never|don't)\b/i,
      'imperative note spliced after "that"',
    ],
    [/\byour (path|move) to your role\b/i, '"your path to your role"'],
    [/"[^"]*\b(I am|I'm|I)\b[^"]*"/, 'first person inside the third-person blurb'],
    [/\b(\w{3,}) \1\b/i, 'repeated word'],
    [/[a-z][.!?] [a-z]/, 'sentence starts lower case'],
    [/\s[,.]/, 'space before punctuation'],
    [
      /\bsaw that (posted|studies|teaches|researches|writes|wrote|tweeted|published|is hiring)\b/i,
      'note spliced with no subject',
    ],
    [/\b(a) ([aeiou]\w+)/i, '"a" before a vowel'],
  ];
  for (const [re, what] of G) {
    const m = body.match(re);
    if (
      m &&
      !typed.includes(m[0].toLowerCase()) &&
      !(what === '"a" before a vowel' && /^(a) (one|uni|use|user|euro)/i.test(m[0]))
    )
      gr.push(`${what}: "${m[0]}"`);
  }
  g.grammar = ok(!gr.length, gr.join('; '));

  // LinkedIn connection note
  if (s === 'outreach_linkedin') {
    const n = d.bodyShort ?? '';
    g.li_note = !n
      ? ok(false, 'no connection note (bodyShort)')
      : ok(n.length <= 300 && /\?/.test(n), `${n.length} chars${/\?/.test(n) ? '' : ', no ask'}`);
    if (g.li_note.pass && n.length > 200)
      g.li_note = { pass: true, detail: `${n.length} chars (over the free-account 200)` };
  } else g.li_note = NA;

  // why you: something only true of the recipient (impossible when nothing is known: not applicable)
  const known = !!(ctx.person.org || ctx.person.title || ctx.person.headline || ctx.facts.length);
  // a recruiter gets a logistics question, where "why you" is their company (not applicable)
  if (FIRST_TOUCH.has(s) && known && r !== 'recruiter') {
    const aboutThem = d.claims.some(
      (c) => (c.kind === 'about_person' || c.kind === 'shared') && c.text !== 'connection missing',
    );
    const factWord = ctx.facts.some((f) => contentWords(f.text).some((w) => lower.includes(w)));
    const mentionsOnlyOrg = !factWord && !!ctx.person.org && lower.includes(ctx.person.org.toLowerCase());
    g.why_you = ok(
      aboutThem && (factWord || !mentionsOnlyOrg || !!ctx.person.isAlumni),
      aboutThem ? 'only names their company, nothing about them' : 'nothing only true of them',
    );
  } else g.why_you = NA;

  // opener: the first sentence after the greeting is about them or a shared tie, not boilerplate
  if (FIRST_TOUCH.has(s)) {
    const first = sentences(body)[0] ?? '';
    const generic = GENERIC_OPENERS.find((re) => re.test(first));
    g.opener = ok(!generic, `generic first line: "${first}"`);
  } else g.opener = NA;

  // own words: when the student wrote their story / aim / proud-of, a first message or ask carries some of it
  // a run of three of their words, or two distinctive content words, counts as using them
  const ownText = [p.words.story, p.words.proudOf].filter(Boolean).join(' ');
  const ownW = contentWords(ownText).filter(
    (w) => !p.major.toLowerCase().includes(w) && !p.goal.roleLabel.toLowerCase().includes(w),
  );
  const toks = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const ot = toks(ownText);
  const bodyT = ` ${toks(body).join(' ')} `;
  const tri = ot.some((_, i) => i + 3 <= ot.length && bodyT.includes(` ${ot.slice(i, i + 3).join(' ')} `));
  if (ownW.length >= 2 && (FIRST_TOUCH.has(s) || s === 'intro_request'))
    g.own_words = ok(
      tri || ownW.filter((w) => lower.includes(w)).length >= 2,
      `none of their own words used (had: "${ownText.slice(0, 80)}...")`,
    );
  else g.own_words = NA;

  // clean voice: the student's raw typing (typos, emoji, "tbh") is not pasted into a message to a stranger
  const raw = [p.words.story, p.words.aim, p.words.proudOf, ctx.update, ctx.answer].filter(Boolean).join(' ');
  const typos = (
    raw.match(/\b(studdied|realy|thigns|buisness|compnay|competiton|nervus|tbh|lol|im)\b/gi) ?? []
  ).filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(body));
  const emoji = !ctx.styleCard.emoji && /\p{Extended_Pictographic}/u.test(body);
  const tooLongPaste =
    !!ctx.answer && ctx.answer.split(/\s+/).length > 30 && body.includes(ctx.answer.slice(0, 60));
  const v: string[] = [];
  if (typos.length) v.push(`typos pasted: ${typos.join(', ')}`);
  if (emoji) v.push('emoji pasted');
  if (tooLongPaste) v.push('a 30+ word answer pasted verbatim');
  if (/\bto make career\b|\bvery interesting to\b|\bresponsible of\b/i.test(body))
    v.push('non-native phrasing pasted');
  g.clean_voice = raw || /\p{Extended_Pictographic}/u.test(body) ? ok(!v.length, v.join('; ')) : NA;

  // length
  const wc = wordsIn(body);
  const [lo, hi] = RANGE[s];
  g.length = ok(wc >= lo && wc <= hi, `${wc} words, want ${lo}-${hi}`);

  // one ask
  // a bump's "I'd still love 15 minutes" is its ask even without a question mark
  const asks = [
    ...asksIn(body),
    ...(s === 'bump'
      ? sentences(body).filter(
          (x) => /\b(still (love|value)|would still)\b.*\bminutes\b/i.test(x) && !x.endsWith('?'),
        )
      : []),
  ];
  if (ASK_ONE.has(s))
    g.one_ask = ok(asks.length === 1, `${asks.length} asks${asks.length ? `: ${asks.join(' | ')}` : ''}`);
  else g.one_ask = ok(asks.length <= 1, `${asks.length} asks: ${asks.join(' | ')}`);

  // concrete, low-effort ask
  if (FIRST_TOUCH.has(s) || s === 'bump' || s === 'intro_request') {
    const recruiter = /recruit/i.test(ctx.person.title ?? '');
    g.concrete_ask =
      recruiter && s !== 'intro_request'
        ? NA
        : ok(/\b(10|15|20|fifteen|twenty|ten)[- ]?min/i.test(body), 'no call length (15 or 20 minutes)');
  } else if (s === 'schedule' || s === 'reply_interested')
    g.concrete_ask = ok(/\b\d{1,2}(:\d\d)?\s?(am|pm)\b/i.test(body), 'no concrete time');
  else g.concrete_ask = NA;

  // subject
  if (ctx.channel === 'gmail' && d.subject && !ctx.thread?.inThread) {
    const subj = d.subject.trim();
    const n = subj.split(/\s+/).length;
    const why: string[] = [];
    const piece =
      / suggested I (write|get in touch)/.test(subj) ||
      /^your (post|article|talk|piece|essay|paper|podcast|interview|video|thread|newsletter|book)\b/i.test(
        subj,
      );
    if (n < 2 || (n > 6 && !piece)) why.push(`${n} words`);
    if (subj.length > (piece ? 70 : 45)) why.push(`${subj.length} chars`);
    if (/!|\burgent\b|\bopportunit|\brequest\b|\bquick question\b|\bfree\b/i.test(subj)) why.push('salesy');
    const caps = subj
      .split(/\s+/)
      .slice(1)
      .filter((w) => /^[A-Z][a-z]/.test(w) && !context.includes(w.replace(/[^\p{L}]/gu, '')));
    if (caps.length) why.push(`title case: ${caps.join(' ')}`);
    g.subject = ok(!why.length, `"${subj}": ${why.join(', ')}`);
  } else if (ctx.channel === 'gmail' && (s === 'outreach_email' || s === 'intro_request') && !d.subject)
    g.subject = ok(false, 'no subject');
  else g.subject = NA;

  // filler
  const fill = FILLER.filter((f) => lower.includes(f));
  g.filler = ok(!fill.length, fill.join(', '));

  // greeting
  const firstLine = bodyLines(body)[0] ?? '';
  g.greeting = ok(
    new RegExp(`^(hi|hello|dear|hey|good (morning|afternoon))\\b.*\\b${ctx.person.firstName}\\b`, 'i').test(
      firstLine,
    ) && !/\bthere\b/i.test(firstLine),
    `greeting "${firstLine}"`,
  );

  // sign-off: their name, written as a name
  const tail = bodyLines(body).slice(-3).join(' ');
  const nameOk = tail.includes(p.name.first) || tail.toLowerCase().includes(p.name.first.toLowerCase());
  const capOk =
    !/^[a-z]/.test(p.name.first) || tail.includes(p.name.first[0]!.toUpperCase() + p.name.first.slice(1));
  g.signoff = ok(nameOk && capOk, nameOk ? `name not capitalised: "${tail}"` : `no name in "${tail}"`);

  // no repeated sentences or phrases
  const sn = sentences(body).map((x) => x.toLowerCase().replace(/[^a-z ]/g, ''));
  const dupS = sn.find((x, i) => sn.indexOf(x) !== i);
  const words = lower
    .replace(/[^a-z' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Map<string, number>();
  let dupG: string | undefined;
  for (let i = 0; i + 5 <= words.length; i++) {
    const k = words.slice(i, i + 5).join(' ');
    grams.set(k, (grams.get(k) ?? 0) + 1);
    if (grams.get(k) === 2 && !dupG) dupG = k;
  }
  const hopes = (lower.match(/\bhope\b/g) ?? []).length;
  const saws = (lower.match(/\bi saw that\b/g) ?? []).length;
  g.no_repeat = ok(
    !dupS && !dupG && hopes <= 1 && saws <= 1,
    dupS
      ? `repeated sentence "${dupS}"`
      : dupG
        ? `repeated "${dupG}"`
        : hopes > 1
          ? 'two "hope"s'
          : 'two "I saw that"s',
  );

  // reading grade
  const fk = fleschKincaidGrade(body);
  g.grade = ok(fk <= 8, `grade ${fk.toFixed(1)}`);

  // long dashes and spaced hyphens used as dashes
  g.dashes = ok(!/[—–]|\s-\s/.test(all), 'dash');

  // the compose v2 validator (what an LLM rewrite must pass), for first touches only; reported, not weighted
  if (FIRST_TOUCH.has(s)) {
    const v2 = validateComposed(
      {
        kind: 'outreach',
        channel: ctx.channel,
        subject: d.subject,
        body: ctx.channel === 'linkedin' ? (d.bodyShort ?? body) : body,
        hooks: d.claims
          .filter((c) => c.kind !== 'logistics')
          .map((c) => ({ text: c.text, sourceId: c.factId ?? 'profile' })),
      } as never,
      {
        goal: p.goal.id === 'fundraising' ? 'fundraising' : 'recruiting',
        recipientFirstName: ctx.person.firstName,
        recipientFullName: ctx.person.fullName,
        inputs: context,
        facts: ctx.facts,
        style: ctx.styleCard,
        connectionNote: ctx.channel === 'linkedin',
      },
    );
    const codes = v2.issues
      .filter((i) => i.blocking)
      .map((i) => `${i.code}${i.code === 'reading_grade' ? ` ${v2.grade}` : ''}`);
    g.compose_v2 = ok(v2.ok, codes.join(', '));
  } else g.compose_v2 = NA;

  const score = RUBRIC_IDS.reduce((a, id) => a + (g[id].pass === false ? WEIGHT[id] : 0), 0);
  return { ...b, draft: d, grade: g, issues, score };
}
