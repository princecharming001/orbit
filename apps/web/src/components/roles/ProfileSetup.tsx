/**
 * Plan 44 §2.2: the first visit, and the profile screen after it. One decision first: where to read the student
 * from (their LinkedIn profile, a resume, or both). Then what Orbit read, in plain words, every line open to change:
 * where they are, the skills it found (remove one, add one), three to six kinds of role that fit with why (tick the
 * ones to search), places and places not, remote, the levels to look at, and sponsorship and citizenship, asked once
 * and never guessed. "Find roles" saves it and runs the search.
 */
import {
  type JobLevel,
  levelsFor,
  type ProfileLevel,
  type RoleKind,
  type RoleProfile,
  type User,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, FileText, Plus, Upload, X } from 'lucide-react';
import { type InputHTMLAttributes, type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { CITY_OPTIONS, ROLE_KIND_OPTIONS, suggestFrom } from '../../data/options';
import {
  type KeptProfile,
  LEVEL_WORDS,
  PROFILE_LEVEL_WORDS,
  profileSources,
  readProfile,
  saveProfile,
  whereTheyAre,
} from '../../engine/roles';
import { forgetViews, readView, useViewState, writeView } from '../../state/viewState';
import { Button, cx, PickCircle, Select, Switch, useToast, Working } from '../../ui';
import { ChipsField } from '../../ui/ChipsField';
import { Suggest } from '../../ui/Suggest';

/** What the screen holds while the student works on it, kept while they are away (state/viewState). */
interface Draft {
  step: 'choose' | 'review';
  use: { resume: boolean; linkedin: boolean };
  profile?: RoleProfile;
  note?: string;
}
const DRAFT_KEY = (userId: string) => `roles:draft:${userId}`;

/**
 * Open the review step on a profile Orbit already read (the server kept the proposal of a student who left before
 * "Find roles"). Nothing happens when the screen already holds something.
 */
export function openProfileReview(userId: string, proposed: RoleProfile): void {
  if (readView<Draft>(DRAFT_KEY(userId))) return;
  writeView<Draft | undefined>(
    DRAFT_KEY(userId),
    {
      step: 'review',
      use: { resume: proposed.sources.includes('resume'), linkedin: proposed.sources.includes('linkedin') },
      profile: proposed,
    },
    undefined,
  );
}

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
        <p className="mt-1.5 text-[13.5px] text-ink-2">
          Orbit reads what you have done, then finds open roles that fit and who you know at each.
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
  const [gradYear, gradMonth] = (p.graduation ?? '').split('-');
  const setGrad = (year?: string, month?: string) =>
    setProfile({ graduation: year ? `${year}-${month || '05'}` : undefined });
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 16 }, (_, i) => String(thisYear + 5 - i));
  return (
    <div className="@container max-w-[860px]" data-testid="roles-profile">
      <h2 className="text-[19px] font-medium tracking-[-0.015em]">Your profile for Roles</h2>
      <p className="mt-1 text-[13.5px] text-ink-2">
        Read from your{' '}
        {p.sources.length === 2
          ? 'resume and LinkedIn profile'
          : p.sources[0] === 'resume'
            ? 'resume'
            : 'LinkedIn profile'}
        . Change anything that is not right.
      </p>
      {d.note && (
        <p
          className="mt-3 rounded-[10px] bg-canvas-2 px-3.5 py-2.5 text-[13px] text-ink-2"
          data-testid="profile-note"
        >
          {d.note}
        </p>
      )}

      <div className="mt-6">
        <Field title="Where you are" testId="profile-where">
          <p className="text-[14px] text-ink" data-testid="profile-where-line">
            {whereTheyAre(p)}
          </p>
          <div className="settings-flat mt-4 grid max-w-[460px] grid-cols-1 gap-4 @[32rem]:grid-cols-[1fr_1.3fr]">
            <label className="block">
              <span className="mb-1 block text-[12.5px] text-ink-3">Stage</span>
              <Select
                value={p.level}
                onChange={(e) => {
                  const level = e.target.value as ProfileLevel;
                  setProfile({ level, wants: { ...p.wants, levels: levelsFor(level) } });
                }}
                aria-label="Where you are"
                className="h-9 text-[14px]"
                data-testid="profile-level"
              >
                {(Object.keys(PROFILE_LEVEL_WORDS) as ProfileLevel[]).map((l) => (
                  <option key={l} value={l}>
                    {PROFILE_LEVEL_WORDS[l]}
                  </option>
                ))}
              </Select>
            </label>
            <div>
              <span className="mb-1 block text-[12.5px] text-ink-3">
                {p.level === 'student' ? 'Graduating' : 'Graduated'}
              </span>
              <div className="grid grid-cols-[1.4fr_1fr] gap-3">
                <Select
                  value={gradMonth ?? ''}
                  onChange={(e) => setGrad(gradYear || String(thisYear), e.target.value)}
                  aria-label="Graduation month"
                  className="h-9 text-[14px]"
                  data-testid="profile-graduation-month"
                >
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={String(i + 1).padStart(2, '0')}>
                      {m}
                    </option>
                  ))}
                </Select>
                <Select
                  value={gradYear ?? ''}
                  onChange={(e) => setGrad(e.target.value || undefined, gradMonth)}
                  aria-label="Graduation year"
                  className="h-9 text-[14px]"
                  data-testid="profile-graduation-year"
                >
                  <option value="">Year</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        </Field>

        <Field title="Levels to look at" testId="profile-levels">
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
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
                    picked
                      ? 'border-ink bg-ink font-medium text-white'
                      : 'border-line bg-canvas text-ink-2 hover:bg-canvas-2 hover:text-ink',
                  )}
                  data-testid={`profile-level-chip-${l}`}
                >
                  {picked && <Check size={12} strokeWidth={2.5} aria-hidden />}
                  {LEVEL_WORDS[l]}
                </button>
              );
            })}
          </div>
        </Field>

        <Field title="Skills" testId="profile-skills-field">
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

        <Field
          title="Kinds of role"
          aside={`${kinds.filter((k) => k.on).length} searched`}
          testId="profile-kinds"
        >
          <ul className="divide-y divide-line-2 overflow-hidden rounded-[12px] border border-line bg-canvas">
            {kinds.map((k, i) => (
              <li
                key={`${k.title}-${i}`}
                className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-canvas-2/50"
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
                  <p className={cx('text-[14px] font-medium', !k.on && 'text-ink-2')}>{k.title}</p>
                  {k.why && <p className="mt-0.5 text-[13px] text-ink-3">{k.why}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => setKinds(kinds.filter((_, j) => j !== i))}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 opacity-100 transition-opacity hover:bg-canvas-2 hover:text-ink @[40rem]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Remove ${k.title}`}
                  title="Remove"
                >
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
            {kinds.length < MAX_KINDS && (
              <li className="px-4 py-2">
                <AddKind
                  have={kinds.map((k) => k.title)}
                  onAdd={(title) => setKinds([...kinds, { title, on: true }])}
                />
              </li>
            )}
          </ul>
          {!kinds.some((k) => k.on) && (
            <p className="mt-2 text-[13px] text-bad">Tick at least one kind of role to search.</p>
          )}
        </Field>

        <Field title="Where" testId="profile-places-field">
          <div className="grid gap-5 @[44rem]:grid-cols-2">
            <div>
              <span className="mb-0.5 block text-[12.5px] text-ink-3">Places you would work</span>
              <ChipsField
                values={p.wants.places}
                onChange={(places) => setProfile({ wants: { ...p.wants, places } })}
                suggest={(q) => suggestFrom(CITY_OPTIONS, q)}
                placeholder="Anywhere"
                testId="profile-places"
              />
            </div>
            <div>
              <span className="mb-0.5 block text-[12.5px] text-ink-3">Not these places</span>
              <ChipsField
                values={p.wants.notPlaces}
                onChange={(notPlaces) => setProfile({ wants: { ...p.wants, notPlaces } })}
                suggest={(q) => suggestFrom(CITY_OPTIONS, q)}
                placeholder="None"
                testId="profile-not-places"
              />
            </div>
          </div>
          <label className="mt-4 flex items-center justify-between gap-3 text-[14px]">
            Remote roles too
            <Switch
              checked={p.wants.remote}
              onChange={(remote) => setProfile({ wants: { ...p.wants, remote } })}
              label="Remote roles too"
              data-testid="profile-remote"
            />
          </label>
        </Field>

        <Field title="Work authorization" testId="profile-eligibility">
          <div className="divide-y divide-line-2">
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
          </div>
        </Field>
      </div>

      {error && (
        <p className="mt-4 text-[13px] text-bad" role="alert" data-testid="profile-error">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line-2 pb-6 pt-5">
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

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The kinds of role kept with a profile (the server keeps twelve). */
const MAX_KINDS = 12;

/** One part of the profile: its name on the left, what to change on the right (stacked on a phone). */
function Field({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="grid gap-x-10 gap-y-3 border-t border-line-2 py-6 @[40rem]:grid-cols-[170px_minmax(0,1fr)]"
      data-testid={testId}
    >
      <div>
        <h3 className="text-[14px] font-medium">{title}</h3>
        {aside && <p className="mt-0.5 text-[12.5px] text-ink-3">{aside}</p>}
      </div>
      <div className="min-w-0">{children}</div>
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

/** Add a kind of role: suggestions from common roles as they type; Enter adds what is typed. */
function AddKind({ have, onAdd }: { have: string[]; onAdd: (title: string) => void }) {
  const [text, setText] = useState('');
  const taken = (t: string) => have.some((h) => h.toLowerCase() === t.toLowerCase());
  const add = (raw: string) => {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
    setText('');
    if (t && !taken(t)) onAdd(t.charAt(0).toUpperCase() + t.slice(1));
  };
  return (
    <div className="flex items-center gap-2.5">
      <Plus size={16} className="shrink-0 text-ink-3" aria-hidden />
      <Suggest
        className="min-w-0 flex-1"
        value={text}
        onChange={setText}
        suggest={(q) =>
          suggestFrom(
            ROLE_KIND_OPTIONS.filter((o) => !taken(o)),
            q,
          )
        }
        onPick={(sg) => add(sg.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !text.trim()) return;
          const highlighted = (e.currentTarget.getAttribute('aria-activedescendant') ?? '') !== '';
          if (!highlighted) {
            e.preventDefault();
            add(text);
          }
        }}
        placeholder="Add a kind of role"
        aria-label="Add a kind of role"
        input={KindInput}
        data-testid="profile-kind-add"
      />
    </div>
  );
}

function KindInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-9 w-full bg-transparent text-[14px] outline-none placeholder:text-[#a59f97]"
    />
  );
}

/** A yes or no asked once: the question, and the answer as a two-part switch. */
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
        'h-7 min-w-[52px] rounded-full px-3 text-[13px] transition-all',
        value === v
          ? 'bg-canvas font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)]'
          : 'text-ink-3 hover:text-ink',
      )}
      data-testid={`${testId}-${v ? 'yes' : 'no'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span className="text-[14px]">{question}</span>
      <span
        className="inline-flex shrink-0 rounded-full bg-canvas-2 p-0.5"
        role="group"
        aria-label={question}
      >
        {btn(true, 'Yes')}
        {btn(false, 'No')}
      </span>
    </div>
  );
}
