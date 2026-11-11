/**
 * Settings, Autopilot (plan 29 §B1, §B5): one page, three modes, the rules printed under Autopilot in plain words and
 * never hidden, the rungs as they stand per kind with their counts and the ladder's switches, a "Run on autopilot"
 * switch on each goal, Pause and Stop everything, and in local mode the honest line that Orbit sends only while it is
 * open. The same page in both modes: an account reads the server's status, local mode this browser's own.
 */
import type { AutopilotMode, AutopilotRung, Goal } from '@orbit/core';
import { firstTouchRungLine } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useAutopilotStatus } from '../../components/autopilot/useAutopilotStatus';
import {
  ChoiceTiles,
  SettingsCard,
  SettingsHeader,
  SettingsRow,
  SettingsStack,
} from '../../components/settings/kit';
import { db } from '../../db/schema';
import {
  AUTOPILOT_MODE_TEXT,
  AUTOPILOT_RULES,
  FIRST_TOUCH_RUNG_RULE,
  LOCAL_AUTOPILOT_NOTE,
  pauseAutopilot,
  setGoalAutopilot,
  setMode,
} from '../../engine/autopilotMode';
import { setAutoReplies } from '../../engine/funnels';
import { GOAL_KIND_LABELS } from '../../engine/goals';
import { LADDER_WORDS, type LadderKind, setAutoKind } from '../../engine/trust';
import { useSession } from '../../state/session';
import { Button, relDate, Switch, useToast } from '../../ui';

const MODES: AutopilotMode[] = ['off', 'assist', 'autopilot'];
const DAY = 86_400_000;

/** What a rung's state says: "Orbit sends", "earned", or "14 of 20 approved unchanged". */
function rungState(r: AutopilotRung): string {
  if (r.unlocked) return r.kind === 'first_touch' ? 'Earned: the batch goes on silence' : 'Orbit sends';
  if (r.unchanged >= r.needed) return 'Earned, asks you';
  return `${r.unchanged} of ${r.needed} approved unchanged`;
}

const RUNG_TITLES: Record<AutopilotRung['kind'], string> = {
  bump: LADDER_WORDS.bump.title,
  thank_you: LADDER_WORDS.thank_you.title,
  schedule: LADDER_WORDS.schedule.title,
  first_touch: 'First messages',
};

export function AutopilotSection() {
  const { user } = useSession();
  const toast = useToast();
  const view = useAutopilotStatus(user);
  const settings = useLiveQuery(() => (user ? db.settings.get(user.id) : undefined), [user?.id]);
  const goals =
    useLiveQuery(
      async () =>
        user
          ? (await db.userGoals.where('userId').equals(user.id).toArray()).filter(
              (g) => !g.deletedAt && g.status === 'active',
            )
          : [],
      [user?.id],
    ) ?? [];
  const [busy, setBusy] = useState<string>();
  if (!user) return null;
  const status = view.status;
  const mode: AutopilotMode = status?.mode ?? settings?.autopilotMode ?? 'off';
  const accountLevel = mode === 'autopilot' ? 2 : mode === 'assist' ? 1 : 0;

  const run = async (key: string, fn: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    setBusy(key);
    try {
      const r = await fn();
      toast.push(r.ok ? { text: done } : { text: r.message ?? 'That did not work.', tone: 'bad' });
      await view.refresh();
    } finally {
      setBusy(undefined);
    }
  };
  const choose = (m: AutopilotMode) =>
    run(`mode:${m}`, () => setMode(user, m), `Orbit is on ${AUTOPILOT_MODE_TEXT[m].title}.`);
  const goalSwitch = (g: Goal, on: boolean) =>
    run(
      `goal:${g.id}`,
      () => setGoalAutopilot(user, g.id, on),
      on ? `${g.title} runs on autopilot.` : `${g.title} no longer runs on autopilot.`,
    );
  const pause = (days: number | null) =>
    run(
      'pause',
      () =>
        pauseAutopilot(user, {
          until: days === null ? null : new Date(Date.now() + days * DAY).toISOString(),
        }),
      days === null
        ? 'Autopilot is back on.'
        : days >= 365
          ? "Stopped. Nothing goes on its own and tomorrow's batch is back in your drafts until you turn it on again."
          : `Paused for ${days === 1 ? 'a day' : `${days} days`}.`,
    );
  const liftGoal = (goalId: string) =>
    run('lift', () => pauseAutopilot(user, { until: null, goalId }), 'Lifted. That goal runs again.');

  const pausedUntil = status?.pausedUntil ?? null;
  const stopped = !!pausedUntil && Date.parse(pausedUntil) - Date.now() > 300 * DAY;
  const auto = new Set(settings?.autoKinds ?? []);
  const rungs = status?.rungs ?? [];
  const first = rungs.find((r) => r.kind === 'first_touch');

  return (
    <div data-testid="settings-autopilot">
      <SettingsHeader
        title="Autopilot"
        description={
          view.local
            ? `How much Orbit does on its own, and the rules it never breaks. ${LOCAL_AUTOPILOT_NOTE}`
            : 'How much Orbit does on its own, and the rules it never breaks.'
        }
      />
      <SettingsStack>
        <SettingsCard title="Mode">
          <div className="py-1">
            <ChoiceTiles
              label="Autopilot mode"
              value={mode}
              onChange={(m) => void choose(m)}
              disabled={!!busy}
              busy={MODES.find((m) => busy === `mode:${m}`)}
              options={MODES.map((m) => ({
                value: m,
                title: AUTOPILOT_MODE_TEXT[m].title,
                line: AUTOPILOT_MODE_TEXT[m].summary,
                testId: `autopilot-mode-${m}`,
              }))}
            />
            {mode !== 'off' && (
              <p
                className="mt-4 text-[13px] leading-relaxed text-ink-2 max-w-[68ch]"
                data-testid="autopilot-mode-body"
              >
                {AUTOPILOT_MODE_TEXT[mode].body}
              </p>
            )}
          </div>
        </SettingsCard>

        <SettingsCard
          title="Replies"
          description="Works in any mode, for threads you started."
          data-testid="autopilot-replies"
        >
          <SettingsRow
            label="Answer simple replies for me"
            description="Booking a time, thank-yous and interested replies go on their own. A question or a no waits for you."
            control={
              <Switch
                checked={!!settings?.autoReplies}
                onChange={(v: boolean) =>
                  void run(
                    'replies',
                    async () => {
                      await setAutoReplies(user.id, v);
                      return { ok: true };
                    },
                    v ? 'Orbit answers simple replies for you now.' : 'Replies wait for your tap again.',
                  )
                }
                label="Answer simple replies for me"
              />
            }
          />
        </SettingsCard>

        <SettingsCard title="Rules Autopilot never breaks" description="They hold whenever Autopilot is on.">
          <ul
            className="p-4 grid gap-x-8 gap-y-2.5 @[34rem]:grid-cols-2 text-[13px] text-ink-2"
            data-testid="autopilot-rules"
          >
            {[...AUTOPILOT_RULES, FIRST_TOUCH_RUNG_RULE].map((r) => (
              <li key={r} className="flex items-start gap-2.5">
                <Check size={14} className="mt-[3px] shrink-0 text-good" aria-hidden />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </SettingsCard>

        <SettingsCard
          title="What Orbit has earned"
          description="Orbit earns each kind when you approve its drafts unchanged. First messages come last."
          data-testid="autopilot-rungs"
        >
          {rungs.map((r) => {
            const ladder = r.kind !== 'first_touch';
            const mine = ladder && auto.has(r.kind as LadderKind);
            return (
              <SettingsRow
                key={r.kind}
                data-testid={`autopilot-rung-${r.kind}`}
                label={RUNG_TITLES[r.kind]}
                description={
                  ladder
                    ? rungState({ ...r, unlocked: mine })
                    : firstTouchRungLine({ unchanged: r.unchanged, needed: r.needed, earned: r.unlocked })
                }
                control={
                  ladder ? (
                    <Switch
                      checked={mine}
                      onChange={(v: boolean) =>
                        void run(
                          `kind:${r.kind}`,
                          async () => {
                            await setAutoKind(user.id, r.kind as LadderKind, v);
                            return { ok: true };
                          },
                          v
                            ? `Orbit sends ${LADDER_WORDS[r.kind as LadderKind].many} on its own.`
                            : `${LADDER_WORDS[r.kind as LadderKind].title} wait for your tap again.`,
                        )
                      }
                      label={`Orbit sends ${LADDER_WORDS[r.kind as LadderKind].many} on its own`}
                    />
                  ) : (
                    <span className="text-[12.5px] text-ink-2 tabular" data-testid="autopilot-rung-count">
                      {r.unchanged} of {r.needed}
                    </span>
                  )
                }
              />
            );
          })}
          {!rungs.length && (
            <p className="px-5 py-4 text-[13px] text-ink-3">Reading where each kind stands.</p>
          )}
        </SettingsCard>

        <SettingsCard
          title="Goals on autopilot"
          description="A goal can run on autopilot while the rest stays by hand. The rules above apply to every goal."
          data-testid="autopilot-goals"
        >
          {goals.length ? (
            goals.map((g) => {
              const on = (g.autonomyLevel ?? accountLevel) === 2;
              const pausedGoal = status?.pausedGoals.find((p) => p.goalId === g.id);
              return (
                <SettingsRow
                  key={g.id}
                  data-testid={`goal-autopilot-${g.id}`}
                  label={g.title}
                  description={
                    pausedGoal
                      ? `${GOAL_KIND_LABELS[g.kind]}. Paused: ${pausedGoal.reason}`
                      : `${GOAL_KIND_LABELS[g.kind]}. ${g.targets.organizations.length ? `${g.targets.organizations.length} ${g.targets.organizations.length === 1 ? 'company' : 'companies'} on it.` : 'No companies on it yet, so autopilot has no one to write to first.'}`
                  }
                  control={
                    <>
                      {pausedGoal && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void liftGoal(g.id)}
                          disabled={!!busy}
                        >
                          Lift the pause
                        </Button>
                      )}
                      <Switch
                        checked={on}
                        busy={busy === `goal:${g.id}`}
                        onChange={(v: boolean) => void goalSwitch(g, v)}
                        label={`Run ${g.title} on autopilot`}
                        data-testid="goal-autopilot-switch"
                      />
                    </>
                  }
                />
              );
            })
          ) : (
            <p className="px-5 py-4 text-[13px] text-ink-3">
              No goals yet. Add one in Goals and it can run on autopilot from here.
            </p>
          )}
        </SettingsCard>

        <SettingsCard
          title="Pause"
          description="Nothing goes out while paused. Stop everything also returns tomorrow's batch to your drafts."
          data-testid="autopilot-pause"
          footer={
            pausedUntil ? (
              <Button size="sm" variant="primary" onClick={() => void pause(null)} disabled={!!busy}>
                Turn it back on
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => void pause(1)}
                  disabled={!!busy}
                  data-testid="autopilot-pause-day"
                >
                  Pause for a day
                </Button>
                <Button
                  size="sm"
                  onClick={() => void pause(7)}
                  disabled={!!busy}
                  data-testid="autopilot-pause-week"
                >
                  Pause for a week
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void pause(365 * 5)}
                  disabled={!!busy}
                  data-testid="autopilot-stop"
                >
                  Stop everything
                </Button>
              </>
            )
          }
        >
          <p className="px-5 py-4 text-[13px] text-ink-2" data-testid="autopilot-pause-state">
            {pausedUntil
              ? stopped
                ? 'Stopped until you turn it back on.'
                : `Paused until ${relDate(pausedUntil)}.`
              : first
                ? `On. ${status?.caps.usedToday ?? 0} of ${status?.caps.autoPerDay ?? 5} sends on its own today, ${status?.caps.firstTouchesThisWeek ?? 0} of ${status?.caps.firstTouchPerWeek ?? 12} first messages this week.`
                : 'On.'}
          </p>
        </SettingsCard>
      </SettingsStack>
    </div>
  );
}
