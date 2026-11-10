import type { Person } from '@orbit/core';
import { useState } from 'react';
import { Avatar, cx } from '../../ui';
import { LogoText } from '../CompanyLogo';

/** How many rows show before "Show all". */
const SHOWN = 30;

/**
 * The people a Map tab lights, as a list beside the map: with thousands of dots the lit ones are hard to find, so
 * the panel names them, closest first, each with their role and what puts them in the tab. Picking one shows the
 * routes to them.
 */
export function LensList({
  title,
  people,
  note,
  empty,
  onPick,
}: {
  title: string;
  people: Person[];
  /** what puts each person in the tab ("Alum", "Replied", "Oct 3") */
  note?: (p: Person) => string | undefined;
  /** what the tab says when it has no one, and what to do about it */
  empty: string;
  onPick: (p: Person) => void;
}) {
  const [all, setAll] = useState(false);
  return (
    <div data-testid="map-lens-list">
      <div className="text-[12px] uppercase tracking-wide text-ink-3 mb-1.5">
        {title}
        {people.length ? ` · ${people.length}` : ''}
      </div>
      {!people.length ? (
        <p className="text-[13px] text-ink-3" data-testid="map-lens-empty">
          {empty}
        </p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {(all ? people : people.slice(0, SHOWN)).map((p) => {
              const n = note?.(p);
              const role = p.currentTitle ?? p.headline;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onPick(p)}
                    className="w-full flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-canvas-2 pointer-coarse:min-h-11"
                    data-testid="map-lens-row"
                  >
                    <Avatar name={p.displayName} src={p.photoUrl} id={p.id} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{p.displayName}</span>
                      {(role || p.currentOrganizationRaw) && (
                        <LogoText person={p} size={13} className="text-[12px] text-ink-3">
                          {role ?? p.currentOrganizationRaw}
                        </LogoText>
                      )}
                    </span>
                    {n && <span className="shrink-0 text-[11.5px] text-ink-3">{n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {people.length > SHOWN && (
            <button
              type="button"
              className={cx(
                'mt-1.5 text-[12px] font-medium text-ink-2 hover:text-ink hover:underline pointer-coarse:min-h-11',
              )}
              onClick={() => setAll((v) => !v)}
              data-testid="map-lens-more"
            >
              {all ? 'Show fewer' : `Show all ${people.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
