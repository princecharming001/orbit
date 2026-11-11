/**
 * Every setting a student can change, and exactly where it lives: the Settings section, and the element on that page
 * to scroll to and light up. The chat shows one as a card with a single button (open_page with `setting`), so
 * "where do I add my resume" or "change my tone" ends one tap from the field itself, never on a page to hunt
 * through. Settings reads the same map to find the spot (`#<id>` on the address).
 *
 * `target` is a CSS selector on the Settings page, the first match wins; `words` is how a student names it.
 */
export interface SettingSpot {
  id: string;
  /** what the card calls it: "Resume", "Writing style" */
  label: string;
  /** the Settings section it is in (the address is /settings/<section>#<id>) */
  section:
    | 'profile'
    | 'goals'
    | 'integrations'
    | 'style'
    | 'voice'
    | 'autopilot'
    | 'limits'
    | 'privacy'
    | 'memory';
  /** the element to scroll to and light up; none for a section that is the whole answer */
  target?: string;
  /** one line on what can be changed there */
  what: string;
  words: RegExp;
}

export const SECTION_NAMES: Record<SettingSpot['section'], string> = {
  profile: 'Profile',
  goals: 'Goals',
  integrations: 'Integrations',
  style: 'Writing style',
  voice: 'Voice',
  autopilot: 'Autopilot',
  limits: 'Limits and schedule',
  privacy: 'Data & privacy',
  memory: 'Memory',
};

const row = (id: string) => `[data-testid="settings-${id}"]`;

/** Ordered: where two could match ("my LinkedIn url" and "LinkedIn"), the more specific comes first. */
export const SETTINGS: SettingSpot[] = [
  // integrations
  {
    id: 'resume',
    label: 'Resume',
    section: 'integrations',
    target: row('resume'),
    what: 'Add or replace your resume. Orbit reads it to write about you accurately.',
    // no \b: it does not hold next to an accented letter
    words: /(^|[^a-z])(r[eé]sum[eé]|cv)(?![a-z])/i,
  },
  {
    id: 'calendly',
    label: 'Calendly',
    section: 'integrations',
    target: row('calendly'),
    what: 'Connect Calendly with your booking link, so drafts can offer your times.',
    words: /\bcalendly\b/i,
  },
  {
    id: 'calcom',
    label: 'Cal.com',
    section: 'integrations',
    target: row('calcom'),
    what: 'Connect Cal.com with your booking link, so drafts can offer your times.',
    words: /\bcal\.?com\b/i,
  },
  {
    id: 'booking-link',
    label: 'Booking link in drafts',
    section: 'integrations',
    target: row('booking-link'),
    what: 'Pick the link drafts add when you propose times.',
    words: /\b(booking|scheduling|calendar) (link|page)\b/i,
  },
  {
    id: 'fathom',
    label: 'Fathom',
    section: 'integrations',
    target: row('fathom'),
    what: 'Connect Fathom so notes from recorded calls land on the people in them.',
    words: /\bfathom\b/i,
  },
  {
    id: 'granola',
    label: 'Granola',
    section: 'integrations',
    target: row('granola'),
    what: 'Connect Granola so notes from recorded calls land on the people in them.',
    words: /\bgranola\b/i,
  },
  {
    id: 'fireflies',
    label: 'Fireflies',
    section: 'integrations',
    target: row('fireflies'),
    what: 'Connect Fireflies so notes from recorded calls land on the people in them.',
    words: /\bfireflies\b/i,
  },
  {
    id: 'wispr',
    label: 'Wispr Flow',
    section: 'integrations',
    target: row('wispr'),
    what: 'Connect Wispr Flow so notes from recorded calls land on the people in them.',
    words: /\bwispr\b/i,
  },
  {
    id: 'notetaker',
    label: 'Meeting notes',
    section: 'integrations',
    target: row('fathom'),
    what: 'Connect the notetaker you use: Fathom, Granola, Fireflies or Wispr Flow.',
    words: /\b(note-?takers?|meeting notes?|call notes?|otter)\b/i,
  },
  {
    id: 'profile-linkedin',
    label: 'Your LinkedIn link',
    section: 'profile',
    target: '#profile-linkedin',
    what: 'The link to your own LinkedIn profile.',
    words: /\bmy (own )?linkedin (url|link|profile|address)\b/i,
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    section: 'integrations',
    // the live connection's row where there is one, else the upload row
    target: `${row('linkedin-live')}, ${row('linkedin')}`,
    what: 'Connect LinkedIn or upload your connections, so Orbit knows your network.',
    words: /\blinkedin\b/i,
  },
  {
    id: 'google',
    label: 'Google',
    section: 'integrations',
    target:
      '[data-testid="settings-google-switch"], [data-testid="google-via-account"], [data-testid="google-unavailable"]',
    what: 'Connect Gmail and Google Calendar.',
    words: /\b(google|gmail)\b/i,
  },
  {
    id: 'claude',
    label: 'Claude',
    section: 'integrations',
    target: '[data-testid="ai-chat-row"]',
    what: "Orbit's AI: your own key, and whether to show its reasoning.",
    words: /\b(api key|claude key|anthropic|ai settings?|show (its )?reasoning)\b/i,
  },
  // how messages sound
  {
    id: 'tone',
    label: 'Writing style',
    section: 'style',
    target: '[data-testid="outreach-coach"]',
    what: 'How your messages sound: tone, greeting, sign-off, length. Teach it from messages you wrote.',
    words:
      /\b(tone|writing style|how (my|orbit'?s?|the) (messages?|drafts?|emails?) (sounds?|reads?)|greetings?|sign-?offs?|more (formal|casual)|less formal|message length|emoji|exclamation)\b/i,
  },
  {
    id: 'voice',
    label: 'Voice',
    section: 'voice',
    target: '[data-testid="voice-card"]',
    what: 'What Orbit learned about how you write, and notes you can add.',
    words: /\b(my voice|voice (notes?|settings?|score))\b/i,
  },
  // sending
  {
    id: 'autopilot',
    label: 'Autopilot',
    section: 'autopilot',
    target: '[data-testid="settings-autopilot"]',
    what: 'What Orbit may send on its own, and when to pause it.',
    words: /\b(auto-?pilot|autonomy|sends? (things |messages )?on its own|auto-?send)\b/i,
  },
  {
    id: 'weekly-target',
    label: 'Weekly pace',
    section: 'limits',
    target: row('weekly'),
    what: 'How many new people to reach each week.',
    words: /\b(weekly (target|pace|goal|number)|how many (people|messages|emails) (a|per|each) week)\b/i,
  },
  {
    id: 'follow-ups',
    label: 'Follow-ups',
    section: 'limits',
    target: '#lim-bumps',
    what: 'How many times Orbit follows up, and how long it waits.',
    words: /\b(follow-?ups?|bumps?|nudges?)\b/i,
  },
  {
    id: 'send-days',
    label: 'Sending days',
    section: 'limits',
    target: '#lim-wdays',
    what: 'Which days messages may go out.',
    words: /\b(send(ing)? days|work days|weekends?|which days)\b/i,
  },
  {
    id: 'sending-limits',
    label: 'Sending limits',
    section: 'limits',
    target: '#lim-gmail',
    what: 'How many emails and LinkedIn messages may go out in a day.',
    words:
      /\b((daily|sending|send|email|linkedin) (limits?|caps?)|how many (emails|messages) (a|per) day)\b/i,
  },
  {
    id: 'morning-brief',
    label: 'Morning brief',
    section: 'limits',
    target: row('morning'),
    what: 'When the morning brief arrives, or turn it off.',
    words: /\b(morning|daily) brief\b/i,
  },
  // goals
  {
    id: 'target-companies',
    label: 'Target companies',
    section: 'goals',
    target: '#target-companies',
    what: 'The companies you are aiming for.',
    words: /\b(target|dream) compan(y|ies)\b/i,
  },
  {
    id: 'target-roles',
    label: 'Target roles',
    section: 'goals',
    target: '#goals-roles',
    what: 'The roles you are going for.',
    words:
      /\b(target )?(roles?|positions?|job titles?) (i'?m|i am|i) (going|looking|aiming|want)|\btarget roles?\b/i,
  },
  {
    id: 'target-industries',
    label: 'Target industries',
    section: 'goals',
    target: '#goals-industries',
    what: 'The industries you want to work in.',
    words: /\b(target )?industr(y|ies)\b/i,
  },
  {
    id: 'target-locations',
    label: 'Target locations',
    section: 'goals',
    target: '#goals-locations',
    what: 'Where you want to work.',
    words:
      /\b(target )?(locations?|cit(y|ies)) (i want|to work|for work)|\btarget (locations?|cit(y|ies))\b/i,
  },
  {
    id: 'own-words',
    label: 'In your own words',
    section: 'goals',
    target: row('own-words'),
    what: 'What you want, in your words, and what Orbit should never do.',
    words: /\b(in my (own )?words|my three lines|never rule)\b/i,
  },
  // profile
  {
    id: 'school',
    label: 'School',
    section: 'profile',
    target: '#profile-school',
    what: 'Your school, year and majors.',
    words: /\bmy (school|college|university)\b/i,
  },
  {
    id: 'majors',
    label: 'Majors',
    section: 'profile',
    target: '#profile-majors',
    what: 'What you study.',
    words: /\b(my )?majors?\b/i,
  },
  {
    id: 'grad-year',
    label: 'Graduation year',
    section: 'profile',
    target: '#profile-year',
    what: 'The year you graduate.',
    words: /\b(grad(uation)? year|class of|when i graduate)\b/i,
  },
  {
    id: 'timezone',
    label: 'Time zone',
    section: 'profile',
    target: '#profile-tz',
    what: 'Your time zone, for the times Orbit proposes.',
    words: /\btime ?zone\b/i,
  },
  {
    id: 'name',
    label: 'Your name',
    section: 'profile',
    target: '#profile-name-input',
    what: 'The name your messages are signed with.',
    words: /\bmy (name|email address)\b/i,
  },
  // data
  {
    id: 'memory',
    label: 'Memory',
    section: 'memory',
    what: 'What Orbit remembers about you. Read it, or delete any line.',
    words: /\b(memory|what (you|orbit) remembers?|forget (things|what))\b/i,
  },
  {
    id: 'delete-data',
    label: 'Delete your data',
    section: 'privacy',
    target: '#danger-zone',
    what: 'Remove everything Orbit holds about you.',
    words: /\b(delete|erase|wipe|remove) (all )?(my )?(data|account|everything)\b/i,
  },
  {
    id: 'privacy',
    label: 'Data & privacy',
    section: 'privacy',
    what: 'What leaves this browser, and a copy of your data.',
    words: /\b(privacy|export (my )?data|download (my )?data|what leaves)\b/i,
  },
];

export const SETTING_IDS = SETTINGS.map((s) => s.id) as [string, ...string[]];

export function settingById(id: string | undefined): SettingSpot | undefined {
  return id ? SETTINGS.find((s) => s.id === id) : undefined;
}

/** "/settings/integrations#resume": the page, and the spot on it. */
export function settingHref(s: SettingSpot): string {
  return `/settings/${s.section}#${s.id}`;
}

/** The setting a message names, if it names one ("where do I add my resume", "change my tone"). */
export function findSetting(text: string): SettingSpot | undefined {
  return SETTINGS.find((s) => s.words.test(text));
}

/**
 * Whether a message is about changing or finding a setting, as against using it ("draft with my resume in mind" is
 * not; "update my resume" is).
 */
export const SETTING_ASK =
  /^(?:(?:how|where) (?:do|can|would|should) i\b|(?:can|could) (?:i|you)\b|i (?:want|need|would like|'d like) to\b|(?:please )?(?:change|update|edit|set|fix|replace|add|upload|connect|disconnect|link|turn (?:on|off)|switch|adjust|manage|open|show me|take me to|go to)\b|let me\b|where(?:'s| is| are)\b)/i;

const SETTING_VERB =
  /\b(change|update|edit|set|fix|replace|add|upload|connect|disconnect|link|turn (?:on|off)|switch|adjust|manage|find|make|delete|remove|settings?)\b/i;

/** The setting a message asks to change or find. */
export function settingAsked(text: string): SettingSpot | undefined {
  const t = text.trim();
  // "where is memory" asks by itself; "can I ..." needs a word of change to be about a setting
  if (!SETTING_ASK.test(t) || !(SETTING_VERB.test(t) || /^(where|how)\b/i.test(t))) return undefined;
  return findSetting(t);
}
