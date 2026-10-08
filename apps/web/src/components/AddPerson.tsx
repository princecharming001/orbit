import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addPersonByHand } from '../engine/people';
import { useSession } from '../state/session';
import { Button, Input, Label, Modal, useToast } from '../ui';

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
  const [f, setF] = useState({ name: '', company: company ?? '', title: '', email: '', linkedinUrl: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!user) return null;
  const emailBad = !!f.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  // a way to reach them: without one, Orbit could draft a message but never send or open it anywhere
  const reachable = !!f.email.trim() || !!f.linkedinUrl.trim();
  const ok = !!f.name.trim() && !emailBad && reachable;
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await addPersonByHand(user.id, f, user.school);
      if (!r) return setError('Add their name first.');
      onClose();
      if (onAdded) {
        onAdded(r.person.id);
        toast.push({ text: `Added ${r.person.displayName}.`, tone: 'good' });
        return;
      }
      toast.push({
        text: r.created
          ? `Added ${r.person.displayName}. When you are ready, use Write to ${r.person.firstName}.`
          : `${r.person.displayName} was already in Orbit, so their details were updated.`,
        tone: 'good',
        ttl: 6000,
      });
      nav(`/people/${r.person.id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    // a stray tap beside the dialog never throws away what was typed
    <Modal
      open
      onClose={onClose}
      title="Add a person"
      keepOnBackdrop={Object.entries(f).some(
        ([k, v]) => v.trim() && !(k === 'company' && v === (company ?? '')),
      )}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        data-testid="add-person-form"
      >
        <p className="text-[13px] text-ink-2">
          Someone you want a coffee chat with: an alum, a friend's contact, a speaker you met. Orbit keeps
          track of them and helps you write the first message.
        </p>
        <div>
          <Label htmlFor="ap-name" required>
            Full name
          </Label>
          <Input
            id="ap-name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="e.g. Priya Shah"
            data-autofocus
            data-testid="add-person-name"
          />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ap-company" optional>
              Company
            </Label>
            <Input
              id="ap-company"
              value={f.company}
              onChange={(e) => setF({ ...f, company: e.target.value })}
              placeholder="e.g. Evercore"
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
              placeholder="e.g. Analyst"
            />
          </div>
        </div>
        <p className="text-[12.5px] text-ink-2 pt-1">
          Add an email or a LinkedIn link, or both, so Orbit has a way to reach them.
        </p>
        <div>
          <Label htmlFor="ap-email" hint="this or LinkedIn">
            Email
          </Label>
          <Input
            id="ap-email"
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            placeholder={`e.g. priya.shah@${
              f.company
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '')
                .slice(0, 20) || 'evercore'
            }.com`}
            aria-invalid={emailBad}
            data-testid="add-person-email"
          />
          {emailBad && <p className="text-[12px] text-bad mt-1">That does not look like an email address.</p>}
        </div>
        <div>
          <Label htmlFor="ap-li" hint="this or an email">
            LinkedIn profile link
          </Label>
          <Input
            id="ap-li"
            value={f.linkedinUrl}
            onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })}
            placeholder="e.g. linkedin.com/in/priya-shah"
            data-testid="add-person-linkedin"
          />
        </div>
        {error && <p className="text-[13px] text-bad">{error}</p>}
        {!reachable && f.name.trim() && !error && (
          <p className="text-[12px] text-ink-3 text-right" data-testid="add-person-missing">
            Add an email or a LinkedIn link to add {f.name.trim().split(/\s+/)[0]}.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ok || busy} data-testid="add-person-save">
            {busy ? 'Adding…' : 'Add person'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
