/**
 * The optional sources of plan 43: Instagram, X and texts (the Mac's Messages). LinkedIn, Gmail and Calendar are
 * always part of Orbit and keep their own connect and disconnect; these three can be switched on for the whole
 * product by the owner (`ORBIT_EXTRA_SOURCES`) and then on or off by each student.
 *
 * Every row Orbit keeps from an optional source says which one it came from: a message by its provider, a touch, a tie
 * and an identity by their kind. `inUse` is the one answer every reader asks, and the `keep*` helpers apply it, so a
 * source that is off is left out everywhere without its rows being deleted (plan 43 §3.2).
 */
import type { TieKind } from './graph/ties';
import type { IntegrationProvider, PersonSource, TouchpointKind } from './types';

export type OptionalSource = 'instagram' | 'x' | 'imessage';

export const OPTIONAL_SOURCES: readonly OptionalSource[] = ['instagram', 'x', 'imessage'];

/**
 * Where a student stands with one optional source (plan 43 §3.1).
 * - `not_connected`: never set up.
 * - `on`: read, and counted in closeness and paths.
 * - `off`: kept, hidden, not read, not counted. Switching on brings everything back.
 * - `removed`: what was taken is deleted.
 */
export type SourceState = 'not_connected' | 'on' | 'off' | 'removed';

/** The person-to-person identity kinds an optional source adds: the platform's own account id, never the handle. */
export type SocialIdentityKind = 'instagram_id' | 'x_id';

export interface SourceInfo {
  id: OptionalSource;
  /** what the student sees: "Instagram", "X", "Texts" */
  name: string;
  /** the integration row's provider */
  provider: IntegrationProvider;
  /** the provider value on stored threads and messages (texts keep theirs in the browser) */
  messageProvider?: 'instagram' | 'x';
  touchKinds: readonly TouchpointKind[];
  tieKinds: readonly TieKind[];
  identityKind?: SocialIdentityKind;
  personSource: PersonSource;
  /** works only for signed-in students: messages arrive on the server and the graph is kept there */
  signedInOnly: boolean;
  /** how a draft goes out: from Orbit with the student's tap, or handed to the app with the draft written */
  send: 'tap' | 'handoff';
  /** whether the source can say who knows a target (texts cannot) */
  mutuals: boolean;
}

export const SOURCES: Readonly<Record<OptionalSource, SourceInfo>> = {
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    provider: 'instagram',
    messageProvider: 'instagram',
    touchKinds: ['instagram_in', 'instagram_out'],
    tieKinds: ['instagram_mutual', 'instagram_follow'],
    identityKind: 'instagram_id',
    personSource: 'instagram',
    signedInOnly: true,
    send: 'tap',
    mutuals: true,
  },
  x: {
    id: 'x',
    name: 'X',
    provider: 'x',
    messageProvider: 'x',
    touchKinds: ['x_in', 'x_out'],
    tieKinds: ['x_mutual', 'x_follow'],
    identityKind: 'x_id',
    personSource: 'x',
    signedInOnly: true,
    send: 'tap',
    mutuals: true,
  },
  imessage: {
    id: 'imessage',
    name: 'Texts',
    provider: 'imessage',
    touchKinds: ['text_in', 'text_out'],
    tieKinds: [],
    personSource: 'imessage',
    signedInOnly: false,
    send: 'handoff',
    mutuals: false,
  },
};

const isSource = (s: string): s is OptionalSource => (OPTIONAL_SOURCES as readonly string[]).includes(s);

/**
 * The owner's switch: which optional sources exist in this Orbit at all, from a comma list such as
 * "instagram,imessage". Unknown names are ignored; unset or empty means none, so nothing changes until the owner
 * opts in. Texts are named `imessage` in code and "Texts" on screen; "texts" is accepted too.
 */
export function parseExtraSources(raw: string | undefined | null): OptionalSource[] {
  if (!raw) return [];
  const out: OptionalSource[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const name = part.trim().toLowerCase();
    const id = name === 'texts' ? 'imessage' : name;
    if (isSource(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** What a student has said about each optional source; a source with no entry is not connected. */
export type SourceStates = Partial<Record<OptionalSource, SourceState>>;

/**
 * The sources whose rows count right now for one student: offered by the owner and switched on by the student. Every
 * reader of closeness, ties, messages and identities asks this, and nothing else.
 */
export function sourcesInUse(
  offered: readonly OptionalSource[],
  states: SourceStates | undefined,
): Set<OptionalSource> {
  const out = new Set<OptionalSource>();
  for (const s of offered) if (states?.[s] === 'on') out.add(s);
  return out;
}

const TOUCH_SOURCE = new Map<TouchpointKind, OptionalSource>();
const TIE_SOURCE = new Map<TieKind, OptionalSource>();
const PROVIDER_SOURCE = new Map<string, OptionalSource>();
const IDENTITY_SOURCE = new Map<string, OptionalSource>();
for (const info of Object.values(SOURCES)) {
  for (const k of info.touchKinds) TOUCH_SOURCE.set(k, info.id);
  for (const k of info.tieKinds) TIE_SOURCE.set(k, info.id);
  if (info.messageProvider) PROVIDER_SOURCE.set(info.messageProvider, info.id);
  if (info.identityKind) IDENTITY_SOURCE.set(info.identityKind, info.id);
}

/** The optional source a touch kind belongs to, or undefined for the always-on sources. */
export const sourceOfTouch = (kind: TouchpointKind): OptionalSource | undefined => TOUCH_SOURCE.get(kind);
export const sourceOfTie = (kind: TieKind): OptionalSource | undefined => TIE_SOURCE.get(kind);
export const sourceOfProvider = (provider: string | undefined | null): OptionalSource | undefined =>
  provider ? PROVIDER_SOURCE.get(provider) : undefined;
export const sourceOfIdentity = (kind: string): OptionalSource | undefined => IDENTITY_SOURCE.get(kind);

const allowed = (s: OptionalSource | undefined, inUse: ReadonlySet<OptionalSource>) => !s || inUse.has(s);

/** Whether a touch counts: the always-on kinds always do, an optional source's only while it is in use. */
export const keepTouch = (kind: TouchpointKind, inUse: ReadonlySet<OptionalSource>): boolean =>
  allowed(sourceOfTouch(kind), inUse);
export const keepTie = (kind: TieKind, inUse: ReadonlySet<OptionalSource>): boolean =>
  allowed(sourceOfTie(kind), inUse);
export const keepProvider = (
  provider: string | undefined | null,
  inUse: ReadonlySet<OptionalSource>,
): boolean => allowed(sourceOfProvider(provider), inUse);
export const keepIdentity = (kind: string, inUse: ReadonlySet<OptionalSource>): boolean =>
  allowed(sourceOfIdentity(kind), inUse);

/**
 * The kinds and providers of every optional source not in use, for a reader that filters in SQL (`kind <> all(...)`).
 * Empty lists when everything is in use, so the filter is a no-op for a student with no optional source.
 */
export function excludedBy(inUse: ReadonlySet<OptionalSource>): {
  touchKinds: TouchpointKind[];
  tieKinds: TieKind[];
  providers: string[];
  identityKinds: string[];
} {
  const out = {
    touchKinds: [] as TouchpointKind[],
    tieKinds: [] as TieKind[],
    providers: [] as string[],
    identityKinds: [] as string[],
  };
  for (const info of Object.values(SOURCES)) {
    if (inUse.has(info.id)) continue;
    out.touchKinds.push(...info.touchKinds);
    out.tieKinds.push(...info.tieKinds);
    if (info.messageProvider) out.providers.push(info.messageProvider);
    if (info.identityKind) out.identityKinds.push(info.identityKind);
  }
  return out;
}

/** The chat channels (plan 43 §3.8): counted by days, never for reply speed, words required, groups weighed down. */
export const CHAT_CHANNELS = ['instagram', 'x', 'text'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export const isChatChannel = (c: string): c is ChatChannel =>
  (CHAT_CHANNELS as readonly string[]).includes(c);
