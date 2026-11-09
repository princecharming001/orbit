/**
 * Files on drafts: a resume or any document the student attaches to an email Orbit sends for them. The browser sends
 * the files with the approval; they are kept in orbit.user_files (service role only) and listed on the draft, and the
 * worker reads them back when it builds the message.
 */
import type { DraftAttachment } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import type { MimeAttachment } from './mime.ts';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_DRAFT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DRAFT_FILES = 3;

/** What a file may be: documents, slides, sheets, text and images. Gmail refuses programs anyway. */
export const ALLOWED_FILE =
  /\.(pdf|docx?|pptx?|xlsx?|csv|txt|md|rtf|odt|pages|key|png|jpe?g|gif|webp|heic)$/i;

export interface IncomingFile {
  name: string;
  mimeType: string;
  /** the bytes, base64 */
  data: string;
  kind?: 'resume' | 'file';
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The `attachments` field of an approval, checked: at most 3 files of 4 MB each and 5 MB in all. */
export function parseIncomingFiles(v: unknown): IncomingFile[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, 'bad_request', 'attachments is a list');
  if (v.length > MAX_DRAFT_FILES)
    throw new HttpError(400, 'bad_request', `at most ${MAX_DRAFT_FILES} attachments`);
  let total = 0;
  return v.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const name =
      typeof o.name === 'string'
        ? o.name
            .replace(/[\r\n/\\]+/g, ' ')
            .trim()
            .slice(0, 200)
        : '';
    if (!name || !ALLOWED_FILE.test(name))
      throw new HttpError(
        400,
        'bad_request',
        'attach a document or an image (PDF, Word, slides, text, picture)',
      );
    if (typeof o.data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(o.data))
      throw new HttpError(400, 'bad_request', 'attachment data is base64');
    const size = Math.floor((o.data.replace(/\s+/g, '').length * 3) / 4);
    if (size > MAX_FILE_BYTES * 1.01) throw new HttpError(413, 'too_large', `${name} is over 4 MB`);
    total += size;
    if (total > MAX_DRAFT_FILE_BYTES * 1.01)
      throw new HttpError(413, 'too_large', 'attachments are over 5 MB in all');
    return {
      name,
      mimeType: typeof o.mimeType === 'string' && o.mimeType ? o.mimeType : 'application/octet-stream',
      data: o.data,
      kind: o.kind === 'resume' ? 'resume' : 'file',
    };
  });
}

/** Keeps the files and makes them the draft's attachments (replacing any it had). */
export async function setDraftFiles(
  db: Db,
  userId: string,
  draftId: string,
  files: IncomingFile[],
): Promise<DraftAttachment[]> {
  const list: DraftAttachment[] = [];
  for (const f of files) {
    const bytes = decodeBase64(f.data);
    if (!bytes.length) throw new HttpError(400, 'bad_request', `${f.name} is empty`);
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', `${f.name} is over 4 MB`);
    const [r] = await db.sql<{ id: string }>`
      insert into orbit.user_files (user_id, kind, name, mime_type, size, bytes)
      values (${userId}::uuid, ${f.kind ?? 'file'}, ${f.name}, ${f.mimeType}, ${bytes.length},
              decode(${f.data.replace(/\s+/g, '')}, 'base64'))
      returning id`;
    list.push({ id: r!.id, name: f.name, mimeType: f.mimeType, size: bytes.length });
  }
  await db.sql`
    update orbit.drafts set attachments = ${JSON.stringify(list)}::jsonb
     where id = ${draftId}::uuid and user_id = ${userId}::uuid`;
  return list;
}

/** The draft's files with their bytes, in order; undefined when one of them is gone. */
export async function draftFiles(
  db: Db,
  userId: string,
  attachments: unknown,
): Promise<MimeAttachment[] | undefined> {
  const list = Array.isArray(attachments) ? (attachments as DraftAttachment[]) : [];
  if (!list.length) return [];
  const ids = list.map((a) => a.id).filter((x) => typeof x === 'string');
  const rows = await db.sql<{ id: string; name: string; mime_type: string; b64: string }>`
    select id, name, mime_type, encode(bytes, 'base64') as b64 from orbit.user_files
     where user_id = ${userId}::uuid and id = any(${ids}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: MimeAttachment[] = [];
  for (const a of list) {
    const r = byId.get(a.id);
    if (!r) return undefined;
    out.push({ name: r.name, mimeType: r.mime_type, bytes: decodeBase64(r.b64) });
  }
  return out;
}
