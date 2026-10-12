import type Anthropic from '@anthropic-ai/sdk';
import type { User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db } from '../../db/schema';
import { MODEL, makeWrap } from '../../integrations/anthropic';
import { refreshPrefs } from '../../integrations/prefs';
import type {
  ChatAction,
  ChatConversation,
  ChatEngine,
  ChatMessage,
  ChipSpec,
  ResultEnvelope,
  ToolContext,
  ToolSpec,
  TurnEvent,
} from '../types';
import { recordToolAction } from './actions';
import { chipsFor, resolveChip } from './chips';
import { type ChatClient, chatClient } from './client';
import { type ExecuteFn, runTurn } from './loop';
import { chatMode, chatModeNote, SETTINGS_ROUTE } from './mode';
import type { MatchablePerson } from './people-match';
import { type RouterIntent, routeUtterance } from './router';
import { ChatStore, conversationNonce } from './store';

export { CHAT_BETAS, MAX_ITERATIONS, MAX_TOKENS, runTurn } from './loop';
export { chatMode, chatModeNote } from './mode';
export { ChatStore } from './store';

export interface ChatEngineDeps {
  registry: ReadonlyMap<string, ToolSpec>;
  execute: ExecuteFn;
  /** the signed-in student; a getter so the engine follows the session */
  user: User | (() => User);
  store?: ChatStore;
  client?: () => ChatClient | undefined;
  now?: () => Date;
  /** pins effort 'low' instead of 'medium'; a getter follows the composer's Smart / Quick switch */
  quick?: boolean | (() => boolean);
  prefixMismatch?: 'drop_block' | 'error';
}

const MODEL_CHANGED =
  'This chat was started on a different model, so it cannot continue. Start a new chat; your earlier chats stay in the list.';

/** The engine the UI talks to: one object that fronts the Claude loop, the no-key router, chips and approvals. */
export function createChatEngine(deps: ChatEngineDeps): ChatEngine {
  const store = deps.store ?? new ChatStore();
  const clock = deps.now ?? (() => new Date());
  // a File does not survive every storage round trip, so an attachment waiting for approval keeps its live input here
  const liveInputs = new Map<string, unknown>();
  const getUser = () => (typeof deps.user === 'function' ? deps.user() : deps.user);
  const getClient = deps.client ?? (() => chatClient());

  const toolContext = (
    conversationId: string,
    caller: ToolContext['caller'],
    extra: Partial<ToolContext> = {},
  ) => {
    const nonce = conversationNonce(conversationId);
    return {
      user: getUser(),
      now: clock(),
      conversationId,
      nonce,
      wrap: makeWrap(nonce).wrap,
      caller,
      ...extra,
    } satisfies ToolContext;
  };

  const emitError = (
    onEvent: (e: TurnEvent) => void,
    message: string,
    kind: Extract<TurnEvent, { type: 'error' }>['kind'] = 'other',
  ) => onEvent({ type: 'error', message, kind });

  const conversationFor = async (id: string, onEvent: (e: TurnEvent) => void) => {
    const conversation = await store.getConversation(id);
    if (!conversation) {
      emitError(onEvent, 'This chat no longer exists. Start a new one.');
      return undefined;
    }
    if (conversation.model !== MODEL) {
      emitError(onEvent, MODEL_CHANGED);
      return undefined;
    }
    return conversation;
  };

  /** Run one tool directly (chip, router, attachment): events to the UI, the envelope in chatActions, a text row. */
  const runToolDirect = async (
    conversation: ChatConversation,
    tool: string,
    input: unknown,
    caller: ToolContext['caller'],
    onEvent: (e: TurnEvent) => void,
    lead?: string,
  ): Promise<void> => {
    const user = getUser();
    const spec = deps.registry.get(tool);
    const toolUseId = newId('run');
    onEvent({ type: 'tool_start', toolUseId, toolName: tool, progress: spec?.progress });
    let env: ResultEnvelope;
    try {
      env = await deps.execute(tool, input, toolContext(conversation.id, caller, { toolUseId }));
    } catch (e) {
      env = {
        kind: 'error',
        data: { detail: e instanceof Error ? e.message : String(e) },
        summary: 'The tool could not finish.',
      };
    }
    const text = [lead, env.summary].filter(Boolean).join(' ');
    const row = await store.append(
      conversation.id,
      {
        role: 'assistant',
        content: [{ type: 'text', text }] satisfies Anthropic.Beta.BetaContentBlockParam[],
      },
      clock(),
    );
    await recordToolAction(store, {
      conversationId: conversation.id,
      userId: user.id,
      toolUseId,
      toolName: tool,
      input,
      env,
      messageId: row.id,
      now: clock(),
    });
    if (env.kind === 'needs_confirmation' && env.confirmationId) liveInputs.set(env.confirmationId, input);
    onEvent({ type: 'tool_result', toolUseId, envelope: env });
    if (lead) onEvent({ type: 'text', delta: lead });
    onEvent({ type: 'done', stopReason: 'end_turn', messageId: row.id });
  };

  const sayText = async (
    conversation: ChatConversation,
    intent: Extract<RouterIntent, { kind: 'text' | 'refuse' }>,
    onEvent: (e: TurnEvent) => void,
  ): Promise<void> => {
    const row = await store.append(
      conversation.id,
      { role: 'assistant', content: [{ type: 'text', text: intent.text }] },
      clock(),
    );
    onEvent({ type: 'text', delta: intent.text });
    if (intent.href) {
      onEvent({
        type: 'tool_result',
        toolUseId: row.id,
        envelope: { kind: 'text', data: { text: intent.text }, summary: intent.text, href: intent.href },
      });
    }
    onEvent({ type: 'done', stopReason: 'end_turn', messageId: row.id });
  };

  const peopleFor = async (userId: string): Promise<MatchablePerson[]> =>
    (await db.people.where('userId').equals(userId).toArray()).filter((p) => p.isHuman && !p.hiddenAt);

  const companiesFor = async (userId: string): Promise<string[]> => {
    const [targets, people] = await Promise.all([
      db.targetCompanies.where('userId').equals(userId).toArray(),
      db.people.where('userId').equals(userId).toArray(),
    ]);
    const names = new Set<string>();
    for (const t of targets) names.add(t.nameRaw);
    for (const p of people) if (p.currentOrganizationRaw) names.add(p.currentOrganizationRaw);
    return [...names];
  };

  /** The open cards, unsent drafts and next booked chat the router can name. */
  const routerExtras = async (userId: string, now: Date) => {
    const [cards, drafts, events] = await Promise.all([
      db.suggestions
        .where('userId')
        .equals(userId)
        .filter((s) => s.status === 'pending')
        .toArray(),
      db.outbound
        .where('userId')
        .equals(userId)
        .filter((o) => ['draft', 'failed', 'handed_off'].includes(o.status))
        .toArray(),
      db.events
        .where('userId')
        .equals(userId)
        .filter(
          (e) => e.status !== 'cancelled' && !!e.chatId && new Date(e.startAt).getTime() > now.getTime(),
        )
        .toArray(),
    ]);
    const next = events.sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    const nextChat = next?.chatId ? await db.chats.get(next.chatId) : undefined;
    return {
      cards: cards
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((c) => ({ id: c.id, personId: c.personId, kind: c.kind })),
      drafts: drafts
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((d) => ({ id: d.id, personId: d.personId, status: d.status, kind: d.kind })),
      nextChat: nextChat ? { personId: nextChat.personId } : undefined,
    };
  };

  const routerTurn = async (
    conversation: ChatConversation,
    text: string,
    onEvent: (e: TurnEvent) => void,
  ): Promise<void> => {
    const user = getUser();
    await store.append(conversation.id, { role: 'user', content: [{ type: 'text', text }] }, clock());
    const [people, companies, extra] = await Promise.all([
      peopleFor(user.id),
      companiesFor(user.id),
      routerExtras(user.id, clock()),
    ]);
    const intent = routeUtterance(text, {
      registry: deps.registry,
      people,
      companies,
      ...extra,
      modeNote: chatModeNote()?.text ?? '',
      settingsHref: SETTINGS_ROUTE,
    });
    if (intent.kind === 'tool')
      return runToolDirect(conversation, intent.tool, intent.input, 'router', onEvent, intent.lead);
    return sayText(conversation, intent, onEvent);
  };

  /** Run a pending confirmation. The registry checks the token and owns the row's status while the tool runs. */
  const approvePending = async (
    actionId: string,
    edited?: { body: string; subject?: string },
  ): Promise<ResultEnvelope> => {
    const action = await store.getAction(actionId);
    const gone = (summary: string): ResultEnvelope => ({ kind: 'error', data: undefined, summary });
    if (!action) return gone('That approval is no longer available.');
    if (action.status !== 'pending')
      return gone(`That was already ${action.status === 'done' ? 'approved' : action.status}.`);
    if (action.expiresAt && new Date(action.expiresAt).getTime() < clock().getTime()) {
      await store.updateAction(actionId, { status: 'expired' }, clock());
      return gone('That approval expired. Ask again to get a fresh one.');
    }
    let env: ResultEnvelope;
    try {
      env = await deps.execute(
        action.toolName,
        liveInputs.get(actionId) ?? action.input,
        toolContext(action.conversationId, 'ui', { toolUseId: actionId, confirmation: actionId, edited }),
      );
    } catch (e) {
      env = {
        kind: 'error',
        data: { detail: e instanceof Error ? e.message : String(e) },
        summary: 'The tool could not finish.',
      };
    }
    liveInputs.delete(actionId);
    // the real registry records the run on the row itself; anything still open here gets the result now
    const after = await store.getAction(actionId);
    if (after?.status === 'pending' || after?.status === 'running')
      await store.updateAction(
        actionId,
        { status: env.kind === 'error' ? 'error' : 'done', envelope: env },
        clock(),
      );
    // the next model turn sees the decision as a plain line; the UI renders meta 'decision' as a status line
    await store.append(
      action.conversationId,
      {
        role: 'user',
        content: [
          { type: 'text', text: `[Orbit] Approved ${actionId}: ${action.toolName} -> ${env.summary}` },
        ],
        meta: 'decision',
      },
      clock(),
    );
    return env;
  };

  const engine: ChatEngine = {
    mode: () => chatMode(),
    modeNote: () => chatModeNote(),

    startConversation: ({ temporary }) =>
      store.createConversation({ userId: getUser().id, model: MODEL, temporary, now: clock() }),
    listConversations: () => store.listConversations(getUser().id),
    async loadConversation(id) {
      const conversation = await store.getConversation(id);
      if (!conversation) throw new Error('This chat no longer exists.');
      const [messages, actions]: [ChatMessage[], ChatAction[]] = await Promise.all([
        store.messages(id),
        store.actions(id),
      ]);
      return { conversation, messages, actions };
    },
    renameConversation: (id, title) => store.renameConversation(id, title),
    archiveConversation: (id) => store.archiveConversation(id, clock()),

    async send(conversationId, text, onEvent, signal) {
      const conversation = await conversationFor(conversationId, onEvent);
      if (!conversation) return;
      const trimmed = text.trim();
      if (!trimmed) return emitError(onEvent, 'Type something first.');
      // another tab may have removed the key, turned the chat off or used up today's budget
      await refreshPrefs();
      if (chatMode() === 'router') return routerTurn(conversation, trimmed, onEvent);
      const client = getClient();
      if (!client) return routerTurn(conversation, trimmed, onEvent);
      await runTurn(
        {
          client,
          registry: deps.registry,
          execute: deps.execute,
          store,
          user: getUser(),
          conversation,
          now: clock,
          quick: typeof deps.quick === 'function' ? deps.quick() : deps.quick,
          prefixMismatch: deps.prefixMismatch,
        },
        [{ type: 'text', text: trimmed }],
        onEvent,
        signal,
      );
    },

    chips: (): ChipSpec[] => chipsFor(deps.registry),
    async runChip(conversationId, chipId, onEvent) {
      const conversation = await conversationFor(conversationId, onEvent);
      if (!conversation) return;
      const chip = chipsFor(deps.registry).find((c) => c.id === chipId);
      if (!chip) return emitError(onEvent, 'That button is not available.');
      await store.append(
        conversation.id,
        { role: 'user', content: [{ type: 'text', text: chip.asUser }] },
        clock(),
      );
      const run = await resolveChip(chip, deps.registry, getUser().id, clock());
      await runToolDirect(conversation, run.tool, run.input, 'ui', onEvent, run.lead);
    },

    async approve(actionId, edited) {
      const action = await store.getAction(actionId);
      const gone = (summary: string): ResultEnvelope => ({ kind: 'error', data: undefined, summary });
      if (!action) return gone('That approval is no longer available.');
      // a draft card's own Approve: ask send_draft for a confirmation first, then approve that one with the text
      // as edited in the card, so the send goes through the same confirmation and approval path as the model's
      // (never a confirmation that already ran: approving that again must not send twice)
      const draftId =
        action.status === 'done' && !action.id.startsWith('conf_') && action.toolName !== 'send_draft'
          ? draftIdOf(action.envelope)
          : undefined;
      if (draftId && deps.registry.has('send_draft')) {
        const askId = newId('run');
        const ask = await deps.execute(
          'send_draft',
          { draftId },
          toolContext(action.conversationId, 'ui', { toolUseId: askId, edited }),
        );
        if (ask.kind !== 'needs_confirmation' || !ask.confirmationId) return ask;
        await recordToolAction(store, {
          conversationId: action.conversationId,
          userId: getUser().id,
          toolUseId: askId,
          toolName: 'send_draft',
          input: { draftId },
          env: ask,
          now: clock(),
        });
        const blocked = (ask.data as { blockedReason?: string } | undefined)?.blockedReason;
        if (blocked) {
          await store.updateAction(ask.confirmationId, { status: 'cancelled' }, clock());
          return gone(blocked);
        }
        return approvePending(ask.confirmationId, edited);
      }
      return approvePending(actionId, edited);
    },

    async cancel(actionId) {
      const action = await store.getAction(actionId);
      if (action?.status !== 'pending') return;
      await store.updateAction(actionId, { status: 'cancelled' }, clock());
      await store.append(
        action.conversationId,
        {
          role: 'user',
          content: [{ type: 'text', text: `[Orbit] Cancelled ${actionId}.` }],
          meta: 'decision',
        },
        clock(),
      );
    },

    async attach(conversationId, file, kind, onEvent) {
      const conversation = await conversationFor(conversationId, onEvent);
      if (!conversation) return;
      const tool = ATTACH_TOOL[kind];
      const spec = deps.registry.get(tool);
      if (!spec)
        return emitError(
          onEvent,
          `Orbit cannot take a ${kind} attachment from the chat yet. Use the app page instead.`,
        );
      const asUser = `${ATTACH_LABEL[kind]}: ${file.name}`;
      await store.append(
        conversation.id,
        { role: 'user', content: [{ type: 'text', text: asUser }] },
        clock(),
      );
      const input = await attachInput(spec, file, kind);
      const parsed = spec.input.safeParse(input);
      if (!parsed.success)
        return emitError(
          onEvent,
          `Orbit could not hand this ${kind} to its ${tool.replace(/_/g, ' ')} tool.`,
        );
      await runToolDirect(conversation, tool, parsed.data, 'ui', onEvent);
    },
  };
  return engine;
}

/** The draft id a done tool result points at (create_draft, get_draft, update_draft_body and the like). */
export function draftIdOf(env: ResultEnvelope | undefined): string | undefined {
  if (env?.kind !== 'draft') return undefined;
  const d = env.data as
    | {
        forModel?: { id?: unknown };
        ui?: { id?: unknown; draft?: { id?: unknown } };
        id?: unknown;
        draft?: { id?: unknown };
      }
    | undefined;
  const id = d?.forModel?.id ?? d?.ui?.draft?.id ?? d?.ui?.id ?? d?.draft?.id ?? d?.id;
  return typeof id === 'string' ? id : undefined;
}

/** The file's text; some runtimes (and jsdom) have no `File.text()`. */
export function readText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Which tool each "+" menu attachment goes to. */
export const ATTACH_TOOL: Record<'note' | 'resume' | 'linkedin' | 'email', string> = {
  note: 'add_note',
  email: 'add_note',
  resume: 'save_resume',
  linkedin: 'import_linkedin',
};

const ATTACH_LABEL: Record<keyof typeof ATTACH_TOOL, string> = {
  note: 'Attached notes',
  email: 'Attached email',
  resume: 'Attached resume',
  linkedin: 'Attached LinkedIn export',
};

/** The file's bytes as base64 (no data: prefix), chunked so a large file does not overflow the call stack. */
export async function readBase64(file: Blob): Promise<string> {
  const buf: ArrayBuffer =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as ArrayBuffer);
          r.onerror = () => reject(r.error);
          r.readAsArrayBuffer(file);
        });
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const TEXT_FILE = /\.(csv|txt|md|markdown|eml)$/i;

/**
 * Build the tool input for an attachment from the tool's own schema keys, so the "+" menu and the tool never drift:
 * `text` gets the file's text (notes, emails), `csvText` gets a CSV's text and `base64` gets the bytes of anything
 * else (a LinkedIn ZIP, a PDF or Word resume), `filename` / `mimeType` describe the file, `source` says it came from
 * a file, and a note gets the file name as its title. Fields the schema does not have are left out.
 */
export async function attachInput(
  spec: ToolSpec,
  file: File,
  kind: keyof typeof ATTACH_TOOL,
): Promise<Record<string, unknown>> {
  const keys = new Set(Object.keys(spec.input.shape ?? {}));
  const input: Record<string, unknown> = {};
  const isText = TEXT_FILE.test(file.name) || file.type.startsWith('text/') || file.type === 'message/rfc822';
  if (keys.has('file')) input.file = file;
  if (keys.has('text')) input.text = await readText(file);
  if (keys.has('csvText') && isText) input.csvText = await readText(file);
  else if (keys.has('base64')) input.base64 = await readBase64(file);
  if (keys.has('source')) input.source = 'upload';
  for (const k of ['fileName', 'filename', 'name']) if (keys.has(k)) input[k] = file.name;
  if (keys.has('mimeType') && file.type) input.mimeType = file.type;
  if (keys.has('title') && kind === 'note') input.title = file.name.replace(/\.[a-z0-9]+$/i, '');
  return input;
}
