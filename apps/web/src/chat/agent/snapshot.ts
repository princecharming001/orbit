import type { ChatStage, Suggestion } from '@orbit/core';
import { STAGE_LABELS, todayKey } from '@orbit/core';
import { db } from '../../db/schema';
import { DEMO_USER_ID } from '../../engine/demo';
import { activeGoals, goalLine } from '../../engine/goals';
import { liveLinkedInAvailable } from '../../engine/linkedinLive';
import { rememberedLines } from '../../engine/memory';
import { resumeProposalLine } from '../../engine/resume';
import { googleStatus, syncStatusNow } from '../../engine/serverSync';
import { todayCards } from '../../engine/today';
import { villageAvailable } from '../../engine/warmIntros';
import { googleClientId } from '../../integrations/google';
import { isServerUser } from '../../integrations/orbitApi';
import { llmFeatures, readPrefs } from '../../integrations/prefs';
import { sharedClaudeAvailable } from '../../integrations/shared-claude';
import { getPanelHint } from '../panel/panelHint';
import { offeredGoalLine } from './afterTurn';
import { setupLine } from './setup';

/**
 * The volatile context the model needs on every turn, appended to `messages` as a `role: 'system'` message only when
 * it changed (so the cached prefix and the thinking-block binding survive). Budget 400 to 700 tokens: the date in the
 * student's timezone, who they are, their goals, pipeline counts, up to six brief cards, pending drafts, integration
 * status and which Claude features are on. No email bodies, no facts, no notes: everything else is a tool call.
 */
export interface Snapshot {
  /** the text sent to the model */
  text: string;
  /** the text without the clock, compared with the last appended copy to decide whether to append again */
  key: string;
  /** YYYY-MM-DD in the student's timezone */
  day: string;
}

const STAGES: ChatStage[] = [
  'identified',
  'warming',
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
  'declined',
  'no_response',
];

const MAX_CARDS = 6;
const MAX_DRAFT_IDS = 5;

function fmtDate(now: Date, tz: string): { date: string; time: string } {
  const opts = (o: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz }).format(now);
    } catch {
      return new Intl.DateTimeFormat('en-US', o).format(now);
    }
  };
  return {
    date: `${opts({ weekday: 'short' })} ${todayKey(now, tz)}`,
    time: opts({ hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

/** A card as one line: `id kind Person (reason in at most eight words)`. */
function cardLine(s: Suggestion, names: Map<string, string>): string {
  const who = s.personId ? (names.get(s.personId) ?? 'someone') : '';
  const reason = s.reasonText
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ')
    .replace(/[.,;:]$/, '');
  return `${s.id} ${s.kind}${who ? ` ${who}` : ''}${reason ? ` (${reason})` : ''}`;
}

/** How long the snapshot waits for memory before it goes without it (the turn should not stall on the server). */
const REMEMBERED_TIMEOUT_MS = 2500;
const REMEMBERED_MAX_CHARS = 1200;

export async function buildSnapshot(
  userId: string,
  now: Date,
  opts: { lastUserText?: string } = {},
): Promise<Snapshot> {
  const account = isServerUser(userId);
  // the server's memories in account mode, this browser's otherwise (engine/memory.ts picks)
  const remembered = rememberedLines({ id: userId }, opts.lastUserText, {
    signal: AbortSignal.timeout(REMEMBERED_TIMEOUT_MS),
    maxChars: REMEMBERED_MAX_CHARS,
  }).catch(() => [] as string[]);
  const resumeOffer = resumeProposalLine(userId).catch(() => undefined);
  const [user, goals, chats, suggestions, briefs, outbound, integrations, people, targets, resumes, goalsV3] =
    await Promise.all([
      db.users.get(userId),
      db.goals.get(userId),
      db.chats.where('userId').equals(userId).toArray(),
      db.suggestions
        .where('userId')
        .equals(userId)
        .filter((s) => s.status === 'pending')
        .toArray(),
      db.briefs.where('userId').equals(userId).toArray(),
      db.outbound
        .where('userId')
        .equals(userId)
        .filter((o) => o.status === 'draft' || o.status === 'queued' || o.status === 'handed_off')
        .toArray(),
      db.integrations.where('userId').equals(userId).toArray(),
      db.people.where('userId').equals(userId).toArray(),
      db.targetCompanies.where('userId').equals(userId).toArray(),
      db.resumes.where('userId').equals(userId).count(),
      activeGoals(userId),
    ]);
  const tz = user?.timezone || 'UTC';
  const { date, time } = fmtDate(now, tz);
  const names = new Map(people.map((p) => [p.id, p.displayName]));

  const student = user
    ? [
        user.fullName || user.firstName,
        [user.school, user.graduationYear ? `'${String(user.graduationYear).slice(-2)}` : '']
          .filter(Boolean)
          .join(' '),
        user.majors?.length ? user.majors.join(', ') : '',
      ]
        .filter(Boolean)
        .join(', ')
    : 'unknown';
  const goalBits = goals
    ? [
        goals.cycleLabel,
        ...goals.targetRoles.slice(0, 4),
        ...goals.targetFunctions.slice(0, 3),
        ...goals.targetIndustries.slice(0, 3),
      ].filter(Boolean)
    : [];

  const counts = new Map<ChatStage, number>();
  for (const c of chats) if (!c.archivedAt) counts.set(c.stage, (counts.get(c.stage) ?? 0) + 1);
  const pipeline = STAGES.filter((s) => counts.get(s))
    .map((s) => `${s} ${counts.get(s)}`)
    .join(', ');

  const latest = briefs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const { cards } = todayCards(suggestions, latest, now);
  const cardLines = cards.slice(0, MAX_CARDS).map((s) => cardLine(s, names));
  const moreCards = Math.max(0, cards.length - MAX_CARDS);

  // oldest first: the longest-waiting drafts are the ones to mention
  const drafts = outbound
    .filter((o) => o.status === 'draft')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const draftLine = drafts.length
    ? `${drafts.length} (${drafts
        .slice(0, MAX_DRAFT_IDS)
        .map((d) => `${d.id} ${names.get(d.personId)?.split(' ')[0] ?? ''}`.trim())
        .join(', ')}${drafts.length > MAX_DRAFT_IDS ? ', ...' : ''})`
    : '0';
  const inFlight = outbound.length - drafts.length;

  // account mode: Google is the account's own sign-in, and the server reports how the import is going
  const serverGoogle = account ? googleStatus(syncStatusNow()) : undefined;
  const google = integrations.find((i) => i.provider === 'google');
  const linkedin = integrations.find((i) => i.provider === 'linkedin_csv');
  const live = integrations.find(
    (i) => i.provider === 'linkedin_live' && i.status !== 'revoked' && !!i.externalAccountId,
  );
  const demo = integrations.find((i) => i.provider === 'demo');
  // the same "connected" the setup widget reads (setupStatus.ts): a Google row that was not revoked
  const googleConnected = account
    ? serverGoogle?.status !== 'needs_reauth' && serverGoogle?.status !== 'revoked'
    : !!google && google.status !== 'revoked';
  const daysAgo = (iso?: string) =>
    iso
      ? `${Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 86_400_000))} d ago`
      : 'never';
  const integ = [
    google ? `Google ${google.status}` : demo ? 'demo calendar' : 'Google not connected',
    `LinkedIn import ${linkedin ? daysAgo(linkedin.lastSyncedAt ?? linkedin.connectedAt) : 'never'}`,
    ...(live
      ? [
          `LinkedIn live ${live.status === 'error' ? 'needs attention' : `synced ${daysAgo(live.lastSyncedAt)}`}`,
        ]
      : []),
    ...(villageAvailable({ id: userId }) ? ['warm intros on'] : []),
  ].join(', ');

  const prefs = readPrefs();
  const feats = llmFeatures(prefs);
  const claude = prefs.anthropicApiKey
    ? (Object.keys(feats) as (keyof typeof feats)[])
        .filter((k) => k !== 'chat')
        .map((k) => `${k} ${feats[k] ? 'on' : 'off'}`)
        .join(', ')
    : sharedClaudeAvailable()
      ? "no key of the student's own; the chat runs on Orbit's shared access (daily limit, chat only)"
      : 'no key';

  const claudeAccess = prefs.anthropicApiKey ? 'own_key' : sharedClaudeAvailable() ? 'shared' : 'none';
  const humans = people.filter((p) => p.isHuman && !p.hiddenAt).length;
  const setup = setupLine({
    people: humans,
    linkedinImported: !!linkedin || !!live,
    linkedinLive: !!live,
    liveLinkedInAvailable: !!user && liveLinkedInAvailable(user),
    googleConnected,
    googleAvailable: !!googleClientId(),
    resumeOnFile: resumes > 0,
    targetCompanies: targets.filter((t) => t.status !== 'closed').length,
    claude: claudeAccess,
    demo: userId === DEMO_USER_ID,
    account: account
      ? {
          google: serverGoogle?.status ?? 'unknown',
          backfill: serverGoogle?.backfill ?? null,
          messages: syncStatusNow()?.counts.messages,
        }
      : undefined,
  });
  const panel = getPanelHint();
  const panelLine = panel
    ? `Open panel: ${panel.title.replace(/\s+/g, ' ').trim().slice(0, 60)} (${panel.href.slice(0, 80)}). The student can see it next to the chat.`
    : '';

  const memory = await remembered;
  const offered = account ? offeredGoalLine(userId) : undefined;
  const resumeLine = await resumeOffer;
  const lines = [
    `Student: ${student}.${goalBits.length ? ` Goals: ${goalBits.join(', ')}.` : ''}`,
    `Active goals (ids): ${goalsV3.length ? goalsV3.map((g) => `${g.id} ${goalLine(g)}`).join('; ') : 'none tracked'}.`,
    ...(memory.length ? [`Remembered (ids): ${memory.join('; ')}.`] : []),
    ...(offered ? [offered] : []),
    ...(resumeLine ? [resumeLine] : []),
    `Pipeline (chats by stage, ${chats.filter((c) => !c.archivedAt).length} total): ${pipeline || 'empty'}. People: ${humans}.`,
    `Today's brief (ids): ${cardLines.length ? cardLines.join('; ') : 'nothing pending'}${moreCards ? `; ${moreCards} more` : ''}.`,
    `Drafts unsent: ${draftLine}.${inFlight ? ` In flight (queued or handed off): ${inFlight}.` : ''}`,
    `Integrations: ${integ}. Claude features: ${claude}.`,
    setup,
    ...(panelLine ? [panelLine] : []),
    `Stage names: ${STAGES.map((s) => `${s} = ${STAGE_LABELS[s]}`).join(', ')}.`,
  ];
  const key = [`Today is ${date}, ${tz}.`, ...lines].join('\n');
  const text = [`Today is ${date}, ${time}, ${tz}.`, ...lines].join('\n');
  return { text, key, day: todayKey(now, tz) };
}

/** Rough token estimate for the budget test (about four characters a token for English prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Whether a fresh snapshot must be appended: no earlier copy, a different day, or anything but the clock changed.
 * `previousKey` is the stored snapshot's key (its text without the time).
 */
export function snapshotIsStale(previous: { key: string; day: string } | undefined, next: Snapshot): boolean {
  if (!previous) return true;
  return previous.day !== next.day || previous.key !== next.key;
}

/** The staleness key of a stored snapshot message: its text with the clock removed. */
export function snapshotKeyOf(text: string): { key: string; day: string } {
  const key = text.replace(/^(Today is \w{3} \d{4}-\d{2}-\d{2}), \d{2}:\d{2}, /, '$1, ');
  const day = text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
  return { key, day };
}
