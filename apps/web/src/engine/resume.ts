import type { Resume, ResumeFacet, ResumeProfile, User } from '@orbit/core';
import {
  heuristicResumeParse,
  looksLikeCompany,
  looksLikeSchool,
  newId,
  normalizeCompany,
  profileFromResume,
  resumeProfileChanges,
  summarySentence,
} from '@orbit/core';
import { db } from '../db/schema';
import { claudeReachable, llmResumeParse } from '../integrations/anthropic';
import { surfaceLlmFailure } from './brief';
import { updateProfile } from './settings';

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

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

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
      for (const item of content.items as {
        str: string;
        transform: number[];
      }[]) {
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

/**
 * The person is at an organisation the student is in now (their own club, their current job): someone they see, not a
 * stranger to warm up to on LinkedIn.
 */
export function sharesOrgNow(
  person: { currentOrganizationRaw?: string },
  facets: Pick<ResumeFacet, 'kind' | 'organizationName' | 'endDate'>[],
): boolean {
  const org = normalizeCompany(person.currentOrganizationRaw);
  return (
    !!org &&
    facets.some(
      (f) =>
        f.kind === 'experience' &&
        !f.endDate &&
        !!f.organizationName &&
        normalizeCompany(f.organizationName) === org,
    )
  );
}

/** The facets of the student's current resume that they kept: what matching and drafting may use. */
export async function currentResumeFacets(userId: string): Promise<ResumeFacet[]> {
  const resume = await db.resumes
    .where('userId')
    .equals(userId)
    .filter((r) => r.isCurrent)
    .first();
  // only the student's own: with no resume of theirs there are no facets (never another profile's, like the demo's)
  if (!resume) return [];
  const facets = await db.resumeFacets.where('resumeId').equals(resume.id).toArray();
  return facets.filter((f) => !f.excluded);
}

/**
 * The chat's "Resume" line: what the student's current resume says, every kept line, so Orbit knows their background
 * without being asked. Capped so a long resume never crowds out the rest of the snapshot.
 */
export async function resumeContextLine(userId: string, max = 2400): Promise<string | undefined> {
  const facets = await currentResumeFacets(userId);
  if (!facets.length) return undefined;
  const order: ResumeFacet['kind'][] = [
    'summary',
    'experience',
    'education',
    'project',
    'skill_group',
    'interest',
  ];
  const parts = [...facets]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map((f) => {
      const head = [f.title, f.organizationName].filter(Boolean).join(', ');
      const when =
        f.startDate || f.endDate
          ? ` (${f.startDate?.slice(0, 7) ?? ''} to ${f.endDate?.slice(0, 7) ?? 'now'})`
          : '';
      const body = f.text.replace(/\s+/g, ' ').trim();
      return f.kind === 'summary' ? body : `${f.kind}: ${head}${when}${head && body ? ': ' : ''}${body}`;
    });
  let line = `Resume (the student's own, current): ${parts.join(' | ')}`;
  if (line.length > max) line = `${line.slice(0, max - 1)}…`;
  return line;
}

/**
 * A model's education line whose place is an employer (a two-column PDF ran a job into the Education column): it is
 * read as a job, so the employer never becomes the student's school.
 */
function employerNotSchool(f: ResumeFacet): ResumeFacet {
  if (f.kind !== 'education' || !f.organizationName) return f;
  return looksLikeCompany(f.organizationName) && !looksLikeSchool(f.organizationName)
    ? { ...f, kind: 'experience' }
    : f;
}

export async function saveResume(
  user: User,
  file: File,
): Promise<{
  resume: Resume;
  facets: ResumeFacet[];
  proposal?: ResumeProfile;
}> {
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
  // Claude reads it with the student's own key (the resume switch on) or through Orbit's shared access; Orbit's own
  // parser otherwise, or when that fails
  let facets = claudeReachable('resume', 'resume')
    ? await llmResumeParse(text, resume.id).catch((e) => surfaceLlmFailure(user.id, e))
    : undefined;
  const source: Resume['parseSource'] = facets ? 'llm' : 'heuristic';
  facets =
    facets?.map(employerNotSchool) ??
    heuristicResumeParse(text, resume.id, { name: user.fullName || undefined });
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
  // the school, majors and year the resume states, offered (never set) where the profile says something else
  const proposal = resumeProfileChanges(user, profileFromResume(facets));
  if (proposal)
    await db.kv.put({
      key: proposalKey(user.id),
      value: { resumeId: resume.id, ...proposal },
    });
  else await db.kv.delete(proposalKey(user.id));
  // last, so a resume shown as read has its lines and its offer in place (Settings waits for parsedAt)
  await db.resumes.update(resume.id, { parsedAt: now, parseSource: source });
  return {
    resume: { ...resume, parsedAt: now, parseSource: source },
    facets,
    proposal,
  };
}

// ---- the profile, from the resume ----------------------------------------------------------------------------------

const proposalKey = (userId: string) => `resumeProfile:${userId}`;

/**
 * What the current resume says about the student's school, majors, degree and graduation year that their profile
 * does not, while that is still so and they have not said no. Never an employer as the school.
 */
export async function resumeProposal(userId: string): Promise<ResumeProfile | undefined> {
  const row = (await db.kv.get(proposalKey(userId)))?.value as
    | (ResumeProfile & { resumeId: string; dismissed?: boolean })
    | undefined;
  if (!row || row.dismissed) return undefined;
  const [user, resume] = await Promise.all([db.users.get(userId), db.resumes.get(row.resumeId)]);
  if (!user || !resume?.isCurrent) return undefined;
  const { resumeId: _r, dismissed: _d, ...offer } = row;
  return resumeProfileChanges(user, offer);
}

/** Use what the resume says (all of it, or the fields named) in the profile; the offer is then closed. */
export async function acceptResumeProposal(
  userId: string,
  fields?: (keyof ResumeProfile)[],
): Promise<User | undefined> {
  const offer = await resumeProposal(userId);
  if (!offer) return undefined;
  const pick = <K extends keyof ResumeProfile>(k: K) =>
    (!fields || fields.includes(k)) && offer[k] !== undefined;
  const user = await updateProfile(userId, {
    ...(pick('school') && offer.school && looksLikeSchool(offer.school) ? { school: offer.school } : {}),
    ...(pick('majors') ? { majors: offer.majors } : {}),
    ...(pick('graduationYear') ? { graduationYear: offer.graduationYear } : {}),
    ...(pick('degree') ? { degree: offer.degree } : {}),
  });
  await db.kv.delete(proposalKey(userId));
  return user;
}

/** The student said no: the offer stays closed until another resume is uploaded. */
export async function dismissResumeProposal(userId: string): Promise<void> {
  const row = (await db.kv.get(proposalKey(userId)))?.value as Record<string, unknown> | undefined;
  if (row)
    await db.kv.put({
      key: proposalKey(userId),
      value: { ...row, dismissed: true },
    });
}

/** "school University of Michigan, majors Computer Science, class of 2027", for the chat and the offer card. */
export function describeResumeProfile(p: ResumeProfile): string {
  return [
    p.school ? `school ${p.school}` : '',
    p.degree ? `degree ${p.degree}` : '',
    p.majors?.length ? `${p.majors.length > 1 ? 'majors' : 'major'} ${p.majors.join(', ')}` : '',
    p.graduationYear ? `class of ${p.graduationYear}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** The snapshot's line for an open offer, so the chat asks before changing the profile. */
export async function resumeProposalLine(userId: string): Promise<string | undefined> {
  const p = await resumeProposal(userId);
  if (!p) return undefined;
  return `Their resume says ${describeResumeProfile(p)}, which their profile does not. Offer once to use it in their profile; only on a yes call update_settings (section profile) with those fields.`;
}

/** Tick or untick a line Orbit read from the resume; an unticked line is never used to describe the student. */
export async function setResumeFacetUsed(facetId: string, used: boolean): Promise<boolean> {
  return (
    (await db.resumeFacets.update(facetId, {
      excluded: !used,
      confirmed: used,
    })) > 0
  );
}

/** Facet kinds that have a role (or degree) and a place; the rest are one line of text. */
export const FACETS_WITH_ROLE = new Set<ResumeFacet['kind']>(['experience', 'education', 'project']);

/** Fix a line Orbit read: the role or degree, where, and what the student did. A fixed line is kept and confirmed. */
export async function fixResumeFacet(
  facetId: string,
  changes: { title?: string; organizationName?: string; text?: string },
): Promise<ResumeFacet | undefined> {
  const facet = await db.resumeFacets.get(facetId);
  if (!facet) return undefined;
  const role = FACETS_WITH_ROLE.has(facet.kind);
  const title = role ? (changes.title ?? facet.title ?? '').trim() || undefined : facet.title;
  const org = role
    ? (changes.organizationName ?? facet.organizationName ?? '').trim() || undefined
    : facet.organizationName;
  const text =
    (changes.text ?? '').trim() ||
    (changes.text === undefined ? facet.text : [title, org].filter(Boolean).join(', '));
  await db.resumeFacets.update(facetId, {
    title,
    organizationName: org,
    text,
    excluded: false,
    confirmed: true,
  });
  return db.resumeFacets.get(facetId);
}
