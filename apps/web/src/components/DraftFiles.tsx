/**
 * The files on an email draft: what is attached (name and size, each removable) and the two ways to add one, the
 * resume Orbit keeps from the student's upload or any file from the computer. When the email goes out from the mail
 * app instead (no send permission), Orbit cannot hand files over, so the student confirms they will attach it there.
 */
import type { OutboundMessage } from '@orbit/core';
import { Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { attachFile, detachFile, FILE_ACCEPT, keepFile, resumeFile, sizeLabel } from '../engine/files';
import { cx } from '../ui';

export function DraftFiles({
  draft,
  userId,
  direct,
  mentionsFile,
  confirmed,
  onConfirm,
  className,
}: {
  draft: OutboundMessage;
  userId: string;
  /** Send sends it from Orbit, which can attach files; otherwise it opens the mail app */
  direct: boolean;
  /** the message says something is attached */
  mentionsFile: boolean;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [asResume, setAsResume] = useState(false);
  const [error, setError] = useState<string>();
  const files = draft.attachments ?? [];
  if (draft.channel !== 'gmail') return null;
  if (!direct)
    return mentionsFile ? (
      <label
        className={cx('flex items-center gap-2 text-[12.5px] text-warn cursor-pointer', className)}
        data-testid="draft-attach-resume"
      >
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
          data-testid="draft-attach-confirm"
        />
        It says a file is attached. I will attach it in my mail app.
      </label>
    ) : null;
  const pick = (resume: boolean) => {
    setAsResume(resume);
    setError(undefined);
    input.current?.click();
  };
  const attachResume = async () => {
    setError(undefined);
    const kept = await resumeFile(userId);
    if (!kept) return pick(true);
    const e = await attachFile(draft.id, kept);
    if (e) setError(e);
  };
  const hasResume = files.some((f) => /resume|cv/i.test(f.name));
  return (
    <div className={cx('text-[12.5px]', className)} data-testid="draft-files">
      {files.length > 0 && (
        <ul className="mb-2 divide-y divide-line-2 border-y border-line-2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-1.5" data-testid="draft-file">
              <Paperclip size={13} className="text-ink-3 shrink-0" aria-hidden />
              <span className="truncate text-ink">{f.name}</span>
              <span className="text-ink-3 shrink-0 tabular">{sizeLabel(f.size)}</span>
              <button
                type="button"
                className="ml-auto shrink-0 p-1 text-ink-3 hover:text-ink"
                aria-label={`Remove ${f.name}`}
                onClick={() => detachFile(draft.id, f.id)}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {!hasResume && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 font-medium text-ink-2 hover:text-ink"
            onClick={attachResume}
            data-testid="draft-attach-resume-file"
          >
            <Paperclip size={13} aria-hidden /> Attach resume
          </button>
        )}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 font-medium text-ink-2 hover:text-ink"
          onClick={() => pick(false)}
          data-testid="draft-attach-file"
        >
          <Paperclip size={13} aria-hidden /> Attach file
        </button>
        {mentionsFile && !files.length && (
          <span className="text-warn" data-testid="draft-attach-needed">
            It says a file is attached. Attach it before sending.
          </span>
        )}
        {error && <span className="text-bad">{error}</span>}
      </div>
      <input
        ref={input}
        type="file"
        accept={FILE_ACCEPT}
        className="hidden"
        data-testid="draft-file-input"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            const kept = await keepFile(userId, file, asResume ? 'resume' : 'file');
            const problem = await attachFile(draft.id, kept);
            if (problem) setError(problem);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
    </div>
  );
}
