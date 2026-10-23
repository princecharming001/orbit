import type { CoffeeChat, OutboundMessage, Person, Suggestion } from '@orbit/core';
import { CHANNEL_LABELS, MESSAGE_KIND_LABELS, STAGE_LABELS } from '@orbit/core';
import type { z } from 'zod/v4';
import { db } from '../../db/schema';
import type { ResultEnvelope, ResultKind, ToolContext, ToolSpec } from '../types';

/** A tool as the registry holds it: the input shape is erased so one map can hold them all. */
export type AnyTool = ToolSpec<z.ZodObject, unknown>;

/** Keep the tool's own types while it is written; the registry sees the erased form. */
export function defineTool<I extends z.ZodObject, D>(spec: ToolSpec<I, D>): AnyTool {
  return spec as unknown as AnyTool;
}

/** Result data carries a compact copy for the model under `forModel`; the UI reads the rest. */
export interface Packed<U = unknown, M = unknown> {
  ui: U;
  forModel: M;
}

export function pack<U, M>(ui: U, forModel: M): Packed<U, M> {
  return { ui, forModel };
}

/** The projection every tool uses: the compact copy, never the whole UI object. */
export function toModel(data: unknown): unknown {
  const d = data as Packed | undefined;
  return d && typeof d === 'object' && 'forModel' in d ? d.forModel : data;
}

export function ok<U, M>(
  kind: ResultKind,
  ui: U,
  forModel: M,
  summary: string,
  href?: string,
): ResultEnvelope<Packed<U, M>> {
  return { kind, data: pack(ui, forModel), summary: plain(summary), href };
}

/** The UI opens the envelope's `href` in the side panel by itself. */
export function autoOpen<E extends ResultEnvelope>(env: E): E {
  return { ...env, autoOpen: true };
}

export function err(message: string, extra: Record<string, unknown> = {}): ResultEnvelope {
  const text = plain(message || 'Something went wrong.');
  return { kind: 'error', data: { message: text, ...extra }, summary: text };
}

/** The reason an engine call gave, as it gave it. */
export function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message || 'Something went wrong.';
  if (typeof e === 'string') return e;
  return 'Something went wrong.';
}

/** Summaries are plain sentences: no em or en dashes, no exclamation marks. */
export function plain(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/!+/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function clip(text: string | undefined, max = 240): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Third-party text (email bodies, notes, LinkedIn fields, facts) is wrapped before the model sees it. */
export function wrapped(
  ctx: ToolContext,
  label: string,
  text: string | undefined,
  max = 1200,
): string | undefined {
  if (!text) return undefined;
  const t = text.length > max ? `${text.slice(0, max)}…` : text;
  return ctx.wrap(label, t);
}

export function firstLine(text: string | undefined): string | undefined {
  return clip(text?.split(/\n+/).find((l) => l.trim()) ?? '', 140);
}

/** A greeting on its own line ("Hi Lena,"), which says nothing about what a message is. */
const GREETING_LINE = /^(?:hi|hey|hello|dear|good (?:morning|afternoon|evening))\b[^.!?\n]{0,40}[,.!]?$/i;

/** The first line of a message that says something: the greeting is skipped. */
export function openingLine(text: string | undefined): string | undefined {
  const lines = (text ?? '').split(/\n+/).filter((l) => l.trim());
  const at = lines.findIndex((l) => !GREETING_LINE.test(l.trim()));
  return clip(lines[at >= 0 ? at : 0] ?? '', 140);
}

/** A date for the model in the student's zone, with the weekday. */
export function fmtWhen(iso: string | undefined, ctx: Pick<ToolContext, 'user'>): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: ctx.user.timezone || undefined,
    });
  } catch {
    return d.toISOString();
  }
}

export function fmtDay(iso: string | undefined, ctx: Pick<ToolContext, 'user'>): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: ctx.user.timezone || undefined,
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- compact references ----------

export interface PersonRef {
  id: string;
  name: string;
  title?: string;
  company?: string;
  href: string;
}

export function personRef(p: Person): PersonRef {
  return {
    id: p.id,
    name: p.displayName,
    title: p.currentTitle,
    company: p.currentOrganizationRaw,
    href: `/people/${p.id}`,
  };
}

export interface ChatRef {
  id: string;
  personId: string;
  stage: CoffeeChat['stage'];
  stageLabel: string;
  stageSince: string;
}

export function chatRef(c: CoffeeChat): ChatRef {
  return {
    id: c.id,
    personId: c.personId,
    stage: c.stage,
    stageLabel: STAGE_LABELS[c.stage],
    stageSince: c.stageEnteredAt.slice(0, 10),
  };
}

export interface DraftRef {
  id: string;
  personId: string;
  person?: string;
  kind: OutboundMessage['kind'];
  kindLabel: string;
  channel: OutboundMessage['channel'];
  channelLabel: string;
  status: OutboundMessage['status'];
  subject?: string;
  firstLine?: string;
  edited: boolean;
  needsInput?: OutboundMessage['needsInput'];
  href: string;
}

export function draftRef(d: OutboundMessage, person?: Person): DraftRef {
  return {
    id: d.id,
    personId: d.personId,
    person: person?.displayName,
    kind: d.kind,
    kindLabel: MESSAGE_KIND_LABELS[d.kind],
    channel: d.channel,
    channelLabel: CHANNEL_LABELS[d.channel],
    status: d.status,
    subject: d.subject,
    firstLine: openingLine(d.bodyFinal ?? d.bodyDraft),
    edited: !!d.bodyFinal,
    needsInput: d.needsInput,
    href: `/inbox?draft=${d.id}`,
  };
}

export interface CardRef {
  id: string;
  kind: Suggestion['kind'];
  personId?: string;
  person?: string;
  reason: string;
  status: Suggestion['status'];
  draftId?: string;
  chatId?: string;
  href: string;
}

export function cardRef(s: Suggestion, person?: Person): CardRef {
  return {
    id: s.id,
    kind: s.kind,
    personId: s.personId,
    person: person?.displayName,
    reason: clip(s.reasonText, 160) ?? '',
    status: s.status,
    draftId: s.outboundMessageId,
    chatId: s.chatId,
    href: `/inbox?card=${s.id}`,
  };
}

// ---------- lookups ----------

export async function requirePerson(ctx: ToolContext, personId: string): Promise<Person> {
  const p = await db.people.get(personId);
  if (!p || p.userId !== ctx.user.id)
    throw new Error('Orbit has no person with that id. Search for them first.');
  return p;
}

export async function requireDraft(ctx: ToolContext, draftId: string): Promise<OutboundMessage> {
  const d = await db.outbound.get(draftId);
  if (!d || d.userId !== ctx.user.id)
    throw new Error('Orbit has no draft with that id. List the drafts first.');
  return d;
}

export async function requireSuggestion(ctx: ToolContext, suggestionId: string): Promise<Suggestion> {
  const s = await db.suggestions.get(suggestionId);
  if (!s || s.userId !== ctx.user.id)
    throw new Error("Orbit has no card with that id. Look at today's brief first.");
  return s;
}

export async function requireChat(ctx: ToolContext, chatId: string): Promise<CoffeeChat> {
  const c = await db.chats.get(chatId);
  if (!c || c.userId !== ctx.user.id)
    throw new Error('Orbit has no chat with that id. List the pipeline first.');
  return c;
}

/** A chat by id, or the person's live chat (not archived, else the newest). */
export async function chatFor(
  ctx: ToolContext,
  ref: { chatId?: string; personId?: string },
): Promise<CoffeeChat | undefined> {
  if (ref.chatId) return requireChat(ctx, ref.chatId);
  if (!ref.personId) return undefined;
  const chats = await db.chats.where('personId').equals(ref.personId).toArray();
  return chats.find((c) => c.stage !== 'archived') ?? chats[0];
}

export async function peopleById(ids: Iterable<string>): Promise<Map<string, Person>> {
  const list = [...new Set(ids)].filter(Boolean);
  const rows = list.length ? await db.people.bulkGet(list) : [];
  return new Map(rows.filter((p): p is Person => !!p).map((p) => [p.id, p]));
}
