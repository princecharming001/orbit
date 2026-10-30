import type { ResumeFacet } from '@orbit/core';
import { useState } from 'react';
import { FACETS_WITH_ROLE, fixResumeFacet, setResumeFacetUsed } from '../engine/resume';
import { Button, Input, Label, Textarea } from '../ui';

const FACET_LABELS: Record<string, string> = {
  experience: 'Experience',
  education: 'Education',
  project: 'Project',
  skill_group: 'Skills',
  interest: 'Interests',
  summary: 'Summary',
};

/** The facet's text without repeating its title or organization (the parse often carries both). */
export function facetDetail(f: { title?: string; organizationName?: string; text: string }): string {
  let t = f.text.trim();
  for (const part of [f.title, f.organizationName].filter(Boolean) as string[]) {
    const re = new RegExp(`^${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,·:-]*`, 'i');
    t = t.replace(re, '').trim();
  }
  // what is left of "Treasurer, Club soccer." once the role and the club are shown is a full stop: nothing to show
  t = t.replace(/^[\s.,;:·-]+/, '');
  return /\w/.test(t) ? t : '';
}

/** "Software Engineering Intern · Brex": the role and where, when the parse found them. */
function facetHeading(f: { title?: string; organizationName?: string }): string {
  return [f.title, f.organizationName !== f.title ? f.organizationName : undefined]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What Orbit read from the resume, one line each: unchecked lines are not used, and any line can be corrected in
 * place (a role the parse ran into the first bullet, a misspelt employer), since drafts and the 30-second intro quote it.
 */
export function ResumeFacetList({ facets, readBy }: { facets: ResumeFacet[]; readBy: string }) {
  const [editing, setEditing] = useState<string>();
  return (
    <div className="mt-1">
      <p className="mb-2 text-[12px] font-medium text-ink-3">{`What ${readBy} read from your resume`}</p>
      <ul className="max-h-80 overflow-y-auto scroll-thin rounded-[10px] border border-line-2 divide-y divide-line-2 bg-canvas-2/40">
        {facets.map((f) =>
          editing === f.id ? (
            <FacetEditor key={f.id} facet={f} onDone={() => setEditing(undefined)} />
          ) : (
            <li
              key={f.id}
              className={`group flex items-start gap-3 px-3 py-2.5 text-[13px] transition-opacity ${f.excluded ? 'opacity-45' : ''}`}
              data-testid="resume-facet"
            >
              <input
                type="checkbox"
                className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                checked={!f.excluded}
                aria-label={`Use ${f.title ?? FACET_LABELS[f.kind] ?? 'this line'}`}
                data-testid="ob-facet-toggle"
                onChange={(e) => setResumeFacetUsed(f.id, e.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <strong className="font-medium text-ink">
                    {facetHeading(f) || (FACET_LABELS[f.kind] ?? 'Other')}
                  </strong>
                  {facetHeading(f) && (
                    <span className="text-[11px] text-ink-3">{FACET_LABELS[f.kind] ?? 'Other'}</span>
                  )}
                </span>
                {/* what they did on its own line, so the employer and the first bullet never run together */}
                {facetDetail(f) && (
                  <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-2 line-clamp-2">
                    {facetDetail(f)}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-canvas hover:text-ink"
                onClick={() => setEditing(f.id)}
                aria-label={`Fix ${f.title ?? FACET_LABELS[f.kind] ?? 'this line'}`}
                data-testid="resume-facet-edit"
              >
                Fix
              </button>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function FacetEditor({ facet, onDone }: { facet: ResumeFacet; onDone: () => void }) {
  const role = FACETS_WITH_ROLE.has(facet.kind);
  const [title, setTitle] = useState(facet.title ?? '');
  const [org, setOrg] = useState(facet.organizationName ?? '');
  const [text, setText] = useState(role ? facetDetail(facet) : facet.text);
  const save = async () => {
    await fixResumeFacet(facet.id, { title, organizationName: org, text });
    onDone();
  };
  return (
    <li className="bg-canvas p-3 space-y-2 text-[13px]" data-testid="resume-facet-editor">
      {role && (
        <div className="grid sm:grid-cols-2 gap-2">
          <div>
            <Label htmlFor={`${facet.id}-title`}>{facet.kind === 'education' ? 'Degree' : 'Role'}</Label>
            <Input id={`${facet.id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Label htmlFor={`${facet.id}-org`}>
              {facet.kind === 'education' ? 'School' : facet.kind === 'project' ? 'For' : 'Where'}
            </Label>
            <Input id={`${facet.id}-org`} value={org} onChange={(e) => setOrg(e.target.value)} />
          </div>
        </div>
      )}
      <div>
        <Label htmlFor={`${facet.id}-text`}>{role ? 'What you did' : FACET_LABELS[facet.kind]}</Label>
        <Textarea id={`${facet.id}-text`} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={save} data-testid="resume-facet-save">
          Save
        </Button>
      </div>
    </li>
  );
}
