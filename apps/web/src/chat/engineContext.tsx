import type { User } from '@orbit/core';
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';
import { useSession } from '../state/session';
import { createChatEngine } from './agent';
import { execute, registry } from './registry';
import type { ChatEngine } from './types';
import { getChatMode } from './ui/prefs';

/**
 * The engine the chat UI talks to. By default it is the real one: `createChatEngine` over the tool registry and its
 * `execute()`, following the signed-in student. The e2e tests that script the UI pass the FakeChatEngine instead
 * (see testing/fakeEngine.ts and testing/flag.ts). The UI never imports an engine directly: it only reads this
 * context.
 */
const EngineCtx = createContext<ChatEngine | undefined>(undefined);

export function ChatEngineProvider({ engine, children }: { engine?: ChatEngine; children: ReactNode }) {
  const { user } = useSession();
  const userRef = useRef<User | undefined>(user);
  userRef.current = user;
  const value = useMemo(
    () =>
      engine ??
      createChatEngine({
        registry,
        execute,
        user: () => {
          const u = userRef.current;
          if (!u) throw new Error('Sign in or load the demo first.');
          return u;
        },
        quick: () => getChatMode() === 'quick',
      }),
    [engine],
  );
  return <EngineCtx.Provider value={value}>{children}</EngineCtx.Provider>;
}

export function useChatEngine(): ChatEngine {
  const engine = useContext(EngineCtx);
  if (!engine) throw new Error('useChatEngine needs a ChatEngineProvider.');
  return engine;
}
