import { createContext, type ReactNode, useContext } from 'react';
import type { ChatConversation, ChatEngine } from './types';

/**
 * The engine the chat UI talks to. The default is a stub that answers honestly that the assistant is not wired in
 * this build; the merge swaps in the real `createChatEngine`, and the e2e tests pass the FakeChatEngine (see
 * testing/fakeEngine.ts). The UI never imports an engine directly: it only reads this context.
 */
const EngineCtx = createContext<ChatEngine | undefined>(undefined);

export function ChatEngineProvider({ engine, children }: { engine?: ChatEngine; children: ReactNode }) {
  return <EngineCtx.Provider value={engine ?? stubEngine}>{children}</EngineCtx.Provider>;
}

export function useChatEngine(): ChatEngine {
  return useContext(EngineCtx) ?? stubEngine;
}

const STUB_NOTE =
  'The assistant is not connected in this build yet. The pages on the left still work, and a Claude key in Settings turns on drafting.';

/** In-memory, no model, no tools: says so instead of pretending. */
function createStubEngine(): ChatEngine {
  const conversations = new Map<string, ChatConversation>();
  let n = 0;
  return {
    mode: () => 'router',
    modeNote: () => ({ text: STUB_NOTE, href: '/settings/integrations' }),
    async startConversation() {
      const now = new Date().toISOString();
      const c: ChatConversation = {
        id: `stub_${++n}`,
        userId: 'local',
        title: 'New chat',
        model: 'none',
        createdAt: now,
        updatedAt: now,
      };
      conversations.set(c.id, c);
      return c;
    },
    async listConversations() {
      return [];
    },
    async loadConversation(id) {
      const conversation = conversations.get(id) ?? (await this.startConversation({ temporary: true }));
      return { conversation, messages: [], actions: [] };
    },
    async renameConversation() {},
    async archiveConversation() {},
    async send(_id, _text, onEvent) {
      onEvent({ type: 'text', delta: STUB_NOTE });
      onEvent({ type: 'done', stopReason: 'end_turn', messageId: `stub_m${++n}` });
    },
    chips: () => [],
    async runChip(_id, _chip, onEvent) {
      onEvent({ type: 'text', delta: STUB_NOTE });
      onEvent({ type: 'done', stopReason: 'end_turn', messageId: `stub_m${++n}` });
    },
    async approve() {
      return { kind: 'error', data: {}, summary: STUB_NOTE };
    },
    async cancel() {},
    async attach(_id, _file, _kind, onEvent) {
      onEvent({ type: 'text', delta: STUB_NOTE });
      onEvent({ type: 'done', stopReason: 'end_turn', messageId: `stub_m${++n}` });
    },
  };
}

const stubEngine = createStubEngine();
