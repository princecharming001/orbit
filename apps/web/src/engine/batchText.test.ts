import { describe, expect, it } from 'vitest';
import { fieldsIn, fillTemplate, likeness, nearTwins } from './batchText';

const priya = {
  firstName: 'Priya',
  lastName: 'Shah',
  displayName: 'Priya Shah',
  currentOrganizationRaw: 'Stripe',
  currentTitle: 'University Recruiter',
  school: 'Cornell',
};

describe('fillTemplate', () => {
  it('fills each field, in either brace style, any case', () => {
    const r = fillTemplate('Hi {first}, I saw {{ company }} is hiring. I am at {School}. {TITLE}', priya);
    expect(r.text).toBe('Hi Priya, I saw Stripe is hiring. I am at Cornell. University Recruiter');
    expect(r.missing).toEqual([]);
  });
  it('leaves a field it cannot fill in braces and names it', () => {
    const r = fillTemplate('Hi {first}, how is {company}?', { displayName: 'Sam Lee' });
    expect(r.text).toBe('Hi Sam, how is {company}?');
    expect(r.missing).toEqual(['company']);
  });
  it('a last name from the full name', () => {
    expect(fillTemplate('{last}', { displayName: 'Ana de la Cruz' }).text).toBe('de la Cruz');
  });
  it('lists the fields a message uses', () => {
    expect(fieldsIn('Hi {first}, {company} and {first}')).toEqual(['first', 'company']);
  });
});

describe('likeness', () => {
  const base =
    'Hi Priya, I am a junior at Cornell studying computer science and I would love to learn about the PM internship at Stripe this summer.';
  it('the same words to two people read as the same, once the names are out', () => {
    const other = base.replace('Priya', 'Sam').replace('Stripe', 'Ramp');
    expect(likeness(base, other, ['Priya', 'Stripe', 'Sam', 'Ramp'])).toBeGreaterThan(0.8);
  });
  it('two different messages do not', () => {
    const other =
      'Hey Sam, your talk on payments infrastructure at the Ramp offsite stuck with me; could I ask two questions about your team?';
    expect(likeness(base, other, ['Priya', 'Sam'])).toBeLessThan(0.2);
  });
  it('counts how many have a near twin', () => {
    const msgs = [
      { body: base, names: ['Priya', 'Stripe'] },
      { body: base.replace('Priya', 'Sam').replace('Stripe', 'Ramp'), names: ['Sam', 'Ramp'] },
      { body: 'Something else entirely, written only for this one person about their own work.', names: [] },
    ];
    expect(nearTwins(msgs)).toBe(2);
  });
});
