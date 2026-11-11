/**
 * How a card's step happens when tapped (plan 42). A step does its work where the student is, and only says it in the
 * thread when words are the point:
 *
 * - `open`: a page of the app in the side panel (a person's prep deck). No tool, no turn.
 * - `run` with `show: 'panel'`: the tool runs at once and its card opens in the side panel (a draft to edit and send,
 *   the routes to someone). The step reads as done; tapping it again opens the same card again.
 * - `run` alone: the tool runs at once and the step says it is done ("Added to targets"), as plan 37 §4 built.
 * - neither, or no panel to show it in (a page outside the chat): the step's message is sent as the next turn.
 *
 * The run is recorded on the card's conversation, so a reload shows it done and the next turn tells the model.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useContext, useRef, useState } from 'react';
import { db } from '../../../db/schema';
import { usePanel } from '../../panel/PanelProvider';
import { rememberPanelResult, resultHref } from '../../panel/results';
import { type StepRun, tapActionId } from '../../types';
import { ChoicesContext } from './Choices';
import { type NextStep, StepRunnerContext } from './parts';

export type StepMode = 'open' | 'panel' | 'place' | 'send';
export type StepState = 'ready' | 'running' | 'done' | 'failed';

export interface StepGo {
  mode: StepMode;
  state: StepState;
  /** what the step says once done ("Draft to Zain", "Added to targets"); the label for a sent step */
  doneLabel: string;
  error?: string;
  /** a chat turn is running: a step that would send a message waits */
  blocked: boolean;
  go: () => void;
}

export function useStepGo(step: NextStep, send: (text: string) => Promise<void> | void): StepGo {
  const panel = usePanel();
  const runner = useContext(StepRunnerContext);
  const { running } = useContext(ChoicesContext);
  const run: StepRun | undefined = step.run;
  const canRun = !!(run && runner.run && runner.origin);
  // a result meant for the panel, with no panel here (a page outside the chat): the message instead
  const mode: StepMode =
    step.open && panel
      ? 'open'
      : canRun && run!.show === 'panel'
        ? panel
          ? 'panel'
          : 'send'
        : canRun
          ? 'place'
          : 'send';
  const id =
    canRun && (mode === 'panel' || mode === 'place')
      ? tapActionId(runner.origin!, { label: step.label, run: run! })
      : undefined;
  // a tap recorded earlier (this conversation, before a reload)
  const stored = useLiveQuery(() => (id ? db.chatActions.get(id) : undefined), [id]);
  const [local, setLocal] = useState<StepState>();
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const state: StepState = local ?? (stored?.status === 'done' ? 'done' : 'ready');
  const doneLabel = mode === 'panel' || mode === 'place' ? run!.done : step.label;
  const openResult = () => {
    if (id && panel) panel.open(resultHref(id), { focus: true });
  };
  const go = () => {
    if (busy.current) return;
    if (mode === 'open') {
      panel!.open(step.open!, { focus: true });
      setLocal('done');
      return;
    }
    if (mode === 'send') {
      if (running) return;
      busy.current = true;
      setLocal('done');
      void Promise.resolve(send(step.message)).finally(() => {
        busy.current = false;
      });
      return;
    }
    // the card is already in the panel: open it again, never run it twice
    if (state === 'done') {
      if (mode === 'panel') openResult();
      return;
    }
    if (state === 'running') return;
    busy.current = true;
    setLocal('running');
    setError(undefined);
    void runner.run!({ label: step.label, run: run! })
      .then((env) => {
        if (env.kind === 'error') {
          setLocal('failed');
          setError(env.summary);
          return;
        }
        if (mode === 'place' && env.kind === 'needs_confirmation') {
          setLocal('failed');
          setError('That needs your approval in a message.');
          return;
        }
        if (mode === 'panel') {
          rememberPanelResult(id!, { toolName: run!.tool, envelope: env, title: run!.done });
          panel!.open(resultHref(id!), { focus: true });
        }
        setLocal('done');
      })
      .catch((e: unknown) => {
        setLocal('failed');
        setError(e instanceof Error ? e.message : 'That did not go through.');
      })
      .finally(() => {
        busy.current = false;
      });
  };
  return { mode, state, doneLabel, error, blocked: mode === 'send' && running, go };
}
