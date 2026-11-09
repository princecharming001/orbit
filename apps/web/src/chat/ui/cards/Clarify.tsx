/**
 * A question back (plan 37 §3.2): the ask named something that fits several things ("Triumph" is two companies the
 * student knows people at), so nothing ran. Each option is one tap; the tap sends the pick as the student's next turn
 * and the original ask runs with it. Once the student has answered, the card is a quiet "Triumph Law" line, so the
 * thread reads question, answer, result and never keeps a dead button.
 */
import { Check } from 'lucide-react';
import { useContext, useRef } from 'react';
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
  return (
    <div
      className="my-2 flex flex-col gap-1.5 max-w-[460px]"
      role="group"
      aria-label={data.question}
      data-testid="result-clarify"
      data-state="open"
    >
      {data.options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="w-full text-left px-3.5 py-2.5 rounded-[6px] border border-line bg-canvas hover:bg-canvas-2 hover:border-[#d6d4d0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:pointer-events-none"
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
          <span className="block text-[14px] font-medium text-ink">{o.label}</span>
          {o.sub && <span className="block text-[12.5px] text-ink-3 mt-0.5">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}
