import type { ResumeFacet } from '@orbit/core';
import { useState } from 'react';
import { db } from '../db/schema';
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
  return /\w/.test(t) ? t : '';
}

const HAS_ROLE = new Set(['experience', 'education', 'project']);

/**
 * What Orbit read from the resume, one line each: unchecked lines are not used, and any line can be corrected in
 * place (a role the parse ran into the first bullet, a misspelt employer), since drafts and the 30-second intro quote it.
 */
export function ResumeFacetList({ facets, readBy }: { facets: ResumeFacet[]; readBy: string }) {
  const [editing, setEditing] = useState<string>();
  return (
    <div className="mt-4">
      <Label hint="uncheck anything that's wrong, or press Fix to correct it">{`What ${readBy} read from your resume`}</Label>
      <ul className="space-y-2 max-h-80 overflow-y-auto scroll-thin pr-1">
        {facets.map((f) =>
          editing === f.id ? (
            <FacetEditor key={f.id} facet={f} onDone={() => setEditing(undefined)} />
          ) : (
            <li
              key={f.id}
              className={`flex items-start gap-2 text-[13px] ${f.excluded ? 'opacity-50' : ''}`}
              data-testid="resume-facet"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={!f.excluded}
                aria-label={`Use ${f.title ?? FACET_LABELS[f.kind] ?? 'this line'}`}
                data-testid="ob-facet-toggle"
                onChange={(e) =>
                  db.resumeFacets.update(f.id, { excluded: !e.target.checked, confirmed: e.target.checked })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="text-ink-3 text-[12px] mr-1.5">{FACET_LABELS[f.kind] ?? 'Other'}</span>
                <strong className="font-medium">
                  {[f.title, f.organizationName !== f.title ? f.organizationName : undefined]
                    .filter(Boolean)
                    .join(' · ')}
                </strong>
                {/* what they did on its own line, so the employer and the first bullet never run together */}
                {facetDetail(f) && <span className="block text-ink-2">{facetDetail(f).slice(0, 140)}</span>}
              </span>
              <button
                type="button"
                className="shrink-0 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
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
  const role = HAS_ROLE.has(facet.kind);
  const [title, setTitle] = useState(facet.title ?? '');
  const [org, setOrg] = useState(facet.organizationName ?? '');
  const [text, setText] = useState(role ? facetDetail(facet) : facet.text);
  const save = async () => {
    await db.resumeFacets.update(facet.id, {
      title: role ? title.trim() || undefined : facet.title,
      organizationName: role ? org.trim() || undefined : facet.organizationName,
      text: text.trim() || [title, org].filter((x) => x.trim()).join(', '),
      excluded: false,
      confirmed: true,
    });
    onDone();
  };
  return (
    <li className="rounded-lg border border-line p-3 space-y-2 text-[13px]" data-testid="resume-facet-editor">
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
