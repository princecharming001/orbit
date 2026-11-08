import { describe, expect, it } from 'vitest';
import { applyTyping, dropSignoff, learnTyping } from './typing';

const lower = [
  'hey jai, would love to grab 15 min sometime this week if you are free',
  'sounds good, see you thursday at 4 in sf then',
  'thanks for the intro, really appreciate it. will follow up with her',
  'haha yes that works, i can send over the deck tonight',
  'just saw the launch, congrats. how is the pm search going',
  'for sure, happy to chat whenever works for you next week',
];
const proper = [
  'Hi Maya, thanks so much for the time yesterday. It was great to learn about the team.',
  'Sounds good. I will send the deck over tonight.',
  'Thanks for the intro, I really appreciate it.',
  'Hope you had a great weekend. Are you free for a quick call Thursday?',
  'Congrats on the launch. How is the hiring going?',
];

describe('how the student types', () => {
  it('reads lowercase from their newest messages, and too few messages as unknown', () => {
    expect(learnTyping(lower, 'Anish')).toMatchObject({ casing: 'lower', signs: false, from: 6 });
    expect(learnTyping(proper, 'Anish')?.casing).toBe('proper');
    expect(learnTyping(lower.slice(0, 3))).toBeUndefined();
  });

  it('follows the newest habit: old capitalised messages past the window do not count', () => {
    const history = [
      ...lower,
      ...lower,
      ...lower,
      ...lower,
      ...lower,
      ...lower,
      ...lower,
      ...proper,
      ...proper,
    ];
    expect(learnTyping(history)?.casing).toBe('lower');
  });

  it('notices someone who signs their messages', () => {
    const signed = proper.map((p) => `${p}\n\nAnish`);
    expect(learnTyping(signed, 'Anish')?.signs).toBe(true);
  });

  it('writes a lowercase draft lowercase all the way through, links kept, sign-off dropped on LinkedIn', () => {
    const style = learnTyping(lower, 'Anish');
    const draft =
      "hey Jai, picking back up from May. I'm recruiting for PM internships. Happy to grab a slot on https://cal.com/Aryan-Vij/30-min if it still works.\n\nAnish";
    expect(applyTyping(draft, style, { channel: 'linkedin', firstName: 'Anish' })).toBe(
      "hey jai, picking back up from may. i'm recruiting for pm internships. happy to grab a slot on https://cal.com/Aryan-Vij/30-min if it still works.",
    );
  });

  it('capitalises a mixed draft properly for someone who writes that way', () => {
    const style = learnTyping(proper, 'Anish');
    expect(
      applyTyping("hey Jai, picking back up from May. i'm curious how it went.\n\nBest,\nAnish", style, {
        channel: 'gmail',
        firstName: 'Anish',
      }),
    ).toBe("Hey Jai, picking back up from May. I'm curious how it went.\n\nBest,\nAnish");
  });

  it('drops only a closing name and the line above it when that line is a sign-off', () => {
    expect(dropSignoff('see you then\n\nBest,\nAnish', 'Anish')).toBe('see you then');
    expect(dropSignoff('see you then\n- anish', 'Anish')).toBe('see you then');
    expect(dropSignoff('ask Anish about it', 'Anish')).toBe('ask Anish about it');
  });
});
