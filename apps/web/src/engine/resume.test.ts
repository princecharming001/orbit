import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import {
  acceptResumeProposal,
  currentResumeFacets,
  dismissResumeProposal,
  docxToText,
  extractTextFromFile,
  looksBinary,
  resumeProposal,
  saveResume,
} from './resume';

const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(data as unknown as BufferSource);
  void w.close();
  const r = cs.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A minimal zip (no CRCs, which the reader does not check) like the ones Word writes. */
async function makeZip(entries: { name: string; text: string; deflate: boolean }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = enc.encode(e.text);
    const data = e.deflate ? await deflateRaw(raw) : raw;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(6, 0x08, true); // sizes in a data descriptor: the local header says 0
    lh.setUint16(8, e.deflate ? 8 : 0, true);
    lh.setUint16(26, name.length, true);
    const local = new Uint8Array([...new Uint8Array(lh.buffer), ...name, ...data]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(10, e.deflate ? 8 : 0, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = centrals.flatMap((c) => [...c]);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cd.length, true);
  end.setUint32(16, offset, true);
  return new Uint8Array([...locals.flatMap((l) => [...l]), ...cd, ...new Uint8Array(end.buffer)]);
}

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Ravi Jain</w:t></w:r></w:p>
<w:p><w:r><w:t>ravi.jain@umich.edu | (734) 555-0192</w:t></w:r></w:p>
<w:p><w:r><w:t>EXPERIENCE</w:t></w:r></w:p>
<w:p><w:r><w:t>Stripe</w:t></w:r><w:r><w:tab/><w:t>Jun 2025 – Aug 2025</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Product Management Intern, Payments &amp; Billing</w:t></w:r></w:p>
<w:p><w:r><w:t>• Shipped a self-serve refund flow used by 3,000 merchants</w:t></w:r></w:p>
</w:body></w:document>`;

const fakeFile = (name: string, bytes: Uint8Array, type = ''): File =>
  ({
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer,
  }) as unknown as File;

beforeEach(async () => {
  await wipeDatabase();
  await db.users.put(user);
});

describe('resume files (IS-13)', () => {
  it('reads the text of a .docx, deflated or stored', async () => {
    for (const deflate of [true, false]) {
      const zip = await makeZip([
        { name: '[Content_Types].xml', text: '<Types/>', deflate },
        { name: 'word/document.xml', text: DOC_XML, deflate },
      ]);
      const text = await docxToText(zip);
      expect(text).toContain('Ravi Jain\nravi.jain@umich.edu');
      expect(text).toContain('Stripe\tJun 2025 – Aug 2025');
      expect(text).toContain('Product Management Intern, Payments & Billing');
      expect(text).not.toMatch(/<w:|PK/);
    }
  });
  it('parses an uploaded .docx into facets, not zip bytes', async () => {
    const zip = await makeZip([{ name: 'word/document.xml', text: DOC_XML, deflate: true }]);
    const { resume, facets } = await saveResume(
      user,
      fakeFile('resume.docx', zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    );
    expect(resume.text).not.toContain('PK');
    expect(resume.text.startsWith('Ravi Jain')).toBe(true);
    const exp = facets.find((f) => f.kind === 'experience')!;
    expect(exp).toMatchObject({ organizationName: 'Stripe' });
    expect(exp.title).toMatch(/Product Management Intern/);
  });
  it('refuses binary, legacy Word, broken and oversized files with a clear message', async () => {
    const junk = new Uint8Array(4000).map((_, i) => (i * 7) % 32);
    await expect(extractTextFromFile(fakeFile('resume.txt', junk))).rejects.toThrow(/PDF/);
    await expect(extractTextFromFile(fakeFile('resume.doc', junk))).rejects.toThrow(/\.docx/);
    await expect(
      extractTextFromFile(fakeFile('resume.docx', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))),
    ).rejects.toThrow(/Word file/);
    const big = { name: 'resume.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 } as File;
    await expect(extractTextFromFile(big)).rejects.toThrow(/10 MB/);
    expect(looksBinary('Ravi Jain\nEXPERIENCE\n• Built things')).toBe(false);
  });
  it('reads plain text', async () => {
    const t = await extractTextFromFile(
      fakeFile('resume.txt', new TextEncoder().encode('Ravi Jain\nSKILLS\nGo, SQL')),
    );
    expect(t).toBe('Ravi Jain\nSKILLS\nGo, SQL');
  });
});

describe('resume facet review (NRC-21)', () => {
  it('facets the student unchecked, and facets of replaced resumes, are never used', async () => {
    const enc = new TextEncoder();
    await saveResume(
      user,
      fakeFile(
        'old.txt',
        enc.encode('Ravi Jain\nEXPERIENCE\nAcme Corp, Intern, Jun 2024 - Aug 2024\n• Did a thing'),
      ),
    );
    const { facets } = await saveResume(
      user,
      fakeFile(
        'new.txt',
        enc.encode(
          'Ravi Jain\nSUMMARY\nJunior studying computer science at Michigan.\nEXPERIENCE\nStripe, Product Intern, Jun 2025 - Aug 2025\n• Shipped a refund flow\nSKILLS\nGo, SQL, Figma',
        ),
      ),
    );
    const skills = facets.find((f) => f.kind === 'skill_group')!;
    await db.resumeFacets.update(skills.id, { excluded: true, confirmed: false });
    const used = await currentResumeFacets(user.id);
    expect(used.map((f) => f.id)).not.toContain(skills.id);
    expect(used.some((f) => f.organizationName === 'Acme Corp')).toBe(false);
    expect(used.some((f) => f.organizationName === 'Stripe')).toBe(true);
    expect(used.find((f) => f.kind === 'summary')?.text).toBe(
      'Ravi Jain is a junior studying computer science at Michigan.',
    );
  });
});

describe('the profile from the resume (plan 17 §G)', () => {
  const twoColumn = new File(
    [
      'Ravi Jain\nravi@umich.edu\n\nEDUCATION   University of Michigan   May 2027\nB.S.E. in Computer Science\n\nEXPERIENCE   Amma Health Inc.   San Francisco, CA\nSoftware Engineering Intern   Jun 2025 – Aug 2025\n• Built a FHIR ingestion pipeline for new clinics\n',
    ],
    'resume.txt',
    { type: 'text/plain' },
  );

  it('offers what differs, never sets it alone, and never offers the employer as the school', async () => {
    const stale = { ...user, school: 'Amma Health Inc.', majors: [], graduationYear: undefined };
    await db.users.put(stale);
    const { facets, proposal } = await saveResume(stale, twoColumn);
    expect(facets.filter((f) => f.kind === 'education').map((f) => f.organizationName)).toEqual([
      'University of Michigan',
    ]);
    expect(facets.find((f) => f.organizationName === 'Amma Health Inc.')?.kind).toBe('experience');
    expect(proposal).toEqual({
      school: 'University of Michigan',
      degree: 'B.S.E.',
      majors: ['Computer Science'],
      graduationYear: 2027,
    });
    // nothing changed until the student says yes
    expect((await db.users.get(user.id))?.school).toBe('Amma Health Inc.');
    expect(await resumeProposal(user.id)).toEqual(proposal);
    await acceptResumeProposal(user.id, ['school', 'graduationYear']);
    expect(await db.users.get(user.id)).toMatchObject({
      school: 'University of Michigan',
      graduationYear: 2027,
    });
    expect(await resumeProposal(user.id)).toBeUndefined();
  });

  it('a "no" keeps the profile, and an offer the profile already matches is not shown', async () => {
    await db.users.put({ ...user, graduationYear: 2026 });
    await saveResume((await db.users.get(user.id))!, twoColumn);
    expect(await resumeProposal(user.id)).toMatchObject({ graduationYear: 2027 });
    await dismissResumeProposal(user.id);
    expect(await resumeProposal(user.id)).toBeUndefined();
    expect((await db.users.get(user.id))?.graduationYear).toBe(2026);
    // the student fixes the year themselves: nothing left to offer after the next upload either
    await db.users.update(user.id, { graduationYear: 2027, degree: 'B.S.E.' });
    const { proposal } = await saveResume((await db.users.get(user.id))!, twoColumn);
    expect(proposal).toBeUndefined();
  });
});
