import { describe, expect, it } from 'vitest';
import {
  fullTimeMonthsOf,
  fullTimeTitle,
  levelAnswerOf,
  levelsFor,
  profileLevelOf,
  yearMonth,
} from './profileLevel';

const NOW = new Date('2026-11-24T12:00:00Z');

describe('yearMonth', () => {
  it('reads the usual ways a date is written', () => {
    expect(yearMonth('2027-05')).toBe('2027-05');
    expect(yearMonth('2027-5-15')).toBe('2027-05');
    expect(yearMonth('May 2027')).toBe('2027-05');
    expect(yearMonth('Sept. 2024')).toBe('2024-09');
    expect(yearMonth('5/2027')).toBe('2027-05');
    // LinkedIn through Unipile: month/day/year
    expect(yearMonth('6/1/2026')).toBe('2026-06');
    expect(yearMonth('11/3/2019')).toBe('2019-11');
    expect(yearMonth('13/1/2019')).toBeUndefined();
    expect(yearMonth('Spring 2027')).toBe('2027-05');
    expect(yearMonth('2027')).toBe('2027-05');
    expect(yearMonth('Present')).toBeUndefined();
    expect(yearMonth('soon')).toBeUndefined();
  });
});

describe('profileLevelOf: from dates', () => {
  it('graduation more than a year away is a student', () => {
    expect(profileLevelOf({ graduation: '2028-05', fullTimeMonths: 0 }, NOW)).toBe('student');
  });
  it('graduating within a year, or graduated in the last year, is a new grad', () => {
    expect(profileLevelOf({ graduation: '2027-05', fullTimeMonths: 0 }, NOW)).toBe('new_grad');
    expect(profileLevelOf({ graduation: '2026-05', fullTimeMonths: 5 }, NOW)).toBe('new_grad');
  });
  it('full-time months after school decide early, mid and senior', () => {
    expect(profileLevelOf({ graduation: '2023-05', fullTimeMonths: 30 }, NOW)).toBe('early');
    expect(profileLevelOf({ graduation: '2019-05', fullTimeMonths: 60 }, NOW)).toBe('mid');
    expect(profileLevelOf({ graduation: '2012-05', fullTimeMonths: 120 }, NOW)).toBe('senior');
    expect(profileLevelOf({ fullTimeMonths: 90 }, NOW)).toBe('senior');
  });
  it('nothing to go on is a new grad', () => {
    expect(profileLevelOf({ fullTimeMonths: 0 }, NOW)).toBe('new_grad');
  });
});

describe('fullTimeMonthsOf', () => {
  it('internships never count, and work before graduating does not either', () => {
    expect(fullTimeTitle('Software Engineering Intern')).toBe(false);
    expect(fullTimeTitle('Research Assistant')).toBe(false);
    expect(fullTimeTitle('Software Engineer')).toBe(true);
    const exp = [
      { start: '2022-06', end: '2022-08', fullTime: false },
      { start: '2023-06', end: '2025-06', fullTime: true },
      { start: '2025-01', end: undefined, fullTime: true },
    ];
    // graduated 2024-05: counts 2024-05 to now (31 months), overlaps once
    expect(fullTimeMonthsOf(exp, '2024-05', NOW)).toBe(31);
    expect(fullTimeMonthsOf(exp, undefined, NOW)).toBe(42);
  });
});

describe('levelsFor and levelAnswerOf', () => {
  it('the level searched follows the profile', () => {
    expect(levelsFor('student')).toEqual(['intern']);
    expect(levelsFor('new_grad')).toEqual(['entry']);
    expect(levelsFor('early')).toEqual(['entry', 'mid']);
    expect(levelsFor('mid')).toEqual(['mid', 'senior']);
    expect(levelsFor('senior')).toEqual(['senior', 'lead', 'exec']);
  });
  it('at, below, a stretch, far above, or nothing when the role does not say', () => {
    expect(levelAnswerOf('student', 'intern')).toBe('at');
    expect(levelAnswerOf('student', 'entry')).toBe('stretch');
    expect(levelAnswerOf('student', 'senior')).toBe('far');
    expect(levelAnswerOf('mid', 'entry')).toBe('below');
    expect(levelAnswerOf('early', 'mid')).toBe('at');
    expect(levelAnswerOf('new_grad', undefined)).toBeUndefined();
  });
});
