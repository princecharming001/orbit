/**
 * The chat thread as the UI sees it: the current conversation, its turns, and whether a turn is running. It lives
 * outside React so the thread survives moving to another page and back, and a running turn keeps streaming while
 * the student looks at Today. The engine stays the source of truth: opening a conversation loads it from there.
 */
import { useSyncExternalStore } from 'react';
import { SETUP_CHIPS } from '../agent/setupChips';
import type {
  ChatAction,
  ChatConversation,
  ChatEngine,
  ChatMessage,
  ResultEnvelope,
  TurnEvent,
} from '../types';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ProgressBlock {
  type: 'progress';
  text: string;
}
export interface ToolBlock {
  type: 'tool';
  toolUseId: string;
  toolName: string;
  progress?: string;
  envelope?: ResultEnvelope;
  status: 'running' | 'done' | 'pending' | 'approved' | 'cancelled';
  /** what Approve produced, shown in place of the confirmation */
  outcome?: ResultEnvelope;
}
export type Block = TextBlock | ProgressBlock | ToolBlock;
export type ErrorKind = Extract<TurnEvent, { type: 'error' }>['kind'];

export interface UserTurn {
  id: string;
  role: 'user';
  text: string;
  at: string;
}
export interface AssistantTurn {
  id: string;
  role: 'assistant';
  blocks: Block[];
  status: 'streaming' | 'done' | 'error' | 'stopped';
  error?: { message: string; kind: ErrorKind };
  at: string;
}
export interface LineTurn {
  id: string;
  role: 'decision' | 'note';
  text: string;
  at: string;
}
export type Turn = UserTurn | AssistantTurn | LineTurn;

export interface ThreadState {
  conversation?: ChatConversation;
  temporary: boolean;
  turns: Turn[];
  running: boolean;
  /** bumps when the history list may have changed (a turn ended, a rename, an archive) */
  historyVersion: number;
}

let state: ThreadState = { temporary: false, turns: [], running: false, historyVersion: 0 };
const listeners = new Set<() => void>();
let controller: AbortController | undefined;
let seq = 0;
const id = () => `t_${++seq}_${Date.now().toString(36)}`;

function set(patch: Partial<ThreadState> | ((s: ThreadState) => Partial<ThreadState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useThread(): ThreadState {
  return useSyncExternalStore(subscribe, () => state);
}
export function getThread(): ThreadState {
  return state;
}
/** tests only */
export function resetThread() {
  controller?.abort();
  controller = undefined;
  set({ conversation: undefined, temporary: false, turns: [], running: false });
}

const autoOpenListeners = new Set<(href: string) => void>();
/** Called with the in-app route when a live tool result asks to be shown in the side panel (never for stored history). */
export function subscribeAutoOpen(l: (href: string) => void): () => void {
  autoOpenListeners.add(l);
  return () => autoOpenListeners.delete(l);
}

function updateTurn(turnId: string, fn: (t: AssistantTurn) => AssistantTurn) {
  set((s) => ({
    turns: s.turns.map((t) => (t.id === turnId && t.role === 'assistant' ? fn(t) : t)),
  }));
}

/** Folds one engine event into the assistant turn it belongs to. Exported for the tests. */
export function applyEvent(turnId: string, e: TurnEvent) {
  switch (e.type) {
    case 'text':
      updateTurn(turnId, (t) => {
        const last = t.blocks[t.blocks.length - 1];
        const blocks =
          last?.type === 'text'
            ? [...t.blocks.slice(0, -1), { type: 'text' as const, text: last.text + e.delta }]
            : [...t.blocks, { type: 'text' as const, text: e.delta }];
        return { ...t, blocks };
      });
      break;
    case 'progress':
      updateTurn(turnId, (t) => ({ ...t, blocks: [...t.blocks, { type: 'progress', text: e.text }] }));
      break;
    case 'tool_start':
      updateTurn(turnId, (t) => ({
        ...t,
        blocks: [
          ...t.blocks,
          {
            type: 'tool',
            toolUseId: e.toolUseId,
            toolName: e.toolName,
            progress: e.progress,
            status: 'running',
          },
        ],
      }));
      break;
    case 'tool_result':
      if (e.envelope.autoOpen && e.envelope.href) for (const l of autoOpenListeners) l(e.envelope.href);
      updateTurn(turnId, (t) => ({
        ...t,
        blocks: t.blocks.map((b) =>
          b.type === 'tool' && b.toolUseId === e.toolUseId
            ? {
                ...b,
                envelope: e.envelope,
                status: e.envelope.kind === 'needs_confirmation' ? 'pending' : 'done',
              }
            : b,
        ),
      }));
      break;
    case 'done':
      updateTurn(turnId, (t) => ({ ...t, status: 'done' }));
      break;
    case 'error':
      updateTurn(turnId, (t) =>
        e.kind === 'aborted'
          ? { ...t, status: 'stopped' }
          : { ...t, status: 'error', error: { message: e.message, kind: e.kind } },
      );
      break;
  }
}

/** Rebuilds turns from what the engine stored (whole content block arrays, plus the actions by tool_use id). */
export function hydrate(messages: ChatMessage[], actions: ChatAction[]): Turn[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const turns: Turn[] = [];
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (m.meta === 'snapshot') continue;
    if (m.meta === 'decision' || m.meta === 'error') {
      turns.push({
        id: m.id,
        role: m.meta === 'decision' ? 'decision' : 'note',
        text: textOf(m.content),
        at: m.createdAt,
      });
      continue;
    }
    if (m.role === 'user') {
      // the agent's own user-role rows (tool results, a follow-up it asked itself for) have no words of the
      // student's: nothing to draw, not an empty bubble
      const text = textOf(m.content).trim();
      if (text) turns.push({ id: m.id, role: 'user', text, at: m.createdAt });
      continue;
    }
    if (m.role !== 'assistant') continue;
    const blocks: Block[] = [];
    for (const raw of Array.isArray(m.content) ? m.content : [m.content]) {
      const b = raw as { type?: string; text?: string; id?: string; name?: string };
      if (b?.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
      else if (b?.type === 'tool_use' && b.id) {
        const a = byId.get(b.id);
        blocks.push({
          type: 'tool',
          toolUseId: b.id,
          toolName: b.name ?? a?.toolName ?? 'tool',
          envelope: a?.envelope,
          status:
            a?.status === 'pending'
              ? 'pending'
              : a?.status === 'cancelled'
                ? 'cancelled'
                : a?.envelope?.kind === 'needs_confirmation' && a?.status === 'done'
                  ? 'approved'
                  : 'done',
        });
      }
    }
    turns.push({
      id: m.id,
      role: 'assistant',
      blocks,
      status: m.stopReason === 'aborted' ? 'stopped' : 'done',
      at: m.createdAt,
    });
  }
  return turns;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('');
  return '';
}

/** The actions the page and the shell call. They take the engine from wherever the caller got it. */
export function threadActions(engine: ChatEngine) {
  async function ensureConversation(): Promise<ChatConversation> {
    if (state.conversation) return state.conversation;
    const c = await engine.startConversation({ temporary: state.temporary });
    set({ conversation: c });
    return c;
  }
  async function turn(
    userText: string,
    go: (conversationId: string, onEvent: (e: TurnEvent) => void, signal: AbortSignal) => Promise<void>,
  ) {
    if (state.running) return;
    const c = await ensureConversation();
    controller = new AbortController();
    const assistant: AssistantTurn = {
      id: id(),
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      at: new Date().toISOString(),
    };
    set((s) => ({
      running: true,
      turns: [
        ...s.turns,
        { id: id(), role: 'user', text: userText, at: new Date().toISOString() },
        assistant,
      ],
    }));
    try {
      await go(c.id, (e) => applyEvent(assistant.id, e), controller.signal);
    } catch (err) {
      applyEvent(assistant.id, {
        type: 'error',
        kind: 'other',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      controller = undefined;
      set((s) => ({
        running: false,
        historyVersion: s.historyVersion + 1,
        turns: s.turns.map((t) =>
          t.id === assistant.id && t.role === 'assistant' && t.status === 'streaming'
            ? { ...t, status: 'done' }
            : t,
        ),
      }));
    }
  }
  return {
    newChat() {
      controller?.abort();
      set({ conversation: undefined, turns: [], running: false });
    },
    setTemporary(on: boolean) {
      // a temporary chat is its own conversation: switching starts fresh either way
      controller?.abort();
      set({ temporary: on, conversation: undefined, turns: [], running: false });
    },
    send: (text: string) => turn(text, (cid, on, signal) => engine.send(cid, text, on, signal)),
    runChip(chipId: string) {
      const chip = [...engine.chips(), ...SETUP_CHIPS].find((c) => c.id === chipId);
      return turn(chip?.asUser ?? chipId, (cid, on) => engine.runChip(cid, chipId, on));
    },
    /** the home's Connect buttons: post the LinkedIn or Gmail setup widget into the thread */
    connect(what: 'linkedin' | 'google') {
      return this.runChip(what === 'linkedin' ? 'connect-linkedin' : 'connect-gmail');
    },
    attach(file: File, kind: 'note' | 'resume' | 'linkedin' | 'email') {
      const label = {
        note: 'a note',
        resume: 'my resume',
        linkedin: 'my LinkedIn connections',
        email: 'an email',
      }[kind];
      return turn(`Attached ${label}: ${file.name}`, (cid, on) => engine.attach(cid, file, kind, on));
    },
    stop() {
      controller?.abort();
    },
    /** re-asks the student's message before this assistant turn */
    retry(turnId: string) {
      const i = state.turns.findIndex((t) => t.id === turnId);
      const prev = state.turns
        .slice(0, i)
        .reverse()
        .find((t): t is UserTurn => t.role === 'user');
      if (prev) return this.send(prev.text);
    },
    async approve(
      toolUseId: string,
      edited?: { body: string; subject?: string },
    ): Promise<string | undefined> {
      const block = findTool(toolUseId);
      if (!block) return 'That card is gone.';
      const actionId = block.envelope?.confirmationId ?? toolUseId;
      const result = await engine.approve(actionId, edited);
      if (result.kind === 'error') return result.summary;
      // these replace or clear this browser's data (the chat included): start the app again where the result points
      const tool = (block.envelope?.data as { toolName?: string } | undefined)?.toolName ?? block.toolName;
      if (RESTARTS.has(tool) && typeof window !== 'undefined') {
        window.location.assign(`${import.meta.env.BASE_URL}${(result.href ?? '/').replace(/^\//, '')}`);
        return undefined;
      }
      set((s) => ({
        historyVersion: s.historyVersion + 1,
        turns: [
          ...s.turns.map((t) =>
            t.role === 'assistant'
              ? {
                  ...t,
                  blocks: t.blocks.map((b) =>
                    b.type === 'tool' && b.toolUseId === toolUseId
                      ? { ...b, status: 'approved' as const, outcome: result }
                      : b,
                  ),
                }
              : t,
          ),
          {
            id: id(),
            role: 'decision',
            text: `Approved: ${block.envelope?.summary ?? result.summary}`,
            at: new Date().toISOString(),
          },
        ],
      }));
      return undefined;
    },
    async cancel(toolUseId: string) {
      const block = findTool(toolUseId);
      if (!block) return;
      await engine.cancel(block.envelope?.confirmationId ?? toolUseId);
      set((s) => ({
        turns: [
          ...s.turns.map((t) =>
            t.role === 'assistant'
              ? {
                  ...t,
                  blocks: t.blocks.map((b) =>
                    b.type === 'tool' && b.toolUseId === toolUseId
                      ? { ...b, status: 'cancelled' as const }
                      : b,
                  ),
                }
              : t,
          ),
          {
            id: id(),
            role: 'decision',
            text: `Cancelled: ${block.envelope?.summary ?? block.toolName}`,
            at: new Date().toISOString(),
          },
        ],
      }));
    },
    async open(conversationId: string) {
      if (state.conversation?.id === conversationId && state.running) return;
      controller?.abort();
      const { conversation, messages, actions } = await engine.loadConversation(conversationId);
      set({ conversation, turns: hydrate(messages, actions), running: false, temporary: false });
    },
    /** refreshes the open conversation from the engine (on returning to the page) */
    async refresh() {
      const c = state.conversation;
      if (!c || state.running) return;
      try {
        const { conversation, messages, actions } = await engine.loadConversation(c.id);
        if (state.conversation?.id === c.id && !state.running)
          set({ conversation, turns: hydrate(messages, actions) });
      } catch {
        // the engine forgot it (a temporary chat after a reload): keep what the store has
      }
    },
    async rename(conversationId: string, title: string) {
      await engine.renameConversation(conversationId, title);
      set((s) => ({
        historyVersion: s.historyVersion + 1,
        conversation: s.conversation?.id === conversationId ? { ...s.conversation, title } : s.conversation,
      }));
    },
    async archive(conversationId: string) {
      await engine.archiveConversation(conversationId);
      if (state.conversation?.id === conversationId) this.newChat();
      set((s) => ({ historyVersion: s.historyVersion + 1 }));
    },
  };
}

/** Approving one of these wipes or swaps the local data, so the page reloads on the result's route. */
const RESTARTS = new Set(['load_demo', 'leave_demo', 'delete_all_data']);

function findTool(toolUseId: string): ToolBlock | undefined {
  for (const t of state.turns)
    if (t.role === 'assistant')
      for (const b of t.blocks) if (b.type === 'tool' && b.toolUseId === toolUseId) return b;
  return undefined;
}
