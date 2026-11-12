/**
 * Picking the Messages files (plan 43 §6). Messages keeps chat.db and, with the newest messages, chat.db-wal in
 * ~/Library/Messages. Chrome and Edge can open that folder (showDirectoryPicker), and Orbit keeps the folder's handle
 * in this browser's database so "Update texts" is one click (the browser asks again for permission when it needs to).
 * Elsewhere the student picks chat.db and chat.db-wal as files. chat.db-shm is never needed.
 *
 * Nothing here leaves the browser: the files are read into memory and opened with sql.js.
 */
import { db } from '../db/schema';

export interface PickedMessages {
  db: Uint8Array;
  wal?: Uint8Array;
  /** where they came from, for the screen: "the Messages folder", "chat.db and chat.db-wal" */
  from: string;
}

/** Thrown when what was picked holds no chat.db: the screen shows the message as it is. */
export class MessagesPickError extends Error {}

const NO_CHAT_DB =
  'Orbit did not find chat.db there. Pick the Messages folder in your Library, or chat.db itself.';

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
};
type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { id?: string; mode?: 'read'; startIn?: string }) => Promise<DirHandle>;
};

const folderKey = (userId: string) => `texts:folder:${userId}`;

/** Whether this browser can open a folder (Chrome and Edge on a Mac). */
export function canPickFolder(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

/** A Mac, from the browser's own words; an iPad that says Macintosh has a touch screen and is not one. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const said = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
  if (!/mac/i.test(said) || /iphone|ipad|ipod/i.test(said)) return false;
  return (nav.maxTouchPoints ?? 0) < 2;
}

async function bytes(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** chat.db and chat.db-wal from a list of files (an <input multiple>); anything else, chat.db-shm included, is left. */
export async function fromFiles(files: Iterable<File>): Promise<PickedMessages> {
  const list = [...files];
  const main = list.find((f) => f.name === 'chat.db') ?? list.find((f) => /\.db$/i.test(f.name));
  if (!main) throw new MessagesPickError(NO_CHAT_DB);
  const wal = list.find((f) => f.name === `${main.name}-wal`);
  return {
    db: await bytes(main),
    ...(wal ? { wal: await bytes(wal) } : {}),
    from: wal ? `${main.name} and ${wal.name}` : main.name,
  };
}

async function readFolder(dir: DirHandle): Promise<PickedMessages> {
  let main: File;
  try {
    main = await (await dir.getFileHandle('chat.db')).getFile();
  } catch {
    throw new MessagesPickError(NO_CHAT_DB);
  }
  let wal: File | undefined;
  try {
    wal = await (await dir.getFileHandle('chat.db-wal')).getFile();
  } catch {
    wal = undefined;
  }
  return {
    db: await bytes(main),
    ...(wal?.size ? { wal: await bytes(wal) } : {}),
    from: 'the Messages folder',
  };
}

/**
 * Ask for the Messages folder and read it; the handle is kept for the next update. Undefined when the student closed
 * the picker. A folder macOS will not open (no Full Disk Access) throws with what to do.
 */
export async function pickMessagesFolder(userId: string): Promise<PickedMessages | undefined> {
  const w = window as PickerWindow;
  if (!w.showDirectoryPicker) return undefined;
  let dir: DirHandle;
  try {
    dir = await w.showDirectoryPicker({ id: 'orbit-messages', mode: 'read' });
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return undefined;
    throw new MessagesPickError(
      'The browser could not open that folder. Give it Full Disk Access in System Settings, or copy chat.db and chat.db-wal to your Desktop and pick them there.',
    );
  }
  const picked = await readFolder(dir);
  try {
    await db.kv.put({ key: folderKey(userId), value: dir });
  } catch {
    // a browser that cannot keep the handle asks for the folder each time
  }
  return picked;
}

/** Whether a folder from an earlier update is kept, so Update can be one click. */
export async function hasSavedFolder(userId: string): Promise<boolean> {
  return !!(await db.kv.get(folderKey(userId)))?.value && canPickFolder();
}

/**
 * Read the kept folder again, inside the student's click (the browser may ask once more for permission). Undefined
 * when there is no kept folder or the student said no; the screen then asks for the folder again.
 */
export async function readSavedFolder(userId: string): Promise<PickedMessages | undefined> {
  const dir = (await db.kv.get(folderKey(userId)))?.value as DirHandle | undefined;
  if (!dir || typeof dir.getFileHandle !== 'function') return undefined;
  try {
    let p = (await dir.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (p !== 'granted') p = (await dir.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (p !== 'granted') return undefined;
    return await readFolder(dir);
  } catch (e) {
    if (e instanceof MessagesPickError) throw e;
    return undefined;
  }
}

/** Forget the kept folder (Remove what Orbit took). */
export async function forgetSavedFolder(userId: string): Promise<void> {
  await db.kv.delete(folderKey(userId));
}
