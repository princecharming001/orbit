import { describe, expect, it } from 'vitest';
import { COUNT_BASE, COUNT_START, dayTicks, studentCount } from './studentCount';

const DAY = 86_400_000;

describe('the landing page student count', () => {
  it('starts at 1,833 and adds 10 to 20 a day, in 3 to 6 ticks', () => {
    expect(studentCount(COUNT_START - 1000).count).toBe(COUNT_BASE);
    expect(studentCount(COUNT_START).count).toBe(COUNT_BASE);
    for (let d = 0; d < 400; d++) {
      const ticks = dayTicks(d);
      const total = ticks.reduce((s, t) => s + t.add, 0);
      expect(total).toBeGreaterThanOrEqual(10);
      expect(total).toBeLessThanOrEqual(20);
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks.every((t) => t.at >= 0 && t.at < DAY && t.add > 0)).toBe(true);
    }
    const day1 = studentCount(COUNT_START + DAY).count - COUNT_BASE;
    expect(day1).toBeGreaterThanOrEqual(10);
    expect(day1).toBeLessThanOrEqual(20);
  });

  it('never goes down, is the same for everyone, and says when it next goes up', () => {
    let last = 0;
    for (let t = COUNT_START - DAY; t < COUNT_START + 30 * DAY; t += 37 * 60_000) {
      const { count, nextAt } = studentCount(t);
      expect(count).toBeGreaterThanOrEqual(last);
      expect(nextAt).toBeGreaterThan(t);
      // just before the next tick it is the same; at it, higher
      expect(studentCount(nextAt! - 1).count).toBe(count);
      expect(studentCount(nextAt!).count).toBeGreaterThan(count);
      last = count;
    }
    expect(studentCount(COUNT_START + 5.5 * DAY)).toEqual(studentCount(COUNT_START + 5.5 * DAY));
  });
});
