/** Tools that draw something small inside the chat: tap-to-answer choices and the setup widgets. Neither changes data. */
import { z } from '../../zod';
import { readSetupStatus, SETUP_WHAT } from '../setupStatus';
import type { ChoiceOption, SetupWhat } from '../types';
import { type AnyTool, defineTool, plain } from './_shared';

export const CHOICE_LABEL_MAX = 28;

export const offerChoices = defineTool({
  name: 'offer_choices',
  kind: 'read',
  description:
    'Call this after you have written your reply (it goes at the very end), only when the student has natural next steps, to show up to three tap-to-answer buttons under your message. Each option is a short label (the button) and the message sent as the student\'s next turn when they tap it, written in the student\'s own voice ("Let\'s do it", "What else can you do?"). Two or three options, never more; skip it when the reply ends in a question the student must answer in their own words. Nothing changes; typing instead always works.',
  input: z.object({
    options: z
      .array(
        z.object({
          label: z
            .string()
            .min(1)
            .max(CHOICE_LABEL_MAX)
            .describe(`The button text, at most ${CHOICE_LABEL_MAX} characters.`),
          message: z
            .string()
            .min(1)
            .max(280)
            .describe("What is sent as the student's next message when they tap it, in the student's voice."),
        }),
      )
      .min(2)
      .max(3)
      .describe('Two or three next steps, most useful first.'),
  }),
  capabilities: [],
  progress: 'Adding options',
  async execute(input) {
    const options: ChoiceOption[] = input.options.map((o) => ({
      label: plain(o.label),
      message: plain(o.message),
    }));
    return {
      kind: 'choices',
      data: { options },
      summary: `Showed ${options.length} options to tap.`,
    };
  },
  toModel: () => 'shown',
});

export const showSetup = defineTool({
  name: 'show_setup',
  kind: 'read',
  description:
    'Call this when the student needs to connect or add something (Google, their LinkedIn connections, a Claude key, a resume) instead of describing Settings: it shows a small widget in the chat where they do it, with the current status. Pick google for Gmail and Calendar, linkedin for the connections export, claude_key for their own Claude API key, resume for their resume file. Nothing changes until the student acts in the widget.',
  input: z.object({
    what: z.enum(SETUP_WHAT as [SetupWhat, ...SetupWhat[]]).describe('Which widget to show.'),
  }),
  capabilities: ['google_connect', 'linkedin_import', 'claude_key_save_test', 'resume_upload'],
  progress: 'Getting the setup ready',
  async execute(input, ctx) {
    const status = await readSetupStatus(ctx.user.id, input.what);
    return {
      kind: 'setup',
      data: status,
      summary: SUMMARIES[input.what](status),
      href: '/settings/integrations',
    };
  },
  toModel: (d) => d,
});

const SUMMARIES: Record<SetupWhat, (s: Awaited<ReturnType<typeof readSetupStatus>>) => string> = {
  google: (s) =>
    s.what !== 'google'
      ? ''
      : s.connected
        ? 'Google is connected. The student can reconnect or sync from the widget.'
        : s.clientIdConfigured
          ? 'Google is not connected yet. The widget has the Connect Google button.'
          : 'Google is not set up in this copy of Orbit yet. The widget explains what is needed.',
  linkedin: (s) =>
    s.what !== 'linkedin'
      ? ''
      : s.people
        ? `Orbit has ${s.people} ${s.people === 1 ? 'person' : 'people'} so far. The widget takes Connections.csv or the whole export ZIP.`
        : 'No people yet. The widget takes Connections.csv or the whole LinkedIn export ZIP.',
  claude_key: (s) =>
    s.what !== 'claude_key'
      ? ''
      : s.keySaved
        ? 'A Claude key is saved in this browser. The widget can replace or remove it.'
        : 'No Claude key is saved. The widget saves one and tests it.',
  resume: (s) =>
    s.what !== 'resume'
      ? ''
      : s.onFile
        ? `A resume is on file (${s.filename}). The widget replaces it.`
        : 'No resume yet. The widget takes a PDF, Word or text file.',
};

export const widgetTools: AnyTool[] = [offerChoices, showSetup];
