import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/AppShell';
import { removeMe } from '../integrations/researchProxy';
import { Button, Input, Label } from '../ui';

/**
 * The public "remove me" page (docs/plan/20 §5): anyone can ask Orbit never to research them. Orbit's research reads
 * only public professional sources, when a student presses Deep research on someone they want to write to; a name
 * on this list is never researched again. A name alone could match a namesake, so it goes with a LinkedIn address, an
 * email or a company. Nothing else is asked or kept: the list holds hashes of these, not the text.
 */
export function RemoveMePage() {
  const [name, setName] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const ready = name.trim().length >= 2 && (linkedinUrl.trim() || email.trim() || company.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await removeMe({
        name: name.trim(),
        linkedinUrl: linkedinUrl.trim() || undefined,
        email: email.trim() || undefined,
        company: company.trim() || undefined,
      });
      if (r.ok) setDone(r.value.message);
      else
        setError(
          r.reason === 'unconfigured'
            ? 'This copy of Orbit does not research anyone, so there is nothing to remove you from.'
            : r.message,
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-full bg-canvas text-ink">
      <div className="max-w-[560px] mx-auto px-5 py-12" data-testid="remove-me">
        <Link to="/" className="inline-flex items-center gap-2 text-ink">
          <Logo size={20} />
          <span className="font-medium">Orbit</span>
        </Link>
        <h1 className="mt-8 text-[26px] font-semibold tracking-[-0.01em]">Remove me from Orbit's research</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
          Orbit helps students write to people they want to learn from. When a student asks, Orbit puts
          together a short brief on that person from public professional sources only (their LinkedIn,
          articles, talks, company news), every line cited, kept 90 days in that student's browser. It never
          looks at where you live, your pay, your health, family, religion, politics or legal matters.
        </p>
        <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
          If you would rather not be researched at all, tell us who you are below. From then on Orbit refuses
          to research you, for every student.
        </p>
        {done ? (
          <p
            className="mt-8 rounded-[var(--radius-card)] border border-line p-4 text-[14px]"
            role="status"
            data-testid="remove-me-done"
          >
            {done}
          </p>
        ) : (
          <form className="mt-8 space-y-4" onSubmit={submit}>
            <div>
              <Label htmlFor="rm-name">Your name</Label>
              <Input
                id="rm-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </div>
            <p className="text-[13px] text-ink-3">
              And at least one of these, so a namesake is not removed by mistake:
            </p>
            <div>
              <Label htmlFor="rm-li">Your LinkedIn address</Label>
              <Input
                id="rm-li"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                placeholder="https://www.linkedin.com/in/…"
              />
            </div>
            <div>
              <Label htmlFor="rm-email">Your work email</Label>
              <Input
                id="rm-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div>
              <Label htmlFor="rm-company">Your company</Label>
              <Input
                id="rm-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                autoComplete="organization"
              />
            </div>
            {error && (
              <p className="text-[13px] text-bad" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={!ready || busy} data-testid="remove-me-submit">
              {busy ? 'Saving' : 'Never research me'}
            </Button>
            <p className="text-[12px] text-ink-3">
              Orbit keeps only a scrambled form (a hash) of what you type here, enough to recognise you,
              nothing more.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
