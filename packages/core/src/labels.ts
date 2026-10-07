// Human labels for every internal code that can reach the screen. UI code never shows a raw enum value
// (`swe`, `thank_you`, `gmail`, `family_friend`, `long_shot`); it looks the value up here instead.
import type {
  Channel,
  FactType,
  MessageKind,
  NoteSource,
  RelationshipType,
  TargetCompany,
  TouchpointKind,
} from './types';

/** Recruiting functions the student can target, keyed by the code stored in `RecruitingGoals.targetFunctions`. */
export const FUNCTION_LABELS: Record<string, string> = {
  swe: 'Software engineering',
  pm: 'Product management',
  ib: 'Investment banking',
  consulting: 'Consulting',
  data: 'Data science and ML',
  design: 'Product design',
  finance: 'Finance',
  marketing: 'Marketing',
  research: 'Research',
  vc: 'Venture capital',
  ops: 'Operations',
};
export const FUNCTION_CODES = Object.keys(FUNCTION_LABELS);

/** "Software engineering" for `swe`; an unknown free-text function is returned as typed. */
export function functionLabel(code: string | undefined): string {
  if (!code) return '';
  return FUNCTION_LABELS[code.toLowerCase()] ?? code;
}

/** Lowercase form for use inside a sentence ("Works in product management"). */
export function functionPhrase(code: string | undefined): string {
  const l = functionLabel(code);
  if (!FUNCTION_LABELS[(code ?? '').toLowerCase()]) return l;
  return l
    .split(' ')
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/** Map typed text ("PM", "Product", "software engineering") back to a known code, if there is one. */
export function functionCodeFor(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (FUNCTION_LABELS[t]) return t;
  for (const [code, label] of Object.entries(FUNCTION_LABELS)) if (label.toLowerCase() === t) return code;
  const aliases: Record<string, string> = {
    product: 'pm',
    'product manager': 'pm',
    'software engineer': 'swe',
    engineering: 'swe',
    banking: 'ib',
    'investment bank': 'ib',
    'data science': 'data',
    ml: 'data',
    design: 'design',
    venture: 'vc',
    operations: 'ops',
  };
  return aliases[t];
}

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  outreach: 'First message',
  bump: 'Follow-up',
  schedule: 'Scheduling',
  thank_you: 'Thank-you',
  nurture: 'Check-in',
  congratulate: 'Congratulations',
  referral_ask: 'Referral ask',
  intro_request: 'Intro ask',
  reply: 'Reply',
  report_back: 'Close the loop',
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  gmail: 'Email',
  linkedin: 'LinkedIn',
  clipboard: 'Copied text',
};

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  unknown: 'Not set',
  recruiter: 'Recruiter',
  alumni: 'Alum',
  peer: 'Peer',
  mentor: 'Mentor',
  professor: 'Professor',
  family_friend: 'Family friend',
  colleague: 'Colleague',
  other: 'Other',
};

export const TARGET_STATUS_LABELS: Record<TargetCompany['status'], string> = {
  researching: 'Researching',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  closed: 'Closed',
};

export const REACH_BAND_LABELS: Record<'strong' | 'possible' | 'long_shot', string> = {
  strong: 'Strong route',
  possible: 'Possible route',
  long_shot: 'Long shot',
};

export const FACT_TYPE_LABELS: Record<FactType, string> = {
  role_detail: 'Their role',
  background: 'Background',
  advice: 'Advice',
  personal: 'Personal',
  offer: 'Offers',
  hook: 'Worth bringing up',
  preference: 'Preferences',
  ask_made: 'Your asks',
  contact_info: 'Contact info',
  connection: 'How you are linked',
};

export const NOTE_SOURCE_LABELS: Record<NoteSource, string> = {
  granola_api: 'Granola',
  granola_email: 'Granola',
  fathom: 'Fathom',
  wispr_capture: 'Dictated',
  wispr_export: 'Wispr Flow',
  manual: 'Typed',
  email_ingest: 'Email',
  upload: 'Upload',
  tracker_import: 'Tracker import',
};

export const TOUCHPOINT_LABELS: Record<TouchpointKind, string> = {
  email_in: 'Email from them',
  email_out: 'Email from you',
  email_cc: 'Copied on an email',
  meeting: 'Meeting',
  linkedin_in: 'LinkedIn message from them',
  linkedin_out: 'LinkedIn message from you',
  linkedin_connected: 'Connected on LinkedIn',
  linkedin_engaged: 'Engaged with their LinkedIn activity',
  note: 'Note',
  manual_log: 'Logged by you',
  intro_observed: 'Introduction',
};
