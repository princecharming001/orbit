import { describe, expect, it } from 'vitest';
import { toYou } from './prep';

describe('toYou: a note or a line the student wrote, read back to them', () => {
  it('turns the first person into you, the student and the person included', () => {
    expect(
      toYou(
        "We talked in May about GTM and his pivot; following up since I'm going for PM internships for summer 2027.",
      ),
    ).toBe(
      "You talked in May about GTM and his pivot; following up since you're going for PM internships for summer 2027.",
    );
    expect(toYou('She offered to intro me to our old team')).toBe(
      'She offered to intro you to your old team',
    );
  });
  it('leaves a capital US alone', () => {
    expect(toYou('He moved to the US office and told us')).toBe('He moved to the US office and told you');
  });
});
