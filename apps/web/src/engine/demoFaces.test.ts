import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDemoDataset } from '@orbit/core';
import { describe, expect, it } from 'vitest';
import { SAMPLE_PEOPLE } from '../components/landing/sampleNetwork';
import { DEMO_STUDENT_FACE, demoFace, withDemoFaces } from './demoFaces';

const PUBLIC = join(__dirname, '../../public');
const onDisk = (url: string) => join(PUBLIC, url.replace(import.meta.env.BASE_URL, ''));

describe('demo faces', () => {
  it('gives every demo person a face of their own, on any day, and every face is a small file', () => {
    for (const day of ['2026-10-06T10:00:00', '2027-01-12T10:00:00', '2027-04-20T10:00:00']) {
      const people = withDemoFaces(buildDemoDataset({ now: new Date(day) }).people);
      const urls = people.map((p) => p.photoUrl);
      expect(urls.every(Boolean)).toBe(true);
      expect(new Set(urls).size).toBe(urls.length);
      for (const u of urls) {
        const file = onDisk(u!);
        expect(existsSync(file), file).toBe(true);
        expect(statSync(file).size).toBeLessThan(25_000);
      }
    }
  });

  it('gives the student and the landing network faces, and keeps a photo someone already has', () => {
    expect(existsSync(onDisk(DEMO_STUDENT_FACE))).toBe(true);
    const urls = SAMPLE_PEOPLE.map((p) => p.photoUrl);
    expect(urls.every(Boolean)).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) expect(existsSync(onDisk(u!))).toBe(true);
    const [kept] = withDemoFaces([{ firstName: 'Maya', photoUrl: 'https://example.com/me.jpg' }]);
    expect(kept!.photoUrl).toBe('https://example.com/me.jpg');
    expect(demoFace('Zebulon')).toBeUndefined();
  });
});
