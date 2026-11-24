/**
 * Who is who, decided without asking. A student had 97 "same person?" questions waiting; they had answered 80 before
 * and said yes to every one. Nearly all were someone's mail on one record and their LinkedIn on another under exactly
 * the same name, with nobody else by that name. Those are folded together as they come in, the ones already waiting
 * are settled by a job, and only a real doubt is still a question.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergePeople, resolvePeople, settleSamePeople } from '../../functions/_shared/ingest/people.ts';
import { addPerson, signedInUser } from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const now = new Date('2026-11-24T12:00:00Z');
const live = async (userId: string) =>
  (
    await t.db.sql<{ display_name: string }>`
      select display_name from orbit.people
       where user_id = ${userId}::uuid and not is_self and merged_into is null and deleted_at is null
       order by display_name, created_at`
  ).map((r) => r.display_name);
const questions = async (userId: string, status = 'open') =>
  (
    await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.merge_suggestions where user_id = ${userId}::uuid and status = ${status}`
  )[0]!.n;
const linkedIn = (name: string, memberId: string, org?: string) => ({
  name,
  memberId,
  linkedinUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}`,
  org,
});
/** A question as it was left before the rule: two records and an open suggestion between them. */
async function ask(userId: string, a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  await t.db.sql`
    insert into orbit.merge_suggestions (user_id, person_a, person_b, score, features)
    values (${userId}::uuid, ${x}::uuid, ${y}::uuid, 0.85, '{}'::jsonb)`;
}

describe('as people come in', () => {
  it('mail from the only person by that name joins their LinkedIn record: no second person, no question', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Ria' });
    const li = await addPerson(t, userId, linkedIn('Aadhya Raghavan', 'ACoAAA1', 'Northwind'));
    const r = await resolvePeople(
      t.db,
      userId,
      [{ key: 'm', email: 'aadhya.r@gmail.com', name: 'Aadhya Raghavan', source: 'gmail' }],
      { now },
    );
    expect(r.byKey.get('m')).toBe(li);
    expect(await live(userId)).toEqual(['Aadhya Raghavan']);
    expect(await questions(userId)).toBe(0);
    const [p] = await t.db.sql<{ primary_email: string | null }>`
      select primary_email from orbit.people where id = ${li}::uuid`;
    // Gmail reads the address without its dots
    expect(p!.primary_email).toBe('aadhyar@gmail.com');
  });

  it('a very common surname, or two people by the name, is still a question', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Sol' });
    await addPerson(t, userId, linkedIn('Michael Chen', 'ACoBBB1'));
    await addPerson(t, userId, linkedIn('Devika Raghunathan', 'ACoBBB2'));
    await addPerson(t, userId, {
      name: 'Devika Raghunathan',
      memberId: 'ACoBBB3',
      linkedinUrl: 'https://www.linkedin.com/in/devika-raghunathan-2',
    });
    const r = await resolvePeople(
      t.db,
      userId,
      [
        { key: 'common', email: 'michaelchen@gmail.com', name: 'Michael Chen', source: 'gmail' },
        { key: 'two', email: 'devika.raghunathan@gmail.com', name: 'Devika Raghunathan', source: 'gmail' },
      ],
      { now },
    );
    // each became their own record, with a question to the student
    expect(new Set(r.byKey.values()).size).toBe(2);
    expect(await live(userId)).toHaveLength(5);
    expect(await questions(userId)).toBe(2);
  });

  it('a work address at another firm, spelled nothing like the name, is a question', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Tam' });
    await addPerson(t, userId, linkedIn('Ottoline Vasquez-Hart', 'ACoCCC1', 'Northwind'));
    await resolvePeople(
      t.db,
      userId,
      [{ key: 'm', email: 'deals@harborcapital.com', name: 'Ottoline Vasquez-Hart', source: 'gmail' }],
      { now },
    );
    expect(await live(userId)).toHaveLength(2);
  });
});

describe('the questions already waiting, and doubles of one profile', () => {
  it('settles the only-one-by-that-name pairs, keeps the LinkedIn record, and leaves the real doubts', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Uma' });
    // 1. mail + LinkedIn, one name, nobody else: settled
    const li1 = await addPerson(t, userId, linkedIn('Shelby Haas-Sapp', 'ACoDDD1'));
    const m1 = await addPerson(t, userId, { name: 'Shelby Haas-Sapp', email: 'shelby@teachsales.co' });
    await ask(userId, li1, m1);
    // 2. a common surname: still asked
    const li2 = await addPerson(t, userId, linkedIn('David Kim', 'ACoDDD2'));
    const m2 = await addPerson(t, userId, { name: 'David Kim', email: 'davidkim@gmail.com' });
    await ask(userId, li2, m2);
    // 3. a nickname, not the same name in full: still asked
    const li3 = await addPerson(t, userId, linkedIn('Elizabeth Okonkwo-Reyes', 'ACoDDD3'));
    const m3 = await addPerson(t, userId, { name: 'Liz Okonkwo-Reyes', email: 'liz.or@gmail.com' });
    await ask(userId, li3, m3);
    // 4. the student said these two are not one person: never joined
    const li4 = await addPerson(t, userId, linkedIn('Ignatius Bellweather', 'ACoDDD4'));
    const m4 = await addPerson(t, userId, { name: 'Ignatius Bellweather', email: 'iggy@bellweather.org' });
    await ask(userId, li4, m4);
    const [x, y] = li4 < m4 ? [li4, m4] : [m4, li4];
    await t.db.sql`
      insert into orbit.do_not_merge (user_id, person_a, person_b) values (${userId}::uuid, ${x}::uuid, ${y}::uuid)`;

    const out = await settleSamePeople(t.db, userId);
    expect(out).toMatchObject({ sameProfile: 0, assumed: 1 });
    expect(out.survivors).toEqual([li1]);
    expect(await questions(userId)).toBe(3);
    expect(await questions(userId, 'merged')).toBe(1);
    // the LinkedIn record stays and now carries the address; the mail record points at it
    const [kept] = await t.db.sql<{ primary_email: string | null; merged_into: string | null }>`
      select primary_email, merged_into from orbit.people where id = ${li1}::uuid`;
    expect(kept).toMatchObject({ primary_email: 'shelby@teachsales.co', merged_into: null });
    const [gone] = await t.db.sql<{ merged_into: string | null }>`
      select merged_into from orbit.people where id = ${m1}::uuid`;
    expect(gone!.merged_into).toBe(li1);
    // a second run has nothing left to do
    expect(await settleSamePeople(t.db, userId)).toMatchObject({ sameProfile: 0, assumed: 0 });
  });

  it('two rows for one LinkedIn profile are one person; and once they are, a question that waited on it is settled', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Val' });
    const first = await addPerson(t, userId, linkedIn('Cosima Altenberg', 'ACoEEE1'));
    // the same profile again, made by a second ingest at the same moment
    const [dup] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, linkedin_member_id, sources)
      values (${userId}::uuid, 'Cosima Altenberg', 'Cosima', 'Altenberg', 'cosima altenberg', 'ACoEEE1', ${['linkedin']}::text[])
      returning id`;
    const mail = await addPerson(t, userId, { name: 'Cosima Altenberg', email: 'cosima@altenberg.studio' });
    await ask(userId, first, mail);
    // before: three records by one name, so the question could not be decided
    const out = await settleSamePeople(t.db, userId);
    expect(out.sameProfile).toBe(1);
    expect(out.assumed).toBe(1);
    expect(await live(userId)).toEqual(['Cosima Altenberg']);
    expect(await questions(userId)).toBe(0);
    const [d] = await t.db.sql<{ merged_into: string | null }>`
      select merged_into from orbit.people where id = ${dup!.id}::uuid`;
    expect(d!.merged_into).toBe(first);
  });

  it('whichever of the two rows stays, the question that waited on the other moves over and is settled', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Xan' });
    const [older] = await t.db.sql<{ id: string }>`
      insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, linkedin_member_id, sources, created_at)
      values (${userId}::uuid, 'Isolde Varga-Whitlock', 'Isolde', 'Varga-Whitlock', 'isolde varga-whitlock', 'ACoGGG1', ${['linkedin']}::text[],
              now() - interval '1 day')
      returning id`;
    // the newer double is the one the question was asked about: it is the one folded away
    const newer = await addPerson(t, userId, linkedIn('Isolde Varga-Whitlock', 'ACoGGG1'));
    await t.db
      .sql`delete from orbit.person_identities where person_id = ${newer}::uuid and kind = 'linkedin_member'`;
    const mail = await addPerson(t, userId, { name: 'Isolde Varga-Whitlock', email: 'isolde@varga.studio' });
    await ask(userId, newer, mail);
    const out = await settleSamePeople(t.db, userId);
    expect(out.sameProfile).toBe(1);
    expect(out.assumed).toBe(1);
    expect(await live(userId)).toEqual(['Isolde Varga-Whitlock']);
    expect(await questions(userId)).toBe(0);
    const [n] = await t.db.sql<{ merged_into: string | null }>`
      select merged_into from orbit.people where id = ${newer}::uuid`;
    expect(n!.merged_into).toBe(older!.id);
  });

  it('nothing is ever deleted: a folded record keeps its row, and the student can still be asked nothing twice', async () => {
    const { userId } = await signedInUser(t, { firstName: 'Wes' });
    const li = await addPerson(t, userId, linkedIn('Perpetua Lindqvist', 'ACoFFF1'));
    const mail = await addPerson(t, userId, { name: 'Perpetua Lindqvist', email: 'perpetua@lindqvist.se' });
    await ask(userId, li, mail);
    const [before] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.people where user_id = ${userId}::uuid`;
    await settleSamePeople(t.db, userId);
    const [after] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit.people where user_id = ${userId}::uuid`;
    expect(after!.n).toBe(before!.n);
    // folding the same two again is a no-op
    expect(await mergePeople(t.db, userId, li, mail)).toBeDefined();
    expect(await live(userId)).toEqual(['Perpetua Lindqvist']);
  });
});
