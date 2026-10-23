import { describe, expect, it } from 'vitest';
import type { MatchablePerson } from '../agent/people-match';
import { NOT_FOLLOWED_LEAD, type RouterContext, type RouterIntent, routeUtterance } from '../agent/router';
import { readSocial } from '../agent/smallTalk';
import { voiceProblems } from '../agent/voice';
import { registry } from '../registry';
import type { ChoiceOption } from '../types';

/**
 * Orbi on the no-key router (docs/plan/19-orbi-persona.md): a few hundred things students actually type, slang and
 * typos and emoji and venting included, each answered like a person. Never "I didn't catch that" for small talk, a
 * short line for a short message, the student's register back, at most one nudge and one question, nothing the
 * voice lint flags, and a greeting in front of a real ask still runs the ask.
 */

const person = (id: string, first: string, last: string, org: string, strength: number): MatchablePerson => ({
  id,
  displayName: `${first} ${last}`,
  firstName: first,
  lastName: last,
  currentOrganizationRaw: org,
  currentTitle: 'Engineer',
  strength,
  isHuman: true,
});

const PEOPLE = [
  person('p1', 'Priya', 'Patel', 'Stripe', 0.8),
  person('p2', 'Daniel', 'Kim', 'Ramp', 0.6),
  person('p3', 'Mei', 'Chen', 'Stripe', 0.7),
];

const BASE: RouterContext = {
  registry,
  people: PEOPLE,
  companies: ['Stripe', 'Ramp', 'Notion'],
  modeNote: 'Add your own key in Settings, Integrations to chat freely.',
  settingsHref: '/settings/integrations',
  firstName: 'Alex',
  now: new Date('2026-10-23T14:05:00'),
  nextChat: { personId: 'p2' },
};

/** three people are waiting on the student */
const FULL: RouterContext = {
  ...BASE,
  cards: [
    { id: 's1', personId: 'p1', kind: 'thank_you' },
    { id: 's2', personId: 'p2', kind: 'bump' },
    { id: 's3', personId: 'p3', kind: 'bump' },
  ],
  drafts: [{ id: 'd1', personId: 'p1', status: 'draft', kind: 'thank_you' }],
};
/** nothing waits on the student */
const IDLE: RouterContext = { ...BASE, cards: [], drafts: [] };
/** nobody in the account yet */
const EMPTY: RouterContext = {
  ...BASE,
  people: [],
  companies: [],
  cards: [],
  drafts: [],
  nextChat: undefined,
};

const CONTEXTS: [string, RouterContext][] = [
  ['people waiting', FULL],
  ['nothing waiting', IDLE],
  ['empty account', EMPTY],
];

function say(utterance: string, ctx: RouterContext = FULL) {
  const r = routeUtterance(utterance, ctx);
  const text = r.kind === 'tool' ? (r.lead ?? '') : r.text;
  const options = r.kind === 'tool' && r.tool === 'offer_choices' ? (r.input.options as ChoiceOption[]) : [];
  return { r, text, options };
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const sentences = (t: string) => t.split(/(?<=[.?])\s+/).filter(Boolean);
/** the nudge sentences the router adds after Orbi's own line, and the setup line on an empty account */
const NUDGE =
  /(?:waiting to hear from you|ready to look at|Nothing's waiting on you today|where your chats stand|Want to start there|Where do you want to start|Want to see who to message|LinkedIn|Gmail|\+ button|Say "|want a quick prep|Want to line up|Want help writing|Want to find someone|What are we working on|drop the export|when you're ready|easy step|first step)/i;
const ownLine = (t: string) => sentences(t).filter((s) => !NUDGE.test(s));

// ---- what students type ------------------------------------------------------------------------------------------

const GREETINGS = [
  'wsp',
  'yo',
  'sup',
  'hey orbi',
  'hi',
  'hello',
  'heyyyy',
  'hiiii',
  'yooo',
  'ayo',
  'hey hey',
  'good morning',
  'gm',
  'good evening',
  'hola',
  'bonjour',
  'Hello there!',
  'Hey Orbi',
  'WSP',
  'whats good',
  'wassup',
  'hey there',
  'hello?',
  'you there?',
  'im back',
  'nice to meet you',
  'hey hey hey',
  'hey whats up',
  'morning orbi',
  'yo orbi',
  '👋',
];

const IDENTITY = [
  'who are you',
  'who r u',
  'whats good who are you',
  'hey, who are you?',
  'what are you',
  'what is this',
  "what's this app",
  'who is this',
  'tell me about yourself',
  "what's your name",
  'Who are you?',
  'yo who are you',
];

const AM_I_A_BOT = [
  'are you a bot',
  'are you human',
  'are you real',
  'is this a bot',
  'are you chatgpt',
  'what model are you',
  'who made you',
  'what version are you',
  'how old are you',
  'where are you from',
  'do you sleep',
  'whats your favorite color',
  'r u a robot',
];

const ABILITY = [
  'what can you do',
  'what do you do',
  'help',
  'help me out',
  'how does this work',
  'what can u do',
  'Hi Orbi, what can you help me with today?',
  'what is orbit for',
  'can you help me',
  'where do i start',
  'idk',
  'i dont know what to do',
  'you decide',
  'surprise me',
  'how am i doing',
  'am i behind',
];

const THANKS = [
  'thanks',
  'thank u',
  'ty',
  'thx',
  'tysm',
  'cheers',
  'gracias',
  'merci',
  'Thank you!',
  'ok thanks',
  'haha thanks',
  'k thx',
  'wow thanks',
  'thanks anyway',
  'appreciate it',
  'thanks so much orbi',
  '🙏',
];

const ACKS = [
  'ok',
  'k',
  'kk',
  'cool',
  'got it',
  'bet',
  'word',
  'aight',
  'sounds good',
  'sure thing',
  'say less',
  'hmm ok',
  'lol ok',
  'ok ok',
  'nice nice',
  'oh',
  'hmm',
  'mhm',
  'noted',
  'facts',
  'true',
  'fair enough',
  'whatever',
  'meh',
  'my bad',
  'sorry',
  'oops',
];

const LAUGHS = [
  'lol',
  'lmao',
  'lmaooo',
  'haha',
  'hahaha',
  'xd',
  '😂',
  'wow',
  'omg',
  'damn',
  'no way',
  'sheesh',
  'yikes',
  'really?',
  'are you sure',
  'fr?',
  "you're the best",
  'good bot',
];

const HOW_ARE_YOU = [
  'how are you',
  'how r u',
  'hru',
  'hows it going',
  'how was your day',
  'you good?',
  'wyd',
  'hbu',
  'hey how r u',
  'hi orbi, how are you?',
  'not much',
  'nm u',
  'same',
  'im good thanks',
  'fine',
  'pretty good',
  'did you miss me',
  'whats up with you',
];

const FEELINGS = [
  "i'm stressed about recruiting",
  'im so behind',
  'i feel behind',
  'nobody replies',
  'nobody responds to me',
  'recruiting sucks',
  'im lonely',
  'im sad',
  'i feel dumb',
  'i suck at networking',
  'ugh',
  'im tired',
  'im overwhelmed',
  'im bored',
  'im nervous about my coffee chat tomorrow',
  'i got rejected',
  'i bombed my interview',
  'i got the offer',
  'i got an interview',
  'great news',
  'yeah im stressed',
  '😭',
  '🎉',
];

const FRUSTRATION = [
  'fuck this',
  'this is dumb',
  'ur useless',
  'you suck',
  'this app sucks',
  'wtf',
  'why are you so dumb',
  'thanks for nothing',
  'seriously',
  'thats not what i asked',
  'wrong',
  'huh?',
  'what?',
  'wait what',
  'i dont understand',
  'repeat that',
  'leave me alone',
  'shut up',
  '🙄',
];

const OFF_TOPIC = [
  "what's the weather",
  'whats the capital of france',
  'who won the game',
  'tell me a joke',
  'whats 2+2',
  'what time is it',
  'what day is it',
  'what year is it',
  'can you write my essay',
  'write me a poem',
  'an essay about networking',
  'play a game',
  'sing a song',
  'set a timer',
  'order me a pizza',
  'open spotify',
  'convert 5 miles to km',
  'love you',
  'are you single',
  'marry me',
  'send nudes',
  'is this free',
  'can i trust you',
  'will you spam people',
  'is my data safe',
  'necesito ayuda',
];

const GOODBYES = [
  'bye',
  'cya',
  'gn',
  'good night',
  'ok bye',
  'thx bye',
  'gtg',
  'ttyl',
  'peace',
  'brb',
  'one sec',
  'nvm',
  'not now',
  'im good',
  'thats all for today',
];

const NOISE = ['asdfgh', '???', '...', 'jkjkjk', '!', 'zxcv', 'qwerty'];

const SOCIAL: [string, string[]][] = [
  ['greetings', GREETINGS],
  ['who are you', IDENTITY],
  ['are you a bot', AM_I_A_BOT],
  ['what can you do', ABILITY],
  ['thanks', THANKS],
  ['acknowledgements', ACKS],
  ['laughs and reactions', LAUGHS],
  ['how are you', HOW_ARE_YOU],
  ['feelings', FEELINGS],
  ['frustration', FRUSTRATION],
  ['off topic', OFF_TOPIC],
  ['goodbyes', GOODBYES],
  ['noise', NOISE],
];
const ALL_SOCIAL = SOCIAL.flatMap(([, list]) => list);

// ---- the rules every reply holds ---------------------------------------------------------------------------------

/** the student's register: lowercase gets lowercase back (except I, names and products), capitals get capitals */
function expectRegister(utterance: string, text: string) {
  if (!text) return;
  // mixed case reads as careful typing; all caps ("WSP") is shouting slang and gets casual back
  const typedUpper =
    /\p{Lu}/u.test(utterance.replace(/\b(?:I|I'm|Orbi|Orbit)\b/g, '')) && /\p{Ll}/u.test(utterance);
  if (typedUpper) expect(text, `${utterance} -> ${text}`).toMatch(/^[A-Z\d]/);
  else
    expect(text, `${utterance} -> ${text}`).toMatch(
      /^(?:[a-z\d]|I\b|I'|Orbi|Alex|Priya|Daniel|Mei|LinkedIn|Gmail|Google|Stripe)/,
    );
}

function expectHuman(utterance: string, r: RouterIntent, text: string) {
  const label = `${utterance} -> ${JSON.stringify(r)}`;
  expect(r.kind, label).not.toBe('refuse');
  expect(text, label).not.toMatch(NOT_FOLLOWED_LEAD);
  expect(text, label).not.toMatch(/didn'?t catch|Try: "/);
  if (r.kind === 'tool') expect(['offer_choices', 'show_setup'], label).toContain(r.tool);
  expect(voiceProblems(text), label).toEqual([]);
  expect(text, label).not.toMatch(/\n|\*|#/);
  expect((text.match(/\?/g) ?? []).length, label).toBeLessThanOrEqual(1);
  expect(words(text), label).toBeLessThanOrEqual(48);
}

describe('Orbi on the no-key router: small talk', () => {
  it('covers well over a hundred ways students talk', () => {
    expect(new Set(ALL_SOCIAL).size).toBe(ALL_SOCIAL.length);
    expect(ALL_SOCIAL.length).toBeGreaterThanOrEqual(200);
  });

  for (const [group, list] of SOCIAL) {
    describe(group, () => {
      for (const [state, ctx] of CONTEXTS) {
        it.each(list)(
          `%s (${state}): a human line, never "I didn't catch that", in the student's register`,
          (u) => {
            const { r, text } = say(u, ctx);
            expectHuman(u, r, text);
            expectRegister(u, text);
            // Orbi's own line before any nudge: short, and shorter still for a short message
            const own = ownLine(text);
            expect(own.length, `${u} -> ${text}`).toBeLessThanOrEqual(3);
            if (words(u) <= 3) expect(words(own.join(' ')), `${u} -> ${text}`).toBeLessThanOrEqual(27);
            if (words(u) <= 2) expect(own.length, `${u} -> ${text}`).toBeLessThanOrEqual(2);
            // at most one nudge
            expect(
              sentences(text).filter((s) => /waiting to hear from you|ready to look at/.test(s)).length,
            ).toBeLessThanOrEqual(1);
            // a greeting or a thanks on an empty account leads to the setup step, never to pills that go nowhere
            if (ctx === EMPTY && r.kind === 'tool' && (group === 'greetings' || group === 'thanks'))
              expect(r.tool, `${u} -> ${text}`).toBe('show_setup');
          },
        );
      }
    });
  }

  it('every pill under a small-talk reply goes somewhere the router handles', () => {
    for (const u of ALL_SOCIAL)
      for (const [, ctx] of CONTEXTS)
        for (const o of say(u, ctx).options) {
          const r = routeUtterance(o.message, ctx);
          const text = r.kind === 'tool' ? (r.lead ?? '') : r.text;
          expect(r.kind, `${u}: pill "${o.label}" (${o.message})`).not.toBe('refuse');
          expect(text, `${u}: pill "${o.label}" (${o.message})`).not.toMatch(NOT_FOLLOWED_LEAD);
        }
  });

  it('introduces itself as Orbi and says plainly it is an AI, never "As an AI"', () => {
    for (const u of IDENTITY) expect(say(u).text, u).toMatch(/Orbi/);
    for (const u of AM_I_A_BOT) expect(say(u).text, u).toMatch(/\bAI\b|Orbi/);
    for (const u of ['are you a bot', 'are you human', 'are you real', 'is this a bot', 'r u a robot']) {
      expect(say(u).text, u).toMatch(/\bAI\b/);
      expect(say(u).text, u).not.toMatch(/as an ai/i);
    }
    expect(say('are you chatgpt').text).toMatch(/^nope/i);
  });

  it('answers a greeting with a greeting in the same register, then the one useful thing', () => {
    expect(say('wsp').text).toMatch(
      /^(?:hey Alex, not (?:much|a lot)|not much, Alex)\. 3 people are waiting to hear from you\. want to start there\?$/,
    );
    expect(say('Hello there!').text).toMatch(
      /^(?:Hey|Hi) Alex(?:, good to see you)?\. 3 people are waiting to hear from you\. Want to start there\?$/,
    );
    expect(say('good morning').text).toMatch(/^good morning Alex\. /);
    expect(say('hola').text).toMatch(/^hola Alex\. /);
    expect(say('whats good who are you').text).toMatch(
      /^(?:hey, not (?:much|a lot)|not much)\. (?:I'm Orbi, the AI in Orbit|Orbi, the AI inside Orbit)\. /,
    );
    expect(say('wsp').options.map((o) => o.label)).toEqual(['Show me', 'Not now']);
  });

  it('ties the nudge to something real: people waiting, a draft, or nothing at all', () => {
    expect(say('hey', FULL).text).toContain('3 people are waiting to hear from you');
    expect(say('hey', { ...FULL, cards: [{ id: 's1', personId: 'p1', kind: 'thank_you' }] }).text).toContain(
      'Priya is waiting to hear from you',
    );
    expect(
      say('hey', { ...IDLE, drafts: [{ id: 'd1', personId: 'p1', status: 'draft', kind: 'thank_you' }] })
        .text,
    ).toContain("you've got 1 draft ready to look at");
    // thanks, laughs and okays get a nudge only when something waits
    for (const u of ['thanks', 'lol', 'ok', 'cool', 'sorry', 'wow']) {
      expect(say(u, FULL).r, u).toMatchObject({ kind: 'tool', tool: 'offer_choices' });
      expect(say(u, IDLE).r.kind, u).toBe('text');
      expect(words(say(u, IDLE).text), u).toBeLessThanOrEqual(4);
    }
    // bad news gets sympathy and no sales pitch
    expect(say('i got rejected', FULL).r.kind).toBe('text');
    // the same pills offered last turn are not offered again
    const again = say('thanks', {
      ...FULL,
      thread: {
        choices: [
          { label: 'Show me', message: "What's on today?" },
          { label: 'Not now', message: 'Not now' },
        ],
      },
    });
    expect(again.r.kind).toBe('text');
    expect(words(again.text)).toBeLessThanOrEqual(4);
  });

  it('varies its lines instead of repeating one string', () => {
    const firstLines = (list: string[]) =>
      new Set(list.map((u) => ownLine(say(u).text).join(' ').toLowerCase()));
    expect(firstLines(GREETINGS).size).toBeGreaterThanOrEqual(4);
    expect(firstLines(THANKS).size).toBeGreaterThanOrEqual(3);
    expect(
      firstLines(['lol', 'lmao', 'haha', 'hahaha', 'xd', 'lmaooo', 'hehe', 'rofl']).size,
    ).toBeGreaterThanOrEqual(2);
    expect(
      firstLines(['fuck this', 'this is dumb', 'ur useless', 'you suck', 'this app sucks', 'wtf']).size,
    ).toBeGreaterThanOrEqual(2);
    // and the same message always gets the same line, so a student is not answered at random
    expect(say('hey').text).toBe(say('hey').text);
  });

  it('notices a feeling, says what is true, then one small step', () => {
    const stressed = say("i'm stressed about recruiting", FULL);
    expect(stressed.text).toMatch(/^recruiting is a lot\. let's do one small thing\. 3 people are waiting/);
    expect(say('nobody replies', FULL).text).toMatch(
      /^silence is the worst part, and it's rarely about you\./,
    );
    expect(say('i feel dumb', FULL).text).toMatch(/^you're not, this part is hard for everyone\./);
    expect(say('im so behind', IDLE).text).toMatch(
      /nothing's waiting on you today, so you're in better shape than it feels/,
    );
    expect(say('im nervous about my coffee chat tomorrow', FULL).options.map((o) => o.label)).toEqual([
      'Prep me',
      'Not now',
    ]);
    expect(say('i got the offer', FULL).text).toMatch(/congrats|great news|big/i);
  });

  it('takes rudeness without defensiveness or grovelling, and offers the closest real thing', () => {
    for (const u of [
      'fuck this',
      'this is dumb',
      'ur useless',
      'why are you so dumb',
      'thanks for nothing',
    ]) {
      const { r, text, options } = say(u, FULL);
      expect(r, u).toMatchObject({ kind: 'tool', tool: 'offer_choices' });
      expect(text, u).toMatch(/on me|I missed|didn't land|got that wrong/);
      expect(text, u).not.toMatch(/sorry you feel|I apologize|I understand your frustration/i);
      expect(text, u).toMatch(/like "write to Priya"/);
      expect(options.map((o) => o.label)).toEqual(["What's on today", 'Who went quiet', 'Show my drafts']);
    }
    expect(say('leave me alone').text).toMatch(/^okay\. I'll be here when you want me\.$/);
  });

  it('handles off-topic asks kindly and comes back to the work', () => {
    expect(say('tell me a joke').r.kind).toBe('text');
    expect(say('whats 2+2').text).toMatch(/^that's 4\. /);
    expect(say('what time is it').text).toBe("it's 2:05 PM.");
    expect(say('what day is it').text).toBe("it's Friday, October 23.");
    expect(say('what year is it').text).toBe("it's 2026.");
    expect(say("what's the weather").text).toMatch(/can't look that up from in here/);
    expect(say('can you write my essay').text).toMatch(/sit that one out/);
    expect(say('can you write my essay').options[0]).toEqual({
      label: 'Write to Priya',
      message: 'Write to Priya',
    });
    expect(say('love you').text).toMatch(/strictly business/);
    expect(say('send nudes').text).toMatch(/^I'll pass\./);
    expect(say('will you spam people').text).toMatch(/^never\. nothing goes out unless you approve/);
    expect(say('is this free').text).toMatch(/billing/);
    expect(say('necesito ayuda').text).toMatch(/only speak English/);
  });

  it('says goodbye like a person and leaves it there', () => {
    expect(say('bye').r.kind).toBe('text');
    expect(say('bye').text).toMatch(/Alex/);
    expect(say('gn').text).toMatch(/^night, Alex\./);
    expect(say('ok thanks bye').text).toMatch(/^anytime\. /);
    expect(say('brb').text).toBe('no rush.');
    expect(say('nvm').text).toMatch(/^(?:no problem|all good|okay)\. /);
    expect(say('Not now').text).toMatch(/^(?:No problem|All good|Okay)\. /);
  });

  it('reads a keyboard mash as noise, not as a name', () => {
    for (const u of NOISE) {
      const { text } = say(u);
      expect(text, u).toMatch(/not sure what that was|got past me/i);
    }
  });

  it('answers an empty-ish message without a lecture', () => {
    for (const u of ['.', '..', '?', '!!', '🙂', '👍', '...?']) {
      const { r, text } = say(u);
      expectHuman(u, r, text);
    }
  });
});

describe('Orbi on the no-key router: small talk in front of a real ask', () => {
  it.each([
    ['hey can you find me someone at stripe', 'search_people'],
    ['hey! can you find me someone at stripe?', 'search_people'],
    ['yo show my pipeline', 'list_pipeline'],
    ['hey who went quiet', 'list_pipeline'],
    ['thanks, show my drafts', 'list_drafts'],
    ["cool, what's on today", 'get_today_brief'],
    ['hey whats up can u show my drafts', 'list_drafts'],
    ['thank you! now show my pipeline', 'list_pipeline'],
    ['hi there can you draft a thank you to priya', 'create_draft'],
    ['good morning! who should i reach out to today?', 'get_today_brief'],
    ['hey orbi who do i know at stripe', 'find_routes'],
    ['lol ok who is Priya', 'get_person'],
    ['sorry, show my drafts', 'list_drafts'],
    ['great, now who went quiet', 'list_pipeline'],
    ['cool thanks, who is Daniel', 'get_person'],
    ['wsp orbi, write to Priya', 'create_draft'],
    ['hey whats good, follow up with Daniel', 'create_draft'],
    ['ok show my drafts', 'list_drafts'],
    ['hey can you move Priya to scheduling', 'move_pipeline_stage'],
    ['hi, note about Priya: she suggested the PM team', 'add_note'],
    ['hello who is priya', 'get_person'],
    ["hey orbi, what's on today", 'get_today_brief'],
    ['yes', 'get_today_brief'],
    ['sure', 'get_today_brief'],
    ['yeah', 'get_today_brief'],
  ])('%s -> %s, not small talk', (u, tool) => {
    expect(routeUtterance(u, FULL)).toMatchObject({ kind: 'tool', tool });
  });

  it('strips only the social part and keeps the ask as typed', () => {
    expect(readSocial('yo show my pipeline').rest).toBe('show my pipeline');
    expect(readSocial('thanks, show my drafts').rest).toBe('show my drafts');
    expect(readSocial('Hey Orbi, who is Priya Patel?').rest).toBe('who is Priya Patel?');
    expect(readSocial('hey whats up').act).toBe('greet');
    expect(readSocial('hey whats up who are you').act).toBe('identity');
    expect(readSocial('ok thanks bye').act).toBe('bye');
    expect(readSocial('ok thanks bye').also).toContain('thanks');
    // a bare yes is the router's answer to its last question, never small talk
    expect(readSocial('yes').act).toBeUndefined();
    expect(readSocial('sure').act).toBeUndefined();
    // "wait a week" and "and Dan?" are follow-ups the router reads, not fillers
    expect(readSocial('wait a week').act).toBeUndefined();
    expect(readSocial('and Dan?').act).toBeUndefined();
    expect(readSocial('and Dan?').rest).toBeUndefined();
  });

  it('never mistakes a command for small talk', () => {
    for (const u of [
      'write to Priya',
      'draft a thank you to Priya',
      'who went quiet',
      "what's on today",
      'show my pipeline',
      'move Priya to scheduling',
      'note about Priya: she suggested the PM team',
      'who do I know at Stripe',
      'add person Jordan Lee at Figma',
      'send my draft to Priya',
      'help me write to Priya',
      'open my pipeline',
      'stop syncing my linkedin',
      'what should I send Daniel next',
    ])
      expect(readSocial(u).act, u).toBeUndefined();
  });
});
