/**
 * Settings, Voice (plan 29 §B1, §B5): how Orbit writes as the student. The style card as plain sentences, the own
 * words from setup that drafts draw on, what Orbit learned from their edits (one line each, with Keep and Forget; a
 * forgotten note is never learned again), how much the recent drafts sound like them, and "Relearn from my sent mail".
 * The same page in both modes: an account reads the server's notes, local mode this browser's own.
 */
import { AudioLines } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SettingsCard, SettingsHeader, SettingsStack } from '../../components/settings/kit';
import { decideNote, readVoice, relearnVoice, type VoiceView } from '../../engine/voice';
import { useSession } from '../../state/session';
import { Button, relDate, Spinner, useToast } from '../../ui';

/** "2.6 of 3" and what it means, in plain words. */
function scoreWords(score: number | null): { value: string; line: string } {
  if (score === null)
    return {
      value: 'Not yet',
      line: 'Orbit scores this once it has written a few drafts for you.',
    };
  const line =
    score >= 2.5
      ? 'Your recent drafts read like the mail you send.'
      : score >= 1.5
        ? 'Most of your recent drafts read like you; a few drifted.'
        : 'Your recent drafts often did not read like you. Orbit holds those for your tap.';
  return { value: `${score.toFixed(1)} of 3`, line };
}

export function VoiceSection() {
  const { user } = useSession();
  const toast = useToast();
  const [view, setView] = useState<VoiceView>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    if (!user) return;
    setView(await readVoice(user));
  }, [user]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!user) return null;

  const decide = async (id: string, action: 'keep' | 'forget') => {
    setBusy(id);
    const r = await decideNote(user.id, id, action);
    setBusy(undefined);
    if (!r.ok) {
      toast.push({ text: r.message, tone: 'bad' });
      return;
    }
    setView((v) =>
      v
        ? {
            ...v,
            notes:
              action === 'forget'
                ? v.notes.filter((n) => n.id !== id)
                : v.notes.map((n) => (n.id === id ? r.note : n)),
          }
        : v,
    );
    toast.push({
      text:
        action === 'forget' ? 'Forgotten. Orbit will not learn that again.' : 'Kept. Your drafts follow it.',
    });
  };

  const relearn = async () => {
    setBusy('relearn');
    const r = await relearnVoice(user);
    setBusy(undefined);
    toast.push({ text: r.message, tone: r.ok ? undefined : 'bad' });
    if (r.ok) await load();
  };

  const score = scoreWords(view?.soundsLikeYou ?? null);
  return (
    <>
      <SettingsHeader
        title="Voice"
        description="How Orbit writes as you: your style in plain sentences, your own words from setup, and what it learned from the drafts you changed."
      />
      {!view ? (
        <Spinner />
      ) : (
        <SettingsStack>
          <SettingsCard
            title="Your style"
            description="Every draft follows this, and nothing goes out on its own unless it sounds like it."
            aside={
              <Link to="/settings/style" className="text-[12.5px] text-ink-2 underline underline-offset-2">
                Change it
              </Link>
            }
            data-testid="voice-card"
            footer={
              <>
                <p className="mr-auto text-[12px] text-ink-3" data-testid="voice-relearned">
                  {view.relearnedAt ? `Last learned ${relDate(view.relearnedAt)}.` : 'Learned as you send.'}
                </p>
                <Button
                  size="sm"
                  onClick={relearn}
                  loading={busy === 'relearn'}
                  disabled={!!busy}
                  data-testid="voice-relearn"
                >
                  Relearn from my sent mail
                </Button>
              </>
            }
          >
            <ul className="px-5 py-4 space-y-1.5">
              {view.cardProse.map((line) => (
                <li key={line} className="text-[13.5px] text-ink">
                  {line}
                </li>
              ))}
            </ul>
          </SettingsCard>

          <SettingsCard title="Sounds like you" data-testid="voice-score">
            <div className="px-5 py-4 flex items-baseline gap-3">
              <span className="shrink-0 whitespace-nowrap text-[19px] font-semibold tabular-nums text-ink">
                {score.value}
              </span>
              <span className="text-[12.5px] text-ink-3">{score.line}</span>
            </div>
          </SettingsCard>

          <SettingsCard
            title="What Orbit learned from your edits"
            description="Each time you change a draft before it goes, Orbit notes what you changed. Keep what is right; forget what is not and it is never learned again."
            aside={
              view.edits ? (
                <span className="text-[12px] text-ink-3">
                  {view.edits} {view.edits === 1 ? 'edit' : 'edits'} so far
                </span>
              ) : undefined
            }
            data-testid="voice-notes"
          >
            {!view.notes.length ? (
              <div className="px-5 py-8 text-center" data-testid="voice-notes-empty">
                <AudioLines size={20} strokeWidth={1.5} className="mx-auto text-ink-3" aria-hidden />
                <p className="mt-2 text-[13.5px] font-medium">Nothing yet</p>
                <p className="mt-1 text-[12.5px] text-ink-3 max-w-sm mx-auto">
                  After a few drafts you change before sending, what your edits show appears here, one line
                  each.
                </p>
              </div>
            ) : (
              view.notes.map((n) => (
                <div
                  key={n.id}
                  className="px-5 py-3 flex flex-wrap items-center gap-3"
                  data-testid="voice-note"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] text-ink">{n.text}</div>
                    <div className="mt-0.5 text-[12px] text-ink-3">
                      {n.keptAt ? 'Kept' : 'Learned'} · from {n.evidence.length}{' '}
                      {n.evidence.length === 1 ? 'edit' : 'edits'}
                    </div>
                  </div>
                  {!n.keptAt && (
                    <Button
                      size="sm"
                      variant="subtle"
                      aria-label={`Keep: ${n.text}`}
                      loading={busy === n.id}
                      disabled={!!busy}
                      onClick={() => decide(n.id, 'keep')}
                    >
                      Keep
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-ink-3 hover:text-bad hover:bg-bad-soft"
                    aria-label={`Forget: ${n.text}`}
                    disabled={!!busy}
                    onClick={() => decide(n.id, 'forget')}
                  >
                    Forget
                  </Button>
                </div>
              ))
            )}
          </SettingsCard>

          <SettingsCard
            title="Your own words"
            description="What you wrote about yourself in setup. Drafts draw on it so they say what you would."
            aside={
              <Link to="/settings/goals" className="text-[12.5px] text-ink-2 underline underline-offset-2">
                Edit
              </Link>
            }
            data-testid="voice-own-words"
          >
            {!view.ownWords.length ? (
              <p className="px-5 py-4 text-[13px] text-ink-3">
                Nothing yet. Answer a question or two in Goals and your drafts start to sound more like you.
              </p>
            ) : (
              view.ownWords.map((w) => (
                <div key={w.key} className="px-5 py-3">
                  <div className="text-[12px] text-ink-3">{w.label}</div>
                  <div className="mt-0.5 text-[13.5px] text-ink whitespace-pre-line">{w.text}</div>
                </div>
              ))
            )}
          </SettingsCard>
        </SettingsStack>
      )}
    </>
  );
}
