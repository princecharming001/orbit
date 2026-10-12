import type Anthropic from '@anthropic-ai/sdk';
import { newId } from '@orbit/core';
import Dexie from 'dexie';
import { db } from '../../db/schema';
import type { ChatAction, ChatConversation, ChatMessage } from '../types';

/**
 * Append-only persistence for the chat. Messages are stored as whole API content block arrays (thinking, tool_use,
 * tool_result, compaction and fallback blocks included) so the history replays byte for byte: the prompt cache and
 * the preserved-thinking prefix check both depend on that. Rows are never updated or deleted; a correction is a new
 * row. Temporary conversations live in memory only: the same API, nothing in Dexie, gone with the tab.
 */
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export interface AppendInput {
  role: ChatMessage['role'];
  content: unknown;
  meta?: ChatMessage['meta'];
  model?: string;
  usage?: ChatMessage['usage'];
  stopReason?: string;
}

/** The untrusted-content nonce of a conversation: derived from its random id, so it is stable without a column. */
export function conversationNonce(conversationId: string): string {
  const body = conversationId.slice(conversationId.indexOf('_') + 1);
  const hex = body.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return (hex + '0'.repeat(16)).slice(0, 16);
}

/**
 * Dexie propagates an open transaction to every promise continuation started inside it. The chat store is called from
 * the SDK tool runner's own promise chain, so a leaked zone would make the next `db.transaction` wait forever. Every
 * Dexie call here runs outside any inherited zone.
 */
function outside<T>(fn: () => Promise<T>): Promise<T> {
  return Dexie.ignoreTransaction(fn);
}

interface TemporaryConversation {
  conversation: ChatConversation;
  messages: ChatMessage[];
  actions: Map<string, ChatAction>;
}

export class ChatStore {
  private temporary = new Map<string, TemporaryConversation>();

  isTemporary(conversationId: string): boolean {
    return this.temporary.has(conversationId);
  }

  async createConversation(opts: {
    userId: string;
    model: string;
    temporary: boolean;
    title?: string;
    now?: Date;
  }): Promise<ChatConversation> {
    const at = (opts.now ?? new Date()).toISOString();
    const conversation: ChatConversation = {
      id: newId('conv'),
      userId: opts.userId,
      title: opts.title ?? 'New chat',
      model: opts.model,
      createdAt: at,
      updatedAt: at,
    };
    if (opts.temporary) {
      this.temporary.set(conversation.id, { conversation, messages: [], actions: new Map() });
    } else {
      await outside(() => db.chatConversations.add(conversation));
    }
    return conversation;
  }

  async getConversation(id: string): Promise<ChatConversation | undefined> {
    return this.temporary.get(id)?.conversation ?? (await outside(() => db.chatConversations.get(id)));
  }

  /** Saved conversations that are not archived, newest activity first. Temporary ones are not listed. */
  async listConversations(userId: string): Promise<ChatConversation[]> {
    const rows = await outside(() => db.chatConversations.where('userId').equals(userId).toArray());
    return rows.filter((c) => !c.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const t = this.temporary.get(id);
    const clean = title.trim().slice(0, 120) || 'New chat';
    if (t) {
      t.conversation = { ...t.conversation, title: clean };
      return;
    }
    await outside(() => db.chatConversations.update(id, { title: clean }));
  }

  async archiveConversation(id: string, now = new Date()): Promise<void> {
    const t = this.temporary.get(id);
    if (t) {
      this.temporary.delete(id);
      return;
    }
    await outside(() => db.chatConversations.update(id, { archivedAt: now.toISOString() }));
  }

  /** Append one message with the next sequence number. Never updates or removes an earlier row. */
  async append(conversationId: string, input: AppendInput, now = new Date()): Promise<ChatMessage> {
    const at = now.toISOString();
    const t = this.temporary.get(conversationId);
    if (t) {
      const seq = (t.messages.at(-1)?.seq ?? 0) + 1;
      const row: ChatMessage = {
        id: newId('cm'),
        conversationId,
        userId: t.conversation.userId,
        seq,
        createdAt: at,
        ...input,
      };
      t.messages.push(row);
      t.conversation = { ...t.conversation, updatedAt: at };
      return row;
    }
    return outside(() =>
      db.transaction('rw', db.chatMessages, db.chatConversations, async () => {
        const conv = await db.chatConversations.get(conversationId);
        if (!conv) throw new Error(`unknown conversation ${conversationId}`);
        const last = await db.chatMessages
          .where('[conversationId+seq]')
          .between([conversationId, -Infinity], [conversationId, Infinity])
          .last();
        const row: ChatMessage = {
          id: newId('cm'),
          conversationId,
          userId: conv.userId,
          seq: (last?.seq ?? 0) + 1,
          createdAt: at,
          ...input,
        };
        await db.chatMessages.add(row);
        await db.chatConversations.update(conversationId, { updatedAt: at });
        return row;
      }),
    );
  }

  /** Every stored row of a conversation in order. */
  async messages(conversationId: string): Promise<ChatMessage[]> {
    const t = this.temporary.get(conversationId);
    if (t) return [...t.messages];
    return outside(() =>
      db.chatMessages
        .where('[conversationId+seq]')
        .between([conversationId, -Infinity], [conversationId, Infinity])
        .toArray(),
    );
  }

  /**
   * The rows that go back to the API before the next student turn. Failed-turn notes (`meta: 'error'`) are for the
   * thread only. A `system` row must be followed by an assistant turn, so a snapshot left orphaned by a turn that
   * failed before the model answered is left out as well (the row stays; append-only). Everything else replays
   * verbatim.
   */
  async replayableRows(conversationId: string): Promise<ChatMessage[]> {
    const rows = (await this.messages(conversationId)).filter((r) => r.meta !== 'error');
    return rows.filter((r, i) => r.role !== 'system' || rows[i + 1]?.role === 'assistant');
  }

  /** The API history: replayable rows mapped verbatim to `BetaMessageParam`. */
  async history(conversationId: string): Promise<BetaMessageParam[]> {
    const rows = await this.replayableRows(conversationId);
    return rows.map((r) => ({ role: r.role, content: r.content as BetaMessageParam['content'] }));
  }

  /** The text of the last snapshot the model will see again, if any (an orphaned one does not count). */
  async lastSnapshotText(conversationId: string): Promise<string | undefined> {
    const rows = await this.replayableRows(conversationId);
    const snap = [...rows].reverse().find((r) => r.meta === 'snapshot');
    if (!snap) return undefined;
    const content = snap.content as BetaContentBlockParam[] | string;
    if (typeof content === 'string') return content;
    return content.find((b) => b.type === 'text')?.text;
  }

  // ---- actions (tool executions and pending confirmations) ----

  async putAction(action: ChatAction): Promise<void> {
    const t = this.temporary.get(action.conversationId);
    if (t) {
      t.actions.set(action.id, action);
      return;
    }
    await outside(() => db.chatActions.put(action));
  }

  async getAction(id: string): Promise<ChatAction | undefined> {
    for (const t of this.temporary.values()) {
      const a = t.actions.get(id);
      if (a) return a;
    }
    return outside(() => db.chatActions.get(id));
  }

  async updateAction(
    id: string,
    changes: Partial<ChatAction>,
    now = new Date(),
  ): Promise<ChatAction | undefined> {
    const current = await this.getAction(id);
    if (!current) return undefined;
    const next = { ...current, ...changes, updatedAt: now.toISOString() };
    await this.putAction(next);
    return next;
  }

  async actions(conversationId: string): Promise<ChatAction[]> {
    const t = this.temporary.get(conversationId);
    if (t) return [...t.actions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return outside(() => db.chatActions.where('conversationId').equals(conversationId).sortBy('createdAt'));
  }
}

// ---- helpers over stored content ----

/** The `tool_use` blocks of an assistant message's content, in order. */
export function toolUsesOf(content: unknown): Anthropic.Beta.BetaToolUseBlockParam[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b?.type === 'tool_use');
}

/** The `tool_result` blocks of a user message's content. */
export function toolResultsOf(content: unknown): Anthropic.Beta.BetaToolResultBlockParam[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => b?.type === 'tool_result');
}

/**
 * The invariant the loop maintains: every stored `tool_use` is answered by a `tool_result` in the next stored
 * message of the conversation. Returns the ids that are not, so a test (or a repair) can see them.
 */
export function unpairedToolUses(rows: Pick<ChatMessage, 'role' | 'content'>[]): string[] {
  const missing: string[] = [];
  rows.forEach((row, i) => {
    if (row.role !== 'assistant') return;
    const uses = toolUsesOf(row.content);
    if (!uses.length) return;
    const answered = new Set(toolResultsOf(rows[i + 1]?.content).map((r) => r.tool_use_id));
    for (const u of uses) if (!answered.has(u.id)) missing.push(u.id);
  });
  return missing;
}
