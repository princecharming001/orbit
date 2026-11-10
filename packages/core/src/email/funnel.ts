/**
 * A group's funnel (plan 38 §G): what Orbit does when someone the student wrote to as part of one group replies, so
 * recruiters at target companies and alumni at startups can each be walked to the next step their own way. The
 * browser and the server read the same rows (users.settings.reply_funnels): the group's people, what an interested
 * reply gets (three of the student's times, the booking link, or the student's own words), and the follow-up when
 * nobody answers. A scheduling reply still books the slot they picked; a question still waits for the student.
 */

export type FunnelInterested = 'slots' | 'link' | 'own';

export interface ReplyFunnel {
  id: string;
  name: string;
  /** the group's people, as the server knows them */
  personIds: string[];
  /** what an interested reply gets */
  interested: FunnelInterested;
  /** the student's own reply for `own` (and `link`, when they wrote one): `{first}`, `{company}`, `{link}` */
  reply?: string;
  /** the follow-up's words when they have not answered; Orbit writes it when unset */
  followUp?: string;
  createdAt: string;
}

/** How many funnels and people the settings keep, so the row stays small. */
export const FUNNEL_LIMITS = { funnels: 30, people: 500, text: 4000 } as const;

/** The default words for `link`: short, warm, and the link on its own line. */
export const LINK_REPLY =
  'Hi {first},\n\nThanks so much for getting back to me. Here is my calendar, pick any time that works for you:\n\n{link}\n\nLooking forward to it.';

/** The funnel a person belongs to: the newest one that names them. */
export function funnelFor(
  funnels: readonly ReplyFunnel[] | undefined,
  personId: string,
): ReplyFunnel | undefined {
  if (!funnels?.length) return undefined;
  let best: ReplyFunnel | undefined;
  for (const f of funnels)
    if (f.personIds.includes(personId) && (!best || f.createdAt > best.createdAt)) best = f;
  return best;
}

/** `{first}`, `{company}`, `{link}` filled in (an unknown first name reads "there"), and the sign-off after. */
export function fillFunnelText(
  text: string,
  v: { first?: string | null; company?: string | null; link?: string | null; signOff?: string | null },
): string {
  const out = text
    .replace(/\{\{?\s*(first|company|link)\s*\}?\}/gi, (_w, name: string) => {
      const key = name.toLowerCase() as 'first' | 'company' | 'link';
      return v[key]?.trim() || (key === 'first' ? 'there' : '');
    })
    .replace(/[ \t]+([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const sign = v.signOff?.trim();
  return sign && !out.toLowerCase().endsWith(sign.toLowerCase()) ? `${out}\n\nBest,\n${sign}` : out;
}

/**
 * The words an interested reply from this person gets under their funnel, or undefined when the funnel leaves it to
 * Orbit (three times) or there is no link to send.
 */
export function funnelReply(
  f: ReplyFunnel | undefined,
  v: { first?: string | null; company?: string | null; link?: string | null; signOff?: string | null },
): string | undefined {
  if (!f || f.interested === 'slots') return undefined;
  if (f.interested === 'link') {
    if (!v.link) return undefined;
    return fillFunnelText(f.reply?.trim() || LINK_REPLY, v);
  }
  return f.reply?.trim() ? fillFunnelText(f.reply, v) : undefined;
}

/** A funnel row as the server takes it, or the reason it is refused. */
export function parseFunnels(v: unknown): ReplyFunnel[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'replyFunnels must be a list' };
  if (v.length > FUNNEL_LIMITS.funnels) return { error: `at most ${FUNNEL_LIMITS.funnels} groups` };
  const out: ReplyFunnel[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') return { error: 'a group must be an object' };
    const r = x as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 80) return { error: 'a group needs an id' };
    if (typeof r.name !== 'string' || r.name.length > 160) return { error: 'a group needs a name' };
    if (!Array.isArray(r.personIds) || r.personIds.length > FUNNEL_LIMITS.people)
      return { error: `a group holds at most ${FUNNEL_LIMITS.people} people` };
    const ids = r.personIds.filter((p): p is string => typeof p === 'string' && /^[0-9a-f-]{36}$/i.test(p));
    if (!['slots', 'link', 'own'].includes(r.interested as string))
      return { error: 'interested is slots, link or own' };
    const text = (t: unknown) =>
      typeof t === 'string' && t.trim() ? t.slice(0, FUNNEL_LIMITS.text) : undefined;
    out.push({
      id: r.id,
      name: r.name,
      personIds: [...new Set(ids.map((i) => i.toLowerCase()))],
      interested: r.interested as FunnelInterested,
      reply: text(r.reply),
      followUp: text(r.followUp),
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    });
  }
  return out;
}
