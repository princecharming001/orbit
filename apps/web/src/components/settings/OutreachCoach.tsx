/**
 * The outreach coach: how the student's messages sound, tuned by talking to it. For each kind of outreach (cold
 * email, LinkedIn note, LinkedIn message, reply, follow-up) it shows a sample written by the real draft engine in
 * their current style, takes feedback in their own words ("shorter", "never say 'circle back'"), keeps a log of every
 * change with an undo, and reviews what they actually sent the way an expert cold outreacher would: reply rate, then
 * what to change, with the exact line it comes from and a fix that updates the style.
 */
import type { CoachFinding, CoachSample, CoachType, StyleCard, User } from '@orbit/core';
import {
  applyStyleChange,
  COACH_SAMPLE_RECIPIENT,
  COACH_TYPES,
  coachSample,
  coachTypeInfo,
  defaultStyleCard,
  reviewOutreach,
  STYLE_SOURCE_WORDS,
} from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { db } from '../../db/schema';
import { applyCoachFeedback, claudeSampleFor, coachSampleUser, sentForCoach } from '../../engine/coach';
import { FEEDBACK_CHIPS } from '../../engine/coachTuning';
import {
  addStyleSample,
  applyStylePreset,
  learnStyle,
  removeStyleSample,
  type StyleTuningEntry,
  styleTuningLog,
  tuneStyle,
  undoStyleTuning,
} from '../../engine/style';
import { llmEnabled, toLlmError } from '../../integrations/anthropic';
import { Button, cx, relDate, Tabs, Textarea, useToast } from '../../ui';

const BY_WORDS: Record<StyleTuningEntry['by'], string> = { you: 'You', coach: 'Coach', claude: 'Claude' };
const LOG_PREVIEW = 6;

function provenance(card: StyleCard): string {
  const learned = card.builtFromCount > 0;
  const from = card.sources
    ? (Object.entries(card.sources) as [keyof typeof STYLE_SOURCE_WORDS, number][])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${STYLE_SOURCE_WORDS[k]}`)
        .join(', ')
    : `${card.builtFromCount} sent emails`;
  if (learned) return `Learned from ${from}${card.custom ? ', tuned by you' : ''}`;
  return card.custom ? 'Tuned by you' : 'A starting style';
}

const NOUNS: Record<CoachType, [string, string]> = {
  cold_email: ['cold email', 'cold emails'],
  linkedin_note: ['LinkedIn note', 'LinkedIn notes'],
  linkedin_message: ['LinkedIn message', 'LinkedIn messages'],
  reply: ['reply', 'replies'],
  follow_up: ['follow-up', 'follow-ups'],
};
/** "a cold email", "3 LinkedIn notes" */
const noun = (type: CoachType, n = 1) => NOUNS[type][n === 1 ? 0 : 1];

export function OutreachCoach({ user }: { user: User }) {
  const toast = useToast();
  const [type, setType] = useState<CoachType>('cold_email');
  const profile = useLiveQuery(() => db.styles.get(user.id), [user.id]);
  const settings = useLiveQuery(() => db.settings.get(user.id), [user.id]);
  const goals = useLiveQuery(() => db.goals.get(user.id), [user.id]);
  const sent = useLiveQuery(() => sentForCoach(user.id), [user.id]);
  const log = useLiveQuery(() => styleTuningLog(user.id), [user.id]) ?? [];
  const card = profile?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName);

  // the sample, from the real draft engine, rewritten whenever the card or the kind changes
  const sample = useMemo(
    () =>
      coachSample(type, {
        user: coachSampleUser(user, goals, settings),
        styleCard: card,
        now: new Date(),
      }),
    [type, card, user, goals, settings],
  );
  const review = useMemo(() => reviewOutreach(type, sent ?? [], sample), [type, sent, sample]);
  const counts = useMemo(() => {
    const c: Partial<Record<CoachType, number>> = {};
    for (const m of sent ?? []) c[m.type] = (c[m.type] ?? 0) + 1;
    return c;
  }, [sent]);

  // Claude's version of the sample, on request; any change to the card or the kind goes back to the template's
  const [claude, setClaude] = useState<{ key: string; sample: CoachSample }>();
  const [writing, setWriting] = useState(false);
  const sampleKey = `${type}:${profile?.updatedAt ?? ''}`;
  const shown = claude?.key === sampleKey ? claude.sample : sample;
  const claudeOn = llmEnabled('drafts');

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const say = async (words: string) => {
    if (!words.trim() || busy) return;
    setBusy(true);
    try {
      const r = await applyCoachFeedback(user, words, type);
      if (r.claudeError)
        toast.push({ text: `${r.claudeError} Saved it as a note for your drafts.`, ttl: 7000 });
      else if (!r.entries.length) toast.push({ text: 'Your style already does that.' });
      setText('');
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void say(text);
  };
  const fix = async (f: CoachFinding) => {
    if (!f.fix) return;
    await tuneStyle(user, [f.fix.change], { by: 'coach', said: f.title, type });
  };
  const rewrite = async () => {
    setWriting(true);
    try {
      const s = await claudeSampleFor(user, type, card);
      if (s) setClaude({ key: sampleKey, sample: s });
      else toast.push({ text: 'Claude is off for drafts. Turn it on in Settings, Integrations.' });
    } catch (e) {
      toast.push({ text: toLlmError(e).message, ttl: 7000 });
    } finally {
      setWriting(false);
    }
  };

  const [learning, setLearning] = useState(false);
  const learn = async () => {
    setLearning(true);
    try {
      const r = await learnStyle(user);
      toast.push(
        r.ok
          ? { text: `Learned your voice from ${r.learnedFrom} messages. Your tuning is kept.`, tone: 'good' }
          : { text: r.reason, ttl: 8000 },
      );
    } finally {
      setLearning(false);
    }
  };

  const info = coachTypeInfo(type);
  const overLimit = info.maxChars
    ? shown.chars > info.maxChars
    : info.maxWords
      ? shown.words > info.maxWords
      : false;

  return (
    <div className="max-w-[720px] min-w-0" data-testid="outreach-coach">
      {/* what it is, where the style came from */}
      <section className="pb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-medium">Outreach coach</h2>
          <span className="text-[12px] text-ink-3" data-testid="coach-provenance">
            {provenance(card)}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          See how each kind of message sounds, tell the coach what to change, and fix what it finds in the
          messages you sent.
        </p>
      </section>

      <Tabs
        value={type}
        onChange={(t) => setType(t)}
        items={COACH_TYPES.map((t) => ({ value: t.id, label: t.label, count: counts[t.id] || undefined }))}
      />
      <p className="-mt-2 mb-3 text-[12.5px] text-ink-3">{info.blurb}</p>

      {/* the sample */}
      <section
        className="rounded-[var(--radius-card)] border border-line bg-canvas shadow-[var(--shadow-card)]"
        data-testid="coach-sample"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line-2 px-4 py-2.5 text-[12px] text-ink-3">
          <span className="min-w-0 truncate">
            To {COACH_SAMPLE_RECIPIENT.name}, {COACH_SAMPLE_RECIPIENT.title} at {COACH_SAMPLE_RECIPIENT.org}
          </span>
          <span className={cx('tabular shrink-0', overLimit && 'text-warn')} data-testid="coach-sample-size">
            {info.maxChars ? `${shown.chars} / ${info.maxChars} characters` : `${shown.words} words`}
          </span>
        </div>
        {shown.subject && (
          <div className="border-b border-line-2 px-4 py-2 text-[13px]">
            <span className="text-ink-3">Subject </span>
            <span className="font-medium" data-testid="coach-sample-subject">
              {shown.subject}
            </span>
          </div>
        )}
        <pre
          className="whitespace-pre-wrap break-words px-4 py-3.5 font-sans text-[13.5px] leading-relaxed text-ink"
          data-testid="coach-sample-body"
        >
          {shown.body}
        </pre>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-2 px-4 py-2 text-[12px] text-ink-3">
          <span className="min-w-0">
            {shown === sample
              ? claudeOn
                ? 'Orbit’s template in your style. Claude also follows your length and notes.'
                : 'Orbit’s template in your style. Length and notes apply when Claude writes your drafts.'
              : 'Written by Claude in your style.'}
          </span>
          {claudeOn &&
            (shown === sample ? (
              <button
                type="button"
                className="text-accent hover:underline disabled:opacity-50"
                onClick={rewrite}
                disabled={writing}
                data-testid="coach-sample-claude"
              >
                {writing ? 'Writing…' : 'Write it with Claude'}
              </button>
            ) : (
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => setClaude(undefined)}
              >
                Show the template
              </button>
            ))}
        </div>
      </section>

      {/* feedback */}
      <section className="pt-6" data-testid="coach-feedback">
        <form onSubmit={submit}>
          <label htmlFor="coach-feedback" className="text-[13.5px] font-medium">
            Tell your coach what to change
          </label>
          <Textarea
            id="coach-feedback"
            rows={2}
            className="mt-2"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void say(text);
              }
            }}
            placeholder={`e.g. shorter, and never say "I hope this email finds you well"`}
            data-testid="coach-feedback-input"
          />
          <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {FEEDBACK_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => void say(c)}
                  disabled={busy}
                  className="h-7 rounded-full border border-line px-2.5 text-[12.5px] text-ink-2 hover:bg-canvas-2 hover:text-ink disabled:opacity-50"
                  data-testid={`coach-chip-${c.toLowerCase().replace(/[^a-z]+/g, '-')}`}
                >
                  {c}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={!text.trim() || busy}
              data-testid="coach-apply"
            >
              {busy ? 'Tuning…' : 'Apply'}
            </Button>
          </div>
        </form>
        <ExampleMessages user={user} samples={profile?.samples ?? []} onLearn={learn} learning={learning} />
      </section>

      {/* the tuning log */}
      <TuningLog user={user} log={log} />

      {/* the review */}
      <section className="mt-6 border-t border-line-2 pt-6" data-testid="coach-review">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-medium">Coach’s review</h2>
          {review.basis === 'sent' && (
            <span className="text-[12.5px] text-ink-2 tabular" data-testid="coach-reply-rate">
              {review.sent} {noun(type, review.sent)} sent · {review.replied} replied
              {review.replyRate !== undefined && ` (${Math.round(review.replyRate * 100)}%)`}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12.5px] text-ink-3">
          {review.basis === 'sample'
            ? `You haven’t sent a ${noun(type)} from Orbit yet, so this reviews the sample above.`
            : review.sent < 5
              ? 'Too few sent to read much into the reply rate yet. The notes below still apply.'
              : `Every ${noun(type)} you sent from Orbit, read the way an expert cold outreacher would.`}
        </p>

        {review.findings.length === 0 ? (
          <p className="mt-4 flex items-start gap-2 text-[13px] text-ink-2" data-testid="coach-all-good">
            <Check size={15} className="mt-0.5 shrink-0 text-good" />
            Nothing to fix. {review.basis === 'sample' ? 'This sample follows' : 'These follow'} what gets
            replies: short, a reason to write to them, and one small ask.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line-2">
            {review.findings.map((f) => (
              <FindingRow
                key={f.id}
                f={f}
                total={review.basis === 'sent' ? review.sent : 0}
                done={!!f.fix && !applyStyleChange(card, f.fix.change, user.firstName)}
                onFix={() => fix(f)}
              />
            ))}
          </ul>
        )}
        {review.strengths.length > 0 && review.findings.length > 0 && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            Working: {review.strengths.map((s) => s.toLowerCase()).join(', ')}.
          </p>
        )}
      </section>

      {/* start over */}
      <section className="mt-6 border-t border-line-2 pt-4 text-[12px] text-ink-3">
        <span className="mr-1">Start over from</span>
        {(['warm', 'direct', 'formal'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className="h-7 rounded-full px-2.5 capitalize hover:bg-canvas-2 hover:text-ink"
            onClick={async () => {
              if (
                (card.custom || card.builtFromCount > 0) &&
                !confirm(`Start over from the ${p} style? Your "never say" list and notes stay.`)
              )
                return;
              await applyStylePreset(user, p);
            }}
            data-testid={`coach-preset-${p}`}
          >
            {p}
          </button>
        ))}
      </section>
    </div>
  );
}

function FindingRow({
  f,
  total,
  done,
  onFix,
}: {
  f: CoachFinding;
  total: number;
  done: boolean;
  onFix: () => void;
}) {
  const dot = { high: 'bg-bad', medium: 'bg-warn', low: 'bg-ink-3' }[f.severity];
  return (
    <li className="py-3.5" data-testid={`coach-finding-${f.id}`}>
      <div className="flex items-start gap-2.5">
        <span className={cx('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', dot)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-[13.5px] font-medium">{f.title}</span>
            {total > 1 && (
              <span className="text-[12px] text-ink-3 tabular">
                in {f.count} of {total}
              </span>
            )}
          </div>
          {f.quote && (
            <blockquote className="mt-1.5 border-l-2 border-line pl-3 text-[13px] italic leading-relaxed text-ink-2 break-words">
              {f.quote}
            </blockquote>
          )}
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">{f.why}</p>
          {f.fix &&
            (done ? (
              <span className="mt-2 inline-flex items-center gap-1 text-[12px] text-good">
                <Check size={13} /> In your style now
              </span>
            ) : (
              <Button size="sm" className="mt-2" onClick={onFix} data-testid={`coach-fix-${f.id}`}>
                Fix this: {f.fix.label}
              </Button>
            ))}
        </div>
      </div>
    </li>
  );
}

function TuningLog({ user, log }: { user: User; log: StyleTuningEntry[] }) {
  const [all, setAll] = useState(false);
  if (!log.length) return null;
  const shown = all ? log : log.slice(0, LOG_PREVIEW);
  return (
    <section className="mt-6 border-t border-line-2 pt-5" data-testid="coach-log">
      <h3 className="text-[13.5px] font-medium">Tuning log</h3>
      <ul className="mt-2 divide-y divide-line-2">
        {shown.map((e) => (
          <li
            key={e.id}
            className={cx(
              'flex items-start justify-between gap-3 py-2 text-[13px]',
              e.undoneAt && 'text-ink-3',
            )}
            data-testid="coach-log-entry"
          >
            <span className={cx('min-w-0 break-words', e.undoneAt && 'line-through')}>
              <span className="text-ink-3">{BY_WORDS[e.by]}: </span>
              {e.by === 'coach' ? e.said : `“${e.said}”`}
              <span className="text-ink-3"> → </span>
              {e.summary}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
              <span className="hidden sm:inline">{relDate(e.at)}</span>
              {e.undoneAt ? (
                'Undone'
              ) : (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => undoStyleTuning(user, e.id)}
                  data-testid="coach-log-undo"
                >
                  Undo
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {log.length > LOG_PREVIEW && (
        <button
          type="button"
          className="mt-1 text-[12px] text-ink-3 hover:text-ink"
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show fewer' : `Show all ${log.length}`}
        </button>
      )}
    </section>
  );
}

/** Teaching by example: paste a message they wrote, or learn again from everything they sent. */
function ExampleMessages({
  user,
  samples,
  onLearn,
  learning,
}: {
  user: User;
  samples: string[];
  onLearn: () => void;
  learning: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [paste, setPaste] = useState('');
  useEffect(() => {
    if (!open) setPaste('');
  }, [open]);
  return (
    <div className="mt-3 text-[12.5px] text-ink-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          className="hover:text-ink"
          onClick={() => setOpen((v) => !v)}
          data-testid="coach-paste-open"
        >
          {open
            ? 'Close examples'
            : `+ Paste a message you wrote${samples.length ? ` (${samples.length})` : ''}`}
        </button>
        <button
          type="button"
          className="hover:text-ink disabled:opacity-50"
          onClick={onLearn}
          disabled={learning}
          data-testid="coach-learn"
        >
          {learning ? 'Learning…' : 'Learn from my sent messages'}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <Textarea
            rows={4}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste an email or LinkedIn message you wrote and liked"
            aria-label="Paste an example message"
            data-testid="coach-paste"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!paste.trim()}
              onClick={async () => {
                const r = await addStyleSample(user, paste);
                if (!r.ok) return toast.push({ text: r.reason });
                setPaste('');
                toast.push({ text: 'Added. Press "Learn from my sent messages" to use it.', tone: 'good' });
              }}
              data-testid="coach-paste-add"
            >
              Add example
            </Button>
          </div>
          {samples.map((s, i) => (
            <div key={s} className="flex items-start gap-2 text-ink-2">
              <span className="line-clamp-2 flex-1">{s}</span>
              <button
                type="button"
                className="text-ink-3 hover:text-ink"
                onClick={() => removeStyleSample(user.id, i)}
                aria-label="Remove this example"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
