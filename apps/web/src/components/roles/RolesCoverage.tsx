/**
 * Plan 44 §4.2: the tab says what it covers, in words, and takes a posting from anywhere. "Roles from 1,240 company
 * boards, SimplifyJobs and your LinkedIn search. Paste a posting from anywhere to score it." A link or the posting's
 * text, scored now; the result opens in the role panel.
 */
import type { RolesCoverage as Coverage, RoleMatch } from '@orbit/core';
import { useState } from 'react';
import { coverageWords, scorePosting } from '../../engine/roles';
import { Button, cx } from '../../ui';

export function RolesCoverage({
  userId,
  coverage,
  onScored,
}: {
  userId: string;
  coverage?: Coverage;
  onScored: (m: RoleMatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const score = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const link = /^https?:\/\/\S+$/i.test(t) ? t : undefined;
      const r = await scorePosting({ id: userId }, link ? { url: link } : { text: t });
      if (!r.ok) setProblem(r.message);
      else {
        setText('');
        setOpen(false);
        onScored(r.match);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-[12.5px] text-ink-3" data-testid="roles-coverage">
      <p>
        <span data-testid="roles-coverage-line">{coverageWords(coverage)}</span>{' '}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="underline decoration-line underline-offset-4 hover:text-ink hover:decoration-ink"
          data-testid="roles-paste-open"
        >
          Paste a posting from anywhere to score it.
        </button>
      </p>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void score();
          }}
          className="mt-2 flex max-w-[720px] flex-col gap-2 @[40rem]:flex-row @[40rem]:items-start"
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && /^https?:\/\/\S+$/i.test(text.trim())) {
                e.preventDefault();
                void score();
              }
            }}
            rows={text.includes('\n') || text.length > 90 ? 4 : 1}
            placeholder="A link to the posting, or its whole text"
            aria-label="A posting's link or text"
            className={cx(
              'min-h-9 w-full flex-1 resize-y rounded-[6px] border border-line bg-canvas px-3 py-2 text-[13.5px] text-ink outline-none focus:border-[#bdbab5] placeholder:text-[#a59f97]',
            )}
            data-testid="roles-paste"
          />
          <Button type="submit" loading={busy} disabled={!text.trim()} data-testid="roles-paste-score">
            Score it
          </Button>
        </form>
      )}
      {problem && (
        <p className="mt-1.5 text-[12.5px] text-bad" role="alert" data-testid="roles-paste-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
