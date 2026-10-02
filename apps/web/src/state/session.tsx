import type { RecruitingGoals, User, UserSettings } from '@orbit/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getCurrentUserId, setCurrentUserId } from '../db/repo';
import { db } from '../db/schema';

interface Session {
  loading: boolean;
  userId?: string;
  user?: User;
  settings?: UserSettings;
  goals?: RecruitingGoals;
  setUserId: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session>({ loading: true, setUserId: async () => {}, signOut: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUid] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getCurrentUserId().then((id) => {
      setUid(id);
      setLoading(false);
    });
  }, []);
  const user = useLiveQuery(() => (userId ? db.users.get(userId) : undefined), [userId]);
  const settings = useLiveQuery(() => (userId ? db.settings.get(userId) : undefined), [userId]);
  const goals = useLiveQuery(() => (userId ? db.goals.get(userId) : undefined), [userId]);
  const setUserId = useCallback(async (id: string) => {
    await setCurrentUserId(id);
    setUid(id);
  }, []);
  const signOut = useCallback(async () => {
    await db.kv.delete('currentUserId');
    setUid(undefined);
  }, []);
  const value = useMemo<Session>(
    () => ({
      loading,
      userId,
      user: user ?? undefined,
      settings: settings ?? undefined,
      goals: goals ?? undefined,
      setUserId,
      signOut,
    }),
    [loading, userId, user, settings, goals, setUserId, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  return useContext(Ctx);
}

export function useUser(): User {
  const s = useSession();
  if (!s.user) throw new Error('No user');
  return s.user;
}
