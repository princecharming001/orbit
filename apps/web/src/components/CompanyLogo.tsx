import type { Person } from '@orbit/core';
import { companyDomain, companyLogoUrl } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import type React from 'react';
import { useState } from 'react';
import { db } from '../db/schema';
import { cx } from '../ui';

/** Domains with no icon of their own: they show their letter, without asking again. */
const missing = new Set<string>();

/**
 * A company's logo, small and square, with its name on hover. The domain comes from what Orbit knows (a stored
 * domain, a work address of someone there, the list of well-known companies); without one, or when the site has no
 * icon, it is the company's first letter on a quiet tile, so a row of them still lines up.
 */
export function CompanyLogo({
  name,
  domain,
  emails,
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
  emails?: (string | undefined)[];
  /** the organisation row, for a domain stored on it */
  orgId?: string;
  size?: number;
  className?: string;
}) {
  const org = useLiveQuery(() => (orgId ? db.organizations.get(orgId) : undefined), [orgId]);
  const d = domain ?? companyDomain(name ?? org?.name, { domains: org?.domains, emails });
  const [failed, setFailed] = useState(false);
  if (!name && !org) return null;
  const label = labelOverride ?? name ?? org?.name ?? '';
  const box = { width: size, height: size };
  const radius = size <= 18 ? 'rounded-[4px]' : 'rounded-[6px]';
  if (!d || failed || missing.has(d)) {
    const tile = cx(
      'inline-flex shrink-0 items-center justify-center bg-canvas-2 text-ink-3 font-semibold border border-line-2',
      radius,
      className,
    );
    const style = { ...box, fontSize: Math.max(8, size * 0.55) };
    const letter = (name ?? org?.name ?? label).trim()[0]?.toUpperCase();
    return decorative ? (
      <span
        className={tile}
        style={style}
        title={label}
        aria-hidden
        data-testid="company-logo"
        data-fallback="true"
      >
        {letter}
      </span>
    ) : (
      <span
        className={tile}
        style={style}
        title={label}
        role="img"
        aria-label={label}
        data-testid="company-logo"
        data-fallback="true"
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      src={companyLogoUrl(d)}
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
      onError={() => {
        missing.add(d);
        setFailed(true);
      }}
    />
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
