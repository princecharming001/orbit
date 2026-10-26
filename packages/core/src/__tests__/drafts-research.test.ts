import { describe, expect, it } from 'vitest';
import {
  contextText,
  type DraftContext,
  generateDraft,
  researchLine,
  WHY_THEM_GAP,
} from '../drafts/templates';
import { validateDraft } from '../drafts/validate';
import { defaultStyleCard } from '../style/card';

const NOW = new Date('2026-10-06T14:00:00Z');

/** A first message to a stranger: no school, employer, referral or meeting in common. */
const stranger = (over: Partial<DraftContext> = {}): DraftContext => ({
  user: {
    firstName: 'Alex',
    lastName: 'Rivera',
    fullName: 'Alex Rivera',
    school: 'Cornell University',
    gradYear: 2028,
    degree: 'BS',
    majors: ['Computer Science'],
    cycleLabel: 'Summer 2027 internship',
    targetFunctions: ['pm'],
    timezone: 'America/New_York',
    pastOrgs: [],
  },
  styleCard: defaultStyleCard('warm', 'Alex'),
  person: {
    firstName: 'Dana',
    lastName: 'Liu',
    fullName: 'Dana Liu',
    title: 'Product Manager',
    org: 'Ramp',
    relationshipType: 'unknown',
    strength: 0.05,
  },
  facts: [],
  kind: 'outreach',
  channel: 'gmail',
  now: NOW,
  seed: 'dana',
  ...over,
});

const OPENER = 'Your post on shipping spend limits in six weeks made me rethink scoping';

describe('the research opener in a first message (docs/plan/20 §6)', () => {
  it('becomes the one line only true of them when nothing human links the student to them', () => {
    const d = generateDraft(stranger({ researchOpener: OPENER }));
    expect(d.body).toContain(`${OPENER}.`);
    expect(d.body).not.toMatch(WHY_THEM_GAP);
    expect(d.needsInput).not.toContain('connection');
    const ctx = stranger({ researchOpener: OPENER });
    const blocking = validateDraft(d, {
      kind: 'outreach',
      facts: [],
      allowedUrls: [],
      recipientFirstName: 'Dana',
      recipientFullName: 'Dana Liu',
      channel: 'gmail',
      context: contextText(ctx),
    }).filter((i) => i.blocking);
    expect(blocking).toEqual([]);
  });

  it('goes in the LinkedIn note too', () => {
    const d = generateDraft(stranger({ researchOpener: OPENER, channel: 'linkedin' }));
    expect(`${d.bodyShort ?? ''} ${d.body}`).toContain(OPENER);
  });

  it('a human link (a shared school) still leads; without an opener the draft is still whole', () => {
    const alum = generateDraft(
      stranger({
        researchOpener: OPENER,
        person: { ...stranger().person, isAlumni: true, relationshipType: 'alumni' },
      }),
    );
    expect(alum.body).not.toContain(OPENER);
    const none = generateDraft(
      stranger({ person: { ...stranger().person, headline: undefined, org: undefined } }),
    );
    expect(none.body).not.toMatch(WHY_THEM_GAP);
    expect(none.body).toMatch(/I came across your profile and thought I'd introduce myself\./);
  });

  it('is one sentence, ended, and never a bracketed prompt', () => {
    expect(researchLine('Your talk stuck with me')).toBe('Your talk stuck with me.');
    expect(researchLine('Did that work?')).toBe('Did that work?');
    expect(researchLine('[Why them: …]')).toBeUndefined();
    expect(researchLine(Array(40).fill('word').join(' '))).toBeUndefined();
  });
});
