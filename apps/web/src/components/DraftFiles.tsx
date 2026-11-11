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
  part,
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
  /** the files list (under the words) or the attach buttons (beside Send); both when not given */
  part?: 'list' | 'actions';
}) {
  const input = useRef<HTMLInputElement>(null);
  const [asResume, setAsResume] = useState(false);
  const [error, setError] = useState<string>();
  const files = draft.attachments ?? [];
  if (draft.channel !== 'gmail') return null;
  if (!direct)
    return mentionsFile && part !== 'actions' ? (
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
  const showList = part !== 'actions';
  const showActions = part !== 'list';
  if (showList && !showActions && !files.length && !(mentionsFile && !files.length)) return null;
  return (
    <div
      className={cx('text-[12.5px]', showActions && !showList && 'inline-flex items-center gap-3', className)}
      data-testid={showList ? 'draft-files' : 'draft-files-actions'}
    >
      {showList && files.length > 0 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {files.map((f) => (
            <li key={f.id} className="group inline-flex items-center gap-1.5 py-1" data-testid="draft-file">
              <Paperclip size={13} className="text-ink-3 shrink-0" aria-hidden />
              <span className="truncate max-w-[240px] text-[13px] text-ink">{f.name}</span>
              <span className="text-ink-3 shrink-0 tabular">{sizeLabel(f.size)}</span>
              <button
                type="button"
                className="shrink-0 p-0.5 text-ink-3 hover:text-ink opacity-60 group-hover:opacity-100"
                aria-label={`Remove ${f.name}`}
                onClick={() => detachFile(draft.id, f.id)}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {showList && mentionsFile && !files.length && (
        <p className="py-1 text-warn" data-testid="draft-attach-needed">
          It says a file is attached. Attach it before sending.
        </p>
      )}
      {showActions && (
        <span className="inline-flex items-center gap-3">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-2 hover:bg-canvas-2 hover:text-ink"
            onClick={() => pick(false)}
            aria-label="Attach a file"
            title="Attach a file"
            data-testid="draft-attach-file"
          >
            <Paperclip size={15} aria-hidden />
          </button>
          {!hasResume && (
            <button
              type="button"
              className="text-ink-3 hover:text-ink"
              onClick={attachResume}
              data-testid="draft-attach-resume-file"
            >
              Attach resume
            </button>
          )}
          {error && <span className="text-bad">{error}</span>}
        </span>
      )}
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
