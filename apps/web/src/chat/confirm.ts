import { newId } from '@orbit/core';
import { db } from '../db/schema';
import type { ChatAction, ToolContext } from './types';

/** A pending confirmation is good for this long; after that the Approve button must ask again. */
export const CONFIRMATION_TTL_MS = 15 * 60_000;

/** Stable JSON: keys sorted, undefined dropped, so the same input always binds to the same text. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * What a token is bound to. For send_draft only the draft id: the text the student approves is bound by
 * approveAndSend's hash, and the Approve card may still edit it before approving.
 */
export function bindingInput(toolName: string, input: unknown): unknown {
  if (toolName === 'send_draft' && input && typeof input === 'object')
    return { draftId: (input as { draftId?: unknown }).draftId };
  return input;
}

export function bindingKey(toolName: string, input: unknown): string {
  return canonicalJson(bindingInput(toolName, input));
}

/** Store a pending confirmation the Approve button will present. */
export async function createConfirmation(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
  summary: string,
  blockedReason?: string,
): Promise<ChatAction> {
  const now = ctx.now.getTime();
  const row: ChatAction = {
    id: `conf_${newId('')}`,
    conversationId: ctx.conversationId,
    userId: ctx.user.id,
    toolName,
    input,
    status: 'pending',
    summary,
    blockedReason,
    expiresAt: new Date(now + CONFIRMATION_TTL_MS).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  await db.chatActions.add(row);
  return row;
}

export type ConfirmFailure =
  | 'no_token'
  | 'unknown'
  | 'other_conversation'
  | 'other_tool'
  | 'input_mismatch'
  | 'expired'
  | 'used'
  | 'cancelled';

export type ConfirmCheck =
  | { ok: true; action: ChatAction }
  /** `action` is the row when one exists (a used token still points at its stored result) */
  | { ok: false; reason: ConfirmFailure; action?: ChatAction };

/** Why a token was refused, in the student's words. */
export const CONFIRM_FAILURE_TEXT: Record<Exclude<ConfirmFailure, 'no_token'>, string> = {
  unknown: 'That approval is not one Orbit knows. Ask again and approve the new card.',
  other_conversation: 'That approval belongs to another conversation. Ask again here.',
  other_tool: 'That approval was for a different action. Ask again and approve the new card.',
  input_mismatch: 'What was approved is not what is being run now. Ask again and approve the new card.',
  expired: 'That approval expired. Ask again and approve the new card.',
  used: 'That approval was already used. Nothing was done twice.',
  cancelled: 'That approval was cancelled. Ask again if you still want it.',
};

/**
 * Is the token the UI presented good for this call? Single use, 15 minutes, bound to the conversation, the tool and
 * the input (the draft id only for send_draft).
 */
export async function checkConfirmation(
  ctx: ToolContext,
  toolName: string,
  input: unknown,
): Promise<ConfirmCheck> {
  if (!ctx.confirmation) return { ok: false, reason: 'no_token' };
  const row = await db.chatActions.get(ctx.confirmation);
  if (!row?.id.startsWith('conf_')) return { ok: false, reason: 'unknown' };
  if (row.conversationId !== ctx.conversationId) return { ok: false, reason: 'other_conversation' };
  if (row.toolName !== toolName) return { ok: false, reason: 'other_tool' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (row.status === 'expired') return { ok: false, reason: 'expired' };
  if (row.status !== 'pending') return { ok: false, reason: 'used', action: row };
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= ctx.now.getTime()) {
    await db.chatActions.update(row.id, { status: 'expired', updatedAt: ctx.now.toISOString() });
    return { ok: false, reason: 'expired' };
  }
  if (bindingKey(toolName, row.input) !== bindingKey(toolName, input))
    return { ok: false, reason: 'input_mismatch' };
  return { ok: true, action: row };
}

/** The student pressed Cancel. */
export async function cancelConfirmation(id: string, now = new Date()): Promise<boolean> {
  const row = await db.chatActions.get(id);
  if (row?.status !== 'pending') return false;
  await db.chatActions.update(id, { status: 'cancelled', updatedAt: now.toISOString() });
  return true;
}

/** Mark every pending confirmation past its time as expired (the UI calls this when a conversation opens). */
export async function expireStaleConfirmations(conversationId: string, now = new Date()): Promise<number> {
  const rows = await db.chatActions
    .where('conversationId')
    .equals(conversationId)
    .filter(
      (r) => r.status === 'pending' && !!r.expiresAt && new Date(r.expiresAt).getTime() <= now.getTime(),
    )
    .toArray();
  for (const r of rows)
    await db.chatActions.update(r.id, { status: 'expired', updatedAt: now.toISOString() });
  return rows.length;
}
