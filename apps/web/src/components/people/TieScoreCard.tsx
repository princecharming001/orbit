import type { Person, TieBand } from '@orbit/core';
import { TIE_BAND_LABELS } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../../db/schema';
import {
  type Closeness,
  explainScore,
  rateCloseness,
  type ScoreView,
  scoreViewOf,
} from '../../engine/closeness';
import { isServerUser } from '../../integrations/orbitApi';
import { Card, cx, useToast } from '../../ui';
import { ClosenessPicker } from '../account/ClosenessPicker';

const BANDS: TieBand[] = ['faint', 'light', 'warm', 'strong', 'close'];

/**
 * The score as five equal steps (Faint, Light, Warm, Strong, Close: 20 points each), filled up to it, with the step
 * it falls in named underneath.
 */
function ScoreMeter({ score, band }: { score: number; band: TieBand }) {
  const s = Math.max(0, Math.min(100, score));
  return (
    <div className="mt-3" aria-hidden data-testid="person-score-meter">
      <div className="grid grid-cols-5 gap-1">
        {BANDS.map((b, i) => {
          const fill = Math.max(0, Math.min(1, (s - i * 20) / 20));
          return (
            <div key={b} className="h-1.5 overflow-hidden rounded-full bg-canvas-2">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
                style={{ width: `${fill * 100}%`, opacity: 0.45 + i * 0.13 }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-1 text-[10.5px]">
        {BANDS.map((b) => (
          <span key={b} className={cx(b === band ? 'font-medium text-ink' : 'text-ink-3')}>
            {TIE_BAND_LABELS[b]}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The tie score on the person page (plan 16 §3.3): "78 · Strong", the sentences behind it, and "Not right?" to rate
 * the tie yourself. Account mode asks orbit-api for the explanation; local mode reads what the browser computed.
 */
export function TieScoreCard({ person, userId }: { person: Person; userId: string }) {
  const toast = useToast();
  const label = useLiveQuery(() => db.tieLabels.get(person.id), [person.id]);
  const [server, setServer] = useState<ScoreView>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const account = isServerUser(userId);
  useEffect(() => {
    if (!account) return;
    let live = true;
    explainScore({ id: userId }, person.id).then((r) => {
      if (live && r.ok) setServer(r.view);
    });
    return () => {
      live = false;
    };
  }, [account, userId, person.id, label?.closeness]);
  const v = server && server.labelled === label?.closeness ? server : scoreViewOf(person, label ?? undefined);
  const pick = async (c: Closeness) => {
    setBusy(true);
    try {
      const r = await rateCloseness({ id: userId }, person.id, c);
      if (!r.ok) {
        toast.push({ text: r.message, tone: 'neutral' });
        return;
      }
      setServer(r.view);
      setAsking(false);
      toast.push({ text: `Thanks. ${person.firstName || 'Their'} closeness now reads ${r.view.label}.` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="person-score-card">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-medium">How close you are</div>
        <div className="text-[15px] font-semibold tabular-nums" data-testid="person-score">
          {v.label}
        </div>
      </div>
      <ScoreMeter score={v.score} band={v.band} />
      {v.explanation.length ? (
        <ul className="mt-2 space-y-1 text-[13px] text-ink-2 leading-relaxed" data-testid="person-score-why">
          {v.explanation.slice(0, 5).map((t, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[13px] text-ink-3">Orbit has little history with them yet.</p>
      )}
      {asking ? (
        <div className="mt-3">
          <p className="text-[12.5px] text-ink-3 mb-2">How close are you, really?</p>
          <ClosenessPicker name={person.displayName} value={label?.closeness} onPick={pick} disabled={busy} />
        </div>
      ) : (
        <button
          type="button"
          className="mt-3 text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
          onClick={() => setAsking(true)}
          data-testid="person-score-not-right"
        >
          Not right?
        </button>
      )}
    </Card>
  );
}
