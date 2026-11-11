/**
 * A question back (plan 37 §3.2): the ask named something that fits several things ("Triumph" is two companies the
 * student knows people at), so nothing ran. Each option is one tap; the tap sends the pick as the student's next turn
 * and the original ask runs with it. Once the student has answered, the card is a quiet "Triumph Law" line, so the
 * thread reads question, answer, result and never keeps a dead button.
 */
import { Check } from 'lucide-react';
import { useContext, useRef } from 'react';
import { cx } from '../../../ui';
import { parsePick, pickMessage, withoutPick } from '../../clarify';
import type { ClarifyData } from '../../types';
import { ChoicesContext } from './Choices';
import type { CardActions } from './ResultCard';

export function ClarifyCard({
  data,
  toolUseId,
  actions,
}: {
  data: ClarifyData;
  toolUseId: string;
  actions: Pick<CardActions, 'send'>;
}) {
  const { running, laterUserText, askText, firstClarify } = useContext(ChoicesContext);
  const sent = useRef(false);
  // the ask this question interrupted; when it was itself a pick, the ask that pick finished
  const ask = askText ? (parsePick(askText)?.ask ?? withoutPick(askText)) : undefined;
  // two tools of one round can both find the same two companies: the question is asked once
  if (firstClarify && firstClarify !== toolUseId) return null;
  if (laterUserText !== undefined) {
    const pick = parsePick(laterUserText);
    const chosen = pick && data.options.find((o) => o.id === pick.id || o.label === pick.label);
    if (!chosen) return null;
    return (
      <div
        className="my-1.5 flex items-center gap-1.5 text-[12.5px] text-ink-3 fade-up"
        data-testid="result-clarify"
        data-state="answered"
      >
        <Check size={13} aria-hidden /> {chosen.label}
      </div>
    );
  }
  // choice chips (the student's pick): a few likely answers as taps, and a way out to type their own
  return (
    <div
      className="my-2 flex flex-wrap gap-2"
      role="group"
      aria-label={data.question}
      data-testid="result-clarify"
      data-state="open"
    >
      {data.options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          className={cx(
            'inline-flex max-w-full items-baseline gap-1.5 rounded-full border px-4 py-2 text-left text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none pointer-coarse:min-h-11',
            i === 0
              ? 'border-accent/50 bg-accent-soft text-ink hover:bg-[#dcebe4]'
              : 'border-line bg-canvas text-ink hover:bg-canvas-2 hover:border-[#d6d4d0]',
          )}
          disabled={running}
          data-testid="clarify-option"
          onClick={() => {
            if (sent.current || running) return;
            sent.current = true;
            void Promise.resolve(actions.send(pickMessage(data.about, data.term, o, ask))).finally(() => {
              sent.current = false;
            });
          }}
        >
          <span className="font-medium truncate">{o.label}</span>
          {o.sub && <span className="text-[12.5px] text-ink-3 truncate">{o.sub}</span>}
        </button>
      ))}
      <button
        type="button"
        className="rounded-full border border-dashed border-line px-4 py-2 text-[14px] text-ink-3 hover:text-ink hover:border-[#cfcbc5] pointer-coarse:min-h-11"
        onClick={() => {
          const box = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
          box?.focus();
        }}
        data-testid="clarify-other"
      >
        Something else
      </button>
    </div>
  );
}
