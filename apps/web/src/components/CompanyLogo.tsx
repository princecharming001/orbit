import type { Organization, Person } from '@orbit/core';
import { companyDomain, normalizeCompany } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Building2, Users } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { db } from '../db/schema';
import { bundledLogo } from '../engine/logoImage';
import { wantCompanyLogo } from '../engine/logoQueue';
import { linkedInImageExpired } from '../engine/photos';
import { cx } from '../ui';

/** A LinkedIn logo still worth trying: present, not past its date, and not one that just failed here. */
const usableLogo = (o: Organization | undefined, failed?: string) =>
  o?.logoUrl && o.logoUrl !== failed && !linkedInImageExpired(o.logoUrl) ? o.logoUrl : undefined;

/**
 * A company's logo, small and square, with its name on hover. Logos come from LinkedIn and are that exact company's
 * (the student's rule: never a guessed one, never another company's of the same name). The company's own LinkedIn logo
 * comes first: kept on the organisation by enrichment (a position on someone's profile names the company) and by the
 * logo queue (engine/logoQueue: Orbit's shared list, and the companies this student's people's profiles settled), from
 * the organisation by id or any organisation of the same name. Schools too: LinkedIn lists them like companies.
 *
 * Until LinkedIn has answered, only a logo shipped with the app stands in, and only for a web address Orbit knows for
 * certain (a stored domain, the list of well-known companies and universities). Otherwise, and for a company LinkedIn
 * shows no logo for, the tile is LinkedIn's own placeholder for a company without one: a plain building, never
 * letters made up from the name.
 */
export function CompanyLogo({
  name,
  domain,
  orgId,
  size = 16,
  className,
  decorative,
  label: labelOverride,
}: {
  name?: string;
  /** what the hover and screen readers say, when it is more than the name ("Cornell University alum") */
  label?: string;
  /** the company's name is already written next to it: screen readers skip the logo, the hover still names it */
  decorative?: boolean;
  domain?: string;
  /** work addresses of people there: no longer used for the logo (a work address is not proof of a company's logo) */
  emails?: (string | undefined)[];
  /** the organisation row, for a domain stored on it */
  orgId?: string;
  size?: number;
  className?: string;
}) {
  // the organisation row by its id, and every row of the same name: a LinkedIn logo on any of them is preferred
  const orgs = useLiveQuery(async () => {
    const norm = normalizeCompany(name);
    const [byId, byName] = await Promise.all([
      orgId ? db.organizations.get(orgId) : undefined,
      norm ? db.organizations.where('nameNormalized').equals(norm).toArray() : [],
    ]);
    return [...(byId ? [byId] : []), ...byName.filter((o) => o.id !== byId?.id)];
  }, [orgId, name]);
  const org = orgs?.[0];
  const inViewRef = useRef(false);
  const [ownFailed, setOwnFailed] = useState<string>();
  // the organisation's own row first: a logo settled for it beats one on another row of the same name
  // an organisation settled exactly (a position, or the student's pick) shows only its own logo, never the logo of
  // another row that merely shares the name
  const ownOrg = (org?.linkedinCompanyExact ? [org] : orgs)?.find((o) => usableLogo(o, ownFailed));
  const own = usableLogo(ownOrg, ownFailed);
  const companyName = name ?? org?.name;
  // cheap (core caches by name), so it is computed each render rather than memoised on a list rebuilt by callers
  const known =
    domain ?? companyDomain(companyName, { domains: orgs?.flatMap((o) => o.domains ?? []), guess: false });
  // no LinkedIn logo yet: ask LinkedIn (engine/logoQueue), once the orgs are read and the tile is near the screen
  useEffect(() => {
    if (orgs && !own && companyName && inViewRef.current) wantCompanyLogo(companyName);
  });
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '200px', fallbackInView: true });
  inViewRef.current = inView;
  const [bundledFailed, setBundledFailed] = useState<string>();
  if (!companyName && !org) return null;
  const label = labelOverride ?? companyName ?? '';
  const box = { width: size, height: size };
  const radius = size <= 18 ? 'rounded-[4px]' : 'rounded-[6px]';
  const img = (src: string, source: string, onError: () => void) => (
    <img
      ref={ref}
      src={src}
      alt={decorative ? '' : label}
      aria-hidden={decorative || undefined}
      title={label}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cx('shrink-0 object-contain bg-white border border-line-2', radius, className)}
      style={box}
      data-testid="company-logo"
      data-source={source}
      onError={onError}
    />
  );
  // the company's own logo, from LinkedIn
  if (own) return img(own, 'linkedin', () => setOwnFailed(own));
  // a logo shipped with the app, for a web address Orbit knows for certain, while LinkedIn answers
  const shipped = known ? bundledLogo(known) : undefined;
  if (shipped && shipped !== bundledFailed) return img(shipped, 'bundled', () => setBundledFailed(shipped));
  return (
    <NoLogo
      label={label}
      size={size}
      decorative={decorative}
      className={cx(radius, className)}
      tileRef={ref}
    />
  );
}

/**
 * LinkedIn's own placeholder for a company with no logo: a plain building on a grey tile. Shown while LinkedIn has
 * not answered for the company yet, and for a company LinkedIn has no logo for. Nothing about it is made up.
 */
export function NoLogo({
  label,
  size,
  decorative,
  className,
  tileRef,
}: {
  label: string;
  size: number;
  decorative?: boolean;
  className?: string;
  tileRef?: (el: Element | null) => void;
}) {
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <span
      ref={tileRef}
      className={cx(
        'inline-flex shrink-0 items-center justify-center border border-line-2 bg-canvas-2 text-ink-3 select-none',
        className,
      )}
      style={{ width: size, height: size }}
      title={label}
      {...a11y}
      data-testid="company-logo"
      data-fallback="true"
    >
      <Building2 size={Math.max(8, Math.round(size * 0.6))} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/** The tile for people with no company on record: a quiet people icon, so the row lines up with the logos above it. */
export function NoCompanyIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center bg-canvas-2 text-ink-3 border border-line-2',
        size <= 18 ? 'rounded-[4px]' : 'rounded-[6px]',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden
      data-testid="no-company-icon"
    >
      <Users size={Math.round(size * 0.6)} strokeWidth={1.75} />
    </span>
  );
}

/** A person's current company as a logo, from their record (its name, their organisation and their addresses). */
export function PersonCompanyLogo({
  person,
  size = 16,
  className,
  decorative,
}: {
  person: Pick<Person, 'currentOrganizationRaw' | 'currentOrganizationId' | 'emails' | 'primaryEmail'>;
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  if (!person.currentOrganizationRaw && !person.currentOrganizationId) return null;
  return (
    <CompanyLogo
      name={person.currentOrganizationRaw}
      orgId={person.currentOrganizationId}
      emails={[person.primaryEmail, ...(person.emails ?? [])]}
      size={size}
      className={className}
      decorative={decorative}
    />
  );
}

/**
 * Someone's role with their company's logo in front of it. The company is the logo: its name shows on hover and is
 * read out by screen readers, so the text is the role alone.
 */
export function LogoText({
  person,
  children,
  size = 14,
  className,
  wrap,
}: {
  person: Pick<Person, 'currentOrganizationRaw' | 'currentOrganizationId' | 'emails' | 'primaryEmail'>;
  children: React.ReactNode;
  size?: number;
  className?: string;
  /** let the text wrap (a table cell) instead of cutting it off with an ellipsis */
  wrap?: boolean;
}) {
  return (
    <span className={cx('flex gap-1.5 min-w-0', wrap ? 'items-start' : 'items-center', className)}>
      <PersonCompanyLogo person={person} size={size} className={wrap ? 'mt-[3px]' : undefined} />
      <span className={wrap ? 'min-w-0' : 'truncate min-w-0'}>{children}</span>
    </span>
  );
}

/** A company's logo as LinkedIn's list gives it (a picker's row), or LinkedIn's plain placeholder when it has none. */
export function OptionLogo({ src, label, size = 20 }: { src?: string; label: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const radius = size <= 18 ? 'rounded-[4px]' : 'rounded-[6px]';
  if (!src || failed) return <NoLogo label={label} size={size} decorative className={radius} />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      className={cx('shrink-0 object-contain bg-white border border-line-2', radius)}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      data-testid="option-logo"
    />
  );
}
