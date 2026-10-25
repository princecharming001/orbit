/**
 * About, first: who they are, straight from their LinkedIn profile, for everyone Orbit has found on LinkedIn (the basic
 * context; Deep research below it goes further, from the web). Their headline and city, their own "About" text, their
 * work history as a timeline (current role first, each with the company's LinkedIn logo, dates and how long) and their
 * schools. Orbit reads the full profile when their page opens (engine/enrichment, a bounded number a day); until then
 * it says it is reading, and someone Orbit has not matched to a LinkedIn profile says so plainly.
 */
import type { Person } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../../db/schema';
import { readRecord } from '../../engine/enrichment/store';
import { byRecency, roleSpan } from '../../engine/roleDates';
import { relDate } from '../../ui';
import { CompanyLogo } from '../CompanyLogo';

export function LinkedInHistory({ person }: { person: Person }) {
  const now = new Date();
  const [allAbout, setAllAbout] = useState(false);
  const rec = useLiveQuery(() => readRecord(person.id), [person.id]);
  const affs =
    useLiveQuery(() => db.affiliations.where('personId').equals(person.id).toArray(), [person.id]) ?? [];
  // LinkedIn's own history when Orbit has read it; what other sources said otherwise
  const linkedin = affs.filter((a) => a.source === 'linkedin_profile');
  const shown = linkedin.length ? linkedin : affs;
  const work = shown.filter((a) => a.kind === 'employment').sort(byRecency);
  const schools = shown.filter((a) => a.kind === 'education').sort(byRecency);
  const onLinkedIn = !!(person.linkedinMemberId || person.linkedinSlug || person.linkedinUrl);
  const reading = onLinkedIn && !rec?.profileAt;
  const about = rec?.about?.trim();
  const first = person.firstName || person.displayName;

  return (
    <section className="space-y-3" data-testid="linkedin-history">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-ink">From LinkedIn</h2>
        <span className="text-[12px] text-ink-3" data-testid="linkedin-history-status">
          {reading
            ? `Reading ${first}'s LinkedIn…`
            : rec?.profileAt
              ? `Read ${relDate(rec.profileAt, now)}`
              : onLinkedIn
                ? ''
                : 'Not matched to a LinkedIn profile yet'}
        </span>
      </div>
      {(person.headline || person.location) && (
        <p className="text-[13.5px] text-ink-2 -mt-1">
          {person.headline}
          {person.headline && person.location ? ' · ' : ''}
          {person.location && <span className="text-ink-3">{person.location}</span>}
        </p>
      )}
      {about && (
        <div className="text-[13px] text-ink-2 whitespace-pre-line" data-testid="linkedin-about">
          {allAbout || about.length <= 320 ? about : `${about.slice(0, 300).trimEnd()}…`}
          {about.length > 320 && (
            <button
              type="button"
              className="ml-1 text-ink-3 underline underline-offset-4 hover:text-ink"
              onClick={() => setAllAbout((v) => !v)}
            >
              {allAbout ? 'Less' : 'More'}
            </button>
          )}
        </div>
      )}
      {work.length > 0 && (
        <div>
          <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-2">Experience</div>
          <ol className="relative ml-3 border-l border-line space-y-3" data-testid="linkedin-experience">
            {work.map((a) => (
              <li key={a.id} className="relative pl-6" data-testid="linkedin-role">
                <span className="absolute -left-[13px] top-0.5 rounded-[6px] bg-canvas">
                  <CompanyLogo name={a.nameRaw} orgId={a.organizationId} size={24} decorative />
                </span>
                <div className="text-[13.5px] font-medium leading-snug">
                  {a.title ?? a.nameRaw}
                  {a.isCurrent && (
                    <span className="ml-1.5 align-middle text-[11px] font-normal text-good bg-good-soft rounded-full px-1.5 py-0.5">
                      Now
                    </span>
                  )}
                </div>
                {a.title && <div className="text-[13px] text-ink-2">{a.nameRaw}</div>}
                {roleSpan(a, now) && <div className="text-[12px] text-ink-3">{roleSpan(a, now)}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {schools.length > 0 && (
        <div>
          <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-2">Education</div>
          <ul className="space-y-2" data-testid="linkedin-education">
            {schools.map((a) => (
              <li key={a.id} className="flex items-start gap-2.5">
                <CompanyLogo name={a.nameRaw} orgId={a.organizationId} size={24} decorative />
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium leading-snug">{a.nameRaw}</div>
                  {(a.degree || a.field) && (
                    <div className="text-[13px] text-ink-2">
                      {[a.degree, a.field].filter(Boolean).join(', ')}
                    </div>
                  )}
                  {roleSpan(a, now) && <div className="text-[12px] text-ink-3">{roleSpan(a, now)}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!reading && !work.length && !schools.length && !about && (
        <p className="text-[12.5px] text-ink-3" data-testid="linkedin-history-empty">
          {onLinkedIn
            ? `LinkedIn shows no work history for ${first}.`
            : `Orbit has not found ${first} on LinkedIn yet. Add their LinkedIn link to see their work history here.`}
        </p>
      )}
    </section>
  );
}
