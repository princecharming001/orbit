/**
 * Plan 44 §2.6: the plan for a posting gains how well the student fits it, from the same scoring as Roles. A job link
 * in the chat still goes to one card (plan_for_posting); this line sits on it while Roles is on. The score is kept
 * with the role, so a reload reads it again without asking the server.
 */
import type { RoleMatch } from '@orbit/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FitBar } from '../../../components/roles/parts';
import { useFeature } from '../../../engine/features';
import { BAND_WORDS, keptMatches, partWords, scorePosting } from '../../../engine/roles';
import { useSession } from '../../../state/session';

const sameUrl = (a?: string, b?: string) =>
  !!a &&
  !!b &&
  a
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase() ===
    b
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();

export function PlanFit({ url }: { url?: string }) {
  const { userId } = useSession();
  const on = useFeature('roles', userId);
  const [state, setState] = useState<{ match?: RoleMatch; problem?: string; loading: boolean }>({
    loading: true,
  });
  useEffect(() => {
    if (!on || !userId || !url) return;
    let live = true;
    void (async () => {
      const had = (await keptMatches(userId)).find((r) => sameUrl(r.match.job.url, url))?.match;
      if (had?.fit) {
        if (live) setState({ match: had, loading: false });
        return;
      }
      const r = await scorePosting({ id: userId }, { url });
      if (live) setState(r.ok ? { match: r.match, loading: false } : { problem: r.message, loading: false });
    })();
    return () => {
      live = false;
    };
  }, [on, userId, url]);
  if (!on || !url) return null;
  if (state.loading)
    return (
      <p className="mb-2 text-[12.5px] text-ink-3" data-testid="plan-fit-loading">
        Reading how well you fit it…
      </p>
    );
  const m = state.match;
  if (!m?.fit)
    return state.problem ? (
      <p className="mb-2 text-[12.5px] text-ink-3" data-testid="plan-fit-problem">
        {/profile/i.test(state.problem) ? (
          <>
            How well you fit it shows once Orbit has read your profile on{' '}
            <Link to="/roles" className="underline underline-offset-4 hover:text-ink">
              Roles
            </Link>
            .
          </>
        ) : (
          state.problem
        )}
      </p>
    ) : null;
  const f = m.fit;
  const parts = partWords(m);
  return (
    <div
      className="mb-2 max-w-[560px] rounded-[10px] border border-line bg-canvas px-3.5 py-3"
      data-testid="plan-fit"
    >
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-medium tabular-nums" data-testid="plan-fit-score">
          {f.score}
        </span>
        <FitBar score={f.score} />
        <span className="text-[13px] text-ink-2">{BAND_WORDS[f.band]}</span>
        <Link
          to={`/roles?role=${encodeURIComponent(m.id)}`}
          className="ml-auto text-[12.5px] text-ink-3 underline decoration-line underline-offset-4 hover:text-ink"
        >
          Why
        </Link>
      </div>
      {(f.caps[0]?.label ?? m.reason) && (
        <p
          className={f.caps.length ? 'mt-1 text-[12.5px] text-bad' : 'mt-1 text-[12.5px] text-ink-2'}
          data-testid="plan-fit-reason"
        >
          {f.caps[0]?.label ?? m.reason}
        </p>
      )}
      <ul className="mt-1.5 space-y-0.5 text-[12px] leading-snug text-ink-3">
        {parts
          .filter((p) => p.value !== undefined)
          .map((p) => (
            <li key={p.part}>
              <span className="text-ink-2">{p.name}:</span> {p.words}
            </li>
          ))}
      </ul>
    </div>
  );
}
