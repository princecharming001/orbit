/**
 * Your chats (plan 23 §4.4), phone first: the week's coffee chats by day with Join and Prep, the ones agreed to with no
 * time yet, and what came back from the ones that just happened (the notes, the facts, the thank-you, or that the
 * notetaker has nothing). Opening the page asks the notetaker about chats that just ended (engine/notesCheck.ts).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, Video } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PersonRow } from '../components/PersonRow';
import { db } from '../db/schema';
import {
  afterText,
  CHATS_AHEAD_MS,
  CHATS_BACK_MS,
  type ChatRow,
  clockOf,
  upcomingChats,
} from '../engine/chatsView';
import { useFlag } from '../engine/flags';
import { checkNotes, connectedNotetaker } from '../engine/notesCheck';
import { useSession } from '../state/session';
import { Button, Card, cx, PageHeader, Spinner } from '../ui';

/** Everything the view reads, live, so a note landing or a time booked updates the page at once. */
export function useChatsView() {
  const { user, userId } = useSession();
  const tz = user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // the minute ticks: "Waiting for Fathom's notes" turns into "no recording" two hours after the end
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return useLiveQuery(async () => {
    if (!userId) return undefined;
    const t = Date.now();
    const [events, chats, people, notes, facts, suggestions, messages, taker] = await Promise.all([
      db.events
        .where('userId')
        .equals(userId)
        .filter((e) => {
          const s = Date.parse(e.startAt);
          return s >= t - CHATS_BACK_MS && s <= t + CHATS_AHEAD_MS;
        })
        .toArray(),
      db.chats.where('userId').equals(userId).toArray(),
      db.people.where('userId').equals(userId).toArray(),
      db.notes
        .where('userId')
        .equals(userId)
        .filter((n) => Date.parse(n.occurredAt) >= t - 3 * CHATS_BACK_MS)
        .toArray(),
      db.facts.where('userId').equals(userId).toArray(),
      db.suggestions
        .where('userId')
        .equals(userId)
        .filter((s) => s.status === 'pending')
        .toArray(),
      db.messages
        .where('userId')
        .equals(userId)
        .filter((m) => m.direction === 'inbound')
        .toArray(),
      connectedNotetaker(userId),
    ]);
    return upcomingChats(
      { events, chats, people, notes, facts, suggestions, messages, notetaker: taker?.name },
      new Date(Math.max(t, now.getTime())),
      tz,
    );
  }, [userId, tz, now]);
}

export function ChatsPage() {
  const { user } = useSession();
  const on = useFlag('chatsView');
  const view = useChatsView();
  const tz = user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // chats that just ended: ask the notetaker now, not only on its schedule
  const justIds = useMemo(() => view?.justHappened.map((r) => r.key).join(',') ?? '', [view]);
  useEffect(() => {
    if (user && justIds) void checkNotes(user, { eventIds: justIds.split(',') });
  }, [user?.id, justIds]);
  if (!on) return <PageHeader title="Chats" subtitle="Your chats are in Drafts under Coming up for now." />;
  if (!view)
    return (
      <div className="py-20 flex justify-center">
        <Spinner />
      </div>
    );
  const empty = !view.days.length && !view.justHappened.length && !view.noTime.length;
  return (
    <div className="max-w-[760px]" data-testid="chats-page">
      <PageHeader
        title="Chats"
        subtitle="Your coffee chats this week and next, and what came back from them."
      />
      {empty && (
        <Card padded data-testid="chats-empty">
          <p className="text-[14px]">No chats booked. When someone agrees to talk, it shows up here.</p>
          <Link to="/inbox" className="inline-block mt-3">
            <Button variant="primary">Who's replied?</Button>
          </Link>
        </Card>
      )}
      {view.justHappened.length > 0 && (
        <Group title="Just happened" testId="chats-just-happened">
          {view.justHappened.map((r) => (
            <Row key={r.key} row={r} tz={tz} past />
          ))}
        </Group>
      )}
      {view.days.map((d) => (
        <Group key={d.key} title={d.label} testId="chats-day">
          {d.rows.map((r) => (
            <Row key={r.key} row={r} tz={tz} />
          ))}
        </Group>
      ))}
      {view.noTime.length > 0 && (
        <Group title="No time yet" testId="chats-no-time">
          {view.noTime.map((r) => (
            <Row key={r.key} row={r} tz={tz} />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="mb-6" data-testid={testId}>
      <h2 className="label-mono mb-1">{title}</h2>
      <ul className="divide-y divide-line-2">{children}</ul>
    </section>
  );
}

function Row({ row, tz, past }: { row: ChatRow; tz: string; past?: boolean }) {
  const [open, setOpen] = useState(false);
  const p = row.person;
  const when = row.startAt
    ? `${clockOf(row.startAt, tz)}${row.minutes ? ` · ${row.minutes} min` : ''}`
    : 'Agreed to talk, no time set';
  const lines = [
    row.lines.goal,
    row.lines.lastSaid && `Last said: “${row.lines.lastSaid}”`,
    row.lines.fact,
  ].filter((x): x is string => !!x);
  const after = row.after;
  const line =
    past && after ? (
      <span data-testid="chats-after" data-kind={after.kind}>
        <span className="text-ink-3">{when} · </span>
        {afterText(after)}
      </span>
    ) : (
      <span data-testid="chats-when">{when}</span>
    );
  const button = 'pointer-coarse:min-h-11';
  const actions = past ? (
    after?.kind === 'notes_in' ? (
      after.thankYou ? (
        <Link to="/inbox">
          <Button size="sm" variant="primary" className={button}>
            Thank-you
          </Button>
        </Link>
      ) : null
    ) : (
      <Link to={`/notes/new?person=${p.id}`}>
        <Button
          size="sm"
          variant={after?.kind === 'waiting' ? 'secondary' : 'primary'}
          className={button}
          data-testid="chats-add-note"
        >
          {after?.kind === 'waiting' ? 'Add a note' : 'Log this chat'}
        </Button>
      </Link>
    )
  ) : (
    <div className="flex items-center gap-1.5">
      {row.joinUrl && (
        <a href={row.joinUrl} target="_blank" rel="noreferrer" data-testid="chats-join">
          <Button size="sm" className={button}>
            <Video size={14} aria-hidden /> Join
          </Button>
        </a>
      )}
      {row.startAt ? (
        <Link to={`/people/${p.id}?tab=facts&prep=1`} data-testid="chats-prep">
          <Button size="sm" variant="primary" className={button}>
            Prep
          </Button>
        </Link>
      ) : (
        <Link to={`/people/${p.id}?draft=schedule`} data-testid="chats-propose">
          <Button size="sm" variant="primary" className={button}>
            Propose times
          </Button>
        </Link>
      )}
    </div>
  );
  return (
    <PersonRow
      person={p}
      testId="chats-row"
      line={line}
      action={actions}
      extra={
        lines.length > 0 && (
          <div className="pl-12">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className={cx(
                'mt-1 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink rounded',
                button,
              )}
              data-testid="chats-more"
            >
              <ChevronDown
                size={13}
                className={cx('transition-transform', open && 'rotate-180')}
                aria-hidden
              />
              {open ? 'Less' : 'Before you talk'}
            </button>
            {open && (
              <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2" data-testid="chats-lines">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )
      }
    />
  );
}
