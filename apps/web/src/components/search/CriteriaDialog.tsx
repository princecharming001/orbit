import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type CriterionForm, MAX_CRITERIA, newCriterion } from '../../engine/peopleSearch';
import { Button, Modal } from '../../ui';
import { NeedToggle } from './NeedToggle';

/**
 * The criteria of a search: plain statements each match is checked against. Must-haves decide who fits; nice-to-haves
 * rank people higher. Update runs the search again with them.
 */
export function CriteriaDialog({
  open,
  criteria,
  onClose,
  onSave,
}: {
  open: boolean;
  criteria: CriterionForm[];
  onClose: () => void;
  onSave: (next: CriterionForm[]) => void;
}) {
  const [rows, setRows] = useState<CriterionForm[]>(criteria);
  // each opening starts from what the search has now, with one empty line to write in when there is none
  useEffect(() => {
    if (open) setRows(criteria.length ? criteria.map((c) => ({ ...c })) : [newCriterion()]);
  }, [open, criteria]);
  const set = (id: string, patch: Partial<CriterionForm>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const kept = rows.filter((r) => r.text.trim());
  return (
    <Modal open={open} onClose={onClose} title="Criteria" width={560} keepOnBackdrop>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(kept.map((r) => ({ ...r, text: r.text.trim() })));
        }}
        data-testid="criteria-dialog"
      >
        <p className="text-[13.5px] text-ink-3">
          Each match is checked against these. Must haves decide who fits; nice to haves rank people higher.
        </p>
        <ol className="mt-4 space-y-4">
          {rows.map((r, i) => (
            <li key={r.id} className="flex gap-3" data-testid="criterion-row">
              <span className="w-4 pt-2.5 text-[13px] text-ink-3 tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <input
                    value={r.text}
                    onChange={(e) => set(r.id, { text: e.target.value })}
                    placeholder="Works at a venture capital firm"
                    aria-label={`Criterion ${i + 1}`}
                    maxLength={200}
                    // the dialog is opened to write: an empty last line takes the cursor (useDialog reads this)
                    data-autofocus={!r.text && i === rows.length - 1 ? '' : undefined}
                    className="h-10 min-w-0 flex-1 rounded-[8px] border border-line bg-canvas px-3 text-[14px] outline-none focus:border-ink placeholder:text-[#a59f97]"
                    data-testid="criterion-text"
                  />
                  <button
                    type="button"
                    onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                    className="p-1.5 rounded-md text-ink-3 hover:bg-canvas-2 hover:text-ink"
                    aria-label={`Remove criterion ${i + 1}`}
                    data-testid="criterion-remove"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="mt-2">
                  <NeedToggle
                    value={r.need}
                    onChange={(need) => set(r.id, { need })}
                    label={`Criterion ${i + 1}`}
                    testId="criterion-need"
                  />
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-5 flex items-center justify-between gap-3">
          {rows.length < MAX_CRITERIA ? (
            <button
              type="button"
              onClick={() => setRows((rs) => [...rs, newCriterion()])}
              className="inline-flex items-center gap-2 text-[14px] font-medium text-ink hover:underline underline-offset-4"
              data-testid="criterion-add"
            >
              <Plus size={15} /> Add criterion
            </button>
          ) : (
            <span className="text-[12.5px] text-ink-3">Six at most, so each one counts.</span>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={onClose} data-testid="criteria-cancel">
              Cancel
            </Button>
            <Button type="submit" variant="primary" data-testid="criteria-save">
              Update
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
