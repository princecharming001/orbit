/**
 * Files on emails: the student's resume (kept when they upload it) or any document they attach to a draft. The bytes
 * stay in this browser's files table; an email the browser sends carries them itself, and an account's approval
 * sends them up with the draft so the server can attach them when it sends.
 */
import { type DraftAttachment, newId, type OutboundMessage, type StoredFile } from '@orbit/core';
import { db } from '../db/schema';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DRAFT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DRAFT_FILES = 3;
/** What can be attached: documents, slides, sheets, text and images (the server takes the same list). */
export const ALLOWED_FILE =
  /\.(pdf|docx?|pptx?|xlsx?|csv|txt|md|rtf|odt|pages|key|png|jpe?g|gif|webp|heic)$/i;
export const FILE_ACCEPT =
  '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.rtf,.odt,.pages,.key,.png,.jpg,.jpeg,.gif,.webp,.heic';

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function mimeOf(file: { name: string; type?: string }): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Why a file cannot be attached, in words; undefined when it can. */
export function fileProblem(file: { name: string; size: number }): string | undefined {
  if (!ALLOWED_FILE.test(file.name))
    return 'Attach a document or a picture (PDF, Word, slides, text, image).';
  if (!file.size) return `${file.name} is empty.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} is over 4 MB.`;
  return undefined;
}

async function readBytes(b: Blob): Promise<Uint8Array> {
  if (typeof b.arrayBuffer === 'function') return new Uint8Array(await b.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(b);
  });
}

/** Keeps a file in this browser, the newest resume first when one is attached. */
export async function keepFile(userId: string, file: File, kind: StoredFile['kind']): Promise<StoredFile> {
  const problem = fileProblem(file);
  if (problem) throw new Error(problem);
  const row: StoredFile = {
    id: newId('f'),
    userId,
    kind,
    name:
      file.name
        .replace(/[\r\n/\\]+/g, ' ')
        .trim()
        .slice(0, 200) || 'file',
    mimeType: mimeOf(file),
    size: file.size,
    bytes: await readBytes(file),
    createdAt: new Date().toISOString(),
  };
  await db.files.add(row);
  return row;
}

/** The resume the student last uploaded, as a file; undefined when Orbit only has its text. */
export async function resumeFile(userId: string): Promise<StoredFile | undefined> {
  const all = await db.files
    .where('userId')
    .equals(userId)
    .filter((f) => f.kind === 'resume')
    .toArray();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

const asAttachment = (f: StoredFile): DraftAttachment => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  size: f.size,
});

/** Adds a kept file to a draft; an error in words when it would pass the limits. */
export async function attachFile(msgId: string, file: StoredFile): Promise<string | undefined> {
  const msg = await db.outbound.get(msgId);
  if (!msg) return 'This draft is gone.';
  const list = msg.attachments ?? [];
  if (list.some((a) => a.id === file.id)) return undefined;
  if (list.length >= MAX_DRAFT_FILES) return `At most ${MAX_DRAFT_FILES} files on one email.`;
  if (list.reduce((t, a) => t + a.size, 0) + file.size > MAX_DRAFT_FILE_BYTES)
    return 'The files would be over 5 MB in all.';
  await db.outbound.update(msgId, { attachments: [...list, asAttachment(file)] });
  return undefined;
}

export async function detachFile(msgId: string, fileId: string): Promise<void> {
  const msg = await db.outbound.get(msgId);
  if (!msg) return;
  await db.outbound.update(msgId, { attachments: (msg.attachments ?? []).filter((a) => a.id !== fileId) });
}

/** The bytes of a draft's files, in order; an error in words when one is no longer in this browser. */
export async function draftFileBytes(
  msg: Pick<OutboundMessage, 'attachments'>,
): Promise<{ name: string; mimeType: string; bytes: Uint8Array }[] | { error: string }> {
  const out: { name: string; mimeType: string; bytes: Uint8Array }[] = [];
  for (const a of msg.attachments ?? []) {
    const f = await db.files.get(a.id);
    if (!f) return { error: `${a.name} is no longer in this browser. Attach it again.` };
    out.push({ name: f.name, mimeType: f.mimeType, bytes: new Uint8Array(f.bytes) });
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

/** "212 KB", "1.4 MB" */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
