/**
 * A labelled corpus for identity resolution (plan 17 §A): pairs of a stored person and an incoming record from
 * another source (Gmail, Contacts and Messages, the LinkedIn export or live sync, a calendar invite, a manual add),
 * each labelled with the truth: the same person, or two people. Every pair goes through `resolveIdentity` as the
 * ingest paths call it.
 *
 * The bar: auto-merge precision 1.0 (no two people are ever merged without the student), hard negatives never even
 * suggested, and recall of match + suggest reported (and kept from falling).
 */
import { describe, expect, it } from 'vitest';
import { compareNames, nameAgreement } from '../entity/names';
import {
  doNotMergeKey,
  findDuplicatePairs,
  type IncomingIdentity,
  type ResolveDecision,
  resolveIdentity,
} from '../entity/resolve';
import { normalizeEmail, parseName } from '../text/normalize';
import type { Person } from '../types';

type Truth = 'same' | 'different';
interface Case {
  /** what the pair is, for the failure message */
  why: string;
  truth: Truth;
  stored: Partial<Person> & { displayName: string };
  /** more people already in Orbit (namesakes, the other half of a tie) */
  others?: (Partial<Person> & { displayName: string })[];
  incoming: Omit<IncomingIdentity, 'source'> & { source?: IncomingIdentity['source'] };
  /** a hard negative: must come back as a new person, never a suggestion */
  never?: boolean;
  /** pairs the student said are two people */
  rejected?: boolean;
}

let n = 0;
const person = (p: Partial<Person> & { displayName: string }): Person => {
  const name = parseName(p.displayName);
  const email = p.primaryEmail ? normalizeEmail(p.primaryEmail) : undefined;
  return {
    id: `p${++n}`,
    userId: 'u',
    firstName: name.first,
    lastName: name.last,
    nameNormalized: name.normalized,
    emails: email ? [email] : [],
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...p,
    primaryEmail: email,
  };
};
const li = (slug: string) => ({ linkedinUrl: `https://www.linkedin.com/in/${slug}`, linkedinSlug: slug });

const cases: Case[] = [];
const same = (why: string, stored: Case['stored'], incoming: Case['incoming'], extra: Partial<Case> = {}) =>
  cases.push({ why, truth: 'same', stored, incoming, ...extra });
const different = (
  why: string,
  stored: Case['stored'],
  incoming: Case['incoming'],
  extra: Partial<Case> = {},
) => cases.push({ why, truth: 'different', stored, incoming, ...extra });

// ---- deterministic keys: an address, a LinkedIn profile or member id, a phone number ----
for (const [name, email] of [
  ['Priya Patel', 'priya@figma.com'],
  ['Liz Chen', 'liz.chen+jobs@gmail.com'],
  ['Marcus Bell', 'marcus.bell@gmail.com'],
  ['Ana Ruiz', 'ana@stripe.com'],
] as const) {
  same(
    `${name}: the same address`,
    { displayName: name, primaryEmail: email },
    {
      displayName: name,
      email: email.toUpperCase(),
      source: 'calendar',
    },
  );
}
same(
  'gmail dots and +tags are one mailbox',
  { displayName: 'Liz Chen', primaryEmail: 'lizchen@gmail.com' },
  { displayName: 'Elizabeth Chen', email: 'Liz.Chen+jobs@gmail.com', source: 'calendar' },
);
for (const slug of ['daniel-kim-1', 'sofia-rossi', 'jose-ng']) {
  same(
    `the same LinkedIn profile (${slug})`,
    { displayName: 'Someone Here', ...li(slug) },
    {
      displayName: 'Someone Here',
      linkedinUrl: `linkedin.com/in/${slug.toUpperCase()}/`,
      source: 'linkedin_csv',
    },
  );
}
same(
  'the same LinkedIn member id from the live sync',
  { displayName: 'Rahul Mehta', linkedinMemberId: 'ACoAA1' },
  { displayName: 'Rahul Mehta', linkedinMemberId: 'ACoAA1', companyRaw: 'Ramp', source: 'enrichment' },
);
for (const [stored, incoming] of [
  ['Ana Ruiz', 'Ana Ruiz'],
  ['Elizabeth Chen', 'Liz Chen'],
  ['Robert Smith', 'Bob'],
  ['王伟', 'Wei Wang'],
  ['Ivan Petrov', 'Иван Петров'],
  ['Sam Lee', 'Samuel Lee'],
] as const)
  same(
    `a shared phone number (${stored} / ${incoming})`,
    { displayName: stored, phones: ['+15551234567'] },
    { displayName: incoming, phones: ['+15551234567'], phonesVerified: true, source: 'imessage' },
  );
same(
  'a phone number on a person known only by address',
  {
    displayName: 'erodriguez',
    primaryEmail: 'erodriguez@bain.com',
    namePlaceholder: true,
    phones: ['+16175550100'],
  },
  { displayName: 'Elena Rodriguez', phones: ['+16175550100'], phonesVerified: true, source: 'imessage' },
);
different(
  'one home line, two names (Contacts calls it John Doe, Orbit has Jane Doe on it)',
  { displayName: 'Jane Doe', phones: ['+15550001111'] },
  { displayName: 'John Doe', phones: ['+15550001111'], phonesVerified: true, source: 'imessage' },
);

// ---- nicknames ----
const nicknames: [string, string][] = [
  ['Bill', 'William'],
  ['Liz', 'Elizabeth'],
  ['Bob', 'Robert'],
  ['Mike', 'Michael'],
  ['Kate', 'Katherine'],
  ['Jim', 'James'],
  ['Tom', 'Thomas'],
  ['Dan', 'Daniel'],
  ['Jen', 'Jennifer'],
  ['Ken', 'Kenneth'],
  ['Peggy', 'Margaret'],
  ['Kit', 'Christopher'],
  ['Beth', 'Elizabeth'],
  ['Becky', 'Rebecca'],
  ['Matt', 'Matthew'],
  ['Nick', 'Nicholas'],
];
const surnames = ['Chen', 'Okafor', 'Novak', 'Haddad', 'Larsen', 'Ito', 'Moreau', 'Silva'];
nicknames.forEach(([nick, formal], i) => {
  const last = surnames[i % surnames.length]!;
  // LinkedIn has the formal name at an employer; mail comes from a work address there under the nickname
  same(
    `${nick}/${formal} ${last}: work address at the LinkedIn employer`,
    { displayName: `${formal} ${last}`, currentOrganizationRaw: 'Stripe', ...li(`${formal}-${last}-${i}`) },
    {
      displayName: `${nick} ${last}`,
      email: `${nick.toLowerCase()}.${last.toLowerCase()}@stripe.com`,
      source: 'gmail',
    },
  );
  // the same name evidence with only the employer in common: a question for the student
  same(
    `${nick}/${formal} ${last}: name and employer only`,
    { displayName: `${formal} ${last}`, currentOrganizationRaw: 'Bain & Company' },
    { displayName: `${nick} ${last}`, companyRaw: 'Bain', source: 'gmail' },
  );
});

// ---- accents and other alphabets ----
const accents: [string, string][] = [
  ['José Núñez', 'Jose Nunez'],
  ['Łukasz Żółć', 'Lukasz Zolc'],
  ['Søren Kierkegaard', 'Soren Kierkegaard'],
  ['Zoë Saldaña', 'Zoe Saldana'],
  ['François Dubois', 'Francois Dubois'],
  ['Björn Ölund', 'Bjorn Olund'],
  ['Thérèse Dvořák', 'Therese Dvorak'],
  ['Øystein Ødegaard', 'Oystein Odegaard'],
  ['Ḑāvids Ēķis', 'Davids Ekis'],
  ['Straße Weiß', 'Strasse Weiss'],
  ['Nguyễn Thị Lan', 'Nguyen Thi Lan'],
  ['Çağrı Öztürk', 'Cagri Ozturk'],
];
accents.forEach(([written, plain], i) => {
  const [first, ...rest] = plain.split(' ');
  const local = `${first}.${rest.at(-1)}`.toLowerCase();
  same(
    `${written} / ${plain}: work address`,
    { displayName: written, currentOrganizationRaw: 'Figma', ...li(`acc-${i}`) },
    { displayName: plain, email: `${local}@figma.com`, source: 'gmail' },
  );
  same(
    `${written} / ${plain}: name and school`,
    { displayName: written, school: 'University of Michigan' },
    { displayName: plain, school: 'University of Michigan', source: 'linkedin_csv' },
  );
});
const scripts: [string, string][] = [
  ['Иван Петров', 'Ivan Petrov'],
  ['Александр Смирнов', 'Aleksandr Smirnov'],
  ['Наталья Иванова', 'Natalya Ivanova'],
  ['Дмитрий Козлов', 'Dmitriy Kozlov'],
  ['Γιώργος Παπαδόπουλος', 'Giorgos Papadopoulos'],
  ['王伟', 'Wei Wang'],
  ['李娜', 'Na Li'],
  ['陳美玲', 'Meiling Chen'],
  ['张小明', 'Xiaoming Zhang'],
  ['김민준', 'Minjun Kim'],
  ['이서연', 'Seoyeon Lee'],
  ['박지훈', 'Jihun Park'],
  ['최유진', 'Yujin Choi'],
  ['정하은', 'Haeun Jung'],
];
scripts.forEach(([written, latin], i) => {
  same(
    `${written} / ${latin}: the same name in two scripts, and the same phone`,
    { displayName: written, phones: [`+1555300${String(i).padStart(4, '0')}`] },
    {
      displayName: latin,
      phones: [`+1555300${String(i).padStart(4, '0')}`],
      phonesVerified: true,
      source: 'imessage',
    },
  );
  same(
    `${written} / ${latin}: the same name in two scripts, and the employer`,
    { displayName: written, currentOrganizationRaw: 'Google' },
    { displayName: latin, companyRaw: 'Google', ...li(`script-${i}`), source: 'linkedin_csv' },
  );
});
same(
  'surname first in Latin letters (Wang Wei / 王伟)',
  { displayName: '王伟', currentOrganizationRaw: 'Tencent' },
  { displayName: 'Wang Wei', companyRaw: 'Tencent', source: 'gmail' },
);
same(
  'Cantonese spelling of a Chinese surname (陳嘉欣 / Ka Yan Chan is not this, but 陳美玲 / Meiling Chan is)',
  { displayName: '陳美玲', currentOrganizationRaw: 'HSBC' },
  { displayName: 'Meiling Chan', companyRaw: 'HSBC', source: 'linkedin_csv' },
);
for (const [a, b] of [
  ['王伟', '李娜'],
  ['王伟', 'Wei Zhang'],
  ['Иван Петров', 'Ivan Popov'],
  ['김민준', 'Minjun Park'],
  ['김민준', '김서연'],
  ['محمد علي', 'Omar Haddad'],
] as const)
  different(
    `${a} / ${b}: different names, the same employer`,
    { displayName: a, currentOrganizationRaw: 'Google' },
    { displayName: b, companyRaw: 'Google', source: 'linkedin_csv' },
  );
different(
  'two names in a script Orbit cannot read never match each other',
  { displayName: '🙂🙂', currentOrganizationRaw: 'Google' },
  { displayName: '🎉🎉', companyRaw: 'Google', source: 'linkedin_csv' },
);

// ---- middle names, initials, double surnames, maiden names ----
for (const [a, b] of [
  ['Mary Ann Smith', 'Mary Smith'],
  ['John F. Kennedy', 'John Kennedy'],
  ['J. Robert Oppenheimer', 'Robert Oppenheimer'],
  ['Ana María López', 'Ana López'],
  ['Min-Jun Kim', 'Minjun Kim'],
  ['Mary-Jane Watson', 'Maryjane Watson'],
  ['Gabriel García Márquez', 'Gabriel García'],
  ['José Núñez-García', 'Jose Nunez Garcia'],
  ['Ana de la Cruz', 'Ana Cruz'],
  ['Sarah Johnson-Miller', 'Sarah Johnson'],
  ['Emily Clark Davis', 'Emily Davis'],
  ['Maria Garcia Lopez', 'Maria Garcia'],
] as const) {
  same(
    `${a} / ${b}: work address at the employer`,
    { displayName: a, currentOrganizationRaw: 'Deloitte', currentOrganizationId: 'org-del' },
    {
      displayName: b,
      email: `${parseName(b)
        .first.toLowerCase()
        .replace(/[^a-z]/g, '')}.${parseName(b)
        .last.toLowerCase()
        .replace(/[^a-z]/g, '')}@deloitte.com`,
      source: 'gmail',
    },
  );
  same(
    `${a} / ${b}: name and employer only`,
    { displayName: a, currentOrganizationRaw: 'Accenture' },
    { displayName: b, companyRaw: 'Accenture', source: 'linkedin_csv' },
  );
}
same(
  'P. Patel and Priya Patel at the same firm (only asked)',
  { displayName: 'Priya Patel', primaryEmail: 'priya@figma.com', currentOrganizationRaw: 'Figma' },
  { displayName: 'P. Patel', email: 'p.patel@figma.com', companyRaw: 'Figma', source: 'gmail' },
);
different(
  'A. Patel is not Priya Patel',
  { displayName: 'Priya Patel', primaryEmail: 'priya@figma.com', currentOrganizationRaw: 'Figma' },
  { displayName: 'A. Patel', email: 'a.patel@figma.com', companyRaw: 'Figma', source: 'gmail' },
);
same(
  'a maiden name with the same address',
  { displayName: 'Sarah Johnson', primaryEmail: 'sarah.j.1990@gmail.com' },
  { displayName: 'Sarah Miller', email: 'sarah.j.1990@gmail.com', source: 'gmail' },
);
same(
  'a maiden name with the same phone',
  { displayName: 'Laura Bianchi', phones: ['+447700900123'] },
  { displayName: 'Laura Rossi', phones: ['+447700900123'], phonesVerified: true, source: 'imessage' },
);
// a married name with nothing else in common cannot be found from names (counted against recall, never merged)
same(
  'a maiden name and nothing else',
  { displayName: 'Rachel Green', currentOrganizationRaw: 'Ralph Lauren' },
  { displayName: 'Rachel Geller', companyRaw: 'Ralph Lauren', source: 'linkedin_csv' },
);

// ---- job changes, LinkedIn and Gmail joined ----
for (const [name, from, to] of [
  ['Priya Patel', 'Figma', 'Stripe'],
  ['Daniel Kim', 'Stripe', 'Ramp'],
  ['Elena Rodriguez', 'Bain & Company', 'Sequoia Capital'],
  ['Tomás Alvarez', 'McKinsey & Company', 'Airbnb'],
] as const) {
  same(
    `${name}: a new employer on LinkedIn (asked)`,
    {
      displayName: name,
      primaryEmail: `${name.split(' ')[0]!.toLowerCase()}@x-${from.length}.com`,
      currentOrganizationRaw: from,
    },
    {
      displayName: name,
      companyRaw: to,
      ...li(`${name.replace(' ', '-').toLowerCase()}-new`),
      source: 'linkedin_csv',
    },
  );
}
for (const [name, email, org] of [
  ['Daniel Kim', 'dkim@stripe.com', 'Stripe'],
  ['Kenneth Park', 'kpark@notion.so', 'Notion'],
  ['Hannah Weiss', 'hannah.weiss@ramp.com', 'Ramp'],
  ['Omar Haddad', 'ohaddad@bain.com', 'Bain & Company'],
  ['Grace Liu', 'grace@anthropic.com', 'Anthropic'],
  ['Sofia Rossi', 'srossi@mckinsey.com', 'McKinsey & Company'],
] as const)
  same(
    `${name}: mail first, then the LinkedIn export row (no address) at that employer`,
    { displayName: name, primaryEmail: email, sources: ['gmail'] },
    {
      displayName: name,
      companyRaw: org,
      ...li(`${name.replace(' ', '-').toLowerCase()}`),
      source: 'linkedin_csv',
    },
  );
for (const [name, email, org] of [
  ['Michael Chen', 'mchen@google.com', 'Google'],
  ['Aisha Bello', 'aisha.bello@meta.com', 'Meta'],
  ['Lucas Martin', 'lmartin@deloitte.com', 'Deloitte'],
  ['Wei Zhang', 'wei.zhang@amazon.com', 'Amazon'],
] as const)
  same(
    `${name}: LinkedIn first, then mail from a work address there`,
    { displayName: name, currentOrganizationRaw: org, ...li(`${name.replace(' ', '-').toLowerCase()}-li`) },
    { displayName: name, email, source: 'gmail' },
  );

// ---- namesakes: same name, two people ----
for (const [name, org] of [
  ['Michael Chen', 'Google'],
  ['David Kim', 'Amazon'],
  ['Sarah Johnson', 'Deloitte'],
  ['Wei Wang', 'Microsoft'],
  ['Maria Garcia', 'JPMorgan Chase'],
  ['John Smith', 'IBM'],
] as const) {
  const slug = name.replace(' ', '-').toLowerCase();
  different(
    `${name} at ${org}: two LinkedIn profiles`,
    { displayName: name, currentOrganizationRaw: org, ...li(`${slug}-a1`) },
    { displayName: name, companyRaw: org, ...li(`${slug}-b2`), source: 'linkedin_csv' },
    { never: true },
  );
  different(
    `${name} at ${org}: a personal address and the employer, against a LinkedIn-only namesake`,
    { displayName: name, currentOrganizationRaw: org, ...li(`${slug}-c3`) },
    {
      displayName: name,
      email: `${name.replace(' ', '').toLowerCase()}@gmail.com`,
      companyRaw: org,
      source: 'gmail',
    },
  );
  different(
    `${name}: a personal address that spells the name, against a LinkedIn-only namesake`,
    { displayName: name, currentOrganizationRaw: org, ...li(`${slug}-d4`) },
    { displayName: name, email: `${name.replace(' ', '').toLowerCase()}@gmail.com`, source: 'gmail' },
  );
  different(
    `${name}: a school address that spells the name, against a LinkedIn-only namesake`,
    { displayName: name, currentOrganizationRaw: org, ...li(`${slug}-e5`) },
    { displayName: name, email: `${name.replace(' ', '.').toLowerCase()}@umich.edu`, source: 'gmail' },
  );
  different(
    `${name} at ${org}: a numbered work address is another ${name}`,
    { displayName: name, currentOrganizationRaw: org, ...li(`${slug}-f6`) },
    {
      displayName: name,
      email: `${name.replace(' ', '.').toLowerCase()}2@${org.split(' ')[0]!.toLowerCase()}.com`,
      source: 'gmail',
    },
  );
  different(
    `${name} at ${org}: the export row against a mail contact with a signature employer`,
    {
      displayName: name,
      primaryEmail: `${name.split(' ')[0]!.toLowerCase()}88@yahoo.com`,
      currentOrganizationRaw: org,
    },
    { displayName: name, companyRaw: org, ...li(`${slug}-g7`), source: 'linkedin_csv' },
  );
}
different(
  'two Contacts cards with the same name and their own numbers',
  { displayName: 'Ana Ruiz', phones: ['+15551110000'] },
  { displayName: 'Ana Ruiz', phones: ['+15552220000'], phonesVerified: true, source: 'imessage' },
  { never: true },
);
different(
  'Contacts numbers against a LinkedIn namesake who has numbers of their own',
  { displayName: 'Kevin Brown', phones: ['+13125550101'], currentOrganizationRaw: 'Uber' },
  {
    displayName: 'Kevin Brown',
    phones: ['+13125550199'],
    phonesVerified: true,
    companyRaw: 'Uber',
    source: 'imessage',
  },
  { never: true },
);
different(
  'the student said these two are different people',
  { displayName: 'Daniel Kim', primaryEmail: 'dkim@stripe.com' },
  { displayName: 'Daniel Kim', companyRaw: 'Stripe', source: 'linkedin_csv' },
  { never: true, rejected: true },
);

// ---- different people with close names ----
for (const [a, b] of [
  ['Priya Patel', 'Pooja Patel'],
  ['Arjun Patel', 'Priya Patel'],
  ['Ellen Smith', 'Allan Smith'],
  ['Jon Smith', 'Jan Smith'],
  ['Marc Johnson', 'Mark Johnson'],
  ['Chris Lee', 'Christine Lee'],
  ['Sam Lee', 'Samantha Lee'],
  ['Alex Kim', 'Alexandra Kim'],
  ['Daniel Kim', 'Danielle Kim'],
  ['Erin Brooks', 'Aaron Brooks'],
  ['Juan Perez', 'Juana Perez'],
  ['Kevin Wu', 'Kelvin Wu'],
] as const) {
  different(
    `${a} / ${b} at one company, the stored one with a work address`,
    {
      displayName: a,
      primaryEmail: `${a.split(' ')[0]!.toLowerCase()}@figma.com`,
      currentOrganizationRaw: 'Figma',
    },
    {
      displayName: b,
      email: `${b.split(' ')[0]!.toLowerCase()}@figma.com`,
      companyRaw: 'Figma',
      source: 'gmail',
    },
  );
  different(
    `${a} / ${b}: the export row against a LinkedIn person`,
    { displayName: a, currentOrganizationRaw: 'Figma', ...li(`${a.replace(' ', '-').toLowerCase()}-x`) },
    { displayName: b, companyRaw: 'Figma', source: 'linkedin_csv' },
  );
}

// ---- sounds alike (Steven/Stephen), spelled close ----
for (const [a, b] of [
  ['Steven Lee', 'Stephen Lee'],
  ['Katherine Lopez', 'Catherine Lopez'],
  ['Sara Kaplan', 'Sarah Kaplan'],
  ['Mohammed Rahman', 'Muhammad Rahman'],
  ['Jon Carter', 'John Carter'],
  ['Anne Thomson', 'Anne Thompson'],
] as const)
  same(
    `${a} / ${b}: spelled differently, with a work address there`,
    { displayName: a, currentOrganizationRaw: 'Palantir' },
    {
      displayName: b,
      email: `${parseName(b).first[0]!.toLowerCase()}${parseName(b).last.toLowerCase()}@palantir.com`,
      source: 'gmail',
    },
  );

// ---- bare addresses ----
same(
  'a typed address that spells the name at the employer',
  { displayName: 'Elena Rodriguez', currentOrganizationRaw: 'Bain & Company' },
  { email: 'erodriguez@bain.com', source: 'gmail' },
);
different(
  'a typed address that does not fit the name',
  { displayName: 'Elena Rodriguez', currentOrganizationRaw: 'Bain & Company' },
  { email: 'mchen@bain.com', source: 'gmail' },
);
same(
  'a named export row for someone known only by address',
  { displayName: 'erodriguez', primaryEmail: 'erodriguez@bain.com', namePlaceholder: true },
  { firstName: 'Elena', lastName: 'Rodriguez', companyRaw: 'Bain & Company', source: 'linkedin_csv' },
);

// ---- look-alike employers ----
for (const inc of [
  { displayName: 'Jose Nunez', email: 'jnunez@baincapital.com', companyRaw: 'Bain Capital' },
  { displayName: 'Jose Nunez', email: 'jose.nunez@baincapital.com' },
  { displayName: 'Jose Nunez', companyRaw: 'Bain Capital' },
] as const)
  different(
    `José Núñez at Bain & Company / ${inc.email ?? inc.companyRaw}`,
    {
      displayName: 'José Núñez',
      primaryEmail: 'jose.nunez@bain.com',
      currentOrganizationRaw: 'Bain & Company',
      currentOrganizationId: 'o-bain',
    },
    inc,
  );

const orgDomains = new Map([
  ['o-bain', ['bain.com']],
  ['org-del', ['deloitte.com']],
]);

function run(c: Case): ResolveDecision {
  const stored = person({ ...c.stored, sources: c.stored.sources ?? ['linkedin_csv'] });
  const others = (c.others ?? []).map(person);
  const inc: IncomingIdentity = {
    source: 'gmail',
    ...c.incoming,
    personId: c.rejected ? 'incoming' : undefined,
  };
  return resolveIdentity(inc, {
    people: [stored, ...others],
    orgDomains,
    doNotMerge: c.rejected ? new Set([doNotMergeKey(stored.id, 'incoming')]) : undefined,
  });
}

const outcome = (d: ResolveDecision) =>
  d.kind === 'match' || d.kind === 'probable' ? 'auto' : d.kind === 'suggest' ? 'suggest' : 'new';

describe('identity corpus (plan 17 §A)', () => {
  const results = cases.map((c) => ({ c, d: run(c), o: outcome(run(c)) }));

  it('has at least 150 labelled pairs of both kinds', () => {
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(cases.filter((c) => c.truth === 'same').length).toBeGreaterThan(60);
    expect(cases.filter((c) => c.truth === 'different').length).toBeGreaterThan(60);
  });

  it('never merges two people on its own: auto-merge precision is 1.0', () => {
    const wrong = results.filter((r) => r.o === 'auto' && r.c.truth === 'different').map((r) => r.c.why);
    expect(wrong).toEqual([]);
    const auto = results.filter((r) => r.o === 'auto');
    expect(auto.length).toBeGreaterThan(40);
  });

  it('never even suggests a hard negative (two profiles, two sets of Contacts numbers, a rejected pair)', () => {
    const asked = results.filter((r) => r.c.never && r.o !== 'new').map((r) => `${r.c.why}: ${r.o}`);
    expect(asked).toEqual([]);
  });

  it('finds the same person (match or suggestion) for most true pairs, and reports recall', () => {
    const truePairs = results.filter((r) => r.c.truth === 'same');
    const found = truePairs.filter((r) => r.o !== 'new');
    const auto = truePairs.filter((r) => r.o === 'auto');
    const falseSuggest = results.filter((r) => r.c.truth === 'different' && r.o === 'suggest');
    const recall = found.length / truePairs.length;
    // reported in the test output (plan 17 asks for recall, not a bar on it); the floor keeps it from sliding
    console.info(
      `identity corpus: ${cases.length} pairs (${truePairs.length} same, ${cases.length - truePairs.length} different); ` +
        `auto-merge precision 1.0 on ${results.filter((r) => r.o === 'auto').length} auto-merges; ` +
        `recall match+suggest ${(recall * 100).toFixed(1)}% (${found.length}/${truePairs.length}), ` +
        `auto ${((auto.length / truePairs.length) * 100).toFixed(1)}%; ` +
        `suggestions on different pairs ${falseSuggest.length}`,
    );
    const missed = truePairs.filter((r) => r.o === 'new').map((r) => r.c.why);
    expect({ recall: recall >= 0.95, missed }).toMatchObject({ recall: true });
  });

  it('the duplicate pass keeps the same discipline: no hard negative is ever paired', () => {
    for (const r of results.filter((x) => x.c.never && !x.c.rejected)) {
      const a = person({ ...r.c.stored });
      const b = person({
        displayName: r.c.incoming.displayName ?? 'Unknown',
        primaryEmail: r.c.incoming.email,
        phones: r.c.incoming.phones,
        currentOrganizationRaw: r.c.incoming.companyRaw,
        linkedinUrl: r.c.incoming.linkedinUrl,
        linkedinSlug: r.c.incoming.linkedinUrl?.split('/in/')[1]?.replace(/\/$/, '').toLowerCase(),
      });
      expect({ why: r.c.why, pairs: findDuplicatePairs([a, b]).length }).toEqual({ why: r.c.why, pairs: 0 });
    }
  });
});

describe('the shared name matcher', () => {
  it('forgives scripts, accents, nicknames, middle names and order, and nothing folds to a match', () => {
    expect(nameAgreement('José Núñez', 'Jose Nunez')).toBe('same');
    expect(nameAgreement('Łukasz Żółć', 'Lukasz Zolc')).toBe('same');
    expect(nameAgreement('Søren Kierkegaard', 'Soren Kierkegaard')).toBe('same');
    expect(nameAgreement('Иван Петров', 'Ivan Petrov')).toBe('same');
    expect(nameAgreement('王伟', 'Wei Wang')).toBe('same');
    expect(nameAgreement('김민준', 'Minjun Kim')).toBe('same');
    expect(nameAgreement('이서연', 'Seoyeon Lee')).toBe('same');
    expect(nameAgreement('Bill Chen', 'William Chen')).toBe('nickname');
    expect(nameAgreement('Mary Ann Smith', 'Mary Smith')).toBe('same');
    expect(nameAgreement('Gabriel García Márquez', 'Gabriel Garcia')).toBe('same');
    expect(nameAgreement('王伟', '李娜')).toBeUndefined();
    expect(nameAgreement('🙂', '🎉')).toBeUndefined();
    expect(nameAgreement('', '')).toBeUndefined();
    expect(nameAgreement('P. Patel', 'Priya Patel')).toBeUndefined();
    expect(compareNames('P. Patel', 'Priya Patel')).toMatchObject({ given: 'initial', score: 0.6 });
    expect(compareNames('J. Robert Smith', 'Robert Smith').given).toBe('middle');
    expect(compareNames('Steven Lee', 'Stephen Lee').given).toBe('phonetic');
    expect(compareNames('Ellen Smith', 'Allan Smith').given).toBe('different');
    expect(compareNames('Wang Wei', 'Wei Wang')).toMatchObject({ swapped: true, score: 0.8 });
    expect(compareNames('王伟', 'Wang Wei')).toMatchObject({ swapped: true, score: 0.95 });
  });
});
