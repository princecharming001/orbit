import type { OutboundMessage } from '@orbit/core';
import { LINKEDIN_NOTE_MAX, MAX_WORDS, wordsIn } from '@orbit/core';
import { useEffect, useState } from 'react';
import { regenerateDraft } from '../engine/brief';
import { useSession } from '../state/session';
import { Button, cx, Input, Textarea } from '../ui';

const INPUT_PROMPT: Record<
  'connection' | 'update' | 'post',
  { label: string; hint: string; placeholder: string }
> = {
  connection: {
    label: 'One line only true of them',
    hint: 'How you found them, what you share, or what of theirs you read. Orbit will not send a cold message without it.',
    placeholder: 'e.g. Read your post on pricing experiments at Ramp; we both interned at Brex',
  },
  update: {
    label: 'One real update since you last spoke',
    hint: 'What you did with their advice, or what changed. A check-in without news reads as a nudge.',
    placeholder: 'e.g. Took your advice and moved my summer to the ops role; first week was ...',
  },
  post: {
    label: 'What is their post about?',
    hint: 'One claim from it, in your words.',
    placeholder: 'e.g. junior engineers should own a metric in their first quarter',
  },
};

export function DraftEditor({
  draft,
  onApprove,
  onCancel,
  busy,
  approveLabel,
}: {
  draft: OutboundMessage;
  onApprove: (body: string, subject?: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  approveLabel?: string;
}) {
  const { user } = useSession();
  const [body, setBody] = useState(draft.bodyFinal ?? draft.bodyDraft);
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [regenerating, setRegenerating] = useState(false);
  useEffect(() => {
    setBody(draft.bodyFinal ?? draft.bodyDraft);
    setSubject(draft.subject ?? '');
  }, [draft.id, draft.bodyDraft, draft.bodyFinal, draft.subject]);
  const wc = wordsIn(body);
  const max = MAX_WORDS[draft.kind];
  const edited = body.trim() !== draft.bodyDraft.trim();
  const isLinkedIn = draft.channel === 'linkedin';
  const needs = (draft.needsInput ?? []).filter((n) => n === 'connection' || n === 'update');
  const hasPlaceholder = /\[[^\]]{3,}\]/.test(body);
  const blocked = needs.length > 0 && (hasPlaceholder || !edited);
  const canRegenerate = needs.every((n) => (inputs[n] ?? '').trim().length >= 8);
  const regenerate = async () => {
    if (!user) return;
    setRegenerating(true);
    await regenerateDraft(user, draft.id, { connection: inputs.connection, update: inputs.update });
    setRegenerating(false);
  };
  return (
    <div>
      {needs.length > 0 && (
        <div
          className="mb-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-[13px]"
          data-testid="draft-needs-input"
        >
          {needs.map((n) => (
            <div key={n} className="mb-2 last:mb-0">
              <div className="font-medium">{INPUT_PROMPT[n].label}</div>
              <div className="text-ink-3 text-[12px] mb-1.5">{INPUT_PROMPT[n].hint}</div>
              <Input
                value={inputs[n] ?? ''}
                onChange={(e) => setInputs((v) => ({ ...v, [n]: e.target.value }))}
                placeholder={INPUT_PROMPT[n].placeholder}
                aria-label={INPUT_PROMPT[n].label}
              />
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!canRegenerate || regenerating}
              onClick={regenerate}
            >
              {regenerating ? 'Redrafting…' : 'Redraft with this'}
            </Button>
            <span className="text-[12px] text-ink-3">or edit the bracketed line yourself below.</span>
          </div>
        </div>
      )}
      {!isLinkedIn && !draft.externalThreadId && (
        <div className="mb-2">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            aria-label="Subject"
          />
        </div>
      )}
      {!isLinkedIn && draft.externalThreadId && (
        <div className="text-[12px] text-ink-3 mb-2">
          Replies in the existing thread{draft.subject ? `: ${draft.subject}` : ''}
        </div>
      )}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(14, Math.max(6, body.split('\n').length + 2))}
        aria-label="Message body"
      />
      <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-3 flex-wrap">
        <span className={cx('tabular', wc > max && 'text-warn')}>
          {wc} words{wc > max ? ` (aim for ≤ ${max})` : ''}
        </span>
        {isLinkedIn && (
          <span
            className={cx(
              'tabular',
              body.length > LINKEDIN_NOTE_MAX && draft.kind === 'outreach' && 'text-warn',
            )}
          >
            {body.length} chars
          </span>
        )}
        <span>{draft.generatedBy === 'llm' ? 'Drafted with Claude' : 'Drafted from the playbook'}</span>
        {edited && (
          <button className="underline underline-offset-2" onClick={() => setBody(draft.bodyDraft)}>
            Reset to suggested
          </button>
        )}
        <span className="ml-auto flex gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !body.trim() || blocked}
            title={blocked ? 'Add the missing line first' : undefined}
            onClick={() => onApprove(body, subject || undefined)}
          >
            {approveLabel ?? (isLinkedIn ? 'Copy & open LinkedIn' : 'Approve & send')}
          </Button>
        </span>
      </div>
    </div>
  );
}
