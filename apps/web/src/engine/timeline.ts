/**
 * A person's timeline, as their page shows it. Every message stays its own touchpoint (the tie score counts each one),
 * but a back-and-forth on one channel reads as one conversation: LinkedIn messages, texts, Instagram and X DMs that
 * follow each other with no long silence fold into one row ("LinkedIn conversation with Shubh, 16 messages"), opened
 * to see each. A gap of CONVERSATION_GAP_DAYS or more starts a new conversation, and an entry on another channel in
 * between (an email, a meeting, a note) ends the one before it.
 */

export const CONVERSATION_GAP_DAYS = 3;

/** One entry as the page builds it from touchpoints and sent drafts. */
export interface TimelineEntry {
  at: string;
  text: string;
  icon: string;
  kind: string;
}

/** A row on the timeline: one entry, or a conversation of several on one channel. */
export type TimelineRow =
  | (TimelineEntry & { type: 'entry' })
  | {
      type: 'conversation';
      channel: Channel;
      /** the newest message's time (the row sorts by it) */
      at: string;
      /** the oldest message's time */
      from: string;
      icon: string;
      kind: string;
      /** "LinkedIn conversation with Shubh" */
      text: string;
      /** messages from them, and from the student */
      theirs: number;
      yours: number;
      /** every message in it, newest first */
      entries: TimelineEntry[];
    };

type Channel = 'linkedin' | 'text' | 'instagram' | 'x';

const CHANNEL_OF: Record<string, { channel: Channel; side: 'in' | 'out' }> = {
  linkedin_in: { channel: 'linkedin', side: 'in' },
  linkedin_out: { channel: 'linkedin', side: 'out' },
  text_in: { channel: 'text', side: 'in' },
  text_out: { channel: 'text', side: 'out' },
  instagram_in: { channel: 'instagram', side: 'in' },
  instagram_out: { channel: 'instagram', side: 'out' },
  x_in: { channel: 'x', side: 'in' },
  x_out: { channel: 'x', side: 'out' },
};

const CHANNEL_WORDS: Record<Channel, string> = {
  linkedin: 'LinkedIn conversation',
  text: 'Texts',
  instagram: 'Instagram conversation',
  x: 'X conversation',
};

const DAY = 86_400_000;

/**
 * Fold the entries (any order) into rows, newest first. A run of two or more messages on one channel with no gap of
 * `gapDays` or more becomes one conversation; a lone message stays an entry.
 */
export function groupTimeline(
  entries: TimelineEntry[],
  firstName: string,
  gapDays = CONVERSATION_GAP_DAYS,
): TimelineRow[] {
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  const rows: TimelineRow[] = [];
  let run: TimelineEntry[] = [];
  let runChannel: Channel | undefined;
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1 || !runChannel) rows.push({ ...run[0]!, type: 'entry' });
    else {
      const sides = run.map((e) => CHANNEL_OF[e.kind]!.side);
      rows.push({
        type: 'conversation',
        channel: runChannel,
        at: run[0]!.at,
        from: run[run.length - 1]!.at,
        icon: run[0]!.icon,
        kind: `${runChannel}_conversation`,
        text: `${CHANNEL_WORDS[runChannel]} with ${firstName}`,
        theirs: sides.filter((s) => s === 'in').length,
        yours: sides.filter((s) => s === 'out').length,
        entries: run,
      });
    }
    run = [];
    runChannel = undefined;
  };
  for (const e of sorted) {
    const ch = CHANNEL_OF[e.kind]?.channel;
    if (!ch) {
      flush();
      rows.push({ ...e, type: 'entry' });
      continue;
    }
    const last = run[run.length - 1];
    const gap = last ? Date.parse(last.at) - Date.parse(e.at) : 0;
    if (run.length && (ch !== runChannel || gap >= gapDays * DAY)) flush();
    run.push(e);
    runChannel = ch;
  }
  flush();
  return rows;
}

/** "16 messages, 9 from Shubh and 7 from you". */
export function conversationCounts(row: { theirs: number; yours: number }, firstName: string): string {
  const n = row.theirs + row.yours;
  const parts = [
    row.theirs ? `${row.theirs} from ${firstName}` : '',
    row.yours ? `${row.yours} from you` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  return `${n} messages${parts ? `, ${parts}` : ''}`;
}
