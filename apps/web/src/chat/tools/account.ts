/** Imports, integrations and the account: every one of these needs the student's approval. */

import { setCurrentUserId } from '../../db/repo';
import { db } from '../../db/schema';
import { deleteAllData, exportAllData, exportFilename, leaveDemoForOwnSetup } from '../../engine/account';
import { DEMO_USER_ID, demoResetPrompt, loadDemo } from '../../engine/demo';
import { disconnectGoogleAccount, googleAccount, markGoogleNeedsReauth } from '../../engine/integrations';
import { connectionsText, importLinkedInExport } from '../../engine/linkedin';
import { saveResume } from '../../engine/resume';
import { syncGoogle } from '../../engine/sync';
import { currentGoogleToken, googleClientId } from '../../integrations/google';
import { writePrefs } from '../../integrations/prefs';
import { z } from '../../zod';
import { type AnyTool, defineTool, ok, plural, toModel } from './_shared';

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

export const saveResumeTool = defineTool({
  name: 'save_resume',
  kind: 'risky',
  description:
    "Call this when the student attaches a resume (PDF, Word .docx or plain text, up to 10 MB) to upload. Pass the file name and its contents as base64 (the UI reads the file). It replaces the current resume, reads the lines Orbit uses in drafts and prep, and returns them so unreadable ones can be fixed or unticked with update_resume_facet. Needs the student's approval.",
  input: z.object({
    filename: z.string().min(1).describe('The file name with its extension (.pdf, .docx, .txt, .md).'),
    base64: z.string().min(1).describe('The file contents, base64 encoded.'),
    mimeType: z.string().optional().describe('The file type, if known (application/pdf).'),
  }),
  capabilities: ['resume_upload', 'onboarding_resume'],
  progress: 'Reading your resume',
  async summarizeIntent(input, ctx) {
    const current = await db.resumes
      .where('userId')
      .equals(ctx.user.id)
      .filter((r) => r.isCurrent)
      .first();
    return {
      text: `Upload ${input.filename} as your resume${current ? `, replacing ${current.filename}` : ''}. Orbit reads it for the lines it uses in drafts and prep.`,
    };
  },
  async execute(input, ctx) {
    const bytes = bytesOf(input.base64);
    const name = input.filename.toLowerCase();
    const type =
      input.mimeType ??
      (name.endsWith('.pdf')
        ? 'application/pdf'
        : name.endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/plain');
    const file = new File([bytes], input.filename, { type });
    const { resume, facets } = await saveResume(ctx.user, file);
    const out = {
      resumeId: resume.id,
      filename: resume.filename,
      parseSource: resume.parseSource,
      facets: facets.map((f) => ({
        id: f.id,
        kind: f.kind,
        title: f.title,
        organization: f.organizationName,
        text: f.text.slice(0, 160),
        used: !f.excluded,
      })),
    };
    const unticked = facets.filter((f) => f.excluded).length;
    return ok(
      'import',
      out,
      out,
      `Saved ${resume.filename} and read ${plural(facets.length, 'line')} from it.${unticked ? ` ${plural(unticked, 'line')} Orbit could not read well ${unticked === 1 ? 'is' : 'are'} unticked until you fix or confirm ${unticked === 1 ? 'it' : 'them'}.` : ''}`,
      '/settings/integrations',
    );
  },
  toModel,
});

export const importLinkedin = defineTool({
  name: 'import_linkedin',
  kind: 'risky',
  description:
    "Call this when the student attaches their LinkedIn export to import their connections: Connections.csv as text (csvText), or the whole LinkedIn ZIP as base64. People are added or updated (a re-import never duplicates), job changes are noticed, closeness and the recommendations are recomputed and the brief is rebuilt. Needs the student's approval.",
  input: z.object({
    csvText: z.string().optional().describe('The text of Connections.csv.'),
    base64: z
      .string()
      .optional()
      .describe('The LinkedIn export ZIP (or the CSV) as base64, when the file was attached as binary.'),
    filename: z.string().optional().describe('The attached file name.'),
  }),
  capabilities: ['linkedin_import', 'onboarding_linkedin'],
  progress: 'Importing your connections',
  async summarizeIntent(input) {
    return {
      text: `Import your LinkedIn connections from ${input.filename ?? 'the attached file'}. People already in Orbit are updated, not duplicated.`,
      blockedReason:
        !input.csvText?.trim() && !input.base64
          ? 'Attach Connections.csv or the LinkedIn ZIP first.'
          : undefined,
    };
  },
  async execute(input, ctx) {
    let csv = input.csvText?.trim();
    if (!csv && input.base64) csv = await connectionsText(new Blob([bytesOf(input.base64)]));
    if (!csv) throw new Error('Attach Connections.csv or the LinkedIn ZIP first.');
    const r = await importLinkedInExport(ctx.user, csv);
    const out = { ...r };
    if (r.imported + r.updated === 0)
      return ok(
        'import',
        out,
        out,
        'Orbit found nobody in that file. Upload Connections.csv from the LinkedIn export, or the ZIP.',
        '/settings/integrations',
      );
    const added = `${plural(r.imported, 'person', 'people')} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} rows skipped` : ''}.`;
    return ok(
      'import',
      out,
      out,
      r.recommended
        ? `${added} ${r.recommended} worth a coffee chat are on Discover.`
        : `${added} Add your target companies so Orbit can say who to meet first.`,
      r.recommended ? '/discover' : '/settings/goals',
    );
  },
  toModel,
});

export const syncGoogleTool = defineTool({
  name: 'sync_google',
  kind: 'risky',
  description:
    "Call this only when the student asks to sync Google (pull new mail and calendar, check for replies) or to connect Google. Syncing works only while Google is signed in on this page; connecting (the Google sign-in popup) cannot be done from here, so when there is no live sign-in the answer is a link to Settings. An optional developer client id is saved first. Needs the student's approval because it reads their mail.",
  input: z.object({
    clientId: z
      .string()
      .optional()
      .describe('A developer Google OAuth client id to save before connecting (rarely needed).'),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('How many days of mail to pull on a first sync (default 90).'),
  }),
  capabilities: ['google_sync', 'google_connect', 'google_client_id_set', 'onboarding_google'],
  progress: 'Syncing Google',
  async summarizeIntent(_input, ctx) {
    const token = currentGoogleToken();
    const account = await googleAccount(ctx.user.id);
    return {
      text: 'Sync Gmail and Google Calendar: sent mail, inbox threads with people, and events, so replies and meetings show up in Orbit.',
      blockedReason: !googleClientId()
        ? 'Google is not part of this version of Orbit.'
        : !token
          ? account
            ? 'Google is signed out. Reconnect from Settings, LinkedIn, resume & AI, then sync.'
            : 'Google is not connected. Connect it from Settings, LinkedIn, resume & AI (it needs the sign-in popup).'
          : undefined,
    };
  },
  async execute(input, ctx) {
    if (input.clientId !== undefined) writePrefs({ googleClientId: input.clientId.trim() || undefined });
    if (!googleClientId()) throw new Error('Google is not part of this version of Orbit.');
    const token = currentGoogleToken();
    if (!token) {
      const account = await googleAccount(ctx.user.id);
      const out = { connected: !!account, signedIn: false, href: '/settings/integrations' };
      return ok(
        'import',
        out,
        out,
        account
          ? 'Google is signed out. Reconnect from Settings, LinkedIn, resume & AI, then sync.'
          : 'Google is not connected yet. Connect it from Settings, LinkedIn, resume & AI; it needs the Google sign-in popup.',
        '/settings/integrations',
      );
    }
    try {
      const r = await syncGoogle(ctx.user, { days: input.days });
      const out = { ...r, signedIn: true };
      return ok(
        'import',
        out,
        out,
        `Google synced: ${plural(r.messages, 'message')} and ${plural(r.events, 'event')}${r.failed ? `, ${r.failed} could not be downloaded and will be retried` : ''}.`,
        '/today',
      );
    } catch (e) {
      await markGoogleNeedsReauth(ctx.user.id, String((e as Error).message ?? e));
      throw e;
    }
  },
  toModel,
});

export const disconnectGoogleTool = defineTool({
  name: 'disconnect_google',
  kind: 'risky',
  description:
    "Call this only when the student asks to disconnect Google, stop syncing their email, or revoke Gmail access. The sign-in is revoked and the account row removed; imported mail stays until they delete their data. Needs the student's approval.",
  input: z.object({}),
  capabilities: ['google_disconnect'],
  progress: 'Disconnecting Google',
  async summarizeIntent(_input, ctx) {
    const account = await googleAccount(ctx.user.id);
    return {
      text: `Disconnect Google${account?.externalAccountId ? ` (${account.externalAccountId})` : ''}. Orbit stops reading mail and calendar; what was imported stays.`,
      blockedReason: account ? undefined : 'Google is not connected.',
    };
  },
  async execute(_input, ctx) {
    const had = await disconnectGoogleAccount(ctx.user.id);
    if (!had) throw new Error('Google is not connected.');
    const out = { connected: false };
    return ok(
      'settings',
      out,
      out,
      'Disconnected. Imported mail stays until you delete your data.',
      '/settings/integrations',
    );
  },
  toModel,
});

export const exportData = defineTool({
  name: 'export_data',
  kind: 'risky',
  description:
    "Call this only when the student asks to export, back up or download all their Orbit data. Returns one JSON file with every table (people, chats, notes, facts, drafts, what was sent, synced email text and events), never the Anthropic key. It is private data, so it needs the student's approval.",
  input: z.object({}),
  capabilities: ['privacy_export_all'],
  progress: 'Preparing your export',
  async summarizeIntent() {
    return {
      text: 'Download everything Orbit stores about your network as one JSON file. Keep it private; it does not include your Anthropic key.',
    };
  },
  async execute(_input, ctx) {
    const data = await exportAllData();
    const json = JSON.stringify(data, null, 1);
    const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
    const filename = exportFilename(ctx.now);
    const model = { filename, bytes: json.length, counts };
    return {
      kind: 'text' as const,
      data: { ui: { filename, json, counts, mimeType: 'application/json' }, forModel: model },
      summary: `Export ready: ${filename}, ${plural(counts.people ?? 0, 'person', 'people')}, ${plural(counts.chats ?? 0, 'chat')}, ${plural(counts.notes ?? 0, 'note')}. Keep it private.`,
      href: '/settings/privacy',
    };
  },
  toModel,
});

export const deleteAllDataTool = defineTool({
  name: 'delete_all_data',
  kind: 'risky',
  description:
    "Call this only when the student explicitly asks to delete or wipe all their Orbit data from this browser. Google is disconnected, the Anthropic key cleared, every table wiped and the session ended; it cannot be undone. Suggest export_data first. Needs the student's approval.",
  input: z.object({}),
  capabilities: ['privacy_delete_all', 'account_sign_out'],
  progress: 'Deleting everything',
  async summarizeIntent() {
    return {
      text: 'Delete all Orbit data from this browser: people, chats, notes, drafts, settings and the Anthropic key. This cannot be undone.',
    };
  },
  async execute() {
    await deleteAllData();
    const out = { deleted: true, href: '/' };
    return ok(
      'text',
      out,
      out,
      'Everything is deleted from this browser. Orbit starts over from the landing page.',
      '/',
    );
  },
  toModel,
});

export const loadDemoTool = defineTool({
  name: 'load_demo',
  kind: 'risky',
  description:
    "Call this only when the student asks to load the demo, try the sample student, or reset to the demo data. It replaces everything in this browser with a made-up student (Alex) and a sample season of email, calendar and notes, so it needs the student's approval; the confirmation says what would be lost.",
  input: z.object({}),
  capabilities: ['demo_load'],
  progress: 'Loading the demo',
  async summarizeIntent(_input, ctx) {
    const user = await db.users.get(ctx.user.id);
    return {
      text:
        demoResetPrompt(user) ?? 'Reload the demo from scratch. Changes you made to the demo data are lost.',
    };
  },
  async execute(_input, ctx) {
    const user = await loadDemo({ reset: true, now: ctx.now });
    const out = { userId: user.id, name: user.fullName, href: '/today' };
    return ok(
      'text',
      out,
      out,
      `The demo is loaded: ${user.fullName}'s sample network. Open Today to see the first brief.`,
      '/today',
    );
  },
  toModel,
});

export const leaveDemo = defineTool({
  name: 'leave_demo',
  kind: 'risky',
  description:
    "Call this only when the student, in the demo, asks to set up Orbit for themselves or leave the demo. The sample data is cleared from this browser and an empty profile starts setup. Only the demo's data goes. Needs the student's approval.",
  input: z.object({}),
  capabilities: ['demo_leave_for_own_setup'],
  progress: 'Clearing the demo',
  async summarizeIntent(_input, ctx) {
    return {
      text: 'Clear the demo data from this browser and start your own setup.',
      blockedReason: ctx.user.id === DEMO_USER_ID ? undefined : 'You are not in the demo.',
    };
  },
  async execute(_input, ctx) {
    if (ctx.user.id !== DEMO_USER_ID) throw new Error('You are not in the demo.');
    const user = await leaveDemoForOwnSetup();
    await setCurrentUserId(user.id);
    const out = { userId: user.id, href: '/onboarding/1' };
    return ok('text', out, out, 'The demo is cleared. Setup starts with your own details.', '/onboarding/1');
  },
  toModel,
});

export const accountTools: AnyTool[] = [
  saveResumeTool,
  importLinkedin,
  syncGoogleTool,
  disconnectGoogleTool,
  exportData,
  deleteAllDataTool,
  loadDemoTool,
  leaveDemo,
];
