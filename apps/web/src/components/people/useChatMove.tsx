import type { CalendarEvent, ChatStage, CoffeeChat, Person } from '@orbit/core';
import { STAGE_LABELS } from '@orbit/core';
import { type ReactNode, useRef, useState } from 'react';
import { db } from '../../db/schema';
import { moveChatGuarded, undoStageMove } from '../../engine/pipeline';
import { useSession } from '../../state/session';
import { useToast } from '../../ui';
import { ConfirmEarlyDone, ScheduleChatDialog } from '../ScheduleChat';

/**
 * Moving a chat to another stage from the board or the list: the move itself, the toast that says what happened
 * (with Undo), and the two questions a move can raise. A chat moved to Scheduled asks when, unless a calendar already
 * says so; a chat whose meeting is still ahead asks before it is marked done. Render `dialogs` once on the page.
 */
export function useChatMove({
  byId,
  meetingFor,
}: {
  byId: Map<string, Person>;
  meetingFor: (chat: CoffeeChat) => CalendarEvent | undefined;
}): {
  move: (chat: CoffeeChat, to: ChatStage, sure?: boolean) => Promise<void>;
  setTime: (chat: CoffeeChat) => void;
  dialogs: ReactNode;
} {
  const { user } = useSession();
  const toast = useToast();
  const [asking, setAsking] = useState<CoffeeChat>();
  // a chat whose meeting is still ahead, about to be marked done: asked first
  const [early, setEarly] = useState<{ chat: CoffeeChat; at: string }>();
  // chats whose move is still being worked on: a second drop or pick of the same card is ignored, other cards move
  const moving = useRef(new Set<string>());
  const move = async (chat: CoffeeChat, to: ChatStage, sure = false) => {
    if (chat.stage === to || !user || moving.current.has(chat.id)) return;
    moving.current.add(chat.id);
    const first = byId.get(chat.personId)?.firstName;
    // the card changes column at once, but the draft the new stage brings takes Claude a few seconds: say so
    const working = toast.push({
      // (Completed drafts a thank-you only from a note, so it says no more than the move)
      text:
        to === 'replied'
          ? `Writing your reply to ${first ?? 'them'}…`
          : `Moving ${first ?? 'the chat'} to ${STAGE_LABELS[to]}…`,
      working: true,
      sticky: true,
    });
    try {
      const r = await moveChatGuarded(user, chat, to, 'user:drag', { force: sure });
      if (r.outcome === 'meeting_ahead') {
        setEarly({ chat, at: r.meetingAt });
        return;
      }
      if (r.outcome !== 'applied') return;
      const from = r.from;
      const name = first ?? 'This chat';
      // booked: ask when, unless a calendar already says so
      if (r.needsTime) {
        const fresh = await db.chats.get(chat.id);
        if (fresh) setAsking(fresh);
      }
      const thanks =
        to === 'completed'
          ? await db.suggestions
              .where('chatId')
              .equals(chat.id)
              .filter((x) => x.kind === 'thank_you' && x.status === 'pending')
              .first()
          : undefined;
      toast.push({
        text: `Moved ${name} to ${STAGE_LABELS[to]}.${
          to === 'completed'
            ? thanks
              ? ' Your thank-you draft is in Drafts.'
              : ' Add a note about the chat and Orbit drafts your thank-you from it.'
            : to === 'replied'
              ? ' Your reply is in Drafts.'
              : ''
        }`,
        action: {
          label: 'Undo',
          onClick: () => undoStageMove(chat.id, from),
        },
        ttl: 6000,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      toast.push({ text: m && m.length < 160 ? m : 'That move did not go through. Try again.', tone: 'bad' });
    } finally {
      toast.dismiss(working);
      moving.current.delete(chat.id);
    }
  };
  const dialogs = (
    <>
      {asking && (
        <ScheduleChatDialog
          key={asking.id}
          chat={asking}
          firstName={byId.get(asking.personId)?.firstName ?? 'them'}
          current={meetingFor(asking)?.startAt}
          onClose={() => setAsking(undefined)}
        />
      )}
      {early && (
        <ConfirmEarlyDone
          firstName={byId.get(early.chat.personId)?.firstName ?? 'them'}
          at={early.at}
          onClose={() => setEarly(undefined)}
          onConfirm={() => {
            const c = early.chat;
            setEarly(undefined);
            move(c, 'completed', true);
          }}
        />
      )}
    </>
  );
  return { move, setTime: setAsking, dialogs };
}
