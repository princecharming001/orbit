import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../db/schema';
import { clockOf } from '../engine/chatsView';
import { useFlag } from '../engine/flags';
import { useSession } from '../state/session';

/**
 * The chat home's line for today's next coffee chat (plan 23 §4.4): "Chat with Dana at 3:00 pm · Prep", one tap into
 * the prep. Nothing when there is no chat left today.
 */
export function NextChatLine() {
  const { user, userId } = useSession();
  const on = useFlag('chatsView');
  const next = useLiveQuery(async () => {
    if (!userId) return undefined;
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const ev = (
      await db.events
        .where('startAt')
        .between(now.toISOString(), end.toISOString(), true, true)
        .filter((e) => e.userId === userId && e.status !== 'cancelled' && (!!e.isCoffeeChat || !!e.chatId))
        .toArray()
    ).sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    if (!ev) return undefined;
    const chat = ev.chatId ? await db.chats.get(ev.chatId) : undefined;
    const person = await db.people.get(chat?.personId ?? ev.attendeePersonIds[0] ?? '');
    return person ? { person, at: ev.startAt } : undefined;
  }, [userId]);
  if (!on || !next || !user) return null;
  const tz = user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <p className="text-center text-[14px] text-ink-3 -mt-2 mb-4" data-testid="home-next-chat">
      Chat with {next.person.firstName || next.person.displayName} at {clockOf(next.at, tz)} ·{' '}
      <Link
        to={`/people/${next.person.id}?tab=facts&prep=1`}
        className="text-ink underline decoration-[#cfcdc9] underline-offset-4 hover:decoration-ink"
      >
        Prep
      </Link>
    </p>
  );
}
