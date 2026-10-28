import { describe, expect, it } from 'vitest';
import { cycleOptions, listField, suggestFrom } from './options';
import { findSchoolDomain, fold, loadSchools, schoolDomainFor, suggestSchools } from './schools';

describe('school suggestions', () => {
  it('finds schools by name, nickname and domain, big ones first', async () => {
    expect((await suggestSchools('UC Berkele')).map((s) => s.value)[0]).toBe(
      'University of California, Berkeley',
    );
    expect((await suggestSchools('umich')).map((s) => s.value)[0]).toBe('University of Michigan - Ann Arbor');
    expect((await suggestSchools('georgia tech')).map((s) => s.value)[0]).toBe(
      'Georgia Institute of Technology',
    );
    expect((await suggestSchools('de anza')).map((s) => s.value)[0]).toBe('De Anza College');
    expect((await suggestSchools('purdue')).map((s) => s.value)[0]).toBe('Purdue University');
    expect((await suggestSchools('mit')).map((s) => s.value)[0]).toBe(
      'Massachusetts Institute of Technology',
    );
    expect((await suggestSchools('oxford')).map((s) => s.value)).toContain('University of Oxford');
    expect((await suggestSchools('x')).length).toBe(0);
    expect(await schoolDomainFor('University of California, Berkeley')).toBe('berkeley.edu');
  });
});

describe('school domain by name', () => {
  // the lookup before it was indexed: a scan of the whole list per name
  async function scan(name: string) {
    const q = fold(name).replace(/^the /, '');
    if (!q) return undefined;
    const all = await loadSchools();
    const byName = all.find((s) => s.domain && fold(s.name).replace(/^the /, '') === q);
    if (byName) return byName.domain;
    const byAlias = all.filter((s) => s.domain && s.aliases.some((a) => fold(a) === q));
    return byAlias.length === 1 ? byAlias[0]!.domain : undefined;
  }

  it('answers exactly as a scan of the list does', async () => {
    const all = await loadSchools();
    const names = [
      ...all.filter((_, i) => i % 100 === 0).flatMap((s) => [s.name, `The ${s.name}`, ...s.aliases]),
      'sjsu',
      'UCSC',
      'Cal',
      'Acme Robotics',
      '',
    ];
    for (const n of names) expect(await findSchoolDomain(n), n).toBe(await scan(n));
    expect(await findSchoolDomain('University of California, Berkeley')).toBe('berkeley.edu');
  });
});

describe('field options', () => {
  it('cycles start with the coming summer; lists suggest the item being typed and pick into it', () => {
    const c = cycleOptions(new Date('2026-10-22'));
    expect(c[0]!.value).toBe('Summer 2027 internship');
    expect(
      suggestFrom(['Product Manager', 'Project Manager', 'Software Engineer'], 'pro').map((s) => s.value),
    ).toEqual(['Product Manager', 'Project Manager']);
    const f = listField(['New York City', 'Chicago', 'Remote']);
    expect(f.suggest('New York City, chi').map((s) => s.value)).toEqual(['Chicago']);
    expect(f.pick('New York City, chi', 'Chicago')).toBe('New York City, Chicago');
  });
});
