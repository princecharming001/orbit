import { normalizeCompany, type TargetCompany } from '@orbit/core';
import { Check, Plus } from 'lucide-react';
import { type InputHTMLAttributes, useMemo, useState } from 'react';
import { suggestCompanies } from '../data/companies';
import { addTargetCompanies } from '../engine/targets';
import { cx } from '../ui';
import { Suggest } from '../ui/Suggest';

/**
 * One line that adds a target company where the list is shown: suggestions with each company's logo as you type, a
 * pick adds it at once, Enter (or a comma-separated list) adds what was typed. A company already on the list says so.
 */
export function AddTargetCompany({
  userId,
  taken,
  onAdded,
  testId = 'add-target-company',
}: {
  userId: string;
  /** names already on the list, left out of the suggestions */
  taken: string[];
  onAdded?: (names: string[]) => void;
  testId?: string;
}) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  // one component for the field's life: a new one each render would remount it and lose the cursor
  const Field = useMemo(
    () =>
      function AddField(props: InputHTMLAttributes<HTMLInputElement>) {
        return (
          <input
            {...props}
            className="w-full h-8 bg-transparent pl-1 pr-2 text-[13px] text-ink placeholder:text-ink-3 outline-none"
          />
        );
      },
    [],
  );
  const add = async (picked?: string) => {
    const text = (picked ?? value).trim();
    if (!text) return;
    setValue('');
    const r = await addTargetCompanies(userId, text).catch(() => undefined);
    if (!r) {
      setValue(text);
      setNote('Could not add that just now. Try again.');
      return;
    }
    setNote(
      r.duplicates.length
        ? `${r.duplicates.join(', ')} ${r.duplicates.length === 1 ? 'is' : 'are'} already on your list.`
        : '',
    );
    if (r.added.length) onAdded?.(r.added);
  };
  return (
    <div>
      <div
        className={cx(
          'flex items-center gap-1.5 rounded-[10px] border border-dashed border-line pl-2 pr-1 transition-colors',
          'hover:border-[#d4d2ce] focus-within:border-solid focus-within:border-ink/40',
        )}
      >
        <Plus size={14} className="shrink-0 text-ink-3" aria-hidden />
        <Suggest
          className="flex-1 min-w-0"
          input={Field}
          value={value}
          onChange={(v) => {
            setValue(v);
            if (note) setNote('');
          }}
          suggest={(q) => suggestCompanies(q, taken)}
          onPick={(s) => void add(s.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Enter on a highlighted suggestion picks it (Suggest handles that)
            if ((e.target as HTMLInputElement).getAttribute('aria-activedescendant')) return;
            e.preventDefault();
            void add();
          }}
          placeholder="Add a company"
          aria-label="Add a target company"
          data-testid={testId}
        />
        {value.trim() ? (
          <button
            type="button"
            onClick={() => void add()}
            className="h-6 px-2 rounded-md bg-ink text-white text-[12px] font-medium hover:bg-[#262d3f] fade-up"
          >
            Add
          </button>
        ) : null}
      </div>
      {note ? (
        <p className="text-[12px] text-ink-3 mt-1.5 fade-up" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Next to a company's name: "Add to targets", or, once it is one, "Target" with a check that takes it off again
 * (the page gives that an Undo).
 */
export function TargetToggle({
  userId,
  name,
  orgId,
  tcs,
  onDrop,
}: {
  userId: string;
  name: string;
  orgId?: string;
  tcs: TargetCompany[];
  onDrop: (t: TargetCompany) => void;
}) {
  const [busy, setBusy] = useState(false);
  const norm = normalizeCompany(name);
  const tc = tcs.find(
    (t) => (!!orgId && t.organizationId === orgId) || (!!norm && normalizeCompany(t.nameRaw) === norm),
  );
  const pill =
    'ml-auto shrink-0 h-7 px-2.5 inline-flex items-center gap-1 rounded-full text-[12px] font-medium transition-colors';
  if (tc)
    return (
      <button
        type="button"
        className={cx(pill, 'bg-accent-soft text-accent hover:bg-[#dcebe4] pop-in')}
        onClick={() => onDrop(tc)}
        aria-pressed
        title={`Take ${name} off your targets`}
        data-testid="company-target-toggle"
      >
        <Check size={12} aria-hidden /> Target
      </button>
    );
  return (
    <button
      type="button"
      className={cx(
        pill,
        'border border-line text-ink-2 hover:text-ink hover:bg-canvas-2 disabled:opacity-60',
      )}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await addTargetCompanies(userId, name);
        } finally {
          setBusy(false);
        }
      }}
      aria-pressed={false}
      data-testid="company-target-toggle"
    >
      <Plus size={12} aria-hidden /> Add to targets
    </button>
  );
}
