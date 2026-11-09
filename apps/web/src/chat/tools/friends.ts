/**
 * Friends from the chat (plan 29 §A5): who the student's friends on Orbit are and what each shares, inviting one,
 * what the student shares back, asking a friend for an intro (the ask goes to the friend, never to the person), and
 * answering a friend's ask (a forward is a draft the student approves; a decline owes no reason). Every one of these
 * needs an Orbit account; without one they say so in a line, since nothing leaves the browser in local mode.
 */
import type { Friend, FriendIntroAsk, FriendShare, FriendShareMode } from '@orbit/core';
import { db } from '../../db/schema';
import {
  askFriendForIntro,
  closenessPhrase,
  FRIENDS_EMPTY,
  FRIENDS_WHAT_CROSSES,
  friendShares,
  friendsAvailable,
  inviteFriend,
  listAsks,
  listFriends,
  previewShares,
  respondToAsk,
  SHARE_MODE_LABELS,
  setShareMode,
} from '../../engine/friends';
import { isAccountMode } from '../../integrations/orbitApi';
import { z } from '../../zod';
import type { ResultEnvelope, ToolContext } from '../types';
import { type AnyTool, defineTool, ok, plural, toModel, wrapped } from './_shared';
import { needsAccount } from './network';

const MODES = ['all', 'companies', 'none'] as const;

function accountBlock(ctx: ToolContext): string | undefined {
  if (friendsAvailable(ctx.user)) return undefined;
  return isAccountMode()
    ? 'Friends needs an Orbit account. Sign in with Google under Settings, Account first.'
    : 'Friends needs an Orbit account, which this copy of Orbit does not have.';
}

const first = (name: string) => name.split(/\s+/)[0] ?? name;

/** "shares 120 people · 6 at your targets · knows 2 at Stripe" */
function friendLine(f: Friend): string {
  const parts = [`shares ${plural(f.shares, 'person', 'people')}`];
  if (f.atTargets) parts.push(`${f.atTargets} at your targets`);
  const top = [...f.knowsAt].sort((a, b) => b.count - a.count)[0];
  if (top) parts.push(`knows ${top.count} at ${top.company}`);
  return parts.join(' · ');
}

/** The friends as the tab keeps them (fresh from the server when it answers), by name. */
async function friendNamed(ctx: ToolContext, name: string | undefined): Promise<Friend | undefined> {
  const r = await listFriends(ctx.user);
  const friends = r.ok ? r.value.friends : await db.friends.where('ownerId').equals(ctx.user.id).toArray();
  if (!name) return friends.length === 1 ? friends[0] : undefined;
  const q = name.trim().toLowerCase();
  return (
    friends.find((f) => f.name.toLowerCase() === q) ??
    friends.find((f) => first(f.name).toLowerCase() === q) ??
    friends.find((f) => f.name.toLowerCase().includes(q))
  );
}

async function sharedNamed(
  ctx: ToolContext,
  friend: Friend,
  name: string,
): Promise<{ hit?: FriendShare; candidates: FriendShare[] }> {
  const r = await friendShares(ctx.user, friend.userId);
  if (!r.ok) return { candidates: [] };
  const q = name.trim().toLowerCase();
  const exact = r.value.shares.filter((s) => s.displayName.toLowerCase() === q);
  if (exact.length === 1) return { hit: exact[0], candidates: exact };
  const partial = r.value.shares.filter((s) => s.displayName.toLowerCase().includes(q));
  return { hit: partial.length === 1 ? partial[0] : undefined, candidates: partial.slice(0, 5) };
}

export const listFriendsTool = defineTool({
  name: 'list_friends',
  kind: 'read',
  description:
    "Call this when the student asks who their friends on Orbit are, what a friend shares with them, who they could reach through friends (at a company or at all), how many of their target companies a friend covers, or what a friend can see of their own network. It lists each friend with how many people they share, how many are at the student's targets and where, and what the student shares back; with a company it also lists the friend's people there and how well the friend knows each. It also lists the intro asks friends made of the student (with their note) and the asks the student made, so call it first when the student says a friend sent or asked them something. It also says plainly what a friend may see and what never crosses. Needs an Orbit account; without one it says so.",
  input: z.object({
    company: z
      .string()
      .optional()
      .describe("A company name: also list the people friends know there, with the friend's closeness word."),
  }),
  capabilities: ['friend_list'],
  progress: 'Reading your friends',
  async execute(input, ctx): Promise<ResultEnvelope> {
    if (!friendsAvailable(ctx.user)) return needsAccount('Friends');
    const [r, asks] = await Promise.all([listFriends(ctx.user), listAsks(ctx.user)]);
    if (!r.ok) throw new Error(r.message);
    const { friends, pending } = r.value;
    // what a friend asked of the student, and what the student asked: the first thing to say when one waits
    const received = asks.ok ? asks.value.received.filter((a) => a.status === 'asked') : [];
    const asked = asks.ok ? asks.value.asked : [];
    const items = friends.map((f) => ({
      text: `${f.name}${f.school ? ` · ${f.school}${f.gradYear ? ` ${f.gradYear}` : ''}` : ''}`,
      sub: friendLine(f),
      chip: `you share: ${SHARE_MODE_LABELS[f.myMode].toLowerCase()}`,
      href: '/friends',
      avatar: { name: f.name, src: f.avatarUrl ?? undefined } as { name: string; src?: string },
    }));
    const at: {
      friend: string;
      people: {
        personId: string;
        name: string;
        title: string | null;
        closeness: string;
        youKnowThemToo?: true;
      }[];
    }[] = [];
    if (input.company) {
      for (const f of friends) {
        const s = await friendShares(ctx.user, f.userId, input.company);
        if (!s.ok || !s.value.shares.length) continue;
        at.push({
          friend: f.name,
          people: s.value.shares.map((p) => ({
            personId: p.personId,
            name: p.displayName,
            title: p.title,
            closeness: `${first(f.name)} ${closenessPhrase(p.closeness, first(p.displayName))}`,
          })),
        });
        for (const p of s.value.shares)
          items.push({
            text: p.displayName,
            sub: `${p.title ? `${p.title} at ` : ''}${p.company ?? input.company} · ${first(f.name)} ${closenessPhrase(p.closeness, first(p.displayName))}`,
            chip: `via ${first(f.name)}`,
            href: `/friends?ask=${encodeURIComponent(f.userId)}&target=${encodeURIComponent(p.personId)}`,
            avatar: { name: p.displayName, src: undefined },
          });
      }
    }
    // the student's own best way in there, by tie score, so a friend route is weighed against it and never guessed
    const co = input.company?.trim().toLowerCase();
    const mine = co
      ? (
          await db.people
            .where('userId')
            .equals(ctx.user.id)
            .filter((p) => !!p.isHuman && (p.currentOrganizationRaw ?? '').toLowerCase().includes(co))
            .toArray()
        ).sort((a, b) => (b.tieScore ?? 0) - (a.tieScore ?? 0))
      : [];
    const own = mine[0];
    // a friend's person the student also knows is said as such, so the shared route is never missed
    const mineNames = new Set(mine.map((p) => p.displayName.toLowerCase()));
    for (const a of at)
      for (const p of a.people) if (mineNames.has(p.name.toLowerCase())) p.youKnowThemToo = true;
    const alsoBy = own
      ? at
          .filter((a) => a.people.some((p) => p.name.toLowerCase() === own.displayName.toLowerCase()))
          .map((a) => a.friend)
      : [];
    const waiting = pending.filter((p) => p.direction === 'in');
    const lead = friends.length
      ? `${plural(friends.length, 'friend')} on Orbit: ${friends.map((f) => `${first(f.name)} (${friendLine(f)})`).join('; ')}.`
      : `No friends on Orbit yet. ${FRIENDS_EMPTY}`;
    const company = input.company
      ? at.length
        ? ` At ${input.company}: ${at.map((a) => `${first(a.friend)} knows ${a.people.map((p) => `${p.name} (${p.closeness.replace(`${first(a.friend)} `, '')}${p.youKnowThemToo ? `; you know ${first(p.name)} too` : ''})`).join(', ')}`).join('; ')}.`
        : ` Nobody your friends share works at ${input.company}.`
      : '';
    const ownLine = own
      ? ` Your own best way in at ${input.company}: ${own.displayName}${alsoBy.length ? `, whom ${alsoBy.map(first).join(' and ')} also ${alsoBy.length > 1 ? 'know' : 'knows'}` : ''}.`
      : '';
    const pend = waiting.length ? ` ${plural(waiting.length, 'request')} waiting on you in Friends.` : '';
    const waitingAsks = received.length
      ? ` ${received.map((a) => `${first(a.askerName)} asked you for an intro to ${a.targetName}${a.targetCompany ? ` at ${a.targetCompany}` : ''}`).join('; ')}. It waits in Friends for you to forward.`
      : '';
    return ok(
      'list',
      {
        title: input.company ? `Friends, and who they know at ${input.company}` : 'Your friends on Orbit',
        items,
      },
      {
        friends: friends.map((f) => ({
          userId: f.userId,
          name: f.name,
          school: f.school,
          gradYear: f.gradYear,
          shares: f.shares,
          atYourTargets: f.atTargets,
          knowsAt: f.knowsAt,
          youShare: f.myMode,
          yourCompanies: f.myCompanyDomains,
        })),
        pending: pending.map((p) => ({ direction: p.direction, who: p.name ?? p.email, status: p.status })),
        asksToYou: received.map((a) => ({
          askId: a.id,
          from: a.askerName,
          wantsToMeet: a.targetName,
          company: a.targetCompany ?? undefined,
          note: wrapped(ctx, 'note', a.note, 600),
        })),
        asksYouMade: asked.map((a) => ({
          askId: a.id,
          friend: a.friendName,
          person: a.targetName,
          company: a.targetCompany ?? undefined,
          status: a.status,
        })),
        atCompany: at.length ? at : undefined,
        yourOwnBest: own
          ? {
              personId: own.id,
              name: own.displayName,
              title: own.currentTitle ?? null,
              tieScore: own.tieScore,
              alsoKnownBy: alsoBy.length ? alsoBy : undefined,
            }
          : undefined,
        whatAFriendSees: FRIENDS_WHAT_CROSSES,
        howToAnswer: FRIENDS_HOW_TO_ANSWER,
        next: 'ask_friend_for_intro asks the friend with a note they forward; respond_to_friend_ask forwards an ask in asksToYou; set_friend_sharing changes what you share',
      },
      `${lead}${company}${ownLine}${pend}${waitingAsks}`,
      '/friends',
    );
  },
  toModel,
});

/**
 * How to word an answer about who the student can reach (plan 35 A2): it travels with list_friends, the only place it
 * matters, instead of sitting in every request's system prompt.
 */
export const FRIENDS_HOW_TO_ANSWER =
  "Two or three short lines that answer the question asked first. Asked what a friend knows somewhere, lead with the friend's best person there and how well the friend knows them, with a clause when youKnowThemToo shows the student knows them too; then the student's own best tie there in one clause (yourOwnBest: the highest tie score among their own people there, never the first alum a list shows), with a clause when alsoKnownBy shows a friend knows them too. Asked who they know there in general, lead with yourOwnBest. The cards carry everyone else, so never walk through the list.";

export const inviteFriendTool = defineTool({
  name: 'invite_friend',
  kind: 'risky',
  description:
    "Call this when the student asks to invite a friend to Orbit, to pool or share networks with someone, or to send a friend request. With an email, one email goes to that address with a sign-in link (someone already on Orbit sees a request to accept instead); without one, it makes a link the student sends themselves. Accepting shares both ways by default and can be changed any time; the invite itself shares nothing. At most 20 invites a day. Needs the student's approval and an Orbit account.",
  input: z.object({
    email: z.string().optional().describe("The friend's email address. Leave it out for a link to copy."),
  }),
  capabilities: ['friend_invite'],
  progress: 'Inviting your friend',
  async summarizeIntent(input, ctx) {
    const e = input.email?.trim();
    return {
      text: e
        ? `Invite ${e} to pool networks with you on Orbit: one email with a sign-in link (a request, if they are on Orbit already). Once you both accept, you see who they know and how well, they see yours, and nothing else crosses.`
        : 'Make an invite link to pool networks on Orbit, for you to send. Once you both accept, you see who they know and how well, they see yours, and nothing else crosses.',
      blockedReason: accountBlock(ctx),
    };
  },
  async execute(input, ctx) {
    if (!friendsAvailable(ctx.user)) return needsAccount('Inviting a friend');
    const r = await inviteFriend(ctx.user, input.email);
    if (!r.ok) throw new Error(r.message);
    const v = r.value;
    const summary =
      v.status === 'requested'
        ? `${input.email} is on Orbit already: the request is waiting on them. Nothing is shared until they accept.`
        : v.status === 'sent'
          ? `Invite sent to ${input.email}. It is a sign-in link; nothing is shared until they accept.`
          : input.email
            ? `No mail goes out from this copy of Orbit, so here is the link for ${input.email}: ${v.link}. Nothing is shared until they accept.`
            : `Here is the link to send: ${v.link}. Nothing is shared until they accept.`;
    return ok(
      'text',
      { link: v.link, status: v.status, invite: v.invite },
      { status: v.status, link: v.link, acceptedYet: false, expiresInDays: 14 },
      summary,
      '/friends',
    );
  },
  toModel,
});

export const setFriendSharingTool = defineTool({
  name: 'set_friend_sharing',
  kind: 'write',
  description:
    'Call this when the student wants to change what they share with friends on Orbit: everyone they know (all), only people at some companies (companies, with the company names or domains), or nothing yet (none). Name a friend to change it for that friend only; leave the name out to change it for all friends and new ones. It takes effect at once and does not end the friendship; the student still sees what the friend shares. Says how many people the friend now sees.',
  input: z.object({
    mode: z.enum(MODES).describe('all, companies or none.'),
    friendName: z.string().optional().describe("The friend's name, to change it for them alone."),
    companies: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('For mode companies: the companies to share, as names or web domains.'),
  }),
  capabilities: ['friend_share'],
  progress: 'Changing what you share',
  async execute(input, ctx) {
    if (!friendsAvailable(ctx.user)) return needsAccount('Sharing with friends');
    const mode = input.mode as FriendShareMode;
    const friend = input.friendName ? await friendNamed(ctx, input.friendName) : undefined;
    if (input.friendName && !friend) throw new Error(`No friend on Orbit named ${input.friendName}.`);
    const domains = (input.companies ?? []).map((c) => {
      const t = c.trim().toLowerCase();
      return t.includes('.') ? t : `${t.replace(/[^a-z0-9]+/g, '')}.com`;
    });
    if (mode === 'companies' && !domains.length)
      throw new Error('Say which companies to share, as names or web domains.');
    const r = await setShareMode(ctx.user, mode, {
      friendshipId: friend?.friendshipId,
      companyDomains: domains,
    });
    if (!r.ok) throw new Error(r.message);
    const who = friend ? first(friend.name) : 'Your friends';
    const sees =
      mode === 'none'
        ? `${who} ${friend ? 'sees' : 'see'} nothing of yours now`
        : `${who} ${friend ? 'sees' : 'see'} ${plural(r.value.shares, 'person', 'people')} of yours${mode === 'companies' ? ` at ${domains.map((d) => d.replace(/\.[a-z]+$/, '')).join(', ')}` : ''}`;
    return ok(
      'settings',
      { mode, companyDomains: domains, shares: r.value.shares, friend: friend?.name },
      {
        mode,
        companyDomains: domains,
        friendSees: r.value.shares,
        friend: friend?.name ?? 'all',
        immediate: true,
      },
      `${sees}. It took effect at once; you still see what ${friend ? first(friend.name) : 'they'} share${friend ? 's' : ''}.`,
      '/friends',
    );
  },
  toModel,
});

export const askFriendForIntroTool = defineTool({
  name: 'ask_friend_for_intro',
  kind: 'risky',
  description:
    "Call this when the student wants a friend on Orbit to introduce them to someone the friend knows (a person listed through a friend by find_routes or list_friends, or any name the friend shares). Give the friend's name, the person's name and the two or three line note the friend can forward as it is: who the student is, why this person, the ask, an out. The ask goes to the friend, never to the person: Orbit never drafts to the person, never shows their address, and nothing is sent until the friend forwards. Needs the student's approval and an Orbit account.",
  input: z.object({
    friendName: z.string().describe('The friend on Orbit who knows the person.'),
    targetName: z.string().describe('The person to be introduced to, as the friend shares them.'),
    note: z
      .string()
      .min(1)
      .max(600)
      .describe(
        "The forwardable blurb in the student's words: who they are, why this person, a 15 minute ask, an out. Two or three lines.",
      ),
  }),
  capabilities: ['friend_ask'],
  progress: 'Asking your friend',
  async summarizeIntent(input, ctx) {
    const blocked = accountBlock(ctx);
    const friend = blocked ? undefined : await friendNamed(ctx, input.friendName);
    const target = friend ? await sharedNamed(ctx, friend, input.targetName) : undefined;
    const fName = friend ? first(friend.name) : input.friendName;
    const tName = target?.hit?.displayName ?? input.targetName;
    const at = target?.hit?.company ? ` at ${target.hit.company}` : '';
    return {
      text: `Ask ${fName} to introduce you to ${tName}${at}, with your note for ${fName} to forward: "${input.note.trim()}". It goes to ${fName}, never to ${first(tName)}; nothing is sent until ${fName} forwards it.`,
      blockedReason:
        blocked ??
        (!friend
          ? `No friend on Orbit named ${input.friendName}.`
          : !target?.hit
            ? target?.candidates.length
              ? `${fName} shares more than one person like that: ${target.candidates.map((c) => c.displayName).join(', ')}. Say which.`
              : `${fName} does not share anyone named ${input.targetName}.`
            : undefined),
    };
  },
  async execute(input, ctx) {
    if (!friendsAvailable(ctx.user)) return needsAccount('Asking a friend for an intro');
    const friend = await friendNamed(ctx, input.friendName);
    if (!friend) throw new Error(`No friend on Orbit named ${input.friendName}.`);
    const target = await sharedNamed(ctx, friend, input.targetName);
    if (!target.hit)
      throw new Error(
        target.candidates.length
          ? `${first(friend.name)} shares more than one person like that: ${target.candidates.map((c) => c.displayName).join(', ')}. Say which.`
          : `${first(friend.name)} does not share anyone named ${input.targetName}.`,
      );
    const r = await askFriendForIntro(ctx.user, friend.userId, target.hit.personId, input.note);
    if (!r.ok) throw new Error(r.message);
    const a = r.value;
    return ok(
      'text',
      { ask: a },
      {
        askId: a.id,
        friend: a.friendName,
        target: a.targetName,
        company: a.targetCompany,
        status: a.status,
        sentToTarget: false,
        note: wrapped(ctx, 'ask', a.note, 600),
        next: `When ${first(a.friendName)} forwards, thank them and report back after the chat.`,
      },
      `Asked ${first(a.friendName)} to introduce you to ${a.targetName}${a.targetCompany ? ` at ${a.targetCompany}` : ''}. It waits on ${first(a.friendName)}; nothing was sent to ${first(a.targetName)}. It sits under Asks in Friends.`,
      '/friends',
    );
  },
  toModel,
});

const ACTIONS = ['forward', 'decline'] as const;

async function openAsk(
  ctx: ToolContext,
  input: { askId?: string; askerName?: string },
): Promise<FriendIntroAsk | undefined> {
  const r = await listAsks(ctx.user);
  const received = r.ok
    ? r.value.received
    : (await db.friendAsks.where('ownerId').equals(ctx.user.id).toArray()).filter(
        (a) => a.friendUserId === ctx.user.id,
      );
  const open = received.filter((a) => a.status === 'asked');
  if (input.askId) return received.find((a) => a.id === input.askId);
  if (input.askerName) {
    const q = input.askerName.trim().toLowerCase();
    const mine = open.filter(
      (a) => a.askerName.toLowerCase().includes(q) || a.targetName.toLowerCase().includes(q),
    );
    return mine.length === 1 ? mine[0] : undefined;
  }
  return open.length === 1 ? open[0] : undefined;
}

export const respondToFriendAskTool = defineTool({
  name: 'respond_to_friend_ask',
  kind: 'risky',
  description:
    "Call this when the student answers an intro a friend asked of them: forward it, or decline it (not this one). Forward makes a draft to the student's own contact that quotes the friend's note, says the friend asked, puts the friend in cc and offers an out; the student approves it in Friends before anything is sent, never on LinkedIn. Decline closes the ask and owes no reason. Name the asking friend or the person, or give the ask's id; with one open ask neither is needed. Needs the student's approval and an Orbit account.",
  input: z.object({
    action: z.enum(ACTIONS).describe('forward, or decline.'),
    askerName: z.string().optional().describe('The friend who asked, or the person they want to meet.'),
    askId: z.string().optional().describe('The ask itself, from list_friends or the Friends tab.'),
  }),
  capabilities: ['friend_respond'],
  progress: 'Answering the ask',
  async summarizeIntent(input, ctx) {
    const blocked = accountBlock(ctx);
    const ask = blocked ? undefined : await openAsk(ctx, input);
    if (!ask)
      return {
        text: `${input.action === 'forward' ? 'Forward' : 'Decline'} a friend's intro ask.`,
        blockedReason: blocked ?? 'No open ask matches. list_friends shows what is waiting.',
      };
    const f = first(ask.askerName);
    const t = first(ask.targetName);
    return {
      text:
        input.action === 'forward'
          ? `Forward ${f}'s note to ${ask.targetName}${ask.targetCompany ? ` at ${ask.targetCompany}` : ''}: a draft to ${t} from you, ${f}'s words quoted, ${f} in cc, an out. You approve it in Friends before anything is sent; never on LinkedIn.`
          : `Tell ${f} not this one, for the intro to ${ask.targetName}. No reason is owed, and nothing goes to ${t}.`,
      blockedReason: ask.status !== 'asked' ? 'That ask was already answered.' : undefined,
    };
  },
  async execute(input, ctx) {
    if (!friendsAvailable(ctx.user)) return needsAccount("Answering a friend's ask");
    const ask = await openAsk(ctx, input);
    if (!ask) throw new Error('No open ask matches. The Friends tab shows what is waiting.');
    const r = await respondToAsk(ctx.user, ask.id, input.action);
    if (!r.ok) throw new Error(r.message);
    const f = first(ask.askerName);
    const t = first(ask.targetName);
    if (input.action === 'decline')
      return ok(
        'text',
        { ask: r.value.ask },
        { askId: ask.id, status: 'declined', sent: false },
        `Declined ${f}'s ask for an intro to ${ask.targetName}. Nothing was sent, and no reason is owed.`,
        '/friends',
      );
    const d = r.value.draft;
    return ok(
      'text',
      { ask: r.value.ask, draft: d },
      {
        askId: ask.id,
        status: 'forwarded',
        draftId: d?.id,
        to: ask.targetName,
        cc: ask.askerName,
        body: d ? wrapped(ctx, 'draft', d.body, 800) : undefined,
        sent: false,
        approveIn: '/friends',
      },
      `Drafted the forward to ${ask.targetName}: ${f}'s note quoted, ${f} in cc. Nothing is sent until you approve it under Asks in Friends; it goes by email, never LinkedIn, and ${f} sees ${t}'s address only when ${t} replies.`,
      '/friends',
    );
  },
  toModel,
});

const CLOSENESS_WORD = { 1: 'knows', 2: 'knows well', 3: 'close' } as const;

export const previewMySharesTool = defineTool({
  name: 'preview_my_shares',
  kind: 'read',
  description:
    'Call this when the student wants to see what a friend sees of their network, row for row ("show what Ana sees", "what does my share look like"). It returns the student\'s own people exactly as that friend sees them: name, title, company, school, alum or not, and the closeness word, never an email, note or draft. Name the friend when the student does, since sharing can differ per friend (only some companies for one of them); leave the name out for what friends see by default. Needs an Orbit account; without one it says so.',
  input: z.object({
    friendName: z.string().optional().describe("The friend's name, for that friend's own view."),
  }),
  capabilities: ['friend_preview'],
  progress: 'Reading what your friends see',
  async execute(input, ctx): Promise<ResultEnvelope> {
    if (!friendsAvailable(ctx.user)) return needsAccount('Friends');
    const friend = input.friendName ? await friendNamed(ctx, input.friendName) : undefined;
    if (input.friendName && !friend) throw new Error(`No friend on Orbit named ${input.friendName}.`);
    const r = await previewShares(ctx.user, friend?.friendshipId);
    if (!r.ok) throw new Error(r.message);
    const { shares, total, mode } = r.value;
    const rows = shares.slice(0, 8).map((s) => ({
      name: s.displayName,
      title: s.title,
      company: s.company,
      school: s.school,
      alum: s.isAlumni,
      closeness: CLOSENESS_WORD[s.closeness] ?? 'knows',
    }));
    const items = rows.map((x) => ({
      text: x.name,
      sub: [
        x.title && x.company ? `${x.title} at ${x.company}` : (x.title ?? x.company),
        x.alum ? 'your alum' : x.school,
      ]
        .filter(Boolean)
        .join(' · '),
      chip: x.closeness,
      href: '/friends',
      avatar: { name: x.name, src: undefined } as { name: string; src?: string },
    }));
    const who = friend ? first(friend.name) : 'A friend';
    const summary = total
      ? `${who} sees ${plural(total, 'person', 'people')} of yours, each as a row like these: name, title, company, school and how well you know them. Never an email, note or draft. The whole list is on the Friends page.`
      : `${who} sees none of your people right now: you share nothing${friend ? ' with them' : ''} yet.`;
    return ok(
      'list',
      { title: `What ${friend ? first(friend.name) : 'a friend'} sees (${total})`, items },
      {
        total,
        friend: friend?.name ?? 'any friend',
        mode: SHARE_MODE_LABELS[mode],
        rows,
        more: Math.max(0, total - rows.length),
      },
      summary,
      '/friends',
    );
  },
  toModel,
});

export const friendTools: AnyTool[] = [
  listFriendsTool,
  previewMySharesTool,
  inviteFriendTool,
  setFriendSharingTool,
  askFriendForIntroTool,
  respondToFriendAskTool,
];
