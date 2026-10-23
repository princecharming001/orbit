/** Settings writes: targets, recommendations, profile and goals, limits, Claude, resume lines, setup steps. */
import type { TargetCompany } from '@orbit/core';
import { FUNCTION_CODES, FUNCTION_LABELS, functionCodeFor, TARGET_STATUS_LABELS } from '@orbit/core';
import { db } from '../../db/schema';
import { finishOnboarding, ONBOARDING_DONE_STEP, setOnboardingStep } from '../../engine/account';
import { recommendationsRefresh } from '../../engine/brief';
import {
  dismissRecommendation,
  RECOMMENDATION_DISMISS_REASONS,
  restoreRecommendation,
  saveRecommendation,
} from '../../engine/recommend';
import { fixResumeFacet, setResumeFacetUsed } from '../../engine/resume';
import {
  dismissHint,
  forgetLearnedStyle,
  LIMIT_RANGES,
  learnStyleFromSent,
  removeTargetCompany,
  saveGoals,
  savePreferences,
  setSchedulingLink,
  setTargetDeadline,
  setTargetPriority,
  setTargetStatus,
  setTonePreset,
  updateLimits,
  updateProfile,
} from '../../engine/settings';
import { addTargetCompanies } from '../../engine/targets';
import { hasLlm, testApiKey } from '../../integrations/anthropic';
import {
  DEFAULT_DAILY_REQUEST_CAP,
  DEFAULT_DAILY_TOKEN_CAP,
  type LlmFeature,
  llmFeatures,
  readPrefs,
  updatePrefs,
  writePrefs,
} from '../../integrations/prefs';
import { z } from '../../zod';
import { type AnyTool, defineTool, ok, personRef, plural, toModel } from './_shared';

const TARGET_STATUSES = Object.keys(TARGET_STATUS_LABELS) as [
  TargetCompany['status'],
  ...TargetCompany['status'][],
];

function targetView(t: TargetCompany) {
  return {
    id: t.id,
    name: t.nameRaw,
    priority: t.priority,
    priorityLabel: t.priority === 1 ? 'Top priority' : t.priority === 2 ? 'Normal' : 'Low',
    status: t.status,
    statusLabel: TARGET_STATUS_LABELS[t.status],
    deadline: t.deadline,
  };
}

export const manageTargetCompany = defineTool({
  name: 'manage_target_company',
  kind: 'write',
  description:
    'Call this only when the student adds target companies ("add Evercore and Lazard to my targets"), changes a target\'s priority (top, normal, low), records where an application stands (researching, applied, interviewing, offer, closed; this drives the applied, interviewing and offer cards), or sets a deadline. Removing is delete_target_company. Target ids come from get_settings goals.',
  input: z.object({
    action: z.enum(['add', 'set_priority', 'set_status', 'set_deadline']).describe('What to do.'),
    names: z.string().optional().describe('For add: the companies, comma separated ("Evercore, Lazard").'),
    targetId: z.string().optional().describe('For the set actions: the target company id.'),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe('For set_priority: 1 top, 2 normal, 3 low.'),
    status: z
      .enum(TARGET_STATUSES)
      .optional()
      .describe('For set_status: researching, applied, interviewing, offer or closed.'),
    deadline: z.string().optional().describe('For set_deadline: YYYY-MM-DD, or empty to remove it.'),
  }),
  capabilities: [
    'target_company_add',
    'target_company_priority',
    'target_company_status',
    'target_company_deadline',
    'onboarding_goals',
  ],
  progress: 'Updating your targets',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    if (input.action === 'add') {
      if (!input.names?.trim()) throw new Error('Say which companies to add.');
      const r = await addTargetCompanies(userId, input.names);
      const all = await db.targetCompanies.where('userId').equals(userId).toArray();
      const out = { added: r.added, duplicates: r.duplicates, targets: all.map(targetView) };
      const parts = [
        r.added.length ? `Added ${r.added.join(', ')}.` : '',
        r.duplicates.length
          ? `${r.duplicates.join(', ')} ${r.duplicates.length === 1 ? 'was' : 'were'} already on your list.`
          : '',
      ].filter(Boolean);
      return ok('settings', out, out, parts.join(' ') || 'Nothing to add.', '/settings/goals');
    }
    if (!input.targetId) throw new Error('Say which target company (its id from get_settings).');
    const t = await db.targetCompanies.get(input.targetId);
    if (!t || t.userId !== userId) throw new Error('Orbit has no target company with that id.');
    let summary: string;
    if (input.action === 'set_priority') {
      if (!input.priority) throw new Error('Give the priority: 1 top, 2 normal, 3 low.');
      await setTargetPriority(t.id, input.priority);
      summary = `${t.nameRaw} is now ${input.priority === 1 ? 'a top priority' : input.priority === 2 ? 'a normal target' : 'a low priority'}.`;
    } else if (input.action === 'set_status') {
      if (!input.status) throw new Error('Give the application status.');
      await setTargetStatus(t.id, input.status, ctx.now);
      summary = `${t.nameRaw}: ${TARGET_STATUS_LABELS[input.status]}.${input.status === 'applied' || input.status === 'interviewing' || input.status === 'offer' ? ' Orbit can suggest telling the people you know there.' : ''}`;
    } else {
      await setTargetDeadline(t.id, input.deadline);
      summary = input.deadline
        ? `${t.nameRaw}'s deadline is ${input.deadline}.`
        : `Removed the deadline for ${t.nameRaw}.`;
    }
    const fresh = (await db.targetCompanies.get(t.id))!;
    const out = { target: targetView(fresh) };
    return ok('settings', out, out, summary, '/settings/goals');
  },
  toModel,
});

export const deleteTargetCompany = defineTool({
  name: 'delete_target_company',
  kind: 'risky',
  description:
    'Call this only when the student asks to remove a company from their target list ("I am no longer targeting Bain"). Needs the student\'s approval; it can be added again with manage_target_company.',
  input: z.object({
    targetId: z.string().describe('The target company id (from get_settings goals).'),
  }),
  capabilities: ['target_company_remove'],
  progress: 'Removing the target',
  async summarizeIntent(input, ctx) {
    const t = await db.targetCompanies.get(input.targetId);
    if (!t || t.userId !== ctx.user.id)
      return { text: 'Remove a target company.', blockedReason: 'Orbit has no target company with that id.' };
    return { text: `Remove ${t.nameRaw} from your target companies.` };
  },
  async execute(input, ctx) {
    const t = await db.targetCompanies.get(input.targetId);
    if (!t || t.userId !== ctx.user.id) throw new Error('Orbit has no target company with that id.');
    const removed = await removeTargetCompany(t.id);
    const out = { removed: removed ? targetView(removed) : undefined };
    return ok(
      'settings',
      { ...out, row: removed },
      out,
      `Removed ${t.nameRaw} from your targets.`,
      '/settings/goals',
    );
  },
  toModel,
});

const REC_REASONS = Object.keys(RECOMMENDATION_DISMISS_REASONS) as [
  keyof typeof RECOMMENDATION_DISMISS_REASONS,
  ...(keyof typeof RECOMMENDATION_DISMISS_REASONS)[],
];

export const manageRecommendation = defineTool({
  name: 'manage_recommendation',
  kind: 'write',
  description:
    'Call this only when the student asks to save a Discover recommendation for later, dismiss one as not a fit (wrong_role, wrong_company, know_them, not_now), bring a dismissed one back, or refresh the recommendations. Starting a message to a recommended person is create_draft.',
  input: z.object({
    action: z.enum(['save', 'dismiss', 'restore', 'refresh']).describe('What to do.'),
    recommendationId: z
      .string()
      .optional()
      .describe('The recommendation id (from list_recommendations); not needed for refresh.'),
    reason: z.enum(REC_REASONS).optional().describe('For dismiss: why it is not a fit.'),
  }),
  capabilities: ['discover_save', 'discover_dismiss', 'discover_refresh'],
  progress: 'Updating Discover',
  async execute(input, ctx) {
    if (input.action === 'refresh') {
      await recommendationsRefresh(ctx.user, ctx.now);
      const shown = await db.recommendations
        .where('userId')
        .equals(ctx.user.id)
        .filter((r) => r.status === 'new' || r.status === 'saved')
        .count();
      const out = { recommendations: shown };
      return ok(
        'people',
        out,
        out,
        shown
          ? `${plural(shown, 'recommendation')} ready on Discover.`
          : 'No recommendations yet. Add people at your target companies or import your LinkedIn connections first.',
        '/discover',
      );
    }
    if (!input.recommendationId) throw new Error('Say which recommendation.');
    const r = await db.recommendations.get(input.recommendationId);
    if (!r || r.userId !== ctx.user.id) throw new Error('Orbit has no recommendation with that id.');
    const person = await db.people.get(r.personId);
    const name = person?.firstName ?? 'them';
    let summary: string;
    if (input.action === 'save') {
      await saveRecommendation(r.id);
      summary = `Saved ${name}. Saved people stay at the top of Discover until you write to them.`;
    } else if (input.action === 'dismiss') {
      if (!input.reason) throw new Error('Give the reason: wrong_role, wrong_company, know_them or not_now.');
      await dismissRecommendation(ctx.user.id, r.id, input.reason);
      summary = `Removed ${name} (${RECOMMENDATION_DISMISS_REASONS[input.reason].toLowerCase()}). Orbit learns from this for the next list.`;
    } else {
      await restoreRecommendation(r.id);
      summary = `${name} is back on Discover.`;
    }
    const fresh = (await db.recommendations.get(r.id))!;
    const out = {
      recommendationId: fresh.id,
      status: fresh.status,
      person: person ? personRef(person) : undefined,
      undo:
        input.action === 'dismiss'
          ? { tool: 'manage_recommendation', input: { action: 'restore', recommendationId: r.id } }
          : undefined,
    };
    return ok('people', out, out, summary, '/discover');
  },
  toModel,
});

const SECTIONS = ['profile', 'goals', 'style', 'schedule', 'hints', 'chat'] as const;

export const updateSettings = defineTool({
  name: 'update_settings',
  kind: 'write',
  description:
    "Call this only when the student asks to change their profile (name, email, school, graduation year, degree, majors, city, LinkedIn, timezone), their goals (recruiting cycle, functions, roles, industries, locations, free text, ambition), their writing style (warm, direct or formal; learn from sent mail; forget the learned style), their scheduling link or brief time, to show or hide Orbit's reasoning (the grey notes under its answers), or to close a first-run hint. Sending limits and Claude settings are update_limits, set_llm_feature and set_claude_key. Give only the fields that change.",
  input: z.object({
    section: z.enum(SECTIONS).describe('Which section the fields belong to.'),
    fullName: z.string().optional().describe('profile'),
    email: z.string().optional().describe('profile'),
    school: z.string().optional().describe('profile'),
    schoolDomain: z.string().optional().describe('profile: the school email domain ("cornell.edu").'),
    graduationYear: z.number().int().min(2000).max(2100).optional().describe('profile'),
    degree: z.string().optional().describe('profile ("BS", "MBA").'),
    majors: z.array(z.string()).optional().describe('profile'),
    currentCity: z.string().optional().describe('profile'),
    linkedinUrl: z.string().optional().describe('profile'),
    timezone: z.string().optional().describe('profile: an IANA zone ("America/Los_Angeles").'),
    cycleLabel: z.string().optional().describe('goals: the recruiting cycle ("Summer 2027 internship").'),
    targetFunctions: z
      .array(z.string())
      .optional()
      .describe(
        'goals: kinds of work, as codes or words (swe, pm, ib, consulting, data, design, finance, marketing, research, vc, ops).',
      ),
    targetRoles: z.array(z.string()).optional().describe('goals'),
    targetIndustries: z.array(z.string()).optional().describe('goals'),
    targetLocations: z.array(z.string()).optional().describe('goals'),
    freeText: z.string().optional().describe('goals: anything else that matters.'),
    ambition: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe(
        'goals: 1 light (2 first messages a week), 2 steady (4), 3 all in (7); also sets the weekly goal.',
      ),
    tonePreset: z.enum(['warm', 'direct', 'formal']).optional().describe('style'),
    learnFromSentMail: z
      .boolean()
      .optional()
      .describe('style: true learns the style from at least five sent emails (Google only).'),
    forgetLearnedStyle: z
      .boolean()
      .optional()
      .describe('style: true drops the learned style and uses the picked tone.'),
    schedulingLink: z
      .string()
      .optional()
      .describe('schedule: the Calendly or Cal.com link drafts include; empty removes it.'),
    briefTimeLocal: z.string().optional().describe('schedule: when the daily brief is built, HH:MM.'),
    hintId: z.string().optional().describe('hints: the first-run hint to close for good (today, pipeline).'),
    showReasoning: z
      .boolean()
      .optional()
      .describe(
        "chat: true shows Orbit's own notes to itself (the grey lines before each step) in the thread; false hides them (the default).",
      ),
  }),
  capabilities: [
    'settings_profile_update',
    'settings_goals_update',
    'style_tone_preset',
    'style_learn_from_sent',
    'style_use_picked',
    'limits_scheduling_link',
    'hint_dismiss',
    'chat_reasoning_toggle',
    'onboarding_about',
    'onboarding_goals',
    'onboarding_prefs',
  ],
  progress: 'Saving your settings',
  async execute(input, ctx) {
    const userId = ctx.user.id;
    const did: string[] = [];
    switch (input.section) {
      case 'profile': {
        const patch: Record<string, unknown> = {};
        for (const k of [
          'fullName',
          'email',
          'school',
          'schoolDomain',
          'graduationYear',
          'degree',
          'majors',
          'currentCity',
          'linkedinUrl',
          'timezone',
        ] as const)
          if (input[k] !== undefined) patch[k] = input[k];
        if (!Object.keys(patch).length) throw new Error('Say which profile field to change.');
        if (typeof patch.fullName === 'string' && !patch.fullName.trim())
          throw new Error('Your name is used to sign every message, so it cannot be empty.');
        const user = await updateProfile(userId, patch);
        if (!user) throw new Error('The profile could not be saved.');
        did.push(...Object.keys(patch));
        const out = {
          profile: {
            fullName: user.fullName,
            email: user.email,
            school: user.school,
            schoolDomain: user.schoolDomain,
            graduationYear: user.graduationYear,
            degree: user.degree,
            majors: user.majors,
            currentCity: user.currentCity,
            linkedinUrl: user.linkedinUrl,
            timezone: user.timezone,
          },
        };
        return ok('settings', out, out, `Profile saved: ${did.join(', ')}.`, '/settings/profile');
      }
      case 'goals': {
        const functions = input.targetFunctions?.map((f) => functionCodeFor(f) ?? f.trim()).filter(Boolean);
        const unknown = functions?.filter((f) => !FUNCTION_CODES.includes(f));
        const goals = await saveGoals(
          userId,
          {
            cycleLabel: input.cycleLabel,
            targetFunctions: functions,
            targetRoles: input.targetRoles,
            targetIndustries: input.targetIndustries,
            targetLocations: input.targetLocations,
            freeText: input.freeText,
            ambition: input.ambition,
          },
          { applyAmbition: input.ambition !== undefined },
        );
        const out = {
          goals: { ...goals, functions: goals.targetFunctions.map((f) => FUNCTION_LABELS[f] ?? f) },
          unknownFunctions: unknown,
        };
        return ok(
          'settings',
          out,
          out,
          `Goals saved${goals.targetFunctions.length ? `: ${goals.targetFunctions.map((f) => FUNCTION_LABELS[f] ?? f).join(', ')}` : ''}.${unknown?.length ? ` Orbit kept "${unknown.join('", "')}" as typed; the known kinds of work are ${Object.values(FUNCTION_LABELS).join(', ')}.` : ''}${input.ambition ? ' The weekly goal follows the ambition.' : ''}`,
          '/settings/goals',
        );
      }
      case 'style': {
        if (input.tonePreset) {
          const style = await db.styles.get(userId);
          if (style && !input.forgetLearnedStyle)
            throw new Error(
              'Drafts follow the style learned from your sent mail. Say forget the learned style to pick a tone instead.',
            );
          await setTonePreset(userId, input.tonePreset);
          did.push(`tone ${input.tonePreset}`);
        }
        if (input.forgetLearnedStyle) {
          await forgetLearnedStyle(userId);
          if (input.tonePreset) await setTonePreset(userId, input.tonePreset);
          did.push('learned style dropped');
        }
        if (input.learnFromSentMail) {
          const r = await learnStyleFromSent(ctx.user, ctx.now);
          if (!r.ok) throw new Error(r.reason);
          did.push(`learned from ${r.count} sent emails`);
        }
        if (!did.length) throw new Error('Say the tone to use, or whether to learn from sent mail.');
        const settings = await db.settings.get(userId);
        const out = { style: { tonePreset: settings?.tonePreset, learned: !!(await db.styles.get(userId)) } };
        return ok('settings', out, out, `Writing style: ${did.join(', ')}.`, '/settings/style');
      }
      case 'schedule': {
        if (input.schedulingLink !== undefined) {
          const link = input.schedulingLink.trim();
          if (link && !/^https?:\/\//i.test(link))
            throw new Error('The scheduling link should start with https://.');
          await setSchedulingLink(userId, link || undefined);
          did.push(link ? 'scheduling link saved' : 'scheduling link removed');
        }
        if (input.briefTimeLocal !== undefined) {
          if (!/^\d{2}:\d{2}$/.test(input.briefTimeLocal)) throw new Error('Give the brief time as HH:MM.');
          await savePreferences(userId, { briefTimeLocal: input.briefTimeLocal });
          did.push(`brief at ${input.briefTimeLocal}`);
        }
        if (!did.length) throw new Error('Give the scheduling link or the brief time.');
        const settings = await db.settings.get(userId);
        const out = {
          schedule: { schedulingLink: settings?.schedulingLink, briefTimeLocal: settings?.briefTimeLocal },
        };
        return ok('settings', out, out, `${did.join(', ')}.`, '/settings/limits');
      }
      case 'chat': {
        if (input.showReasoning === undefined) throw new Error('Say whether to show or hide the reasoning.');
        writePrefs({ showReasoning: input.showReasoning });
        const out = { chat: { showReasoning: input.showReasoning } };
        return ok(
          'settings',
          out,
          out,
          input.showReasoning
            ? "Orbit's reasoning now shows under its answers."
            : "Orbit's reasoning is hidden again.",
          '/settings/integrations',
        );
      }
      case 'hints': {
        if (!input.hintId) throw new Error('Say which hint to close.');
        await dismissHint(userId, input.hintId);
        const out = { hint: input.hintId, dismissed: true };
        return ok('settings', out, out, 'That tip will not show again.', '/');
      }
    }
  },
  toModel,
});

export const updateLimitsTool = defineTool({
  name: 'update_limits',
  kind: 'risky',
  description:
    "Call this only when the student asks to change how much Orbit lets them write: first messages a week (1 to 350), hours between messages to the same person, emails per day (1 to 50), LinkedIn messages per day (1 to 30), follow-ups when no reply (0 to 2), warm-ups on or off and their length in working days (2 to 10), or the daily Claude request and token caps. These change what can go out, so they need the student's approval.",
  input: z.object({
    weeklyOutreachTarget: z.number().int().optional().describe('First messages a week, 1 to 350.'),
    perPersonCooldownHours: z
      .number()
      .int()
      .optional()
      .describe('Hours between unanswered messages to the same person.'),
    dailySendCapGmail: z.number().int().optional().describe('Emails per day, at most.'),
    dailySendCapLinkedin: z.number().int().optional().describe('LinkedIn messages per day, at most.'),
    maxBumps: z.number().int().optional().describe('Follow-ups when someone has not replied (0 to 2).'),
    warmUpEnabled: z.boolean().optional().describe('Warm up before messaging strangers on LinkedIn.'),
    warmUpDays: z.number().int().optional().describe('Warm-up length in working days (2 to 10).'),
    llmDailyRequestCap: z.number().int().min(0).optional().describe('Claude requests per day.'),
    llmDailyTokenCap: z.number().int().min(0).optional().describe('Claude tokens per day.'),
  }),
  capabilities: [
    'limits_weekly_target',
    'limits_cooldown',
    'limits_daily_caps',
    'limits_max_bumps',
    'limits_warmup_toggle',
    'limits_warmup_days',
    'claude_caps_set',
  ],
  progress: 'Saving your limits',
  async summarizeIntent(input) {
    const parts = Object.entries(input)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} to ${String(v)}`);
    return {
      text: parts.length ? `Set ${parts.join(', ')}.` : 'Change your limits.',
      blockedReason: parts.length ? undefined : 'Nothing to change.',
    };
  },
  async execute(input, ctx) {
    const { llmDailyRequestCap, llmDailyTokenCap, ...limits } = input;
    const given = Object.entries(limits).filter(([, v]) => v !== undefined);
    if (!given.length && llmDailyRequestCap === undefined && llmDailyTokenCap === undefined)
      throw new Error('Say which limit to change.');
    const settings = given.length
      ? await updateLimits(ctx.user.id, limits)
      : await db.settings.get(ctx.user.id);
    if (llmDailyRequestCap !== undefined)
      writePrefs({ llmDailyRequestCap: Math.max(0, Math.floor(llmDailyRequestCap)) });
    if (llmDailyTokenCap !== undefined)
      writePrefs({ llmDailyTokenCap: Math.max(0, Math.floor(llmDailyTokenCap)) });
    const prefs = readPrefs();
    const out = {
      limits: settings
        ? {
            weeklyOutreachTarget: settings.weeklyOutreachTarget,
            perPersonCooldownHours: settings.perPersonCooldownHours,
            dailySendCapGmail: settings.dailySendCapGmail,
            dailySendCapLinkedin: settings.dailySendCapLinkedin,
            maxBumps: settings.maxBumps,
            warmUpEnabled: settings.warmUpEnabled,
            warmUpDays: settings.warmUpDays,
          }
        : undefined,
      claudeCaps: {
        requestsPerDay: prefs.llmDailyRequestCap ?? DEFAULT_DAILY_REQUEST_CAP,
        tokensPerDay: prefs.llmDailyTokenCap ?? DEFAULT_DAILY_TOKEN_CAP,
      },
      ranges: LIMIT_RANGES,
    };
    const clamped = given
      .filter(([k, v]) => settings && typeof v === 'number' && settings[k as keyof typeof settings] !== v)
      .map(([k]) => k);
    return ok(
      'settings',
      out,
      out,
      `Limits saved.${clamped.length ? ` ${clamped.join(', ')} ${clamped.length === 1 ? 'was' : 'were'} kept inside the allowed range.` : ''}`,
      '/settings/limits',
    );
  },
  toModel,
});

export const setClaudeKey = defineTool({
  name: 'set_claude_key',
  kind: 'risky',
  description:
    "Call this only when the student gives an Anthropic API key to save (Orbit tests it with one tiny request), or asks to remove the saved key. The key stays in this browser, apart from the rest of the data, and is never exported. Never read the key back; get_usage says only whether one is saved. Needs the student's approval.",
  input: z.object({
    apiKey: z.string().optional().describe('The key to save and test; leave out to remove the saved key.'),
  }),
  capabilities: ['claude_key_save_test', 'claude_key_remove', 'onboarding_prefs'],
  progress: 'Saving the key',
  async summarizeIntent(input) {
    return {
      text: input.apiKey?.trim()
        ? 'Save this Anthropic API key in this browser and test it with one small request. Anthropic bills your account for what Claude does from then on.'
        : hasLlm()
          ? 'Remove the saved Anthropic API key. Orbit goes back to writing every draft on its own.'
          : 'Remove the key.',
      blockedReason: !input.apiKey?.trim() && !hasLlm() ? 'No key is saved.' : undefined,
    };
  },
  async execute(input) {
    const key = input.apiKey?.trim();
    if (!key) {
      if (!hasLlm()) throw new Error('No key is saved.');
      writePrefs({ anthropicApiKey: undefined });
      const out = { keySaved: false };
      return ok(
        'settings',
        out,
        out,
        'Key removed. Orbit writes every draft on its own again.',
        '/settings/integrations',
      );
    }
    writePrefs({ anthropicApiKey: key });
    const r = await testApiKey();
    const out = { keySaved: true, works: r.ok, error: r.error, features: llmFeatures(readPrefs()) };
    return ok(
      'settings',
      out,
      out,
      r.ok
        ? 'Key saved and it works. Claude now drafts messages; the other features are off until turned on.'
        : `Key saved, but the test failed: ${r.error ?? 'unknown error'}`,
      '/settings/integrations',
    );
  },
  toModel,
});

const FEATURES = ['drafts', 'emailTriage', 'notes', 'resume', 'summaries', 'chat'] as const;
const FEATURE_WORDS: Record<LlmFeature, string> = {
  drafts: 'write drafts (sends the facts and thread context for each message to Anthropic)',
  emailTriage: 'read synced email to sort it (sends email text to Anthropic)',
  notes: 'read meeting notes (sends the note text to Anthropic)',
  resume: 'read the resume (sends its text to Anthropic)',
  summaries: 'write person summaries (sends facts and history to Anthropic)',
  chat: 'answer in the chat on the home page (sends what you type and a short summary of your day to Anthropic)',
};

export const setLlmFeature = defineTool({
  name: 'set_llm_feature',
  kind: 'risky',
  description:
    "Call this only when the student asks to change what Claude may do: drafts, emailTriage (Google only), notes, resume, summaries, chat (the home page chat itself). Each one changes what leaves the device, so it needs the student's approval. A key must be saved first (set_claude_key).",
  input: z.object({
    feature: z.enum(FEATURES).describe('Which feature.'),
    on: z.boolean().describe('true to allow it, false to turn it off.'),
  }),
  capabilities: ['claude_feature_toggle'],
  progress: 'Updating what Claude may do',
  async summarizeIntent(input) {
    return {
      text: `${input.on ? 'Let Claude' : 'Stop Claude from'} ${FEATURE_WORDS[input.feature]}.`,
      blockedReason: hasLlm() ? undefined : 'No Anthropic key is saved yet. Save one first.',
    };
  },
  async execute(input) {
    if (!hasLlm()) throw new Error('No Anthropic key is saved yet. Save one first.');
    const prefs = updatePrefs((cur) => ({
      ...cur,
      llmFeatures: { ...llmFeatures(cur), [input.feature]: input.on },
    }));
    const out = { features: llmFeatures(prefs) };
    return ok(
      'settings',
      out,
      out,
      `Claude ${input.on ? 'may now' : 'no longer will'} ${FEATURE_WORDS[input.feature].split(' (')[0]}.`,
      '/settings/integrations',
    );
  },
  toModel,
});

export const updateResumeFacet = defineTool({
  name: 'update_resume_facet',
  kind: 'write',
  description:
    'Call this only when the student asks to stop using (or use again) a line Orbit read from their resume, or to fix one: the role or degree, where, and what they did. Facet ids come from get_settings integrations. A fixed line is kept and marked confirmed.',
  input: z.object({
    facetId: z.string().describe('The resume line id.'),
    used: z.boolean().optional().describe('false: never use this line; true: use it again.'),
    title: z.string().optional().describe('The corrected role or degree.'),
    organizationName: z.string().optional().describe('The corrected employer, school or project.'),
    text: z.string().optional().describe('The corrected description.'),
  }),
  capabilities: ['resume_facet_toggle', 'resume_facet_fix', 'onboarding_resume'],
  progress: 'Updating the resume line',
  async execute(input) {
    const facet = await db.resumeFacets.get(input.facetId);
    if (!facet) throw new Error('Orbit has no resume line with that id.');
    const did: string[] = [];
    if (input.title !== undefined || input.organizationName !== undefined || input.text !== undefined) {
      await fixResumeFacet(facet.id, {
        title: input.title,
        organizationName: input.organizationName,
        text: input.text,
      });
      did.push('fixed');
    }
    if (input.used !== undefined) {
      await setResumeFacetUsed(facet.id, input.used);
      did.push(input.used ? 'used again' : 'no longer used');
    }
    if (!did.length) throw new Error('Say whether to use the line, or what to fix.');
    const fresh = (await db.resumeFacets.get(facet.id))!;
    const out = {
      facet: {
        id: fresh.id,
        kind: fresh.kind,
        title: fresh.title,
        organization: fresh.organizationName,
        text: fresh.text,
        used: !fresh.excluded,
      },
    };
    return ok('settings', out, out, `Resume line ${did.join(' and ')}.`, '/settings/integrations');
  },
  toModel,
});

export const advanceOnboarding = defineTool({
  name: 'advance_onboarding',
  kind: 'write',
  description:
    'Call this only during setup, when the student asks to go to the next step, skip a step, or finish setup ("I am done, take me to the chat"). Finishing builds the recommendations and the welcome brief. The setup steps are 1 welcome, 2 about you, 3 goals, 4 LinkedIn, 5 Gmail (only when Google sign-in is set up), 6 ready; the profile and goals themselves are saved with update_settings, and the resume, tone and other details are set later in Settings.',
  input: z.object({
    step: z
      .number()
      .int()
      .min(1)
      .max(ONBOARDING_DONE_STEP)
      .optional()
      .describe('The step to move to (1 to 6).'),
    finish: z.boolean().optional().describe('true: finish setup.'),
  }),
  capabilities: ['onboarding_step_nav', 'onboarding_finish', 'landing_get_started'],
  progress: 'Moving setup along',
  async execute(input, ctx) {
    if (input.finish) {
      const user = await db.users.get(ctx.user.id);
      if (user?.onboardingCompletedAt) {
        const out = { completed: true, step: user.onboardingStep };
        return ok('settings', out, out, 'Setup was already finished.', '/');
      }
      if (!user?.fullName.trim() || !user.school.trim())
        throw new Error(
          'Setup needs at least a name and a school before it can finish. Add them to your profile first.',
        );
      const fresh = await finishOnboarding(ctx.user.id, ctx.now);
      const out = { completed: true, step: fresh?.onboardingStep };
      return ok('settings', out, out, 'Setup finished. Your first brief is ready in the chat.', '/');
    }
    if (!input.step) throw new Error('Say which step, or finish.');
    const step = await setOnboardingStep(ctx.user.id, input.step);
    const out = { step, href: `/onboarding/${Math.max(0, (step ?? input.step) - 1)}` };
    return ok('settings', out, out, `Setup is on step ${step}.`, out.href);
  },
  toModel,
});

export const settingsTools: AnyTool[] = [
  manageTargetCompany,
  deleteTargetCompany,
  manageRecommendation,
  updateSettings,
  updateLimitsTool,
  setClaudeKey,
  setLlmFeature,
  updateResumeFacet,
  advanceOnboarding,
];
