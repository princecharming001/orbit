import type { Person } from '@orbit/core';
import { ChevronDown, Linkedin, Search, UserPlus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { suggestCompanies } from '../data/companies';
import { db } from '../db/schema';
import { addLinkedInFound, type FoundView, lookUpLinkedInPeople } from '../engine/linkedinSearch';
import { addPersonByHand } from '../engine/people';
import { useSession } from '../state/session';
import { Avatar, Button, cx, Input, Label, Modal, Spinner, useToast } from '../ui';
import { Suggest } from '../ui/Suggest';

/**
 * "Add a person": the way into Orbit that needs no Google and no LinkedIn export. The student types who they want to
 * talk to; Orbit opens that person's page, where "Write to ..." drafts the first message.
 */
export function AddPersonButton({
  label = 'Add a person',
  variant = 'secondary',
  company,
  className,
}: {
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** prefill the company (an "Add someone at Evercore" shortcut) */
  company?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)} className={className} data-testid="add-person">
        <UserPlus size={14} /> {label}
      </Button>
      {open && <AddPersonDialog onClose={() => setOpen(false)} company={company} />}
    </>
  );
}

/** How long typing must pause before LinkedIn is asked: each search spends one of the day's few. */
const SEARCH_AFTER_MS = 450;
const MIN_QUERY = 3;

type Option = { kind: 'mine'; person: Person } | { kind: 'linkedin'; found: FoundView };

/**
 * Search first, LinkedIn style: typing a name or "PM at Stripe" lists who Orbit already has at once and, as typing
 * settles, people on LinkedIn with their photo and headline. A pick opens (or adds) them. Anyone LinkedIn cannot find
 * is added by hand below, with the name carried over.
 */
export function AddPersonDialog({
  onClose,
  company,
  onAdded,
}: {
  onClose: () => void;
  company?: string;
  /** stay where the student is (a note being matched) and hand back who was added, instead of opening them */
  onAdded?: (personId: string) => void;
}) {
  const { user } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const listId = useId();
  const [q, setQ] = useState('');
  const [settled, setSettled] = useState('');
  const [found, setFound] = useState<FoundView[]>();
  const [searching, setSearching] = useState(false);
  const [lookupNote, setLookupNote] = useState<string>();
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string>();
  // a shortcut that names the company ("Add someone at Evercore") opens the fields straight away
  const [byHand, setByHand] = useState(!!company);
  const [local, setLocal] = useState<Person[]>([]);

  // who Orbit already has, as the student types: instant, from this browser
  useEffect(() => {
    const t = q.trim().toLowerCase();
    if (!user || t.length < 2) {
      setLocal([]);
      return;
    }
    let live = true;
    void db.people
      .where('userId')
      .equals(user.id)
      .filter(
        (p) =>
          p.isHuman &&
          !p.hiddenAt &&
          (p.displayName.toLowerCase().includes(t) || (p.headline ?? '').toLowerCase().includes(t)),
      )
      .limit(4)
      .toArray()
      .then((ps) => live && setLocal(ps));
    return () => {
      live = false;
    };
  }, [q, user]);

  // LinkedIn, once typing settles
  useEffect(() => {
    const t = q.trim();
    if (t.length < MIN_QUERY) {
      setSettled('');
      setFound(undefined);
      setLookupNote(undefined);
      return;
    }
    const timer = window.setTimeout(() => setSettled(t), SEARCH_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    if (!user || !settled) return;
    let live = true;
    setSearching(true);
    void lookUpLinkedInPeople(user, settled)
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setFound(r.people.filter((p) => !p.knownPersonId));
          setLookupNote(undefined);
        } else {
          setFound([]);
          setLookupNote(
            r.reason === 'not_connected'
              ? 'Connect LinkedIn in Settings to search it here.'
              : r.reason === 'limit'
                ? "That's today's LinkedIn searches. Add them by hand below."
                : 'LinkedIn did not answer just now.',
          );
        }
      })
      .finally(() => live && setSearching(false));
    return () => {
      live = false;
    };
  }, [settled, user]);

  const options: Option[] = [
    ...local.map((person) => ({ kind: 'mine' as const, person })),
    ...(found ?? []).map((f) => ({ kind: 'linkedin' as const, found: f })),
  ];
  useEffect(() => setActive(0), [q]);
  if (!user) return null;

  const done = (personId: string, text: string) => {
    onClose();
    if (onAdded) {
      onAdded(personId);
      toast.push({ text, tone: 'good' });
      return;
    }
    toast.push({ text, tone: 'good', ttl: 5000 });
    nav(`/people/${personId}`);
  };
  const pick = async (o: Option) => {
    if (o.kind === 'mine') return done(o.person.id, `${o.person.displayName} is already in Orbit.`);
    setAdding(o.found.id);
    try {
      const r = await addLinkedInFound(user, [o.found.id]);
      if (!r.ok || !r.people[0]) {
        toast.push({ text: r.ok ? 'Could not add them just now.' : r.message, tone: 'bad' });
        return;
      }
      done(r.people[0].id, `Added ${r.people[0].displayName}. Write to them when you're ready.`);
    } finally {
      setAdding(undefined);
    }
  };
  const showList = q.trim().length >= 2 && !byHand;

  return (
    // a stray tap beside the dialog never throws away what was typed
    <Modal open onClose={onClose} title="Add a person" keepOnBackdrop={!!q.trim() || byHand}>
      <div data-testid="add-person-form">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (!options.length) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => (a + 1) % options.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (a - 1 + options.length) % options.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                void pick(options[active]!);
              }
            }}
            placeholder="Search a name, or a role and company"
            aria-label="Search for a person"
            role="combobox"
            aria-expanded={showList && options.length > 0}
            aria-controls={listId}
            aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
            className="h-11 pl-10 text-[15px] rounded-[12px]"
            data-autofocus
            data-testid="add-person-search"
          />
          {searching && (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3">
              <Spinner />
            </span>
          )}
        </div>

        {showList && (
          <div className="mt-2" id={listId} role="listbox" aria-label="People found">
            {local.length > 0 && <GroupLabel>In your Orbit</GroupLabel>}
            {options.map((o, i) => {
              const row =
                o.kind === 'mine'
                  ? {
                      key: o.person.id,
                      name: o.person.displayName,
                      line: o.person.headline ?? o.person.currentTitle,
                      photo: o.person.photoUrl,
                      id: o.person.id,
                    }
                  : {
                      key: o.found.id,
                      name: o.found.name,
                      line: o.found.headline,
                      photo: o.found.pictureUrl,
                      id: o.found.memberId,
                    };
              const firstLinkedIn = o.kind === 'linkedin' && (i === 0 || options[i - 1]!.kind === 'mine');
              return (
                <div key={row.key}>
                  {firstLinkedIn && <GroupLabel linkedin>On LinkedIn</GroupLabel>}
                  <button
                    type="button"
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void pick(o)}
                    disabled={!!adding}
                    className={cx(
                      'w-full flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors fade-up',
                      i === active ? 'bg-canvas-2' : 'hover:bg-canvas-2',
                    )}
                    data-testid={o.kind === 'mine' ? 'add-person-mine' : 'add-person-found'}
                  >
                    <Avatar name={row.name} src={row.photo} id={row.id} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[14px] font-medium text-ink truncate">{row.name}</span>
                        {o.kind === 'linkedin' && o.found.distance && (
                          <span className="shrink-0 text-[11px] text-ink-3 tabular">
                            {o.found.distance === 1 ? '1st' : o.found.distance === 2 ? '2nd' : '3rd'}
                          </span>
                        )}
                      </span>
                      {row.line && (
                        <span className="block text-[12.5px] text-ink-3 truncate">{row.line}</span>
                      )}
                    </span>
                    {adding === row.key ? (
                      <Spinner />
                    ) : (
                      <span className="shrink-0 text-[12px] text-ink-3">
                        {o.kind === 'mine' ? 'Open' : 'Add'}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
            {searching && !found && (
              <div className="space-y-1.5 px-2.5 py-2" aria-hidden>
                {[0, 1].map((k) => (
                  <div key={k} className="flex items-center gap-3">
                    <span className="w-9 h-9 rounded-full skeleton" />
                    <span className="flex-1 space-y-1.5">
                      <span className="block h-3 w-1/3 skeleton" />
                      <span className="block h-2.5 w-2/3 skeleton" />
                    </span>
                  </div>
                ))}
              </div>
            )}
            {lookupNote && <p className="px-2.5 pt-2 text-[12.5px] text-ink-3">{lookupNote}</p>}
            {!searching && found && !options.length && !lookupNote && (
              <p className="px-2.5 pt-2 text-[12.5px] text-ink-3" data-testid="add-person-none">
                No one by that name. Add them by hand.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => setByHand((v) => !v)}
            className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
            aria-expanded={byHand}
            data-testid="add-person-by-hand"
          >
            Add by hand
            <ChevronDown
              size={14}
              className={cx('transition-transform', byHand && 'rotate-180')}
              aria-hidden
            />
          </button>
          {byHand && (
            <ByHand
              key="by-hand"
              userId={user.id}
              school={user.school}
              initialName={q}
              company={company}
              onCancel={onClose}
              onDone={done}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function GroupLabel({ children, linkedin }: { children: string; linkedin?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-3">
      {linkedin && <Linkedin size={12} aria-hidden />}
      {children}
    </div>
  );
}

/** Someone LinkedIn cannot find: name, where they work, and one way to reach them. */
function ByHand({
  userId,
  school,
  initialName,
  company,
  onCancel,
  onDone,
}: {
  userId: string;
  school?: string;
  initialName: string;
  company?: string;
  onCancel: () => void;
  onDone: (personId: string, text: string) => void;
}) {
  const [f, setF] = useState({
    name: initialName.trim(),
    company: company ?? '',
    title: '',
    email: '',
    linkedinUrl: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const emailBad = !!f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  // a way to reach them: without one, Orbit could draft a message but never send or open it anywhere
  const reachable = !!f.email.trim() || !!f.linkedinUrl.trim();
  const ok = !!f.name.trim() && !emailBad && reachable;
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await addPersonByHand(userId, f, school);
      if (!r) return setError('Add their name first.');
      onDone(
        r.person.id,
        r.created
          ? `Added ${r.person.displayName}. Write to them when you're ready.`
          : `${r.person.displayName} was already in Orbit, so their details were updated.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-3 space-y-3 fade-up"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <Label htmlFor="ap-name" required>
          Full name
        </Label>
        <Input
          id="ap-name"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          placeholder="Priya Shah"
          data-testid="add-person-name"
        />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <Label htmlFor="ap-company" optional>
            Company
          </Label>
          <Suggest
            id="ap-company"
            value={f.company}
            onChange={(c) => setF({ ...f, company: c })}
            suggest={(x) => suggestCompanies(x)}
            placeholder="Evercore"
            data-testid="add-person-company"
          />
        </div>
        <div>
          <Label htmlFor="ap-title" optional>
            Role
          </Label>
          <Input
            id="ap-title"
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            placeholder="Analyst"
          />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <Label htmlFor="ap-email" hint="or LinkedIn">
            Email
          </Label>
          <Input
            id="ap-email"
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            placeholder="priya@evercore.com"
            aria-invalid={emailBad}
            data-testid="add-person-email"
          />
        </div>
        <div>
          <Label htmlFor="ap-li" hint="or email">
            LinkedIn link
          </Label>
          <Input
            id="ap-li"
            value={f.linkedinUrl}
            onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })}
            placeholder="linkedin.com/in/priya-shah"
            data-testid="add-person-linkedin"
          />
        </div>
      </div>
      {emailBad && <p className="text-[12px] text-bad">That does not look like an email address.</p>}
      {error && <p className="text-[13px] text-bad">{error}</p>}
      {!reachable && f.name.trim() && !error && (
        <p className="text-[12px] text-ink-3" data-testid="add-person-missing">
          Add an email or a LinkedIn link so Orbit can reach {f.name.trim().split(/\s+/)[0]}.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ok || busy} data-testid="add-person-save">
          {busy ? 'Adding…' : 'Add person'}
        </Button>
      </div>
    </form>
  );
}
