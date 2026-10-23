import { describe, expect, it } from 'vitest';
import { freshPhoto, isLinkedInPhoto } from './photos';

const old = 'https://media.licdn.com/dms/image/v2/a/profile.jpg?e=1700000000';
const neu = 'https://media.licdn.com/dms/image/v2/a/profile.jpg?e=1800000000';

describe('LinkedIn photos', () => {
  it('a newer LinkedIn link replaces an expiring one; the student’s own photo stays', () => {
    expect(isLinkedInPhoto(old)).toBe(true);
    expect(isLinkedInPhoto('data:image/png;base64,AAAA')).toBe(false);
    expect(freshPhoto(undefined, neu)).toBe(neu);
    expect(freshPhoto(old, neu)).toBe(neu);
    expect(freshPhoto('https://example.com/me.jpg', neu)).toBe('https://example.com/me.jpg');
    expect(freshPhoto(old, undefined)).toBe(old);
  });
});
