import type { Organization, Person } from '@orbit/core';
import { companyDomain, companyInitials, looksLikeSchool, normalizeCompany } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Users } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { findSchoolDomain } from '../data/schools';
import { db } from '../db/schema';
import { bundledLogo, forgetLogo, isBundledLogo, knownLogo, resolveLogo } from '../engine/logoImage';
import { wantCompanyLogo } from '../engine/logoQueue';
import { linkedInImageExpired } from '../engine/photos';
import { cx } from '../ui';

/** A LinkedIn logo still worth trying: present, not past its date, and not one that just failed here. */
const usableLogo = (o: Organization | undefined, failed?: string) =>
  o?.logoUrl && o.logoUrl !== failed && !linkedInImageExpired(o.logoUrl) ? o.logoUrl : undefined;

/**
 * A company's logo, small and square, with its name on hover. Logos come from LinkedIn (the student's rule: never a
 * guessed one). The company's own LinkedIn logo comes first (kept on the organisation by enrichment and by the logo
 * queue, which looks a company up on LinkedIn when a tile shows it without one; an expired link is skipped until it
 * is fetched again), from the organisation by id or any organisation of the same name. Until LinkedIn has answered,
 * only a logo shipped with the app stands in, and only for a web address Orbit knows for certain (a stored domain,
 * the list of well-known companies and universities): never a name turned into a ".com", never a work address, never
 * an icon service's answer for a company. A school's official address may still show its own site icon. Otherwise
 * it is the company's initials on a tile coloured by its name, so a row of them still lines up and the same company
 * always looks the same.
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
  const ownOrg = orgs?.find((o) => usableLogo(o, ownFailed));
  const own = usableLogo(ownOrg, ownFailed);
  const companyName = name ?? org?.name;
  // cheap (core caches by name), so it is computed each render rather than memoised on a list rebuilt by callers
  const known =
    domain ?? companyDomain(companyName, { domains: orgs?.flatMap((o) => o.domains ?? []), guess: false });
  const school = !!companyName && looksLikeSchool(companyName);
  // no LinkedIn logo yet: ask LinkedIn (engine/logoQueue), once the orgs are read and the tile is near the screen
  useEffect(() => {
    if (orgs && !own && companyName && inViewRef.current) wantCompanyLogo(companyName);
  });
  // a school the short list does not know: the full school list, loaded only for names that read like a school
  const [schoolDomain, setSchoolDomain] = useState<string>();
  useEffect(() => {
    setSchoolDomain(undefined);
    if (known || !companyName || !school) return;
    let live = true;
    findSchoolDomain(companyName)
      .then((d) => live && setSchoolDomain(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [known, companyName]);
  const d = known ?? schoolDomain;
  // the icon is looked for once the tile is near the screen
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '200px', fallbackInView: true });
  inViewRef.current = inView;
  const [found, setFound] = useState<{ domain: string; src: string | null }>();
  useEffect(() => {
    if (!d || own || !inView) return;
    // a company: the logo shipped with the app for its known address, or nothing (no icon services)
    if (!school) {
      setFound({ domain: d, src: bundledLogo(d) ?? null });
      return;
    }
    const k = knownLogo(d);
    if (k !== undefined) {
      setFound({ domain: d, src: k });
      return;
    }
    let live = true;
    resolveLogo(d).then((src) => live && setFound({ domain: d, src }));
    return () => {
      live = false;
    };
  }, [d, own, inView, school]);
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
  const src = d && found?.domain === d ? found.src : undefined;
  if (src)
    return img(src, isBundledLogo(src) ? 'bundled' : 'icon', () => {
      forgetLogo(d!);
      setFound({ domain: d!, src: null });
    });
  return (
    <Monogram
      name={companyName ?? label}
      label={label}
      size={size}
      decorative={decorative}
      className={cx(radius, className)}
      tileRef={ref}
    />
  );
}

/** A company's initials on a tile whose colour comes from its name: the same company always looks the same. */
function Monogram({
  name,
  label,
  size,
  decorative,
  className,
  tileRef,
}: {
  name: string;
  label: string;
  size: number;
  decorative?: boolean;
  className?: string;
  tileRef?: (el: Element | null) => void;
}) {
  const hue = useMemo(() => {
    let h = 0;
    const key = normalizeCompany(name) || name;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h % 360;
  }, [name]);
  // two letters where they fit (16 px and up), one on the smallest tiles
  const text = companyInitials(name, size >= 16 ? 2 : 1) || '?';
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <span
      ref={tileRef}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-semibold border tracking-[-0.02em] select-none',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, size * (text.length > 1 ? 0.44 : 0.55)),
        background: `hsl(${hue} 38% 94%)`,
        color: `hsl(${hue} 32% 34%)`,
        borderColor: `hsl(${hue} 28% 86%)`,
      }}
      title={label}
      {...a11y}
      data-testid="company-logo"
      data-fallback="true"
    >
      {text}
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
