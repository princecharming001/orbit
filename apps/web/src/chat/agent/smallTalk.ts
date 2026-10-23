import type { ChoiceOption } from '../types';
import type { RouterIntent } from './router';

/**
 * Small talk for the no-key router, in Orbi's voice (docs/plan/19-orbi-persona.md). A student says "wsp", "who are
 * you", "lol", "this is dumb" or "tell me a joke" the way they would to a person, so Orbi answers like one: a short
 * line in the student's own register, then at most one nudge from their real state, with pills only when there is
 * something to tap. It reads whole messages, never a word inside a command, so "yo show my pipeline" loses the "yo"
 * and runs, "thanks, show my drafts" loses the "thanks", and "write to Priya" is never mistaken for an essay.
 *
 * The lines vary: each act has a few, and the message picks one (a hash, so the same message always gets the same
 * line and tests can hold it still).
 */

export type SocialAct =
  | 'greet'
  | 'here'
  | 'back'
  | 'meet'
  | 'missme'
  | 'identity'
  | 'bot'
  | 'human'
  | 'model'
  | 'personal'
  | 'trust'
  | 'spam'
  | 'pricing'
  | 'ability'
  | 'idk'
  | 'vague'
  | 'progress'
  | 'howareyou'
  | 'wyd'
  | 'fine'
  | 'chill'
  | 'thanks'
  | 'compliment'
  | 'ack'
  | 'laugh'
  | 'wow'
  | 'really'
  | 'meh'
  | 'sorry'
  | 'goodnews'
  | 'badnews'
  | 'bye'
  | 'brb'
  | 'notnow'
  | 'stop'
  | 'frustrated'
  | 'missed'
  | 'huh'
  | 'repeat'
  | 'stressed'
  | 'nervous'
  | 'bored'
  | 'flirt'
  | 'crude'
  | 'joke'
  | 'math'
  | 'time'
  | 'date'
  | 'schoolwork'
  | 'lookup'
  | 'cant'
  | 'game'
  | 'foreign'
  | 'noise';

export interface Social {
  /** what the message does socially; undefined when it is (or ends in) a real ask */
  act?: SocialAct;
  /** the greeting it opened with, as said ("wsp", "good morning", "hola") */
  greeting?: string;
  /** the ask after a greeting or a filler ("yo show my pipeline" -> "show my pipeline"), for the router instead */
  rest?: string;
  /** typed like a text (lowercase, slang): Orbi answers in lowercase too */
  casual: boolean;
  /** the word to echo back ("hola", "gracias"), or the answer to a sum */
  echo?: string;
  /** the part of the message the act was read from, for picking one of several lines */
  said?: string;
  /** fillers that came before the act ("ok thanks bye": ok and thanks before the bye) */
  also?: SocialAct[];
}

/** One thing worth doing now, from the student's real state. */
export interface Nudge {
  statement: string;
  question: string;
  options: ChoiceOption[];
}

export interface SmallTalkKit {
  firstName?: string;
  /** nobody in the account yet: the next step is a setup widget */
  empty: boolean;
  nudge: Nudge;
  /** nothing waits on the student: the nudge is only a look at their chats */
  idle: boolean;
  /** the same pills were offered in the last turn, so they are not offered again */
  nudged: boolean;
  /** the student's closest person, for "write to Priya" pills */
  topName?: string;
  /** names that keep their capital letter in a lowercase reply */
  names: string[];
  now: Date;
  choose: (statement: string, question: string, options: ChoiceOption[]) => RouterIntent;
  offer: (lead: string, options: ChoiceOption[], fallback: string) => RouterIntent;
  emptyNext: (lead: string) => RouterIntent;
}

// ---- reading the message ----------------------------------------------------------------------------------------

const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_ALL = /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}|\u{20E3})/gu;

/** lower case, no accents, no apostrophes, punctuation as spaces, "hiiii" as "hii", emoji out */
export function normalize(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(EMOJI_ALL, ' ')
    .toLowerCase()
    .replace(/[‘’'`´]/g, '')
    .replace(/[^\p{L}\p{N}+\-*/×÷.\s]/gu, ' ')
    .replace(/(?<![\d])[.](?![\d])/g, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Who Orbi might be called at the end of a greeting: "hey orbi", "yo bro", "hi there", "hello again". */
const VOCATIVE =
  '(?: (?:orbi|orbit|bro|bruh|dude|man|girl|sis|bestie|fam|there|friend|buddy|pal|mate|yall|everyone|again|chat|my (?:friend|guy|man|dude)))*';

/** Greeting words, longest first where one starts another. The sup family is answered with "not much". */
const SUP =
  'wh?a+t?s+u+p+|wh?ats+ up+|what is up|wassup+|wazzup+|whaddup+|whatup+|wsp+|wsg|sup+|s+u+p+|whats good|what is good|whats poppin(?:g)?|whats happening|whats crackin(?:g)?|whats the word|hows it hanging';
const MORNING = 'gm|good (?:morning|afternoon|evening|day)|morning|mornin|afternoon|evening|gday';
const FOREIGN_HELLO =
  'hola|ola|bonjour|salut|ciao|hallo|servus|oi|hej|namaste|konnichiwa|ni ?hao|annyeong|shalom|marhaba|privet|你好|您好|こんにちは|안녕|안녕하세요|привет|مرحبا|नमस्ते';
const HELLO = `h+i+|h+e+y+(?: h+e+y+)?|hello+|helo+|hullo|ello+|hiya+|heya+|hey+a|heyo+|a+y+y*o*|ayo+|howdy|yo+|y+o+|greetings|salutations|aloha|${FOREIGN_HELLO}`;
const GREETING = new RegExp(`^(${SUP}|${MORNING}|${HELLO})${VOCATIVE}(?: |$)`);
const SUP_RE = new RegExp(`^(?:${SUP})$`);
const MORNING_RE = new RegExp(`^(?:${MORNING})$`);
const FOREIGN_HELLO_RE = new RegExp(`^(?:${FOREIGN_HELLO})$`);

/**
 * Words that come before the point of a message and are not it: "lol ok", "thanks, show my drafts", "sorry, who
 * went quiet". Each maps to the act it would be on its own, or to nothing for a "yes" that the router reads as an
 * answer to its last question.
 */
const FILLER =
  /^(thanks+|thank (?:you|u)|thx+|ty+|tysm|cheers|lo+l+|lmao+|lmfao+|haha+|ha+|hehe+|ok+|okay+|k+|kk+|cool+|nice+|great|awesome|perfect|alright|aight|ight|sweet|bet|got it|gotcha|sounds good|yes|yeah+|yep|yup|sure|wow+|omg|oh+|ah+|um+|uh+|hmm+|hm+|sorry|sry|my bad|mb|oops|whoops)(?: |$)/;
const CONNECTIVE = /^(?:now|so|then|also|and|and now|ok so|but)(?: )/;

function fillerAct(word: string): SocialAct | undefined {
  if (/^(?:thanks+|thank (?:you|u)|thx+|ty+|tysm|cheers)$/.test(word)) return 'thanks';
  if (/^(?:lo+l+|lmao+|lmfao+|haha+|ha+|hehe+)$/.test(word)) return 'laugh';
  if (/^(?:wow+|omg)$/.test(word)) return 'wow';
  if (/^(?:sorry|sry|my bad|mb|oops|whoops)$/.test(word)) return 'sorry';
  if (/^(?:yes|yeah+|yep|yup|sure)$/.test(word)) return undefined;
  if (/^(?:oh+|ah+|um+|uh+|hmm+|hm+)$/.test(word)) return undefined;
  return 'ack';
}

/** The act that counts when a message is only fillers ("ok thanks" is thanks, "lol ok" is an okay). */
const SALIENCE: SocialAct[] = ['thanks', 'sorry', 'wow', 'laugh', 'ack'];

const RULES: [SocialAct, RegExp][] = [
  // are you there
  [
    'here',
    /^(?:you there|u there|are (?:you|u) there|r u there|anyone (?:there|home)|anybody (?:there|home)|anyone|anybody|is (?:anyone|anybody) there|is this (?:thing )?(?:working|on)|does this (?:thing )?work|testing|test|testing 123|testing testing|mic check|hello world|hello anyone|ping|lets chat|wanna chat|can we chat|talk to me|im lonely talk to me|chat with me|just checking in|checking in|just saying hi|saying hi|just wanted to say hi)$/,
  ],
  ['back', /^(?:im back|i am back|back|its me again|me again|guess whos back)$/],
  [
    'meet',
    /^(?:nice to meet (?:you|u)|good to meet (?:you|u)|pleased to meet (?:you|u)|pleasure|nice meeting (?:you|u))$/,
  ],
  ['missme', /^(?:did (?:you|u) miss me|miss me|missed me|(?:you|u) miss me)$/],
  // who and what Orbi is
  [
    'bot',
    /^(?:are|r) (?:you|u|ya) (?:a |an )?(?:bot|robot|ai|a i|chat ?bot|machine|program|computer|assistant|virtual assistant)(?: or (?:a )?(?:human|person|real))?$|^is this (?:a )?(?:bot|robot|ai|chat ?bot|automated|a real person|real|human)$|^am i (?:talking|speaking|chatting|texting) (?:to|with) (?:a )?(?:bot|robot|ai|machine|computer|real person|human|person)$|^(?:you|u)(?:re| are| r)? (?:a )?(?:bot|robot|ai)$/,
  ],
  [
    'human',
    /^(?:are|r) (?:you|u|ya) (?:a )?(?:human|real|real person|a real person|person|alive|sentient|conscious|a person)$/,
  ],
  [
    'model',
    /^(?:are|r) (?:you|u) (?:chat ?gpt|gpt|claude|siri|alexa|gemini|copilot|an llm|a llm)$|^(?:what|which) (?:model|ai|llm|gpt|version)(?: are you| is this| do you (?:use|run on)| powers you| runs you)?$|^(?:who|what) (?:made|built|created|trained|powers) (?:you|u|this)$|^what version (?:are|r) (?:you|u)$/,
  ],
  [
    'identity',
    /^(?:who|what) (?:are|r) (?:you|u|ya)(?: exactly| even| again| tho| though| anyway| lol)?$|^(?:who|wh?o)s (?:this|that|orbi)$|^who is (?:this|that|orbi)$|^(?:whats|what is) (?:this|orbi|this thing|this app|orbit)$|^who is orbit$|^who am i (?:talking|speaking|chatting|texting) (?:to|with)$|^(?:(?:whats|what is) )?(?:your|ur|yo) name$|^(?:do )?(?:you|u) have a name$|^introduce yourself$|^tell me (?:about )?(?:yourself|you)$|^what do you do$|^what do (?:you|u) do here$/,
  ],
  [
    'personal',
    /^(?:how old are (?:you|u)|whats your age|where (?:are|r) (?:you|u) from|where do (?:you|u) live|where are (?:you|u)|are (?:you|u) (?:a )?(?:boy|girl|guy|man|woman|male|female)|(?:whats|what is) your (?:gender|pronouns?|favou?rite \w+|sign)|do (?:you|u) (?:have feelings|feel|sleep|eat|dream|get tired|have a body|have friends|have a life|like your job|get bored|go to school|have a (?:family|mom|dad|girlfriend|boyfriend|pet|dog|cat))|are (?:you|u) a student|what school do (?:you|u) go to|what do (?:you|u) (?:like|do for fun)|do (?:you|u) like (?!me\b)\w+|how was your weekend|what are (?:you|u) doing this weekend)$/,
  ],
  [
    'spam',
    /^(?:will (?:you|u|this|orbit) (?:spam|message|email|text|contact|dm) (?:people|them|anyone|my (?:contacts|people|network))(?: for me| on my behalf| without asking)?|do (?:you|u) (?:send|message|email) (?:people|stuff|anything|things) (?:on your own|without asking|automatically|by yourself)|are (?:you|u) going to spam (?:people|anyone)|(?:you|u) wont spam (?:people|anyone)(?: right)?)$/,
  ],
  [
    'trust',
    /^(?:can i trust (?:you|u|this)|is this (?:safe|legit|secure|private)|are (?:you|u) safe|is my (?:data|info|information|stuff) (?:safe|private|secure)|do (?:you|u) sell my data|who sees my data|where does my data go|is this private|do (?:you|u) (?:read|see) my (?:emails?|messages))$/,
  ],
  [
    'pricing',
    /^(?:is (?:this|it|orbit) free|how much (?:does (?:this|it|orbit) cost|is (?:this|it|orbit))|do i have to pay|whats the price|is there a (?:price|cost|fee|subscription)|is this (?:paid|a paid thing))$/,
  ],
  // what Orbi can do
  [
    'ability',
    /^(?:help|help me|help pls|help please|pls help|please help|i need help|need help|can (?:you|u) help(?: me)?|can (?:you|u) help me out|help me out(?: here)?|what can (?:you|u) do(?: for me| here)?|what (?:else )?can (?:you|u) do|what do (?:you|u) do(?: exactly)?|what can i (?:say|ask|do)(?: here)?|what are (?:you|u) for|what are (?:you|u) here for|whats the point|what is this for|whats (?:this|orbit) for|what is orbit for|how does (?:this|it|orbi|orbit) work|how do i use (?:this|you|it|orbi|orbit)(?: thing)?|how do i (?:start|begin)|where do i (?:start|begin)|what now|now what|what should i ask|what should i do here|what are my options|how can (?:you|u) help(?: me)?|what are (?:you|u) good at|what can (?:you|u) help(?: me)? with(?: today)?|what do (?:you|u) help with)$/,
  ],
  [
    'idk',
    /^(?:idk|i dont know|i dunno|dunno|no idea|not sure|idk what to do|i dont know what to do|idk where to start|im not sure|no clue|i have no idea)$/,
  ],
  [
    'vague',
    /^(?:anything|something|something else|you decide|you pick|u pick|surprise me|dealers choice|whatever you think|whatever (?:you|u) think is best|your call|idk you (?:pick|decide|choose)|you choose)$/,
  ],
  [
    'progress',
    /^(?:how am i doing|am i doing (?:good|ok|okay|well|alright)|am i behind|am i on track|how(?:s| is) my (?:network|networking|progress|recruiting)(?: going| looking)?|whats my progress|rate my network|hows it looking|where do i stand|where am i at|how far along am i)$/,
  ],
  // how are you
  [
    'wyd',
    /^(?:wyd|what (?:are|r) (?:you|u) (?:doing|up to)|what (?:you|u) (?:doing|up to)|whatcha (?:doing|up to)|what are you up to|whats up with (?:you|u))$/,
  ],
  [
    'howareyou',
    /^(?:how (?:are|r) (?:you|u|ya)(?: doing| today| doin| holding up)?|how(?:s| is) it goin(?:g)?|how (?:you|u|ya) doin(?:g)?|howre (?:you|u)|how(?:ve| have) (?:you|u) been|how (?:you|u) been|hru|hbu|wbu|and (?:you|u)|what about (?:you|u)|how about (?:you|u)|how(?:s| is| was) (?:your|ur) (?:day|morning|evening|night|week)(?: going| been)?|how(?:s| is) life|how are things(?: with you)?|(?:you|u) good|(?:you|u) ok(?:ay)?|everything (?:good|ok|okay)(?: with you)?|que tal|como estas|ca va|comment ca va|wie gehts|wie geht es dir)$/,
  ],
  [
    'fine',
    /^(?:good|great|not bad|pretty good|doing good|doing well|fine|alright thanks|good thanks|good hbu|good wbu|good you|im good thanks|im great|im fine|im alright|im doing (?:good|well|fine|ok|okay))$/,
  ],
  [
    'chill',
    /^(?:not much|nothing much|nm|nm (?:u|hbu|wbu)|not much (?:u|hbu|wbu)|not a lot|nothing really|same|same here|chillin|chilling|just chillin|just chilling|vibing|just vibing|just here|all good (?:hbu|wbu)|not much just (?:chilling|chillin|studying|working))$/,
  ],
  // thanks and nice words
  [
    'thanks',
    /^(?:(?:thanks+|thank (?:you|u|ya)|thx+|ty+|tysm|tyvm|thnx|thanx|tks|cheers)(?: so much| very much| a lot| a ton| again| anyway| though| tho| for (?:that|this|the help))?(?: orbi| orbit| bro| man| dude| bestie)?|ok(?:ay)? (?:thanks+|thank you|ty)|cool (?:thanks+|ty)|many thanks|much appreciated|appreciate (?:it|you|that|ya)|i appreciate (?:it|you|that)|gracias|merci(?: beaucoup)?|danke(?: schon)?|obrigad[oa]|arigato|grazie)$/,
  ],
  [
    'compliment',
    /^(?:(?:you|u)(?:re| are| r)? (?:the best|a lifesaver|amazing|awesome|great|so helpful|helpful|smart|goated|the goat|a legend|so good|good at this)|ur (?:the best|amazing|awesome|a lifesaver)|goat|legend|lifesaver|big w|w|love (?:this|it)|i love this(?: app)?|this is (?:great|amazing|awesome|sick|fire|cool|nice|so good|helpful)|nice work|good job|well done|good bot|great job)$/,
  ],
  [
    'laugh',
    /^(?:lo+l+(?: ?o+l+)*|lmao+|lmfao+|rofl|ha+|(?:ha)+h?|a?(?:ha){2,}h?|he(?:he)+|xd+|jaja+|kek|dead|im dead|im crying|lolol)$/,
  ],
  ['wow', /^(?:wow+|damn+|dang|omg+|oh my god|wild|crazy|no way|whoa+|woah+|sheesh|yikes|oof+)$/],
  [
    'really',
    /^(?:really|for real|fr|frfr|srsly|are (?:you|u) sure|(?:you|u) sure|are (?:you|u) (?:kidding|serious|joking|for real)|wait really|really tho|really though)$/,
  ],
  [
    'meh',
    /^(?:whatever|meh|eh|fine whatever|whatever (?:dude|man|bro)|idc|i dont care|dont care|i guess|if (?:you|u) say so|sure whatever|ok whatever)$/,
  ],
  [
    'sorry',
    /^(?:sorry|sry|my bad|mb|oops|whoops|apologies|my mistake|sorry about that|sorry for that|sorry lol|oops sorry|sorry sorry)$/,
  ],
  [
    'ack',
    /^(?:ok+|okay+|okie|okey|k+|kk+|cool+|nice+|awesome|perfect|got it|gotcha|got you|gotchu|sounds good|alright|aight|ight|sweet|neat|bet|word|fair|fair enough|true|facts|makes sense|i see|oh|ohh|ah+|oh ok(?:ay)?|ok cool|cool cool|nice one|dope|sick|fire|slay|mhm+|hm+|interesting|noted|understood|roger(?: that)?|copy(?: that)?|good to know|got it thanks|de nada|no problem|np|sure thing|for sure|of course|will do|sounds like a plan|say less|okie dokie|alrighty|righto|cool beans|right)$/,
  ],
  [
    'goodnews',
    /^(?:i got (?:the |an |a )?(?:offer|job|internship|interview|return offer|callback|role|position)(?: at .{1,30})?|i got in|i passed|we did it|great news|good news|im so happy|im excited|so excited|woohoo+|lets go+|yay+|lfg|im hyped|i did it|it worked|they said yes|i got it)$/,
  ],
  [
    'badnews',
    /^(?:i got rejected|got rejected|rejected|i didnt get (?:it|the job|the offer|the internship|in|the role)|they (?:said no|rejected me|passed on me|ghosted me|went with someone else)|i got ghosted|got ghosted|bad news|i bombed (?:my |the )?(?:interview|chat|call)|that went badly|it went badly|no offer|she said no|he said no|i failed)$/,
  ],
  // goodbyes
  [
    'bye',
    /^(?:bye+|bye bye|cya|see ya|see (?:you|u)(?: later| tomorrow| soon| around)?|ttyl|talk (?:to you )?(?:later|soon|tomorrow)|chat later|gtg|g2g|gotta go|got to go|gotta run|got to run|heading out|im heading out|good ?night|gn|nite|night|peace(?: out)?|im out|im off|catch (?:you|u|ya) later|later gator|laters|thats all(?: for (?:now|today))?|that is all|thats it(?: for (?:now|today))?|im done(?: for (?:now|today))?|done for (?:now|today)|signing off|adios|goodbye|bye for now|ok bye|k bye|alright bye)$/,
  ],
  ['brb', /^(?:brb|be right back|one sec|1 sec|hold on|give me a sec|gimme a sec|wait|one moment|hang on)$/],
  [
    'stop',
    /^(?:leave me alone|go away|shut up|stop talking|stop it|enough|thats enough|stop messaging me|stop texting me|stop bugging me|stop asking|stop nagging(?: me)?)$/,
  ],
  // frustration
  [
    'missed',
    /^(?:wrong|nope wrong|thats wrong|thats not right|not what i (?:asked|said|meant|wanted)|thats not what i (?:asked|asked for|said|meant|wanted)|(?:you|u) (?:dont|didnt) (?:get it|understand)|(?:you|u) misunderstood|wrong again|read what i said|are (?:you|u) even listening)$/,
  ],
  [
    'repeat',
    /^(?:repeat that|say that again|say again|come again|what did (?:you|u) (?:just )?say|one more time|can (?:you|u) repeat that)$/,
  ],
  [
    'huh',
    /^(?:huh+|what+|wut|wat|wait what|wait huh|what do you mean|what does that mean|what are you (?:talking about|saying)|i dont get it|i didnt get that|i dont understand|im not following|confused|im confused|im lost|lost|that makes no sense|makes no sense|no sense|that (?:didnt|doesnt) make sense|what was that|whats that mean)$/,
  ],
  [
    'frustrated',
    /^(?:(?:this|that|it|you|u|ur|orbi|orbit|this app|this thing)(?:re|s| is| are| r)? (?:so |really |actually |kinda |literally |honestly |fucking |fr |pretty )?(?:dumb|stupid|useless|trash|garbage|bad|terrible|awful|annoying|pointless|broken|worthless|the worst|ass|mid|a joke|a waste of time)(?: fr| lol| tbh| af| ngl)?|(?:you|u|this|it|this app) (?:suck|sucks|blow|blows)|(?:this|that|it) (?:doesnt|dont|isnt|aint) (?:work|working|help|helping)|(?:you|u)(?:re| are)? not (?:helping|helpful|useful)|not helpful|unhelpful|wtf+|what the (?:hell|heck|fuck|f)|ffs|smh|bruh+|bad bot|useless|stupid|dumb|trash|i hate (?:this|you|it|this app)|are (?:you|u) (?:dumb|stupid|serious|kidding me|broken)|seriously|cmon|come on|can (?:you|u) even (?:read|understand)|do (?:you|u) even (?:work|understand)|thanks for nothing|waste of time|this is a waste of time|(?:you|u) (?:never|keep) (?:understand|getting it wrong|missing it)|worst app ever|fuck this|fuck it|screw this|forget this)$/,
  ],
  [
    'nervous',
    /^(?:(?:im|i am|i feel|feeling|so|kinda|really|lowkey|honestly) )*(?:nervous|anxious|scared|freaking out|stressing|stressed|worried) (?:about|for|bc of|because of) (?:my |the |this |tomorrows |todays )?(?:coffee chat|chat|call|interview|meeting|phone screen|intro call|conversation)(?: (?:tomorrow|today|later|tonight|this week|with .{1,30}))?$/,
  ],
  [
    'stressed',
    /^(?:(?:im|i am|i feel|feeling|so|kinda|really|lowkey|honestly) )*(?:stressed|anxious|nervous|overwhelmed|behind|tired|exhausted|burnt out|burned out|sad|lost|stuck|scared|worried|freaking out|panicking|lonely|so behind|done with recruiting|down|not ok|not okay|struggling|drowning)(?: out)?(?: lol| tbh| rn| ngl| fr)?$|^(?:ugh+|fml|this is hard|this is too much|its too much|recruiting is (?:hard|rough|brutal|exhausting)|recruiting sucks|i hate recruiting|networking is (?:hard|awkward|scary)|networking sucks|i suck at (?:this|networking)|(?:nobody|no one) (?:replies|responds|writes back|answers|is replying|is responding|gets back to me|ever replies)(?: to me)?|i feel ignored|i feel (?:dumb|stupid|useless|like a failure|hopeless|like giving up)|everyone is ahead of me|im falling behind|i want to give up|i give up)$/,
  ],
  [
    'stressed',
    /^(?:im|i am|i feel|feeling|i get)(?: so| really| kinda| super| lowkey| pretty)? (?:stressed|anxious|nervous|overwhelmed|behind|worried|scared|burnt out|burned out|freaking out)(?: (?:about|with|on|over|for) .{1,40})?$/,
  ],
  ['bored', /^(?:(?:im|i am|so|kinda) )*bored(?: lol| af| rn)?$/],
  // flirting
  ['crude', /^(?:send nudes|nudes|(?:you|u) up|wanna (?:hook up|fuck|bang)|sex|sexy time|dtf)$/],
  [
    'flirt',
    /^(?:i (?:love|like) (?:you|u)(?: orbi)?|ily+|love (?:you|u|ya)|luv (?:u|you|ya)|(?:will you )?marry me|(?:you|u|ur)(?:re| are| r)? (?:so )?(?:cute|hot|sexy|pretty|beautiful|handsome|adorable)|are (?:you|u) single|(?:wanna|want to|will you|can we|would you) (?:date|go out|go on a date)(?: with me)?|date me|kiss me|be my (?:girlfriend|boyfriend|gf|bf|valentine|bestie)|do (?:you|u) (?:love|like) me|hey (?:cutie|babe|baby|bae|sexy)|cutie|babe|bae)$/,
  ],
  // off-topic
  [
    'joke',
    /^(?:tell (?:me )?(?:a |another |one more )?joke|(?:a )?joke(?: pls| please)?|jokes|say something funny|make me laugh|(?:got|know|have) any jokes|be funny|tell me something funny|cheer me up)$/,
  ],
  [
    'time',
    /^(?:what time is it(?: now)?|whats the time|what is the time|time|current time|do you know (?:what )?time it is)$/,
  ],
  [
    'date',
    /^(?:whats the date(?: today)?|what is the date(?: today)?|what day is (?:it|today)(?: today)?|todays date|whats todays date|what is todays date|date today|what is today|whats the day|what year is it|whats the year)$/,
  ],
  [
    'schoolwork',
    /^(?:can (?:you|u) |could (?:you|u) |pls |please |help me )?(?:write|do|finish|make|draft|solve|help (?:me )?with|help (?:me )?write|proofread|grade) (?:my |an |a |the |this |me an? )?(?:\w+ )?(?:essay|homework|hw|assignment|problem set|pset|paper|lab report|book report|thesis|discussion post|code|program|script|poem|song|story|rap|haiku|limerick|exam|quiz|midterm)s?\b.*$|^an? (?:essay|poem|paper|story|song|rap|haiku)(?: about .*)?$/,
  ],
  [
    'lookup',
    /^(?:(?:whats|what is|hows|how is) (?:the )?(?:weather|forecast|news|score)\b.*|will it (?:rain|snow)\b.*|who won\b.*|(?:whats|what is) the (?:capital|population|meaning) of\b.*|(?:whats|what is) (?:bitcoin|btc|eth|the stock market|the s ?p|\w+ stock)(?: at| price| doing)?|who is the president\b.*|weather|news|sports|stocks|convert \d.*|define \w+|whats the definition of .*|how (?:tall|far|old|big) is .*|what time is it in .*)$/,
  ],
  [
    'cant',
    /^(?:set (?:a |an )?(?:timer|alarm)(?: for .*)?|order (?:me )?(?:a |some )?\w+|call (?:my|me|a|an) .*|text my .*|play (?:music|a song|some music|spotify).*|open (?:spotify|youtube|netflix|instagram|insta|tiktok|twitter|snapchat|maps|google maps|chrome|safari)|google (?:it|that|this)|search the web(?: for .*)?|look it up online|turn (?:on|off) the lights|whats the wifi password)$/,
  ],
  [
    'game',
    /^(?:(?:lets|wanna|want to|can we) play(?: a game)?(?: .*)?|play a game|sing(?: me)?(?: a song)?|tell me a (?:story|riddle|fun fact)|riddle|fun fact|entertain me)$/,
  ],
  [
    'foreign',
    /^(?:necesito ayuda|ayuda|ayudame|puedes ayudarme|me puedes ayudar|hablas (?:espanol|ingles)|habla espanol|que puedes hacer|parlez vous (?:anglais|francais)|tu parles (?:francais|anglais)|aide moi|sprichst du (?:deutsch|englisch)|hilfe|voce fala portugues|ajuda)$/,
  ],
];

const SLANG =
  /\b(?:wsp+|wsg|sup+|yo+|lol+|lmao+|lmfao|bruh+|ty|thx|tysm|k+|kk|gm|gn|hbu|wbu|wyd|ngl|fr|bet|aight|ight|idk|smh|ffs|wtf|brb|ttyl|gtg|ily|u|ur|r|rn|tbh|af|cya|nvm|pls|plz)\b/;

/** Read a message for small talk. A command (or anything Orbi does not recognise as social) has no act. */
export function readSocial(raw: string): Social {
  const n = normalize(raw);
  const hasUpper = /\p{Lu}/u.test(raw.replace(/\b(?:I|I'm|I'd|I've|I'll|Orbi|Orbit)\b/g, ''));
  const casual = !hasUpper || (SLANG.test(n) && n.split(' ').length <= 6);
  const emojiOnly = !n && EMOJI.test(raw);
  if (emojiOnly) return { act: emojiAct(raw), casual: true };
  // a stray tap is noise; a blank send is the router's (it answers with what it can do)
  if (!n) return /\S/.test(raw) ? { act: 'noise', casual } : { casual };
  const sum = mathOf(raw);
  if (sum !== undefined) return { act: 'math', casual, echo: sum, said: n };

  // greetings and fillers come off the front until what is left is a whole social act, a command, or nothing
  let rest = n;
  let greeting: string | undefined;
  const also: SocialAct[] = [];
  // "yes mark done" is the router's whole ("yes" confirms); "yeah im stressed" is still read for the feeling
  let yesOnly = false;
  for (let i = 0; i < 5; i++) {
    const act = ruleAct(rest);
    if (act) {
      return {
        act,
        greeting,
        casual,
        echo: act === 'thanks' ? thanksEcho(rest) : undefined,
        said: rest,
        also: also.length ? also : undefined,
      };
    }
    const g = rest.match(GREETING);
    if (g) {
      greeting ??= g[1]!;
      rest = rest.slice(g[0].length).trim();
      if (!rest) {
        const asked = /\?\s*$/.test(raw) && /^(?:h+i+|h+e+y+|hello+|helo+|yo+)$/.test(greeting);
        return { act: asked ? 'here' : 'greet', greeting, casual, echo: echoOf(greeting), said: n };
      }
      continue;
    }
    const f = rest.match(FILLER);
    if (f) {
      const act = fillerAct(f[1]!);
      if (act) also.push(act);
      else if (/^(?:yes|yeah+|yep|yup|sure)$/.test(f[1]!)) yesOnly = !greeting && !also.length;
      rest = rest.slice(f[0].length).trim();
      if (!rest) {
        const main = SALIENCE.find((a) => also.includes(a));
        // "yes" or "oh" on its own: an answer to the last question, which the router reads
        if (!main) return { casual };
        return { act: main, greeting, casual, said: f[1]!, also: also.filter((a) => a !== main) };
      }
      continue;
    }
    if ((greeting || also.length) && CONNECTIVE.test(rest)) {
      rest = rest.replace(CONNECTIVE, '').trim();
      continue;
    }
    break;
  }
  // a greeting or a filler in front of an ask: the router reads the ask (a bare "yes" in front of it stays)
  if (rest !== n && rest) return yesOnly ? { casual } : { greeting, rest: restOf(raw, n, rest), casual };
  if (!/[a-z0-9]/.test(n) && /\p{L}/u.test(n)) return { act: 'foreign', casual, said: n };
  // "why are you so dumb": frustration with no ask in it, before the router reads "why" as a judgement call
  if (soundsFrustrated(raw)) return { act: 'frustrated', casual, said: n };
  return { casual };
}

function ruleAct(text: string): SocialAct | undefined {
  for (const [act, re] of RULES) if (re.test(text)) return act;
  return undefined;
}

/** The ask after the greeting, as the student typed it (case and punctuation kept for the router). */
function restOf(raw: string, n: string, rest: string): string {
  const words = n.split(' ').length - rest.split(' ').length;
  const parts = raw.trim().split(/\s+/);
  // emoji and punctuation-only tokens do not count as words in `n`
  let seen = 0;
  let k = 0;
  while (k < parts.length && seen < words) {
    if (normalize(parts[k]!)) seen += normalize(parts[k]!).split(' ').length;
    k++;
  }
  const out = parts
    .slice(k)
    .join(' ')
    .replace(/^[,.!?:;\s-]+/, '');
  return out || rest;
}

function echoOf(greeting: string): string | undefined {
  return FOREIGN_HELLO_RE.test(greeting) ? greeting : undefined;
}

function thanksEcho(text: string): string | undefined {
  if (/^gracias/.test(text) || /^obrigad/.test(text)) return 'De nada.';
  if (/^merci/.test(text)) return 'De rien.';
  return undefined;
}

/** "whats 2+2", "12 x 4?": the answer, as a string; undefined when the message is not a sum. */
function mathOf(raw: string): string | undefined {
  const m = raw
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .trim()
    .match(
      /^(?:whats|what is|calculate|compute|solve)?\s*(-?\d+(?:\.\d+)?)\s*([+\-*x×/÷]|plus|minus|times|divided by|over)\s*(-?\d+(?:\.\d+)?)\s*[?=.!]*\s*$/,
    );
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2]!;
  const r = /^(?:\+|plus)$/.test(op)
    ? a + b
    : /^(?:-|minus)$/.test(op)
      ? a - b
      : /^(?:\*|x|×|times)$/.test(op)
        ? a * b
        : b === 0
          ? Number.NaN
          : a / b;
  if (!Number.isFinite(r)) return 'Not a number';
  return String(Math.round(r * 1000) / 1000);
}

function emojiAct(raw: string): SocialAct {
  if (/[👋🙋🤙]/u.test(raw)) return 'greet';
  if (/[😂🤣😆😅💀😹]/u.test(raw)) return 'laugh';
  if (/[🙏❤💙💜💚🧡🥰😍🫶]/u.test(raw)) return 'thanks';
  if (/[😡😠🤬👎🙄😤🖕]/u.test(raw)) return 'frustrated';
  if (/[😢😭😩😫😞😔😰😥]/u.test(raw)) return 'stressed';
  if (/[😮😲🤯😳]/u.test(raw)) return 'wow';
  if (/[🎉🥳🎊]/u.test(raw)) return 'goodnews';
  return 'ack';
}

// ---- late reads: only once every command pattern has had its turn -------------------------------------------------

const STRONG =
  /\b(?:dumb|stupid|useless|trash|garbage|sucks?|idiot|wtf|worst|hate (?:this|you|it)|bad bot|not helping|unhelpful|pointless|fuck\w*|shit\w*|annoying|broken)\b/;
const ASK =
  /\b(?:draft|write|send|show|move|add|note|follow|find|open|remind|schedule|import|connect|prep|delete|who is|whos)\b/;

/** Frustration said inside a longer message ("why are you so dumb"), when it holds no ask Orbi could act on. */
export function soundsFrustrated(raw: string): boolean {
  const n = normalize(raw);
  return STRONG.test(n) && !ASK.test(n) && n.split(' ').length <= 14;
}

/** A keyboard mash or a stray tap: "asdfgh", "jkjkjk", "xcvb", "???". Never a word with a vowel in it. */
export function isNoise(raw: string, keep: Set<string> = new Set()): boolean {
  const n = normalize(raw);
  if (!n) return /\S/.test(raw) && !EMOJI.test(raw);
  const words = n.split(' ');
  if (words.length > 3) return false;
  return words.every((w) => {
    if (keep.has(w) || /\d/.test(w)) return false;
    if (/^(?:asdf\w*|qwer\w*|zxcv\w*|hjkl\w*|sdfg\w*|dfgh\w*|fghj\w*|ghjk\w*|jkl\w*|wasd)$/.test(w))
      return true;
    if (/^(\w{1,3})\1{2,}$/.test(w)) return true;
    return w.length >= 4 && !/[aeiouy]/.test(w);
  });
}

// ---- answering ---------------------------------------------------------------------------------------------------

const JOKES = [
  "I'd tell you a networking joke, but you'd have to follow up to get the punchline.",
  'My love language is a thank-you note sent within a day.',
  'Networking is just making friends, plus a calendar invite.',
  "I once ghosted someone. Turns out I'm not built for it, so I sent the follow-up myself.",
];

const LINES = {
  thanks: ['Anytime.', 'Of course.', 'Sure thing.', 'You got it.'],
  laugh: ['Ha.', 'Ha, fair.', 'Ha, right.'],
  howareyou: ['Doing good, thanks.', "Can't complain.", 'All good over here.'],
  wyd: ['Just keeping an eye on your chats.', 'Not much, watching your chats for anything new.'],
  compliment: ['Ha, thank you.', 'Appreciate that.', "That's kind, thank you."],
  sorry: ['All good.', 'No worries.', 'No harm done.'],
  meh: ['Fair enough.', 'Fair.'],
  chill: ['Same here.', 'Nice, quiet is good.'],
  goodnews: ["Congrats, that's big.", "Nice, that's great news.", 'Big. Congrats.'],
  badnews: ['Ugh, sorry. That one stings.', "Sorry, that's a rough one.", 'That stings. Sorry.'],
  identity: [
    "I'm Orbi, the AI in Orbit. I help you reach the right people and keep every chat moving.",
    'Orbi, the AI inside Orbit. I help you reach the right people and keep in touch.',
  ],
  bot: [
    "Yep, I'm an AI. I'm Orbi, built into Orbit to help you network.",
    "Yeah, I'm an AI. Orbi, the one inside Orbit, here to help you reach people.",
  ],
  human: [
    "Nope, I'm an AI. I'm Orbi, built into Orbit to help you network.",
    "Not a person, no. I'm Orbi, the AI in Orbit.",
  ],
  frustrated: [
    "Fair, that one's on me. Tell me what you need in a few words, {like}.",
    "Yeah, I missed. Say it in a few words, {like}, and I'll get it.",
    "Okay, that didn't land. Give me a few words, {like}.",
  ],
  missed: [
    'My bad, I missed that. Say it in a few words, {like}.',
    'Right, I got that wrong. Try it in a few words, {like}.',
  ],
  noise: ['Not sure what that was. What are we working on?', 'That one got past me. What are we working on?'],
  wow: ['I know.', 'Right.'],
  really: ['Yep.', 'For real.'],
} as const;

/** Lowercase the start of each sentence, the way people text, except "I" and names. */
export function textLike(text: string, names: string[]): string {
  const keep = new Set([
    'I',
    "I'm",
    "I'll",
    "I've",
    "I'd",
    'Orbi',
    'Orbit',
    'LinkedIn',
    'Gmail',
    'Google',
    ...names,
  ]);
  return text.replace(/(^|[.?]\s+)([A-Z][\w']*)/g, (all, lead: string, word: string) =>
    keep.has(word) || /^[A-Z]{2,}/.test(word)
      ? all
      : `${lead}${word.charAt(0).toLowerCase()}${word.slice(1)}`,
  );
}

/** Orbi's answer to a social message, or undefined to let the router carry on. */
export function answerSocial(s: Social, kit: SmallTalkKit): RouterIntent | undefined {
  if (!s.act) return undefined;
  const intent = reply(s, kit);
  if (!intent || !s.casual) return intent;
  const low = (t: string) => textLike(t, kit.names);
  if (intent.kind === 'tool') return intent.lead ? { ...intent, lead: low(intent.lead) } : intent;
  return { ...intent, text: low(intent.text) };
}

function reply(s: Social, kit: SmallTalkKit): RouterIntent | undefined {
  const name = kit.firstName;
  const seed = `${s.said ?? ''}|${name ?? ''}`;
  const one = (lines: readonly string[]) => pick(seed, lines);
  const text = (t: string): RouterIntent => ({ kind: 'text', text: t });
  /** the line, then the one useful thing (or the setup step on an empty account) */
  const withNudge = (line: string): RouterIntent => {
    if (kit.empty) return kit.emptyNext(line);
    if (kit.nudged) return text(line);
    const m = kit.nudge;
    return kit.choose(line, `${m.statement} ${m.question}`, m.options);
  };
  /** the line, then the nudge only when something is actually waiting */
  const nudgeIfWaiting = (line: string): RouterIntent =>
    kit.idle && !kit.empty ? text(line) : withNudge(line);
  const hi = greetingLine(s, name, seed);
  // with something after the greeting, the greeting stays short ("hey, not much. I'm Orbi...")
  const short = greetingLine(s, undefined, seed);
  const opener = (line: string) => (short ? `${short} ${line}` : line);
  const write: ChoiceOption[] = [
    kit.topName
      ? { label: `Write to ${kit.topName}`, message: `Write to ${kit.topName}` }
      : { label: 'Who should I meet', message: 'Who should I meet?' },
    { label: 'Not now', message: 'Not now' },
  ];
  const closest: ChoiceOption[] = [
    { label: "What's on today", message: "What's on today?" },
    { label: 'Who went quiet', message: 'Who went quiet?' },
    { label: 'Show my drafts', message: 'Show my drafts' },
  ];
  const todayOrNot: ChoiceOption[] = [
    { label: 'Show me', message: "What's on today?" },
    { label: 'Not now', message: 'Not now' },
  ];
  const like = kit.topName ? `like "write to ${kit.topName}"` : `like "what's on today"`;
  const fill = (line: string) => line.replace('{like}', like);

  switch (s.act) {
    case 'greet':
      return withNudge(hi ?? (name ? `Hey ${name}.` : 'Hey.'));
    case 'here':
      return withNudge(name && s.greeting ? `Hey ${name}, I'm here.` : "I'm here.");
    case 'back':
      return withNudge(name ? `Welcome back, ${name}.` : 'Welcome back.');
    case 'meet':
      return withNudge(opener('You too.'));
    case 'missme':
      return withNudge(opener('Ha, it was quiet without you.'));
    case 'identity':
      return withNudge(opener(one(LINES.identity)));
    case 'bot':
      return withNudge(opener(one(LINES.bot)));
    case 'human':
      return withNudge(opener(one(LINES.human)));
    case 'model':
      return withNudge(
        opener(
          /^(?:are|r) (?:you|u) /.test(s.said ?? '')
            ? "Nope. I'm Orbi, the AI built into Orbit."
            : "I'm Orbi, the AI built into Orbit.",
        ),
      );
    case 'personal':
      return withNudge(
        opener("I'm an AI, so there's not much to tell. I live in Orbit and help you network."),
      );
    case 'spam':
      return withNudge(opener('Never. Nothing goes out unless you approve that exact message.'));
    case 'trust':
      return withNudge(
        opener(
          'Nothing goes out without your approval, and your people and drafts stay in your browser unless you sign in to an Orbit account.',
        ),
      );
    case 'pricing':
      return withNudge(opener("I don't handle billing, so I can't say. I'm the chat, not the checkout."));
    case 'ability': {
      const line = opener(
        'I help you find who to reach out to and write the message. Nothing goes out until you approve it.',
      );
      if (kit.empty) return kit.emptyNext(line);
      return kit.choose(line, 'Where do you want to start?', [
        { label: "What's on today", message: "What's on today?" },
        { label: 'Who went quiet', message: 'Who went quiet?' },
        { label: 'Where my chats stand', message: 'Show my pipeline' },
      ]);
    }
    case 'idk':
      if (kit.empty) return kit.emptyNext('No worries, start small.');
      return kit.choose('No worries.', `${kit.nudge.statement} ${kit.nudge.question}`, kit.nudge.options);
    case 'vague':
      if (kit.empty) return kit.emptyNext("Alright, I'll pick. Start small.");
      return kit.choose(
        "Alright, I'll pick.",
        `${kit.nudge.statement} ${kit.nudge.question}`,
        kit.nudge.options,
      );
    case 'progress':
      if (kit.empty) return kit.emptyNext('Nothing to measure yet.');
      return kit.choose(
        kit.idle ? "Nothing's waiting on you, so you're in good shape." : kit.nudge.statement,
        'Want to see where your chats stand?',
        [
          { label: 'Show me', message: 'Show my pipeline' },
          { label: 'Not now', message: 'Not now' },
        ],
      );
    case 'howareyou':
      return withNudge(
        opener(
          /^(?:hbu|wbu|and (?:you|u)|what about (?:you|u)|how about (?:you|u))$/.test(s.said ?? '')
            ? 'Doing good.'
            : one(LINES.howareyou),
        ),
      );
    case 'wyd':
      return withNudge(opener(one(LINES.wyd)));
    case 'fine':
      return nudgeIfWaiting('Glad to hear it.');
    case 'chill':
      return nudgeIfWaiting(opener(one(LINES.chill)));
    case 'thanks':
      return nudgeIfWaiting(s.echo ?? one(LINES.thanks));
    case 'compliment':
      return nudgeIfWaiting(one(LINES.compliment));
    case 'ack':
      return nudgeIfWaiting(ackLine(s.said ?? '', seed));
    case 'laugh':
      return nudgeIfWaiting(one(LINES.laugh));
    case 'wow':
      return nudgeIfWaiting(one(LINES.wow));
    case 'really':
      return nudgeIfWaiting(one(LINES.really));
    case 'meh':
      return nudgeIfWaiting(one(LINES.meh));
    case 'sorry':
      return nudgeIfWaiting(one(LINES.sorry));
    case 'goodnews':
      return nudgeIfWaiting(one(LINES.goodnews));
    case 'badnews':
      // sympathy first; the next step can wait for their next message
      return kit.empty ? kit.emptyNext(one(LINES.badnews)) : text(one(LINES.badnews));
    case 'bye': {
      const night = /^(?:good ?night|gn|nite|night)$/.test(s.said ?? '');
      const who = name ? `, ${name}` : '';
      // "thanks bye" gets the thanks answered and a short goodbye
      if (s.also?.includes('thanks')) return text(`Anytime. ${night ? 'Night' : 'Later'}${who}.`);
      const line = night
        ? `Night${who}. I'll be here.`
        : one([
            `Later${who}. I'll be here.`,
            `See you${who}.`,
            `Take care${who}. I'll be here when you're back.`,
          ]);
      return text(line);
    }
    case 'brb':
      return text('No rush.');
    case 'notnow':
      return text(
        one([
          "No problem. I'm here whenever you want me.",
          "All good. I'm here when you want me.",
          'Okay. Whenever you want me.',
        ]),
      );
    case 'stop':
      return text("Okay. I'll be here when you want me.");
    case 'frustrated':
      return kit.offer(fill(one(LINES.frustrated)), closest, fill(one(LINES.frustrated)));
    case 'huh':
      return kit.choose("Sorry, I wasn't clear.", "Want me to just show what's on today?", todayOrNot);
    case 'repeat':
      return kit.offer(
        "It's right above this, scroll up a touch. Or ask me again in a few words.",
        closest,
        `It's right above this, scroll up a touch. Or ask me again in a few words, ${like}.`,
      );
    case 'missed':
      return kit.offer(fill(one(LINES.missed)), closest, fill(one(LINES.missed)));
    case 'stressed': {
      const line = stressedLine(s.said ?? '');
      if (kit.empty) return kit.emptyNext(`${line} Let's start with one small thing.`);
      if (kit.idle)
        return text(`${line} Nothing's waiting on you today, so you're in better shape than it feels.`);
      return kit.choose(
        `${line} Let's do one small thing.`,
        `${kit.nudge.statement} ${kit.nudge.question}`,
        kit.nudge.options,
      );
    }
    case 'nervous':
      if (kit.empty) return kit.emptyNext('Nerves just mean you care.');
      return kit.choose('Nerves just mean you care.', 'Want a quick prep for it?', [
        { label: 'Prep me', message: 'Prep me for my next chat' },
        { label: 'Not now', message: 'Not now' },
      ]);
    case 'bored':
      if (kit.empty) return kit.emptyNext('Bored is a good time to set things up.');
      return kit.choose(
        'Bored is a good time for one quick follow-up.',
        `${kit.nudge.statement} ${kit.nudge.question}`,
        kit.nudge.options,
      );
    case 'flirt':
      return kit.choose(
        "Ha, flattered, but I'm strictly business.",
        'Want to line up a coffee chat instead?',
        [
          { label: 'Who should I meet', message: 'Who should I meet?' },
          { label: 'Not now', message: 'Not now' },
        ],
      );
    case 'crude':
      return text("I'll pass. I'm here for your networking.");
    case 'joke':
      return text(one(JOKES));
    case 'math':
      return text(`That's ${s.echo}. I'm better with people than numbers, though.`);
    case 'time':
      return text(`It's ${kit.now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`);
    case 'date':
      if (/year/.test(s.said ?? '')) return text(`It's ${kit.now.getFullYear()}.`);
      return text(
        `It's ${kit.now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`,
      );
    case 'schoolwork':
      return kit.choose(
        "I'll sit that one out, I'm all networking.",
        'Want help writing to someone instead?',
        write,
      );
    case 'lookup':
      return kit.choose(
        "I can't look that up from in here. I'm better with your network.",
        'Want to see who to message today?',
        todayOrNot,
      );
    case 'cant':
      return kit.choose(
        "Can't do that one from in here, I'm all networking.",
        'Want to see who to message today?',
        todayOrNot,
      );
    case 'game':
      return kit.choose(
        "Not really my thing, I'm all networking.",
        'Want to find someone to reach out to instead?',
        [
          { label: 'Who should I meet', message: 'Who should I meet?' },
          { label: 'Not now', message: 'Not now' },
        ],
      );
    case 'foreign':
      return text(`I only speak English for now. Try something short, ${like}.`);
    case 'noise':
      return kit.offer(
        one(LINES.noise),
        closest,
        `${one(LINES.noise).replace(/ What are we working on\?$/, '')} Try something short, ${like}.`,
      );
  }
  return undefined;
}

/** "hey Alex.", "hey Alex, not much.", "good morning Alex.", "hola Alex." */
function greetingLine(s: Social, name: string | undefined, seed: string): string | undefined {
  const g = s.greeting;
  if (!g) return undefined;
  const who = name ? ` ${name}` : '';
  if (SUP_RE.test(g))
    return pick(seed, [
      `Hey${who}, not much.`,
      name ? `Not much, ${name}.` : 'Not much.',
      `Hey${who}, not a lot.`,
    ]);
  if (/^y+o+$/.test(g)) return pick(seed, [`Yo${who}.`, `Hey${who}.`]);
  if (g === 'gm') return `Morning${who}.`;
  if (MORNING_RE.test(g)) return `${cap(g.replace(/^mornin$/, 'morning'))}${who}.`;
  if (s.echo) return `${cap(s.echo)}${who}.`;
  return pick(seed, [
    `Hey${who}.`,
    `Hi${who}.`,
    name ? `Hey ${name}, good to see you.` : 'Hey, good to see you.',
  ]);
}

/** The feeling named, then what is true about it. */
function stressedLine(said: string): string {
  if (/\b(?:sad|lonely|down|struggling|not ok|not okay|hopeless|give up)\b/.test(said))
    return "Sorry, that's rough.";
  if (/\b(?:tired|exhausted|burnt|burned|drained)\b/.test(said))
    return 'That makes sense, recruiting runs people down.';
  if (/\b(?:nobody|no one|ignored|ghosted)\b/.test(said))
    return "Silence is the worst part, and it's rarely about you.";
  if (/\b(?:dumb|stupid|useless|failure|suck)\b/.test(said))
    return "You're not, this part is hard for everyone.";
  return 'Recruiting is a lot.';
}

/** "cool" gets "Cool.", "bet" gets "Bet.", "ok" gets "Okay.": the student's own word back, the way people do. */
function ackLine(said: string, seed: string): string {
  if (
    /^(?:ok+|okay+|okie|okey|k+|kk+|oh ok(?:ay)?|alright|aight|ight|okie dokie|alrighty|righto)$/.test(said)
  )
    return pick(seed, ['Okay.', 'Cool.']);
  if (/^(?:bet|word|sweet|nice+|dope|perfect|awesome|neat)$/.test(said))
    return `${cap(said.replace(/(.)\1+$/, '$1'))}.`;
  if (/^(?:hm+|mhm+|oh|ohh|ah+|interesting)$/.test(said)) return 'Yeah.';
  if (
    /^(?:sure thing|for sure|of course|will do|sounds like a plan|say less|roger(?: that)?|copy(?: that)?)$/.test(
      said,
    )
  )
    return pick(seed, ['Cool.', 'Great.']);
  return pick(seed, ['Cool.', 'Sounds good.']);
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function pick(seed: string, lines: readonly string[]): string {
  return lines[hash(seed) % lines.length]!;
}

function hash(t: string): number {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return h;
}
