import { wordCount } from '../text/email';
import type { Channel, DraftClaim, MessageKind, PersonFact, StyleCard } from '../types';

export interface DraftContext {
  user: {
    firstName: string;
    fullName: string;
    school: string;
    gradYear?: number;
    majors: string[];
    cycleLabel: string;
    targetFunctions: string[];
    oneLiner?: string;
    schedulingLink?: string;
    timezone: string;
  };
  styleCard: StyleCard;
  person: {
    firstName: string;
    fullName: string;
    title?: string;
    org?: string;
    isAlumni?: boolean;
    relationshipType: string;
    strength: number;
  };
  facts: PersonFact[];
  kind: MessageKind;
  channel: Channel;
  proposedWindows?: { startIso: string; endIso?: string; raw?: string }[];
  thread?: {
    lastInboundBody?: string;
    lastInboundAt?: string;
    firstOutboundAt?: string;
    asksOfUser?: string[];
    proposedTimes?: { startIso: string; raw: string }[];
  };
  target?: { name: string; title?: string; org?: string; why?: string };
  reason?: string;
  warmUpContext?: string; // e.g. "commented on their post about X"
  newAffiliation?: { title?: string; org?: string };
  targetCompany?: { name: string; roleLabel?: string; link?: string };
  now?: Date;
}

export interface DraftOutput {
  subject?: string;
  body: string;
  bodyShort?: string;
  claims: DraftClaim[];
}

export const MAX_WORDS: Record<MessageKind, number> = {
  outreach: 120,
  bump: 60,
  schedule: 80,
  thank_you: 100,
  nurture: 90,
  congratulate: 50,
  referral_ask: 110,
  intro_request: 110,
  reply: 120,
};
export const BANNED_PHRASES = [
  'i hope this email finds you well',
  'reach out',
  'pick your brain',
  'leverage',
  'synergy',
  'as an ai',
  'ignore previous',
  'touch base',
  'circle back',
];

function greeting(card: StyleCard, first: string): string {
  const g = card.greetingPatterns[0] ?? 'Hi {first},';
  return g.replace('{first}', first);
}
function signoff(card: StyleCard, fallbackName: string): string {
  return card.signoffs[0] ?? `Best,\n${fallbackName}`;
}
function fmtWindow(w: { startIso: string; endIso?: string; raw?: string }, tz: string): string {
  const d = new Date(w.startIso);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  const t = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: d.getMinutes() ? '2-digit' : undefined,
    timeZone: tz,
  });
  if (w.endIso) {
    const e = new Date(w.endIso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: new Date(w.endIso).getMinutes() ? '2-digit' : undefined,
      timeZone: tz,
    });
    return `${day} ${t}–${e}`;
  }
  return `${day} at ${t}`;
}
function tzAbbr(tz: string, now: Date): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value ?? tz
    );
  } catch {
    return tz;
  }
}

function pick(facts: PersonFact[], types: PersonFact['type'][]): PersonFact | undefined {
  return facts.find((f) => types.includes(f.type) && !f.deletedAt);
}

export function generateDraft(ctx: DraftContext): DraftOutput {
  const { user, person, styleCard: card } = ctx;
  const now = ctx.now ?? new Date();
  const claims: DraftClaim[] = [];
  const first = person.firstName || person.fullName.split(' ')[0] || 'there';
  const org = person.org;
  const role = person.title;
  const who =
    user.oneLiner ??
    `${user.gradYear ? `a ${user.gradYear} ` : 'a '}${user.majors[0] ?? ''} student at ${user.school}`
      .replace(/\s+/g, ' ')
      .trim();
  const ask = user.schedulingLink
    ? `Would you be open to a 20-minute call sometime in the next couple of weeks? Here's my calendar if that's easier: ${user.schedulingLink}`
    : `Would you be open to a 20-minute call sometime in the next couple of weeks? Happy to work around your schedule.`;
  const G = greeting(card, first);
  const S = signoff(card, user.firstName);
  const hook = pick(ctx.facts, ['hook', 'offer', 'advice', 'role_detail', 'background']);
  const target = targetLabel(ctx);
  let subject: string | undefined;
  let body = '';
  let bodyShort: string | undefined;
  switch (ctx.kind) {
    case 'outreach': {
      const connection = person.isAlumni
        ? `I'm ${who}, and I came across your profile while looking for ${user.school} alumni working in ${target}.`
        : org
          ? `I'm ${who}, and I've been following ${org}'s work while recruiting for ${target} roles this cycle.`
          : `I'm ${who}, recruiting for ${target} roles this cycle.`;
      if (person.isAlumni)
        claims.push({ text: `${person.fullName} is a ${user.school} alum`, kind: 'shared' });
      if (org) claims.push({ text: `${person.fullName} works at ${org}`, kind: 'about_person' });
      const specific =
        role && org
          ? `Your path to ${role} at ${org} is the kind of route I'd love to understand better.`
          : hook
            ? `I noticed ${hook.text.replace(/\.$/, '')}, which is exactly what I'm trying to learn more about.`
            : `I'd love to hear how you think about getting started in ${target}.`;
      if (hook) claims.push({ text: hook.text, factId: hook.id, kind: 'about_person' });
      const warm = ctx.warmUpContext ? ` ${ctx.warmUpContext}` : '';
      subject = person.isAlumni
        ? `${user.school} student, quick question about ${org ?? target}`
        : `Quick question about ${org ?? target}`;
      body = `${G}\n\n${connection}${warm} ${specific}\n\n${ask}\n\n${S}`;
      bodyShort =
        `Hi ${first}, I'm ${who}${person.isAlumni ? ` (fellow ${user.school}${org ? `, now at ${org}` : ''})` : ''}. I'd love 20 minutes to hear about your path${org ? ` at ${org}` : ''} while I recruit for ${target} roles. Thanks!`.slice(
          0,
          300,
        );
      break;
    }
    case 'bump': {
      const when = ctx.thread?.firstOutboundAt
        ? new Date(ctx.thread.firstOutboundAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
        : 'last week';
      subject = undefined; // reply in thread
      body = `${G}\n\nFloating this back up in case it got buried — I wrote on ${when} about a quick chat on ${target}${org ? ` at ${org}` : ''}. Even 15 minutes would be a big help, and I'm happy to send a couple of specific questions in advance so it's efficient.\n\n${S}`;
      claims.push({ text: `first message sent ${when}`, kind: 'logistics' });
      break;
    }
    case 'schedule': {
      const windows = (ctx.proposedWindows ?? []).slice(0, 2).map((w) => fmtWindow(w, user.timezone));
      const tz = tzAbbr(user.timezone, now);
      const offer = windows.length
        ? `Would either of these work? ${windows.join(' or ')} (${tz}).`
        : user.schedulingLink
          ? `Here's my calendar so you can grab whatever is easiest: ${user.schedulingLink}`
          : `Would any time this week or next work for you? I'm flexible.`;
      body = `${G}\n\nThanks so much — that would be great. ${offer} If neither works, send me a time that does and I'll make it fit.\n\n${S}`;
      claims.push({ text: 'proposed windows', kind: 'logistics' });
      break;
    }
    case 'thank_you': {
      const f1 = pick(ctx.facts, ['advice']);
      const f2 = pick(ctx.facts, ['offer', 'hook', 'role_detail']);
      const specifics = [f1, f2].filter(Boolean) as PersonFact[];
      const line1 = specifics[0]
        ? `Your point that ${specifics[0].text.replace(/\.$/, '').replace(/^(they|he|she)\s+/i, '')} stuck with me.`
        : 'I learned a lot from how you described your path.';
      const line2 = specifics[1]
        ? ` I'll follow up on ${specifics[1].text.replace(/\.$/, '').replace(/^(they|he|she)\s+/i, 'what you mentioned about ')}.`
        : '';
      for (const f of specifics) claims.push({ text: f.text, factId: f.id, kind: 'about_person' });
      body = `${G}\n\nThank you for taking the time today. ${line1}${line2}\n\nI'll keep you posted on how the ${user.cycleLabel.toLowerCase()} search goes — and if there's ever anything I can do for you, please say so.\n\n${S}`;
      break;
    }
    case 'nurture': {
      const h = pick(ctx.facts, ['hook', 'offer']);
      const update = `On my end, ${user.cycleLabel.toLowerCase()} recruiting is in full swing and your advice has shaped how I'm approaching it.`;
      const ref = h
        ? `I remembered you mentioned ${h.text.replace(/\.$/, '').replace(/^(they|he|she)\s+/i, '')} — how did that go?`
        : `How have things been${org ? ` at ${org}` : ''}?`;
      if (h) claims.push({ text: h.text, factId: h.id, kind: 'about_person' });
      body = `${G}\n\nIt's been a little while, so I wanted to check in. ${ref} ${update}\n\nNo need to reply at length — just wanted to stay in touch.\n\n${S}`;
      break;
    }
    case 'congratulate': {
      const what =
        ctx.newAffiliation?.title && ctx.newAffiliation.org
          ? `${ctx.newAffiliation.title} at ${ctx.newAffiliation.org}`
          : ctx.newAffiliation?.org
            ? `the move to ${ctx.newAffiliation.org}`
            : 'the new role';
      claims.push({ text: `new role: ${what}`, kind: 'about_person' });
      body = `${G}\n\nJust saw the news — congratulations on ${what}! Well deserved. Hope the first weeks are going well.\n\n${S}`;
      break;
    }
    case 'referral_ask': {
      const tc = ctx.targetCompany;
      const link = tc?.link ? ` (${tc.link})` : '';
      const offer = pick(ctx.facts, ['offer']);
      const open = offer
        ? `When we spoke you kindly offered to ${offer.text.replace(/^.*?(refer|put in a word|forward)/i, '$1').replace(/\.$/, '')}, so I wanted to follow up.`
        : `I wanted to ask a small favor, with zero pressure if it isn't a fit.`;
      if (offer) claims.push({ text: offer.text, factId: offer.id, kind: 'about_person' });
      body = `${G}\n\n${open} I'm applying to the ${tc?.roleLabel ?? target} role at ${tc?.name ?? org ?? 'your company'}${link}, and after our conversation I'm confident it's the right kind of team for me. If you'd be comfortable referring me, I can send my resume and a two-line summary to make it easy. Totally understand if not.\n\n${S}`;
      break;
    }
    case 'intro_request': {
      const t = ctx.target;
      const why = t?.why ?? `their work in ${target}`;
      body = `${G}\n\nI have a small ask. I'm trying to reach ${t?.name ?? 'someone'}${t?.title ? ` (${t.title}${t?.org ? ` at ${t.org}` : ''})` : t?.org ? ` at ${t.org}` : ''} to learn about ${why}, and I noticed you're connected. If you'd be comfortable making a short intro, here's a blurb you could forward:\n\n"${user.fullName} is ${who} recruiting for ${target} roles. They'd love 20 minutes to hear about ${why}. They're thoughtful and will come prepared."\n\nAnd if it's not a good fit to ask, no worries at all.\n\n${S}`;
      claims.push({ text: `target: ${t?.name ?? ''}`, kind: 'logistics' });
      break;
    }
    case 'reply': {
      const asks = ctx.thread?.asksOfUser ?? [];
      const times = ctx.thread?.proposedTimes ?? [];
      const answer = asks.length
        ? asks.map((a) => `On "${a.replace(/[.?]$/, '')}": happy to — I'll send that over today.`).join(' ')
        : '';
      const accept = times.length
        ? `${fmtWindow(times[0]!, user.timezone)} works perfectly for me (${tzAbbr(user.timezone, now)}).`
        : '';
      body = `${G}\n\nThanks for getting back to me! ${accept} ${answer}\n\nLooking forward to it.\n\n${S}`
        .replace(/\s{2,}/g, ' ')
        .replace(/ \n/g, '\n');
      claims.push({ text: 'reply to asks', kind: 'logistics' });
      break;
    }
  }
  return { subject, body: body.trim(), bodyShort, claims };
}

export function targetLabel(ctx: DraftContext): string {
  const f = ctx.user.targetFunctions[0];
  const map: Record<string, string> = {
    swe: 'software engineering',
    pm: 'product management',
    ib: 'investment banking',
    consulting: 'consulting',
    data: 'data science',
    design: 'product design',
    finance: 'finance',
    marketing: 'marketing',
    research: 'research',
    vc: 'venture capital',
    ops: 'operations',
  };
  return f ? (map[f] ?? f) : 'early-career';
}
