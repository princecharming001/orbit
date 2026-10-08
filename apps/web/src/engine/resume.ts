import type { Resume, ResumeFacet, User } from '@orbit/core';
import { heuristicResumeParse, newId, summarySentence } from '@orbit/core';
import { db } from '../db/schema';
import { hasLlm, llmResumeParse } from '../integrations/anthropic';
import { surfaceLlmFailure } from './brief';

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** A friendly error for files Orbit cannot read; its message is shown to the student as is. */
export class ResumeFileError extends Error {}

async function fileBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  // older environments: FileReader
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  void writer.write(data as unknown as BufferSource).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** One entry of a zip archive, read through the central directory (local headers may omit sizes). */
async function readZipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | undefined> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return undefined;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) return undefined;
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const entryName = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (view.getUint32(local, true) !== 0x04034b50) return undefined;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return inflateRaw(data);
    return undefined;
  }
  return undefined;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Plain text of a Word document: one line per paragraph, tabs and line breaks kept. */
export async function docxToText(bytes: Uint8Array): Promise<string> {
  const xml = await readZipEntry(bytes, 'word/document.xml');
  if (!xml) throw new ResumeFileError("That Word file couldn't be opened. Save it as a PDF and upload that.");
  return (
    new TextDecoder()
      .decode(xml)
      // line breaks between tags are formatting, not text
      .replace(/>\s*[\r\n]\s*</g, '><')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
        e[0] === '#'
          ? String.fromCodePoint(
              e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
            )
          : (XML_ENTITIES[e.toLowerCase()] ?? ''),
      )
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** True when text decoded from a file is mostly control or replacement characters (a binary file). */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: counting control characters is the point
  const bad = (sample.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) ?? []).length;
  return bad / sample.length > 0.05;
}

/** Text of an uploaded resume: PDF, Word (.docx) or plain text. Anything else is refused with a clear message. */
export async function extractTextFromFile(file: File): Promise<string> {
  if (file.size > MAX_RESUME_BYTES)
    throw new ResumeFileError(
      'That file is over 10 MB. Upload a PDF or Word version of your resume instead.',
    );
  const name = file.name.toLowerCase();
  if (/\.(doc|pages|rtf|odt)$/.test(name))
    throw new ResumeFileError(
      'Orbit reads PDF, Word (.docx) and plain text. Save your resume as a PDF and upload that.',
    );
  let text: string;
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let lastY: number | undefined;
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as { str: string; transform: number[] }[]) {
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs((y ?? 0) - lastY) > 2) {
          lines.push(line.trim());
          line = '';
        }
        line += `${item.str} `;
        lastY = y;
      }
      lines.push(line.trim());
      pages.push(lines.join('\n'));
    }
    text = pages.join('\n\n');
  } else {
    const bytes = await fileBytes(file);
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (name.endsWith('.docx') || isZip) text = await docxToText(bytes);
    else text = new TextDecoder().decode(bytes);
  }
  if (looksBinary(text))
    throw new ResumeFileError(
      "Orbit couldn't read text from that file. Save your resume as a PDF and upload that.",
    );
  if (!text.trim())
    throw new ResumeFileError(
      'That file has no text Orbit can read (a scanned PDF is an image). Upload a PDF exported from your editor.',
    );
  return text;
}

/** The facets of the student's current resume that they kept: what matching and drafting may use. */
export async function currentResumeFacets(userId: string): Promise<ResumeFacet[]> {
  const resume = await db.resumes
    .where('userId')
    .equals(userId)
    .filter((r) => r.isCurrent)
    .first();
  // demo data and older imports may have facets without a resume row; use them all then
  const facets = resume
    ? await db.resumeFacets.where('resumeId').equals(resume.id).toArray()
    : await db.resumeFacets.toArray();
  return facets.filter((f) => !f.excluded);
}

export async function saveResume(user: User, file: File): Promise<{ resume: Resume; facets: ResumeFacet[] }> {
  const text = await extractTextFromFile(file);
  const now = new Date().toISOString();
  await db.resumes.where('userId').equals(user.id).modify({ isCurrent: false });
  const resume: Resume = {
    id: newId('r'),
    userId: user.id,
    filename: file.name,
    text,
    isCurrent: true,
    createdAt: now,
  };
  await db.resumes.add(resume);
  let facets = hasLlm()
    ? await llmResumeParse(text, resume.id).catch((e) => surfaceLlmFailure(user.id, e))
    : undefined;
  const source: Resume['parseSource'] = facets ? 'llm' : 'heuristic';
  facets = facets ?? heuristicResumeParse(text, resume.id, { name: user.fullName || undefined });
  // a model-written summary gets the same rules as the heuristic one: one "<Name> is ..." sentence, or none
  facets = facets.flatMap((f) => {
    if (f.kind !== 'summary') return [f];
    const sentence = summarySentence(f.text, user.fullName || undefined);
    return sentence ? [{ ...f, text: sentence }] : [];
  });
  // a line Orbit could not read well (no role and no organization, or a few stray words) starts unticked, so it is
  // never used to describe the student until they say it is right
  facets = facets.map((f) =>
    ['experience', 'education', 'project'].includes(f.kind) &&
    ((!f.title && !f.organizationName) || f.text.split(/\s+/).length < 3)
      ? { ...f, excluded: true }
      : f,
  );
  await db.resumeFacets.bulkAdd(facets);
  await db.resumes.update(resume.id, { parsedAt: now, parseSource: source });
  return { resume: { ...resume, parsedAt: now, parseSource: source }, facets };
}
