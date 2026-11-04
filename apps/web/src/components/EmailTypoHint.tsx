/**
 * "Did you mean priya@gmail.com?" under an email field, for a mistyped provider ("gmial.com", "yaho.com"). The guess
 * comes from @zootools/email-spell-checker (MIT), an open-source descendant of mailcheck; it is only offered, never
 * applied by itself.
 */
import emailSpellChecker from '@zootools/email-spell-checker';

/** The corrected address when the domain looks like a typo of a common provider, else undefined. */
export function emailTypo(email: string): string | undefined {
  const e = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return undefined;
  const s = emailSpellChecker.run({ email: e });
  return s && s.full.toLowerCase() !== e.toLowerCase() ? s.full : undefined;
}

export function EmailTypoHint({ email, onFix }: { email: string; onFix: (fixed: string) => void }) {
  const fixed = emailTypo(email);
  if (!fixed) return null;
  return (
    <p className="mt-1 text-xs text-ink-3" data-testid="email-typo-hint">
      Did you mean{' '}
      <button type="button" className="underline text-ink-2" onClick={() => onFix(fixed)}>
        {fixed}
      </button>
      ?
    </p>
  );
}
