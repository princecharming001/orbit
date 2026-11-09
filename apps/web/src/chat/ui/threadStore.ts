/**
 * The chat thread as the UI sees it: the current conversation, its turns, and whether a turn is running. It lives
 * outside React so the thread survives moving to another page and back, and a running turn keeps streaming while
 * the student looks at Today. A turn belongs to its conversation, not to the screen: opening another chat or a new
 * one leaves it running, and coming back shows it where it is. Only Stop ends it. The engine stays the source of
 * truth: opening a conversation loads it from there.
 */

import { useSyncExternalStore } from 'react';
import { withoutButtonTalk } from '../agent/buttonTalk';
import { isOrbitNote } from '../agent/orbitNote';
import { SETUP_CHIPS } from '../agent/setupChips';
import { webSources } from '../agent/webSearch';
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
/** Claude searched the web: what for, and what it found (the sources the answer leans on) */
export interface WebBlock {
  type: 'web';
  id: string;
  query?: string;
  sources: { title: string; url: string }[];
  status: 'searching' | 'done' | 'failed';
}
export type Block = TextBlock | ProgressBlock | ToolBlock | WebBlock;
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
/** a turn still running, by conversation: its own copy of the turns, so it keeps going while another chat is open */
interface LiveTurn {
  conversation: ChatConversation;
  turns: Turn[];
  controller: AbortController;
}
const live = new Map<string, LiveTurn>();
/** the conversation each running assistant turn belongs to */
const turnHome = new Map<string, string>();
let seq = 0;
const id = () => `t_${++seq}_${Date.now().toString(36)}`;

function set(patch: Partial<ThreadState> | ((s: ThreadState) => Partial<ThreadState>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  // a change to the open chat's turns (an approval, a cancel) reaches its running copy too
  const l = state.conversation ? live.get(state.conversation.id) : undefined;
  if (l && next.turns) l.turns = state.turns;
  for (const fn of listeners) fn();
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
  for (const l of live.values()) l.controller.abort();
  live.clear();
  turnHome.clear();
  set({ conversation: undefined, temporary: false, turns: [], running: false });
}

/** Whether a turn is still running in this conversation (the sidebar can mark it). */
export function isRunning(conversationId: string | undefined): boolean {
  return !!conversationId && live.has(conversationId);
}

const autoOpenListeners = new Set<(href: string) => void>();
/** Called with the in-app route when a live tool result asks to be shown in the side panel (never for stored history). */
export function subscribeAutoOpen(l: (href: string) => void): () => void {
  autoOpenListeners.add(l);
  return () => autoOpenListeners.delete(l);
}

function updateTurn(turnId: string, fn: (t: AssistantTurn) => AssistantTurn) {
  const map = (turns: Turn[]) => turns.map((t) => (t.id === turnId && t.role === 'assistant' ? fn(t) : t));
  const home = turnHome.get(turnId);
  const l = home ? live.get(home) : undefined;
  if (l) l.turns = map(l.turns);
  // the screen shows it only while its conversation is the open one
  if (!home || state.conversation?.id === home) set((s) => ({ turns: l ? l.turns : map(s.turns) }));
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
    case 'tool_result': {
      // a side panel opens only for the chat on screen, never for one running in the background
      const home = turnHome.get(turnId);
      if (e.envelope.autoOpen && e.envelope.href && (!home || state.conversation?.id === home))
        for (const l of autoOpenListeners) l(e.envelope.href);
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
    }
    case 'web_search':
      updateTurn(turnId, (t) =>
        t.blocks.some((b) => b.type === 'web' && b.id === e.id)
          ? {
              ...t,
              blocks: t.blocks.map((b) => (b.type === 'web' && b.id === e.id ? { ...b, query: e.query } : b)),
            }
          : {
              ...t,
              blocks: [
                ...t.blocks,
                { type: 'web', id: e.id, query: e.query, sources: [], status: 'searching' },
              ],
            },
      );
      break;
    case 'web_results':
      updateTurn(turnId, (t) => {
        const status = e.failed ? ('failed' as const) : ('done' as const);
        const found = t.blocks.some((b) => b.type === 'web' && b.id === e.id);
        return {
          ...t,
          blocks: found
            ? t.blocks.map((b) =>
                b.type === 'web' && b.id === e.id ? { ...b, sources: e.sources, status } : b,
              )
            : [...t.blocks, { type: 'web', id: e.id, sources: e.sources, status }],
        };
      });
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

/**
 * Rebuilds turns from what the engine stored (whole content block arrays, plus the actions by tool_use id). One answer
 * is often several stored assistant messages (a card, then the reply chips, then the words after a tool result or a
 * nudge): they read as the one turn they were live, so a conversation opened later reads the way it did then, with no
 * empty turn and no row of buttons between its parts.
 */
export function hydrate(messages: ChatMessage[], actions: ChatAction[]): Turn[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const turns: Turn[] = [];
  // the answer being built: assistant messages join it until the student says something or a line is drawn
  let open: AssistantTurn | undefined;
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (m.meta === 'snapshot' || m.meta === 'memory') continue;
    if (m.meta === 'decision' || m.meta === 'error') {
      open = undefined;
      turns.push({
        id: m.id,
        role: m.meta === 'decision' ? 'decision' : 'note',
        text: textOf(m.content),
        at: m.createdAt,
      });
      continue;
    }
    // Orbit's own note to the model (the nudge for words after a turn of cards alone): not the student's, so no
    // bubble, and the answer it asked for goes on in the same turn, as it read live
    if (isOrbitNote(m)) continue;
    if (m.role === 'user') {
      // the agent's own user-role rows (tool results, a follow-up it asked itself for) have no words of the
      // student's: nothing to draw, not an empty bubble, and the answer goes on
      const text = textOf(m.content).trim();
      if (text) {
        open = undefined;
        turns.push({ id: m.id, role: 'user', text, at: m.createdAt });
      }
      continue;
    }
    if (m.role !== 'assistant') continue;
    const blocks: Block[] = [];
    for (const raw of Array.isArray(m.content) ? m.content : [m.content]) {
      const b = raw as {
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: { query?: unknown };
        tool_use_id?: string;
        content?: unknown;
      };
      // a sentence about the buttons was never shown live, and is not shown when the chat is opened again
      if (b?.type === 'text' && b.text) {
        const text = withoutButtonTalk(b.text);
        if (text.trim()) blocks.push({ type: 'text', text });
      }
      // Claude's web search, as it read live: the query, then the sources it found
      else if (b?.type === 'server_tool_use' && b.name === 'web_search' && b.id)
        blocks.push({
          type: 'web',
          id: b.id,
          query: typeof b.input?.query === 'string' ? b.input.query : undefined,
          sources: [],
          status: 'searching',
        });
      else if (b?.type === 'web_search_tool_result' && b.tool_use_id) {
        const web = [...(open?.blocks ?? []), ...blocks].find(
          (x): x is WebBlock => x.type === 'web' && x.id === b.tool_use_id,
        );
        const sources = webSources(b.content);
        const status = Array.isArray(b.content) ? ('done' as const) : ('failed' as const);
        if (web) Object.assign(web, { sources, status });
        else blocks.push({ type: 'web', id: b.tool_use_id, sources, status });
      } else if (b?.type === 'tool_use' && b.id) {
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
    const stopped = m.stopReason === 'aborted';
    if (open) {
      open.blocks.push(...blocks);
      if (stopped) open.status = 'stopped';
      continue;
    }
    // a message with nothing to draw (only the model's thinking) starts no turn of its own
    if (!blocks.length && !stopped) continue;
    open = { id: m.id, role: 'assistant', blocks, status: stopped ? 'stopped' : 'done', at: m.createdAt };
    turns.push(open);
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
    if (state.conversation && live.has(state.conversation.id)) return;
    const c = await ensureConversation();
    if (live.has(c.id)) return;
    const controller = new AbortController();
    const assistant: AssistantTurn = {
      id: id(),
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      at: new Date().toISOString(),
    };
    const turns: Turn[] = [
      ...state.turns,
      { id: id(), role: 'user', text: userText, at: new Date().toISOString() },
      assistant,
    ];
    live.set(c.id, { conversation: c, turns, controller });
    turnHome.set(assistant.id, c.id);
    set({ running: true, turns });
    // a new chat is in Recent from its first word, named by then: a student who leaves during the first answer can
    // see it is still working and go back to it
    let listed = false;
    try {
      await go(
        c.id,
        (e) => {
          if (!listed) {
            listed = true;
            set((s) => ({ historyVersion: s.historyVersion + 1 }));
          }
          applyEvent(assistant.id, e);
        },
        controller.signal,
      );
    } catch (err) {
      applyEvent(assistant.id, {
        type: 'error',
        kind: 'other',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const l = live.get(c.id);
      live.delete(c.id);
      turnHome.delete(assistant.id);
      const finish = (ts: Turn[]) =>
        ts.map((t) =>
          t.id === assistant.id && t.role === 'assistant' && t.status === 'streaming'
            ? { ...t, status: 'done' as const }
            : t,
        );
      set((s) =>
        s.conversation?.id === c.id
          ? { running: false, historyVersion: s.historyVersion + 1, turns: finish(l?.turns ?? s.turns) }
          : { historyVersion: s.historyVersion + 1 },
      );
    }
  }
  /** Shows a conversation: its running turn as it is now when one is going, else what the engine stored. */
  function show(conversation: ChatConversation | undefined, turns: Turn[], temporary: boolean) {
    const l = conversation ? live.get(conversation.id) : undefined;
    set({ conversation, turns: l ? l.turns : turns, running: !!l, temporary });
  }
  return {
    newChat() {
      // a turn still running in the chat being left keeps going; it is there when the student opens it again
      show(undefined, [], state.temporary);
    },
    setTemporary(on: boolean) {
      // a temporary chat is its own conversation: switching starts fresh either way
      show(undefined, [], on);
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
      if (state.conversation) live.get(state.conversation.id)?.controller.abort();
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
      const running = live.get(conversationId);
      if (running) return show(running.conversation, running.turns, false);
      const { conversation, messages, actions } = await engine.loadConversation(conversationId);
      show(conversation, hydrate(messages, actions), false);
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
    async pin(conversationId: string, pinned: boolean) {
      await engine.pinConversation(conversationId, pinned);
      set((s) => ({ historyVersion: s.historyVersion + 1 }));
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
