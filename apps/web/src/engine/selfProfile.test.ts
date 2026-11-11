import { newId, type Person, type User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileSearch } from '../chat/agent/searchCompile';
import { buildSnapshot } from '../chat/agent/snapshot';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { runNetworkSearch } from './networkSearch';
import { aboutMe, aboutMeLines, ownProfile, readOwnProfile, schoolLevel, schoolsOf } from './selfProfile';

let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

describe('which kind of school', () => {
  it('reads high schools, colleges and graduate schools from the name and the degree', () => {
    expect(schoolLevel({ school: 'Mission San Jose High School' })).toBe('high_school');
    expect(schoolLevel({ school: 'Phillips Exeter Academy' })).toBe('high_school');
    expect(schoolLevel({ school: 'Harker', degree: 'High School Diploma' })).toBe('high_school');
    expect(schoolLevel({ school: 'University of California, Berkeley', degree: 'BS' })).toBe('college');
    expect(schoolLevel({ school: 'Cornell University' })).toBe('college');
    expect(schoolLevel({ school: 'Stanford Graduate School of Business', degree: 'MBA' })).toBe('graduate');
    expect(schoolLevel({ school: 'Stanford University', degree: 'Master of Science' })).toBe('graduate');
  });
});

describe("the student's own LinkedIn profile", () => {
  it('is read in full once, kept, and read again only after two weeks', async () => {
    expect(await readOwnProfile(user)).toBe('read');
    const kept = await ownProfile(user.id);
    expect(kept?.profile.education.length).toBeGreaterThan(1);
    expect(await readOwnProfile(user)).toBe('fresh');
    const later = new Date(Date.parse(kept!.readAt) + 15 * 86_400_000);
    expect(await readOwnProfile(user, { now: later })).toBe('read');
  });

  it('knows every school (the high school too), the jobs, skills and the rest', async () => {
    const me = await aboutMe(user);
    expect(schoolsOf(me, 'high_school')).toEqual(['Lincoln High School']);
    expect(schoolsOf(me, 'college')).toContain(user.school);
    expect(me.jobs.length).toBeGreaterThan(0);
    expect(me.skills).toContain('TypeScript');
    const lines = aboutMeLines(me).join('\n');
    expect(lines).toMatch(/Schools: .*Lincoln High School \(high school/);
    expect(lines).toMatch(/Experience: .*Brex/);
    expect(lines).toMatch(/Skills: /);
    expect(lines).toMatch(/Languages: .*Spanish/);
    // short enough for the chat's context, and no dashes
    expect(aboutMeLines(me, 600).join(' | ').length).toBeLessThanOrEqual(700);
    expect(lines).not.toMatch(/[—–]/);
  });

  it('the chat is told who the student is, from their profile', async () => {
    const snap = await buildSnapshot(user.id, new Date());
    expect(snap.text).toMatch(/About the student, from their own LinkedIn profile/);
    expect(snap.text).toMatch(/Lincoln High School \(high school/);
  });
});

describe('"people who went to my high school"', () => {
  it("compiles to the student's own high school, and finds the people from it, not the college alums", async () => {
    const spec = compileSearch('list out people who went to my high school');
    expect(spec?.relationship).toMatchObject({ alumOfMySchool: true, mySchoolLevel: 'high_school' });
    expect(compileSearch('who do I know from my college')?.relationship).toMatchObject({
      alumOfMySchool: true,
      mySchoolLevel: 'college',
    });
    const now = new Date().toISOString();
    const add = async (name: string, school: string): Promise<Person> => {
      const p = {
        id: newId('p'),
        userId: user.id,
        displayName: name,
        firstName: name.split(' ')[0],
        lastName: name.split(' ')[1],
        emails: [],
        isHuman: true,
        sources: ['linkedin_profile'],
        relationshipType: 'unknown',
        createdAt: now,
        updatedAt: now,
      } as unknown as Person;
      await db.people.add(p);
      await db.affiliations.add({
        id: newId('a'),
        userId: user.id,
        personId: p.id,
        kind: 'education',
        nameRaw: school,
        isCurrent: false,
        source: 'linkedin_profile',
      });
      return p;
    };
    const hs = await add('Jamie Ortega', 'Lincoln High School');
    const cornell = await add('Sam Patel', user.school);
    await readOwnProfile(user);
    const r = await runNetworkSearch(user, spec!, { caller: 'router' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sure = r.rows.filter((x) => x.band === 'strong' || x.band === 'likely').map((x) => x.personId);
    expect(sure).toContain(hs.id);
    expect(sure).not.toContain(cornell.id);
  });
});
