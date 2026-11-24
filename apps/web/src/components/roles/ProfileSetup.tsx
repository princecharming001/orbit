/**
 * Plan 44 §2.2: the first visit, and the profile screen after it. One decision first: where to read the student
 * from (their LinkedIn profile, a resume, or both). Then what Orbit read, in plain words, every line open to change:
 * where they are, the skills it found (remove one, add one), three to six kinds of role that fit with why (tick the
 * ones to search), places and places not, remote, the levels to look at, and sponsorship and citizenship, asked once
 * and never guessed. "Find roles" saves it and runs the search.
 */
import type { JobLevel, ProfileLevel, RoleKind, RoleProfile, User } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, FileText, Upload } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type KeptProfile,
  LEVEL_WORDS,
  PROFILE_LEVEL_WORDS,
  profileSources,
  readProfile,
  saveProfile,
  whereTheyAre,
} from '../../engine/roles';
import { levelsFor } from '../../engine/rolesSim';
import { forgetViews, readView, useViewState } from '../../state/viewState';
import { Button, cx, Input, PickCircle, Select, Switch, useToast, Working } from '../../ui';
import { ChipsField } from '../../ui/ChipsField';

/** What the screen holds while the student works on it, kept while they are away (state/viewState). */
interface Draft {
  step: 'choose' | 'review';
  use: { resume: boolean; linkedin: boolean };
  profile?: RoleProfile;
  note?: string;
}
const DRAFT_KEY = (userId: string) => `roles:draft:${userId}`;

/** Forget what the screen was holding (after Find roles, or Cancel). */
export function clearProfileDraft(userId: string): void {
  forgetViews(DRAFT_KEY(userId));
}

const ALL_LEVELS: JobLevel[] = ['intern', 'entry', 'mid', 'senior', 'lead'];

export function ProfileSetup({
  user,
  kept,
  onDone,
  onCancel,
}: {
  user: User;
  /** the profile already saved: the screen opens on it to change it */
  kept?: KeptProfile;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useViewState<Draft | undefined>(DRAFT_KEY(user.id), () =>
    kept
      ? { step: 'review', use: { resume: true, linkedin: true }, profile: kept.profile, note: kept.note }
      : undefined,
  );
  const sources = useLiveQuery(() => profileSources(user.id), [user.id]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const d: Draft = draft ?? {
    step: 'choose',
    use: { resume: !!sources?.resume, linkedin: !!sources?.linkedin },
  };
  const set = (part: Partial<Draft>) => setDraft({ ...(readView<Draft>(DRAFT_KEY(user.id)) ?? d), ...part });
  const setProfile = (part: Partial<RoleProfile>) => {
    const cur = readView<Draft>(DRAFT_KEY(user.id)) ?? d;
    if (cur.profile) set({ profile: { ...cur.profile, ...part } });
  };
  // a source is used when the student has it and did not untick it (the first time, everything they have)
  const useResume = !!sources?.resume && (draft ? d.use.resume : true);
  const useLinkedIn = !!sources?.linkedin && (draft ? d.use.linkedin : true);

  const read = async () => {
    setReading(true);
    setError(undefined);
    try {
      const r = await readProfile(user, { resume: useResume, linkedin: useLinkedIn });
      if (!r.ok) setError(r.message);
      else
        set({
          step: 'review',
          profile: r.proposed,
          note: r.note,
          use: { resume: useResume, linkedin: useLinkedIn },
        });
    } finally {
      setReading(false);
    }
  };

  const find = async () => {
    if (!d.profile) return;
    setSaving(true);
    setError(undefined);
    try {
      const r = await saveProfile(user, d.profile, { note: d.note });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      clearProfileDraft(user.id);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  if (d.step === 'choose' || !d.profile)
    return (
      <div className="max-w-[640px]" data-testid="roles-first-visit">
        <h2 className="text-[17px] font-medium tracking-[-0.01em]">Where should Orbit read you from?</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">
          Orbit reads what you have done, says which kinds of role fit, then lists open roles with a score out
          of 10 and who you know at each company. Nothing is guessed from an empty profile.
        </p>
        <div className="mt-5 divide-y divide-line rounded-[10px] border border-line bg-canvas">
          {sources?.linkedin && (
            <SourceRow
              on={useLinkedIn}
              onToggle={(on) => set({ use: { resume: useResume, linkedin: on } })}
              title="Use my LinkedIn profile"
              line={
                sources.linkedin.read
                  ? 'Nothing to upload. Orbit reads your jobs, schools and skills.'
                  : 'Nothing to upload. Orbit reads it now.'
              }
              mark={
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] bg-[#0a66c2] text-[11px] font-bold text-white">
                  in
                </span>
              }
              testId="profile-use-linkedin"
            />
          )}
          {sources?.resume ? (
            <SourceRow
              on={useResume}
              onToggle={(on) => set({ use: { resume: on, linkedin: useLinkedIn } })}
              title="Use my resume"
              line={`${sources.resume.filename}, ${sources.resume.lines} lines Orbit can read`}
              mark={<FileText size={20} className="text-ink-3" aria-hidden />}
              testId="profile-use-resume"
              extra={<ProfileLink label="Change in Profile" />}
            />
          ) : (
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Upload size={20} className="shrink-0 text-ink-3" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[14px]">Add your resume</p>
                <p className="text-[12.5px] text-ink-3">
                  It lives in your profile, where drafts and intros read it too.
                </p>
              </div>
              <ProfileLink label="Add in Profile" primary={!sources?.linkedin} />
            </div>
          )}
        </div>
        {sources?.resume && sources.linkedin && (
          <p className="mt-2 text-[12.5px] text-ink-3">
            Using both: a job on one and not the other is kept, and the newer end date wins.
          </p>
        )}
        {error && (
          <p className="mt-3 text-[13px] text-bad" role="alert" data-testid="profile-error">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void read()}
            loading={reading}
            disabled={!useResume && !useLinkedIn}
            data-testid="profile-read"
          >
            {reading ? 'Reading your profile' : 'Read my profile'}
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    );

  const p = d.profile;
  const kinds = p.kinds;
  const setKinds = (next: RoleKind[]) => setProfile({ kinds: next });
  return (
    <div className="max-w-[720px]" data-testid="roles-profile">
      <h2 className="text-[17px] font-medium tracking-[-0.01em]">What Orbit read</h2>
      <p className="mt-1 text-[13.5px] text-ink-3">
        From your{' '}
        {p.sources.length === 2
          ? 'resume and LinkedIn profile'
          : p.sources[0] === 'resume'
            ? 'resume'
            : 'LinkedIn profile'}
        . Change anything that is not right.
      </p>
      {d.note && (
        <p
          className="mt-3 rounded-[8px] bg-canvas-2 px-3 py-2 text-[13px] text-ink-2"
          data-testid="profile-note"
        >
          {d.note}
        </p>
      )}

      <Field title="Where you are" testId="profile-where">
        <p className="text-[14px]" data-testid="profile-where-line">
          {whereTheyAre(p)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select
            value={p.level}
            onChange={(e) => {
              const level = e.target.value as ProfileLevel;
              setProfile({ level, wants: { ...p.wants, levels: levelsFor(level) } });
            }}
            aria-label="Where you are"
            className="h-9 text-[13px]"
            data-testid="profile-level"
          >
            {(Object.keys(PROFILE_LEVEL_WORDS) as ProfileLevel[]).map((l) => (
              <option key={l} value={l}>
                {PROFILE_LEVEL_WORDS[l]}
              </option>
            ))}
          </Select>
          <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
            {p.level === 'student' ? 'Graduating' : 'Graduated'}
            <Input
              type="month"
              value={p.graduation ?? ''}
              onChange={(e) => setProfile({ graduation: e.target.value || undefined })}
              className="!h-9 w-[11rem] text-[13px]"
              aria-label="Graduation month"
              data-testid="profile-graduation"
            />
          </label>
        </div>
      </Field>

      <Field
        title="Levels to look at"
        hint="Set from where you are. Widen it if you like."
        testId="profile-levels"
      >
        <div className="flex flex-wrap gap-1.5">
          {ALL_LEVELS.map((l) => {
            const picked = p.wants.levels.includes(l);
            return (
              <button
                key={l}
                type="button"
                aria-pressed={picked}
                onClick={() =>
                  setProfile({
                    wants: {
                      ...p.wants,
                      levels: picked ? p.wants.levels.filter((x) => x !== l) : [...p.wants.levels, l],
                    },
                  })
                }
                className={cx(
                  'h-8 px-2.5 rounded-[6px] border text-[12.5px] transition-colors',
                  picked
                    ? 'bg-ink border-ink text-white font-medium'
                    : 'bg-canvas border-line text-ink-2 hover:bg-canvas-2 hover:text-ink',
                )}
                data-testid={`profile-level-chip-${l}`}
              >
                {LEVEL_WORDS[l]}
              </button>
            );
          })}
        </div>
      </Field>

      <Field title="Skills Orbit found" hint="Remove one, add one" testId="profile-skills-field">
        <ChipsField
          values={p.skills.map((s) => s.name)}
          onChange={(names) =>
            setProfile({
              skills: names.map(
                (n) => p.skills.find((s) => s.name === n) ?? { name: n, from: 'added' as const },
              ),
            })
          }
          placeholder="Add a skill"
          testId="profile-skills"
        />
      </Field>

      <Field title="Kinds of role that fit" hint="Tick the ones to search" testId="profile-kinds">
        <ul className="divide-y divide-line-2 rounded-[10px] border border-line bg-canvas">
          {kinds.map((k, i) => (
            <li
              key={`${k.title}-${i}`}
              className="flex items-start gap-3 px-3 py-2.5"
              data-testid="profile-kind"
            >
              <PickCircle
                checked={k.on}
                onChange={(on) => setKinds(kinds.map((x, j) => (j === i ? { ...x, on } : x)))}
                label={`Search ${k.title}`}
                size={18}
                testId="profile-kind-tick"
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">{k.title}</p>
                {k.why && <p className="text-[12.5px] text-ink-3">{k.why}</p>}
              </div>
              <button
                type="button"
                onClick={() => setKinds(kinds.filter((_, j) => j !== i))}
                className="text-[12.5px] text-ink-3 hover:text-ink"
                aria-label={`Remove ${k.title}`}
              >
                Remove
              </button>
            </li>
          ))}
          {kinds.length < 6 && (
            <li className="px-3 py-2">
              <AddKind onAdd={(title) => setKinds([...kinds, { title, on: true }])} />
            </li>
          )}
        </ul>
        {!kinds.some((k) => k.on) && (
          <p className="mt-1.5 text-[12.5px] text-bad">Tick at least one kind of role to search.</p>
        )}
      </Field>

      <Field title="Where" testId="profile-places-field">
        <div className="grid gap-4 @[36rem]:grid-cols-2">
          <div>
            <p className="mb-1 text-[12.5px] text-ink-3">Places you would work. Empty is anywhere.</p>
            <ChipsField
              values={p.wants.places}
              onChange={(places) => setProfile({ wants: { ...p.wants, places } })}
              placeholder="New York, San Francisco"
              testId="profile-places"
            />
          </div>
          <div>
            <p className="mb-1 text-[12.5px] text-ink-3">Not these places</p>
            <ChipsField
              values={p.wants.notPlaces}
              onChange={(notPlaces) => setProfile({ wants: { ...p.wants, notPlaces } })}
              placeholder="A city to leave out"
              testId="profile-not-places"
            />
          </div>
        </div>
        <label className="mt-3 inline-flex items-center gap-2.5 text-[13.5px]">
          <Switch
            checked={p.wants.remote}
            onChange={(remote) => setProfile({ wants: { ...p.wants, remote } })}
            label="Remote roles too"
            data-testid="profile-remote"
          />
          Remote roles too
        </label>
      </Field>

      <Field title="Work authorization" hint="Asked once, never guessed" testId="profile-eligibility">
        <YesNo
          question="Will you need visa sponsorship to work in the US?"
          value={p.eligibility.needsSponsorship}
          onChange={(v) => setProfile({ eligibility: { ...p.eligibility, needsSponsorship: v } })}
          testId="profile-sponsorship"
        />
        <YesNo
          question="Are you a US citizen?"
          value={p.eligibility.usCitizen}
          onChange={(v) => setProfile({ eligibility: { ...p.eligibility, usCitizen: v } })}
          testId="profile-citizen"
        />
      </Field>

      {error && (
        <p className="mt-4 text-[13px] text-bad" role="alert" data-testid="profile-error">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2 pb-6">
        <Button
          variant="primary"
          onClick={() => void find()}
          loading={saving}
          disabled={!kinds.some((k) => k.on) || !p.wants.levels.length}
          data-testid="profile-find"
        >
          Find roles
        </Button>
        <Button variant="ghost" onClick={() => set({ step: 'choose' })} data-testid="profile-reread">
          Read again
        </Button>
        {onCancel && (
          <Button
            variant="ghost"
            onClick={() => {
              clearProfileDraft(user.id);
              onCancel();
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="mt-6" data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-[13.5px] font-medium">{title}</h3>
        {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function SourceRow({
  on,
  onToggle,
  title,
  line,
  mark,
  extra,
  testId,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  title: string;
  line: string;
  mark: ReactNode;
  extra?: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <PickCircle checked={on} onChange={onToggle} label={title} size={20} testId={testId} />
      <span className="inline-flex w-6 shrink-0 justify-center">{mark}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">{title}</p>
        <p className="truncate text-[12.5px] text-ink-3">{line}</p>
      </div>
      {extra}
    </div>
  );
}

/** Where the resume is added or changed: the profile, the one place it lives. */
function ProfileLink({ label, primary }: { label: string; primary?: boolean }) {
  return (
    <Link
      to="/settings/profile#resume"
      className={cx(
        'inline-flex h-8 items-center rounded-[6px] px-3 text-[13px] font-medium',
        primary ? 'bg-ink text-white hover:bg-[#262626]' : 'border border-line bg-canvas hover:bg-canvas-2',
      )}
      data-testid="profile-resume-link"
    >
      {label}
    </Link>
  );
}

function AddKind({ onAdd }: { onAdd: (title: string) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim().replace(/\s+/g, ' ').slice(0, 60);
    setText('');
    if (t) onAdd(t.charAt(0).toUpperCase() + t.slice(1));
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      className="flex items-center gap-2"
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a kind of role, like Product analyst"
        aria-label="Add a kind of role"
        className="h-8 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[#a59f97]"
        data-testid="profile-kind-add"
      />
      {text.trim() && (
        <Button size="sm" type="submit">
          Add
        </Button>
      )}
    </form>
  );
}

function YesNo({
  question,
  value,
  onChange,
  testId,
}: {
  question: string;
  value: boolean | undefined;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  const btn = (v: boolean, label: string) => (
    <button
      type="button"
      aria-pressed={value === v}
      onClick={() => onChange(v)}
      className={cx(
        'inline-flex h-8 items-center gap-1 rounded-[6px] border px-3 text-[12.5px] transition-colors',
        value === v
          ? 'bg-ink border-ink text-white font-medium'
          : 'bg-canvas border-line text-ink-2 hover:bg-canvas-2',
      )}
      data-testid={`${testId}-${v ? 'yes' : 'no'}`}
    >
      {value === v && <Check size={12} aria-hidden />}
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="text-[13.5px]">{question}</span>
      <span className="flex gap-1.5">
        {btn(true, 'Yes')}
        {btn(false, 'No')}
      </span>
    </div>
  );
}
