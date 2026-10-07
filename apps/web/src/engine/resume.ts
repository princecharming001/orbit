import type { Resume, ResumeFacet, User } from '@orbit/core';
import { heuristicResumeParse, newId } from '@orbit/core';
import { db } from '../db/schema';
import { hasLlm, llmResumeParse } from '../integrations/anthropic';
import { surfaceLlmFailure } from './brief';

export async function extractTextFromFile(file: File): Promise<string> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
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
    return pages.join('\n\n');
  }
  return file.text();
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
  facets = facets ?? heuristicResumeParse(text, resume.id);
  await db.resumeFacets.bulkAdd(facets);
  await db.resumes.update(resume.id, { parsedAt: now, parseSource: source });
  return { resume: { ...resume, parsedAt: now, parseSource: source }, facets };
}
