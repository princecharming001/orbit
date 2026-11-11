/**
 * A card button's result in the side panel (plan 42): the same card the chat would draw (a draft to edit and send,
 * the routes to someone, drafts to several), with every button on it working, beside the conversation instead of
 * under it. Approving a send here goes through the same confirmation as in the thread.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageLoading } from '../../pages/lazyPages';
import { NotFound } from '../../ui';
import { useChatEngine } from '../engineContext';
import type { ResultEnvelope } from '../types';
import { type CardActions, ResultCard } from '../ui/cards/ResultCard';
import { type ToolBlock, threadActions } from '../ui/threadStore';
import { loadPanelResult, type PanelResult, panelResultNow } from './results';

export default function ResultPanel() {
  const { id = '' } = useParams();
  const engine = useChatEngine();
  const thread = useMemo(() => threadActions(engine), [engine]);
  // this tab's run at once; after a reload, the action row the run recorded
  const [result, setResult] = useState<PanelResult | null | undefined>(() => panelResultNow(id));
  useEffect(() => {
    let live = true;
    const now = panelResultNow(id);
    if (now) setResult(now);
    else void loadPanelResult(id).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [id]);
  const [status, setStatus] = useState<ToolBlock['status']>('done');
  const [outcome, setOutcome] = useState<ResultEnvelope>();
  if (result === undefined) return <PageLoading />;
  if (result === null)
    return (
      <div className="px-5">
        <NotFound
          title="This is no longer here"
          body="It came from a chat that was closed or cleared. Ask again in the chat to bring it back."
          to="/"
          linkLabel="Back to the chat"
        />
      </div>
    );
  const env = result.envelope;
  const block: ToolBlock = {
    type: 'tool',
    toolUseId: id,
    toolName: result.toolName,
    status: env.kind === 'needs_confirmation' && status === 'done' ? 'pending' : status,
    envelope: env,
    outcome,
  };
  const actions: CardActions = {
    async approve(toolUseId, edited) {
      const r = await engine.approve(env.confirmationId ?? toolUseId, edited);
      if (r.kind === 'error') return r.summary;
      setStatus('approved');
      setOutcome(r);
      return undefined;
    },
    async cancel(toolUseId) {
      await engine.cancel(env.confirmationId ?? toolUseId);
      setStatus('cancelled');
    },
    send: (text) => thread.send(text),
    runStep: (origin, step) => thread.runStep(origin, step),
  };
  return (
    // the panel is the frame: the card draws flat inside it, no box within a box
    <div
      className="@container px-1 pb-6 [&>*]:!my-0 [&>*]:!border-0 [&>*]:!bg-transparent [&>*]:!shadow-none [&>*]:!px-0 [&>*]:!pt-0 [&>*]:!backdrop-blur-none"
      data-testid="panel-result"
      data-kind={env.kind}
    >
      <ResultCard block={block} actions={actions} />
    </div>
  );
}
