/**
 * A field that takes several entries: each one a quiet chip, the text being typed after them on the same line.
 * Enter or a comma adds what is typed, a suggestion adds itself, × or Backspace (in an empty box) takes one away. The
 * suggestions leave out what is already chosen. Used for target roles, industries and locations.
 */
import { X } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';
import { cx } from './index';
import { Suggest, type Suggestion } from './Suggest';

export function ChipsField({
  id,
  values,
  onChange,
  options,
  suggest,
  placeholder,
  testId,
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** a fixed list to suggest from (what is chosen is left out) */
  options?: readonly string[];
  suggest?: (q: string) => Suggestion[];
  placeholder?: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState('');
  const has = (v: string) => values.some((x) => x.toLowerCase() === v.toLowerCase());
  // what is typed splits at commas; a suggestion picked is one entry, commas and all ("New York, NY")
  const add = (raw: string, whole = false) => {
    const parts = (whole ? [raw] : raw.split(',')).map((p) => p.trim()).filter(Boolean);
    const next = [...values];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    if (next.length !== values.length) onChange(next);
    setDraft('');
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));
  const find = (q: string): Suggestion[] => {
    const all = suggest
      ? suggest(q)
      : (options ?? [])
          .filter((o) => !q || o.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map((value) => ({ value }));
    return all.filter((s) => !has(s.value));
  };
  return (
    <div
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 border-b border-line py-1.5 transition-colors focus-within:border-ink hover:border-[#cfccc6]"
      data-testid={testId}
    >
      {values.map((v) => (
        <span
          key={v}
          className="group inline-flex h-7 items-center gap-1 rounded-full bg-canvas-2 pl-2.5 pr-1 text-[13px] text-ink"
          data-testid={testId ? `${testId}-chip` : undefined}
        >
          {v}
          <button
            type="button"
            onClick={() => remove(v)}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-3 hover:bg-line hover:text-ink"
            aria-label={`Remove ${v}`}
          >
            <X size={11} strokeWidth={2.25} aria-hidden />
          </button>
        </span>
      ))}
      <Suggest
        id={id}
        className="min-w-[140px] flex-1"
        value={draft}
        onChange={(v) => (v.endsWith(',') ? add(v) : setDraft(v))}
        suggest={find}
        onPick={(s) => add(s.value, true)}
        minChars={0}
        placeholder={values.length ? 'Add another' : placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            // a suggestion highlighted with the arrows is picked by Suggest itself
            const highlighted = (e.currentTarget.getAttribute('aria-activedescendant') ?? '') !== '';
            if (!highlighted) {
              e.preventDefault();
              add(draft);
            }
          } else if (e.key === 'Backspace' && !draft && values.length) {
            e.preventDefault();
            remove(values[values.length - 1]!);
          }
        }}
        input={ChipInput}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </div>
  );
}

/**
 * The bare text box after the chips. A component of its own, defined once: a new function on every render would be a
 * new kind of element to React, which would throw the box away on each keystroke and take the cursor with it.
 */
function ChipInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'h-8 w-full bg-transparent text-[14px] outline-none placeholder:text-[#a59f97]',
        // the settings page's flat style is for whole fields; this box sits inside one
        'settings-chip-input',
      )}
    />
  );
}
