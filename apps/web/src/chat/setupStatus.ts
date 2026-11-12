/**
 * What each setup widget needs to know about the student's account: read by the `show_setup` tool (so the card can
 * render without another call) and again, live, by the card itself. Never holds a key: only whether one is saved.
 */
import { db } from '../db/schema';
import { DEMO_USER_ID } from '../engine/demo';
import { googleAccount } from '../engine/integrations';
import { linkedInLiveStatus } from '../engine/linkedinLive';
import { googleStatus } from '../engine/serverSync';
import { villageAvailable } from '../engine/warmIntros';
import { currentGoogleToken, googleClientId } from '../integrations/google';
import { accountUser, isServerUser } from '../integrations/orbitApi';
import { envGoogleClientId, readPrefs } from '../integrations/prefs';
import { sharedClaudeUrl } from '../integrations/shared-claude';
import type { SetupWhat } from './types';

export const SETUP_WHAT: readonly SetupWhat[] = [
  'google',
  'linkedin',
  'claude_key',
  'resume',
  'instagram',
  'x',
  'texts',
];

export interface GoogleSetup {
  what: 'google';
  connected: boolean;
  /** a live sign-in is on this page (Google asks again after about an hour) */
  signedIn: boolean;
  needsReauth: boolean;
  email?: string;
  lastSyncedAt?: string;
  /** a Google client id exists (built in or pasted), so the sign-in popup can open */
  clientIdConfigured: boolean;
  /** the client id is part of this build, so there is nothing to paste */
  builtInClient: boolean;
  /** the account is the demo's, whose mail and calendar are replayed */
  demo: boolean;
}
export interface LinkedinSetup {
  what: 'linkedin';
  /** people in Orbit (not hidden) */
  people: number;
  /** rows in the last export upload */
  lastRows?: number;
  lastImportedAt?: string;
  /** live LinkedIn through Unipile (the sample student's is the mock connector) */
  live: {
    /** live connect can be offered here */
    available: boolean;
    connected: boolean;
    lastSyncedAt?: string;
    rows?: number;
    /** the last sync failed */
    error?: string;
    demo: boolean;
  };
  /** Village warm intros are on for this student */
  warmIntros: boolean;
}
export interface ClaudeKeySetup {
  what: 'claude_key';
  keySaved: boolean;
  /** Orbit's shared Claude access exists for visitors without a key */
  sharedAccess: boolean;
}
export interface ResumeSetup {
  what: 'resume';
  onFile: boolean;
  filename?: string;
  addedAt?: string;
}
/** Plan 43: Instagram, X or texts, as the chat's card shows them: offered at all, and where the student stands. */
export interface SourceSetup {
  what: 'instagram' | 'x' | 'texts';
  /** this Orbit offers it to this student (and, for Instagram and X, they can use it here) */
  offered: boolean;
  state: 'not_connected' | 'on' | 'off' | 'removed';
  /** Instagram and X: connected, with the handle */
  connected?: boolean;
  username?: string;
  /** Instagram: what is being read now */
  reading?: string;
  /** X: what has been spent this month and the limit, in dollars */
  spentUsd?: number;
  limitUsd?: number;
}
export type SetupStatus = GoogleSetup | LinkedinSetup | ClaudeKeySetup | ResumeSetup | SourceSetup;

export async function readSetupStatus(userId: string, what: SetupWhat): Promise<SetupStatus> {
  switch (what) {
    case 'google': {
      // an Orbit account: Google came with the sign-in, and the server keeps the mail current
      if (isServerUser(userId)) {
        const server = googleStatus();
        return {
          what,
          connected: true,
          signedIn: server?.status !== 'needs_reauth',
          needsReauth: server?.status === 'needs_reauth',
          email: accountUser()?.email,
          lastSyncedAt: server?.lastSyncedAt ?? undefined,
          clientIdConfigured: true,
          builtInClient: true,
          demo: false,
        };
      }
      const g = await googleAccount(userId);
      const demoRow = userId === DEMO_USER_ID || !!(await demoAccount(userId));
      return {
        what,
        connected: !!g && g.status !== 'revoked',
        signedIn: !!currentGoogleToken(),
        needsReauth: g?.status === 'needs_reauth',
        email: g?.externalAccountId,
        lastSyncedAt: g?.lastSyncedAt,
        clientIdConfigured: !!googleClientId(),
        builtInClient: !!envGoogleClientId(),
        demo: demoRow && !g,
      };
    }
    case 'linkedin': {
      const li = await db.integrations
        .where('userId')
        .equals(userId)
        .filter((i) => i.provider === 'linkedin_csv')
        .first();
      const people = await db.people
        .where('userId')
        .equals(userId)
        .filter((p) => p.isHuman && !p.hiddenAt)
        .count();
      const rows = (li?.syncState as { rows?: unknown } | undefined)?.rows;
      const user = await db.users.get(userId);
      const live = user ? await linkedInLiveStatus(user) : undefined;
      return {
        what,
        people,
        lastRows: typeof rows === 'number' ? rows : undefined,
        lastImportedAt: li?.lastSyncedAt,
        live: {
          available: !!live?.available,
          connected: !!live?.connected,
          lastSyncedAt: live?.lastSyncedAt,
          rows: live?.rows,
          error: live?.error,
          demo: !!live?.demo,
        },
        warmIntros: villageAvailable({ id: userId }),
      };
    }
    case 'claude_key':
      return { what, keySaved: !!readPrefs().anthropicApiKey, sharedAccess: !!sharedClaudeUrl() };
    case 'resume': {
      const r = (await db.resumes.where('userId').equals(userId).toArray())
        .filter((x) => x.isCurrent)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { what, onFile: !!r, filename: r?.filename, addedAt: r?.createdAt };
    }
    case 'instagram':
    case 'x':
    case 'texts':
      return sourceSetup(userId, what);
  }
}

async function sourceSetup(userId: string, what: SourceSetup['what']): Promise<SourceSetup> {
  const { sourcesNow } = await import('../engine/sources');
  const s = await sourcesNow(userId);
  if (what === 'texts') {
    const { isMac } = await import('../integrations/messagesFolder');
    return {
      what,
      offered: s.offered.includes('imessage') && isMac(),
      state: s.states.imessage ?? 'not_connected',
    };
  }
  const social = await import('../engine/social');
  const offered = social.socialSupported(userId) && s.offered.includes(what);
  const state = s.states[what] ?? 'not_connected';
  if (!offered) return { what, offered, state };
  if (what === 'instagram') {
    const st = await social.keptStatus(userId, 'instagram');
    return {
      what,
      offered,
      state,
      connected: !!st && st.status !== 'not_connected' && st.status !== 'connecting',
      username: st?.username,
      reading: social.instagramProgress(st),
    };
  }
  const st = await social.keptStatus(userId, 'x');
  return {
    what,
    offered,
    state,
    connected: !!st && (st.status === 'active' || st.status === 'needs_reauth'),
    username: st?.username,
    spentUsd: st?.spentThisMonthUsd,
    limitUsd: st?.limitUsd,
  };
}

function demoAccount(userId: string) {
  return db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => i.provider === 'demo')
    .first();
}
