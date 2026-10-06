import type { User } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { importConnectionsCsv } from './linkedin';
import { upsertPerson } from './people';

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
