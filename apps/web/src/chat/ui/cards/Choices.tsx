/**
 * Tap-to-answer pills under an assistant message. A tap sends the option's message as the student's next turn. The
 * pills wait while a turn runs; once the student has sent anything later they are gone: the option they tapped stays
 * as a quiet "You chose" line, and when they typed their own words instead nothing is left behind, so there is never
 * a dead button in the thread.
 */
import { Check } from 'lucide-react';
import { createContext, useContext, useRef } from 'react';
import { cx } from '../../../ui';
import type { ChoiceOption } from '../../types';
import type { CardActions } from './ResultCard';

export interface ChoicesState {
  /** a turn is running */
  running: boolean;
  /** the text of the first message the student sent after this assistant turn, if any */
  laterUserText?: string;
}

/** Provided by the thread for each assistant turn; the default is a live, idle thread. */
export const ChoicesContext = createContext<ChoicesState>({ running: false });

export function Choices({
  options,
  actions,
}: {
  options: ChoiceOption[];
  actions: Pick<CardActions, 'send'>;
}) {
  const { running, laterUserText } = useContext(ChoicesContext);
  // a second tap before the thread reports "running" must not send twice
  const sent = useRef(false);
  if (!options.length) return null;
  if (laterUserText !== undefined) {
    const chosen = options.find((o) => o.message.trim() === laterUserText.trim());
    if (!chosen) return null;
    return (
      <div
        className="my-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-3 fade-up"
        data-testid="result-choices"
        data-state="answered"
      >
        <Check size={13} aria-hidden /> You chose: {chosen.label}
      </div>
    );
  }
  return (
    <div
      className="my-2 flex flex-wrap gap-2"
      role="group"
      aria-label="Suggested replies"
      data-testid="result-choices"
      data-state="open"
    >
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          className={cx(
            'glass glass-hover type-chip rounded-full min-h-10 px-4 text-ink-2 hover:text-ink text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none max-w-full',
          )}
          disabled={running}
          data-testid="choice-pill"
          onClick={() => {
            if (sent.current || running) return;
            sent.current = true;
            void Promise.resolve(actions.send(o.message)).finally(() => {
              sent.current = false;
            });
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
