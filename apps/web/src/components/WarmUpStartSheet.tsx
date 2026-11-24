/**
 * The start sheet of an automated LinkedIn warm-up: the whole plan in plain words, the comment Orbit drafted (editable,
 * or left out with a switch) and one Start button. Orbit's privacy policy promises nothing is posted from the
 * student's accounts without their approval of the exact words, so the text in the box when Start is pressed is the
 * text that is sent to the server and the only text ever posted; nothing is asked after Start.
 *
 * Mounted once in the app shell and opened through state/warmUpSheet.ts.
 */
import {
  approvedCommentError,
  autoPlanLines,
  type CoffeeChat,
  type Person,
  WARMUP_AUTO_CAPS,
  type WarmUpPreview,
} from '@orbit/core';
import { useEffect, useRef, useState } from 'react';
import { db } from '../db/schema';
import { startWarmUpOrOutreach } from '../engine/brief';
import { type AutoWarmUpMode, previewAutoWarmUp, startAutoWarmUp } from '../engine/warmupAuto';
import { useSession } from '../state/session';
import { closeWarmUpSheet, useWarmUpSheet, type WarmUpSheetRequest } from '../state/warmUpSheet';
import { Button, Modal, Switch, Textarea, useToast, Working } from '../ui';

type View =
  | { step: 'loading' }
  | { step: 'refused'; message: string; retry: boolean }
  | { step: 'ready'; preview: WarmUpPreview; mode: AutoWarmUpMode };

export function WarmUpStartSheet() {
  const req = useWarmUpSheet();
  // a new request is a new sheet: nothing typed for one person is ever shown for another
  return req ? <Sheet key={`${req.personId}:${req.source}`} req={req} /> : null;
}

function Sheet({ req }: { req: WarmUpSheetRequest }) {
  const { user } = useSession();
  const toast = useToast();
  const [person, setPerson] = useState<Person>();
  const [view, setView] = useState<View>({ step: 'loading' });
  const [text, setText] = useState('');
  const [include, setInclude] = useState(true);
  const [busy, setBusy] = useState<'start' | 'manual'>();
  const [problem, setProblem] = useState<string>();
  const alive = useRef(true);
  const now = useRef(new Date());

  const load = async () => {
    if (!user) return;
    setView({ step: 'loading' });
    setProblem(undefined);
    const p = await db.people.get(req.personId);
    if (!alive.current) return;
    setPerson(p);
    const r = await previewAutoWarmUp(user, req.personId);
    if (!alive.current) return;
    if (!r.ok) {
      setView({
        step: 'refused',
        message: r.message,
        retry: r.reason === 'busy' || r.reason === 'error' || r.reason === 'unknown_person',
      });
      return;
    }
    now.current = new Date();
    setText(r.preview.comment ?? '');
    setInclude(!!r.preview.post && !!r.preview.comment);
    setView({ step: 'ready', preview: r.preview, mode: r.mode });
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  if (!user) return null;
  const first = person?.firstName || 'them';
  const close = () => {
    if (!busy) closeWarmUpSheet();
  };
  const started = (chat: CoffeeChat, words: string) => {
    toast.push({ text: words, tone: 'good', ttl: 6000 });
    closeWarmUpSheet();
    req.onStarted?.(chat);
  };

  /** The steps by hand instead, as before: reminders with links. */
  const manual = async () => {
    setBusy('manual');
    try {
      const r = await startWarmUpOrOutreach(user, req.personId, 'linkedin', req.source);
      if (r.chat) started(r.chat, `Warm-up started for ${first}. The first step is in Drafts.`);
      else closeWarmUpSheet();
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const start = async () => {
    if (view.step !== 'ready') return;
    const withComment = !!view.preview.post && include;
    if (withComment) {
      const wrong = approvedCommentError(text);
      if (wrong) {
        setProblem(wrong);
        return;
      }
    }
    setBusy('start');
    setProblem(undefined);
    try {
      // the words in the box, as they are: this is the text the student approved
      const r = await startAutoWarmUp(user, view.preview, withComment ? text : null, req.source);
      if (!alive.current) return;
      if (!r.ok) {
        setProblem(r.message);
        return;
      }
      started(r.chat, `Warm-up started for ${first}. Orbit runs it and tells you when it is done.`);
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const title = `Warm up to ${first}`;
  if (view.step === 'loading')
    return (
      <Modal open onClose={close} title={title}>
        <p className="flex items-center gap-2 text-[13.5px] text-ink-2" data-testid="warmup-sheet-loading">
          <Working />
          Reading what {first} posted lately.
        </p>
      </Modal>
    );
  if (view.step === 'refused')
    return (
      <Modal open onClose={close} title={title}>
        <div className="space-y-3 text-[13.5px] text-ink-2" data-testid="warmup-sheet-refused">
          <p>{view.message}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {view.retry && (
              <Button variant="primary" onClick={() => void load()} data-testid="warmup-sheet-retry">
                Try again
              </Button>
            )}
            <Button
              onClick={() => void manual()}
              loading={busy === 'manual'}
              data-testid="warmup-sheet-manual"
            >
              Do the steps myself
            </Button>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    );

  const { preview, mode } = view;
  const hasPost = !!preview.post;
  const withComment = hasPost && include;
  const lines = autoPlanLines({
    firstName: person?.firstName ?? '',
    steps: preview.steps.filter((s) => withComment || s.kind !== 'comment_post'),
    postExcerpt: preview.post?.excerpt,
    now: now.current,
    tz: preview.timezone || user.timezone,
  });
  const left = WARMUP_AUTO_CAPS.commentMaxChars - text.length;
  return (
    <Modal open onClose={close} title={title} keepOnBackdrop width={560}>
      <div className="space-y-4 text-[13.5px] text-ink-2" data-testid="warmup-sheet">
        <p>
          Orbit does these steps from your LinkedIn, on working days, a few days apart. After Start there is
          nothing left for you to do.
        </p>
        <ol className="space-y-1.5" data-testid="warmup-plan">
          {lines.map((l) => (
            <li key={l.kind} data-testid={`warmup-plan-${l.kind}`}>
              <span className="font-medium text-ink">{l.day}:</span> {l.text}
            </li>
          ))}
        </ol>
        {!hasPost && (
          <p className="text-ink-3" data-testid="warmup-no-post">
            {first} has not posted lately, so this warm-up is the profile view only.
          </p>
        )}
        {hasPost && (
          <div className="rounded-lg bg-canvas-2 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink" id="warmup-comment-label">
                Leave a comment
              </span>
              <Switch
                checked={include}
                onChange={(on) => {
                  setInclude(on);
                  setProblem(undefined);
                }}
                label="Leave a comment"
                data-testid="warmup-comment-switch"
              />
            </div>
            {include ? (
              <>
                <Textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setProblem(undefined);
                  }}
                  rows={4}
                  aria-labelledby="warmup-comment-label"
                  placeholder="Write your comment here"
                  data-testid="warmup-comment-text"
                />
                <p className="text-[12px] text-ink-3 flex justify-between gap-3">
                  <span>
                    {preview.comment
                      ? 'Orbit posts exactly these words. Edit them until they sound like you.'
                      : 'Orbit could not write a comment for this post. Write one here, or leave it out.'}
                  </span>
                  <span className={left < 0 ? 'text-bad' : undefined} data-testid="warmup-comment-left">
                    {left}
                  </span>
                </p>
              </>
            ) : (
              <p className="text-[12px] text-ink-3" data-testid="warmup-comment-off">
                No comment will be posted. Orbit views the profile and likes the post.
              </p>
            )}
          </div>
        )}
        <p className="text-ink-3">
          When the last step has run, Orbit tells you and offers your first message. The message itself waits
          for your Send. You can stop the warm-up at any time.
        </p>
        {mode === 'demo' && (
          <p className="text-[12px] text-ink-3" data-testid="warmup-sheet-demo">
            This is the sample student. Nothing is posted anywhere.
          </p>
        )}
        {problem && (
          <p className="text-bad text-[13px]" role="alert" data-testid="warmup-sheet-problem">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="primary"
            onClick={() => void start()}
            loading={busy === 'start'}
            disabled={!!busy}
            data-testid="warmup-start"
          >
            Start
          </Button>
          <Button variant="ghost" onClick={close} disabled={!!busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
