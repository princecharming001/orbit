import { normalizeCompany, type User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../db/schema';
import { type CompanyOption, companyOptions, pickCompany } from '../engine/companyPick';
import { linkedInImageExpired } from '../engine/photos';
import { cx, Spinner } from '../ui';
import type { Suggestion } from '../ui/Suggest';
import { OptionLogo } from './CompanyLogo';

/** "Software Development · San Francisco": what tells namesakes apart in LinkedIn's list. */
export const optionSub = (o: CompanyOption) =>
  [o.industry, o.location].filter(Boolean).join(' · ') || undefined;

/** How long typing must pause before LinkedIn's company list is asked (each ask is one company search). */
export const LINKEDIN_SUGGEST_PAUSE_MS = 500;

/**
 * LinkedIn's own companies for what is typed, for a field's slower suggestions (Suggest `more`): each with its logo,
 * industry and place, so "Triumph" offers Triumph Labs and TRIUMPH the aerospace group apart. Asked once typing
 * pauses, from 2 letters; nothing when LinkedIn is not connected.
 */
export async function linkedInCompanySuggestions(
  user: Pick<User, 'id'>,
  q: string,
  current: () => boolean,
): Promise<Suggestion[]> {
  if (q.trim().length < 2) return [];
  await new Promise((r) => setTimeout(r, LINKEDIN_SUGGEST_PAUSE_MS));
  if (!current()) return [];
  const r = await companyOptions(user, q);
  if (!r.ok) return [];
  return r.options.slice(0, 6).map((o) => ({
    value: o.name,
    sub: ['On LinkedIn', optionSub(o)].filter(Boolean).join(' · '),
    mark: <OptionLogo src={o.logoUrl} label={o.name} />,
    data: o,
  }));
}

/** A picked suggestion that came from LinkedIn's list: kept as the company the name means, exactly. */
export async function keepLinkedInPick(user: Pick<User, 'id'>, s: Suggestion): Promise<void> {
  const o = s.data as CompanyOption | undefined;
  if (o?.id) await pickCompany(user, s.value, o).catch(() => undefined);
}

/**
 * Which company a name means, from LinkedIn's own list: each with its logo, industry and place. Picking one keeps it
 * as the company the name means for this student (its logo shows everywhere the name does).
 */
export function CompanyChooser({
  user,
  name,
  onDone,
}: {
  user: Pick<User, 'id'>;
  name: string;
  onDone: (picked?: CompanyOption) => void;
}) {
  const [state, setState] = useState<
    { loading: true } | { loading: false; options: CompanyOption[]; note?: string }
  >({ loading: true });
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let live = true;
    void companyOptions(user, name).then((r) => {
      if (!live) return;
      setState(
        r.ok ? { loading: false, options: r.options } : { loading: false, options: [], note: r.message },
      );
    });
    return () => {
      live = false;
    };
  }, [user, name]);
  return (
    <div
      className="mt-1 mb-2 ml-2 rounded-[10px] border border-line bg-canvas p-1.5 fade-up"
      data-testid="company-chooser"
    >
      <p className="px-1.5 pt-0.5 pb-1.5 text-[12px] text-ink-3">Which {name} do you mean?</p>
      {state.loading ? (
        <p className="flex items-center gap-2 px-1.5 py-2 text-[12.5px] text-ink-3">
          <Spinner /> Asking LinkedIn…
        </p>
      ) : state.options.length ? (
        <ul>
          {state.options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(o.id);
                  const r = await pickCompany(user, name, o);
                  setBusy(undefined);
                  if (r.ok) onDone(o);
                  else setState({ loading: false, options: state.options, note: r.message });
                }}
                className={cx(
                  'w-full flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-canvas-2 disabled:opacity-60 pointer-coarse:min-h-11',
                )}
                data-testid="company-chooser-option"
              >
                <OptionLogo src={o.logoUrl} label={o.name} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{o.name}</span>
                  {optionSub(o) && (
                    <span className="block truncate text-[12px] text-ink-3">{optionSub(o)}</span>
                  )}
                </span>
                {busy === o.id && <Spinner />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1.5 py-1.5 text-[12.5px] text-ink-3">
          {state.note ?? `LinkedIn lists no company called ${name}.`}
        </p>
      )}
      {!state.loading && state.note && state.options.length > 0 && (
        <p className="px-1.5 pt-1 text-[12px] text-bad">{state.note}</p>
      )}
      <div className="flex justify-end px-1 pt-1">
        <button
          type="button"
          onClick={() => onDone()}
          className="h-7 px-2 rounded-md text-[12px] text-ink-3 hover:text-ink hover:bg-canvas-2 pointer-coarse:h-11"
          data-testid="company-chooser-close"
        >
          None of these
        </button>
      </div>
    </div>
  );
}

/**
 * Under a target company Orbit has no logo for yet: "Which Triumph?", opening LinkedIn's list to pick the one meant.
 * Gone once the company is settled (picked, named by a position, or found plainly by name, with its logo).
 */
export function UnsettledCompany({
  user,
  name,
  orgId,
}: {
  user: Pick<User, 'id'>;
  name: string;
  orgId?: string;
}) {
  const [open, setOpen] = useState(false);
  const settled = useLiveQuery(async () => {
    const norm = normalizeCompany(name);
    const [byId, byName] = await Promise.all([
      orgId ? db.organizations.get(orgId) : undefined,
      norm ? db.organizations.where('nameNormalized').equals(norm).toArray() : [],
    ]);
    return [...(byId ? [byId] : []), ...byName].some(
      (o) => o.linkedinCompanyExact || (!!o.logoUrl && !linkedInImageExpired(o.logoUrl)),
    );
  }, [orgId, name]);
  if (settled !== false) return null;
  if (open) return <CompanyChooser user={user} name={name} onDone={() => setOpen(false)} />;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="ml-8 -mt-0.5 mb-1 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink pointer-coarse:min-h-11"
      data-testid="company-which"
    >
      Which {name}?
    </button>
  );
}
