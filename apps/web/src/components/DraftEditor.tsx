import type { OutboundMessage } from '@orbit/core';
import { MAX_WORDS, wordCount } from '@orbit/core';
import { useEffect, useState } from 'react';
import { Button, cx, Input, Textarea } from '../ui';

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
  const [body, setBody] = useState(draft.bodyFinal ?? draft.bodyDraft);
  const [subject, setSubject] = useState(draft.subject ?? '');
  useEffect(() => {
    setBody(draft.bodyFinal ?? draft.bodyDraft);
    setSubject(draft.subject ?? '');
  }, [draft.id, draft.bodyDraft, draft.bodyFinal, draft.subject]);
  const wc = wordCount(body);
  const max = MAX_WORDS[draft.kind];
  const edited = body.trim() !== draft.bodyDraft.trim();
  const isLinkedIn = draft.channel === 'linkedin';
  return (
    <div>
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
      <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-3">
        <span className={cx('tabular', wc > max + 25 && 'text-warn')}>
          {wc} words{wc > max ? ` (aim for ≤ ${max})` : ''}
        </span>
        {isLinkedIn && (
          <span className={cx('tabular', body.length > 300 && draft.kind === 'outreach' && 'text-warn')}>
            {body.length} chars
          </span>
        )}
        <span>{draft.generatedBy === 'llm' ? 'Drafted with Claude' : 'Drafted from template'}</span>
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
            disabled={busy || !body.trim()}
            onClick={() => onApprove(body, subject || undefined)}
          >
            {approveLabel ?? (isLinkedIn ? 'Copy & open LinkedIn' : 'Approve & send')}
          </Button>
        </span>
      </div>
    </div>
  );
}
