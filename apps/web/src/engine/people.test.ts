import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { importConnectionsCsv, importLinkedInExport } from './linkedin';
import { suggestDuplicateMerges, upsertPerson } from './people';

const user: User = {
  id: 'u1',
  email: 'ravi.jain@umich.edu',
  fullName: 'Ravi Jain',
  firstName: 'Ravi',
  lastName: 'Jain',
  school: 'University of Michigan',
  majors: ['Computer Science'],
  timezone: 'America/Detroit',
  onboardingStep: 11,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const HDR = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\n';
const people = () => db.people.where('userId').equals(user.id).toArray();
const pick = (p: { displayName: string; firstName: string; namePlaceholder?: boolean }) => ({
  name: p.displayName,
  firstName: p.firstName,
  namePlaceholder: p.namePlaceholder,
});

beforeEach(async () => {
  await wipeDatabase();
});

describe('people resolution across sources', () => {
  it('NRC-06: gmail first, then a CSV row without email, gives one person', async () => {
    await upsertPerson({
      userId: user.id,
      email: 'dkim@stripe.com',
      displayName: 'Daniel Kim',
      source: 'gmail',
    });
    const r = await importConnectionsCsv(
      user,
      `${HDR}Daniel,Kim,https://www.linkedin.com/in/daniel-kim-1,,Stripe,Software Engineer,12 Mar 2025\n`,
    );
    expect(r).toMatchObject({ imported: 0, updated: 1 });
    const all = await people();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ currentTitle: 'Software Engineer', linkedinSlug: 'daniel-kim-1' });
    expect(await db.merges.count()).toBe(0);
  });

  it('NRC-09/NRC-17: CSV suffixes and accents produce the right greeting name', async () => {
    await importConnectionsCsv(
      user,
      `${HDR}Sam,"Lee, Jr.",https://www.linkedin.com/in/sam-lee-jr,,Acme Corp,CEO,10 Oct 2024\nJosé,Núñez-García,https://www.linkedin.com/in/jose-ng,,"Bain & Company, Inc.",Consultant,1 Sep 2023\n`,
    );
    const all = await people();
    const sam = all.find((p) => p.linkedinSlug === 'sam-lee-jr')!;
    expect(sam).toMatchObject({ displayName: 'Sam Lee', firstName: 'Sam', lastName: 'Lee' });
    const jose = all.find((p) => p.linkedinSlug === 'jose-ng')!;
    expect(jose).toMatchObject({ displayName: 'José Núñez-García', firstName: 'José' });
    // the plain gmail spelling and the short org name resolve to the same person and the same org row
    const { created } = await upsertPerson({
      userId: user.id,
      email: 'jose.nunez-garcia@bain.com',
      displayName: 'Jose Nunez-Garcia',
      companyRaw: 'Bain',
      source: 'gmail',
    });
    expect(created).toBe(false);
    const orgs = await db.organizations.toArray();
    expect(orgs.filter((o) => o.nameNormalized === 'bain')).toHaveLength(1);
    expect((await db.people.get(jose.id))!.displayName).toBe('José Núñez-García');
  });

  it('NRC-05/NRC-16: a gmail signature cannot overwrite the LinkedIn org or title', async () => {
    await importConnectionsCsv(
      user,
      `${HDR}William,Chen,https://www.linkedin.com/in/wchen,,McKinsey & Company,Associate,12 Mar 2025\n`,
    );
    const { person, created } = await upsertPerson({
      userId: user.id,
      email: 'wchen@mckinsey.com',
      displayName: 'Bill Chen',
      companyRaw: 'McKinsey',
      title: 'Consultant',
      source: 'gmail',
    });
    expect(created).toBe(false);
    expect(person).toMatchObject({ currentOrganizationRaw: 'McKinsey & Company', currentTitle: 'Associate' });
    expect(person.fieldSources).toMatchObject({
      currentTitle: 'linkedin_csv',
      currentOrganizationId: 'linkedin_csv',
    });
    expect(await db.organizations.count()).toBe(1);
    // a manual edit outranks the CSV
    const manual = await upsertPerson({
      userId: user.id,
      linkedinUrl: 'https://www.linkedin.com/in/wchen',
      title: 'Engagement Manager',
      source: 'manual',
    });
    expect(manual.person.currentTitle).toBe('Engagement Manager');
  });

  it('NRC-10: a bare address gets its real name when a signed email or CSV row arrives', async () => {
    const first = await upsertPerson({ userId: user.id, email: 'erodriguez@bain.com', source: 'gmail' });
    expect(first.person).toMatchObject({ displayName: 'erodriguez', namePlaceholder: true });
    await upsertPerson({
      userId: user.id,
      email: 'erodriguez@bain.com',
      displayName: 'Elena Rodriguez',
      companyRaw: 'Bain & Company',
      source: 'gmail',
    });
    const p = (await db.people.get(first.person.id))!;
    expect(p).toMatchObject({ displayName: 'Elena Rodriguez', firstName: 'Elena', namePlaceholder: false });
    // lowercase header names are cleaned too
    const tom = await upsertPerson({
      userId: user.id,
      email: 'twu@datadog.com',
      displayName: 'tom wu',
      source: 'gmail',
    });
    expect(tom.person).toMatchObject({ displayName: 'Tom Wu', firstName: 'Tom' });
    // dotted address without a name reads as a name until a real one arrives
    const dotted = await upsertPerson({ userId: user.id, email: 'maya.wu@figma.com', source: 'gmail' });
    expect(dotted.person.displayName).toBe('Maya Wu');
    // a header name that is only the handle ("priya.patel") is no name: never "Hi Priya.patel,"
    const handle = await upsertPerson({
      userId: user.id,
      email: 'priya.patel@x.com',
      displayName: 'priya.patel',
      source: 'gmail',
    });
    expect(handle.person).toMatchObject({
      displayName: 'Priya Patel',
      firstName: 'Priya',
      namePlaceholder: true,
    });
    const bare = await upsertPerson({
      userId: user.id,
      email: 'dkim@stripe.com',
      displayName: 'dkim',
      source: 'gmail',
    });
    expect(bare.person).toMatchObject({ displayName: 'dkim', namePlaceholder: true });
  });

  it('L21: a handle in any case becomes the name it spells out, never "Hi Priya.Patel," or "Hi pp,"', async () => {
    const cases: [string, string, string, string][] = [
      ['Priya.Patel', 'priya.patel@y.com', 'Priya Patel', 'Priya'],
      ['priya_patel', 'pp@x.com', 'Priya Patel', 'Priya'],
      ['jdoe', 'john.doe@acme.com', 'John Doe', 'John'],
      ['Sam_Lee', 'slee@z.com', 'Sam Lee', 'Sam'],
    ];
    for (const [displayName, email, full, first] of cases) {
      const r = await upsertPerson({ userId: user.id, email, displayName, source: 'gmail' });
      expect({ displayName, ...pick(r.person) }).toEqual({
        displayName,
        name: full,
        firstName: first,
        namePlaceholder: true,
      });
    }
    // a capitalised hyphenated single name is a real name, not a handle
    const mj = await upsertPerson({
      userId: user.id,
      email: 'mj@q.com',
      displayName: 'Mary-Jane',
      source: 'gmail',
    });
    expect(mj.person).toMatchObject({ displayName: 'Mary-Jane' });
    expect(mj.person.namePlaceholder).toBeUndefined();
  });

  it('NRC-20: two colleagues who share a surname and an employer get no merge card', async () => {
    await upsertPerson({
      userId: user.id,
      email: 'priya@figma.com',
      displayName: 'Priya Patel',
      companyRaw: 'Figma',
      source: 'gmail',
    });
    const arjun = await upsertPerson({
      userId: user.id,
      email: 'arjun@figma.com',
      displayName: 'Arjun Patel',
      companyRaw: 'Figma',
      source: 'gmail',
    });
    expect(arjun.created).toBe(true);
    expect(await db.merges.count()).toBe(0);
  });

  it('NRC-10: a typed address matches the CSV person at that employer instead of creating a duplicate', async () => {
    await importConnectionsCsv(
      user,
      `${HDR}Elena,Rodriguez,https://www.linkedin.com/in/elena-r,,Bain & Company,Manager,12 Mar 2025\n`,
    );
    const r = await upsertPerson({ userId: user.id, email: 'erodriguez@bain.com', source: 'gmail' });
    expect(r.created).toBe(false);
    expect(r.person.displayName).toBe('Elena Rodriguez');
    expect(await db.people.count()).toBe(1);
  });

  it('NRC-15: same full name at a new employer yields a merge suggestion', async () => {
    await upsertPerson({
      userId: user.id,
      email: 'priya@figma.com',
      displayName: 'Priya Patel',
      companyRaw: 'Figma',
      source: 'gmail',
    });
    await importConnectionsCsv(
      user,
      `${HDR}Priya,Patel,https://www.linkedin.com/in/priya-p,,Stripe,Product Manager,12 Mar 2025\n`,
    );
    const merges = await db.merges.toArray();
    expect(merges).toHaveLength(1);
    expect(merges[0]!.status).toBe('pending');
  });

  it('NRC-11: John Smith and Jonathan Smith at the same company stay two people', async () => {
    await importConnectionsCsv(
      user,
      `${HDR}Jonathan,Smith,https://www.linkedin.com/in/jsmith,,Stripe,Engineer,12 Mar 2025\n`,
    );
    const r = await upsertPerson({
      userId: user.id,
      displayName: 'John Smith',
      companyRaw: 'Stripe',
      source: 'gmail',
    });
    expect(r.created).toBe(true);
    expect(await db.people.count()).toBe(2);
  });
});

describe('duplicate detection after imports (NRC-20)', () => {
  const stored = (id: string, displayName: string, over: Record<string, unknown> = {}) => {
    const [firstName = '', ...rest] = displayName.split(' ');
    return db.people.add({
      id,
      userId: user.id,
      displayName,
      firstName,
      lastName: rest.join(' '),
      nameNormalized: displayName.toLowerCase(),
      emails: [],
      relationshipType: 'unknown',
      strength: 0,
      interactionCount: 0,
      sources: ['gmail'],
      isHuman: true,
      tags: [],
      createdAt: `2026-01-0${id.length}T00:00:00.000Z`,
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });
  };
  it('a CSV import raises merge cards for true duplicates and never for colleagues', async () => {
    await stored('pf', 'Priya Patel', {
      primaryEmail: 'priya@figma.com',
      emails: ['priya@figma.com'],
      currentOrganizationRaw: 'Figma',
    });
    await stored('pgm', 'Priya Patel', {
      primaryEmail: 'priya.patel@gmail.com',
      emails: ['priya.patel@gmail.com'],
    });
    await stored('arj', 'Arjun Patel', { currentOrganizationRaw: 'Figma' });
    await importConnectionsCsv(
      user,
      `${HDR}Maya,Wu,https://www.linkedin.com/in/maya-wu,,Datadog,Engineer,12 Mar 2025\n`,
    );
    const merges = await db.merges.toArray();
    const keys = merges.map((m) => [m.personAId, m.personBId].sort().join('|'));
    expect(keys).toEqual(['pf|pgm']);
    expect(merges[0]).toMatchObject({ status: 'pending' });
    // running it again, or after the student decided, adds nothing
    expect(await suggestDuplicateMerges(user.id)).toBe(0);
    await db.merges.update(merges[0]!.id, { status: 'rejected' });
    expect(await suggestDuplicateMerges(user.id)).toBe(0);
  });
});

describe('a LinkedIn upload from anywhere in the app', () => {
  it('rebuilds the recommendations at once, so Discover never says nobody matches right after an import', async () => {
    await db.goals.put({
      userId: user.id,
      cycleLabel: 'Summer 2027',
      targetRoles: ['Summer analyst'],
      targetFunctions: ['ib', 'consulting'],
      targetIndustries: [],
      targetLocations: [],
      ambition: 2,
    });
    await db.targetCompanies.put({
      id: 'tc1',
      userId: user.id,
      nameRaw: 'Goldman Sachs',
      priority: 1,
      status: 'researching',
    });
    const r = await importLinkedInExport(
      user,
      `${HDR}Daniel,Okafor,https://www.linkedin.com/in/daniel-okafor,,Goldman Sachs,Analyst,12 Mar 2025\nSana,Ahmed,https://www.linkedin.com/in/sana-ahmed,,McKinsey & Company,Business Analyst,1 Sep 2023\n`,
    );
    expect(r).toMatchObject({ imported: 2, updated: 0 });
    expect(r.recommended).toBeGreaterThan(0);
    const recs = await db.recommendations.where('userId').equals(user.id).toArray();
    const daniel = (await people()).find((p) => p.firstName === 'Daniel')!;
    const rec = recs.find((x) => x.personId === daniel.id)!;
    expect(rec.reasons.map((x) => x.text)).toContain('Works in investment banking (Analyst)');
    const sana = (await people()).find((p) => p.firstName === 'Sana')!;
    const sanaReasons = recs.find((x) => x.personId === sana.id)?.reasons.map((x) => x.text) ?? [];
    expect(sanaReasons.join(' ')).not.toMatch(/investment banking/);
    const li = await db.integrations.where('userId').equals(user.id).toArray();
    expect(li.map((i) => i.provider)).toEqual(['linkedin_csv']);
  });
});
